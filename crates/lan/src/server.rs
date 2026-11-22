//! Serves the open business to other PCs over TLS.
//!
//! The server holds the business signed out; each sign-in gets its own `Business` acting for that
//! user on the same file, so every command still checks the role and is audited. The facade runs
//! one command at a time on the file's one connection, so two PCs posting at once are served one
//! after the other and both succeed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use manager_core::methods::is_business_method;
use manager_core::{Business, BusinessError, Result};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::{json, Value};

use crate::certificate::Identity;
use crate::protocol::{Reply, MAX_LINE};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn refuse<T>(code: &'static str, message: &str) -> Result<T> {
    Err(BusinessError::new(code, message))
}

/** One PC's connection: its socket, to end it when the server stops, and the session it uses. */
struct Connection {
    stream: TcpStream,
    token: Option<String>,
}

struct Shared {
    file: Business,
    /** Sign-ins by session token, held only in memory: restarting the server signs everyone out. */
    sessions: Mutex<HashMap<String, Arc<Business>>>,
    connections: Mutex<HashMap<u64, Connection>>,
    stopping: AtomicBool,
}

/** A running server; `close` stops it, ends every connection and signs everyone out. */
pub struct RunningServer {
    pub port: u16,
    pub fingerprint: String,
    shared: Arc<Shared>,
    address: SocketAddr,
    accepting: Option<JoinHandle<()>>,
}

impl RunningServer {
    /** How many PCs are connected now. */
    pub fn clients(&self) -> usize {
        lock(&self.shared.connections).len()
    }

    pub fn close(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        let Some(accepting) = self.accepting.take() else {
            return;
        };
        self.shared.stopping.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees it is stopping.
        let wake = if self.address.ip().is_unspecified() {
            SocketAddr::from(([127, 0, 0, 1], self.port))
        } else {
            self.address
        };
        let _ = TcpStream::connect_timeout(&wake, Duration::from_secs(1));
        let _ = accepting.join();
        for connection in lock(&self.shared.connections).values() {
            let _ = connection.stream.shutdown(Shutdown::Both);
        }
        for (_, business) in lock(&self.shared.sessions).drain() {
            business.sign_out();
        }
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS gives random bytes");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn text(request: &Value, field: &str) -> String {
    match &request[field] {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl Shared {
    fn end(&self, token: &str) {
        if let Some(business) = lock(&self.sessions).remove(token) {
            business.sign_out();
        }
    }

    /**
     * Signs in, within the licence's number of users. A PC that went away without signing out
     * keeps its seat while it may come back; when the seats run out, those sessions end first.
     */
    fn sign_in(&self, name: &str, password: &str) -> Result<Business> {
        match self.file.sign_in(name, password) {
            Err(e) if e.code == "licence_users_exceeded" => {
                let live: Vec<String> = lock(&self.connections)
                    .values()
                    .filter_map(|c| c.token.clone())
                    .collect();
                let gone: Vec<String> = lock(&self.sessions)
                    .keys()
                    .filter(|t| !live.contains(t))
                    .cloned()
                    .collect();
                for token in gone {
                    self.end(&token);
                }
                self.file.sign_in(name, password)
            }
            other => other,
        }
    }

    fn set_token(&self, connection: u64, token: Option<String>) {
        if let Some(c) = lock(&self.connections).get_mut(&connection) {
            c.token = token;
        }
    }

    fn token_of(&self, connection: u64) -> Option<String> {
        lock(&self.connections)
            .get(&connection)
            .and_then(|c| c.token.clone())
    }

    fn handle(&self, request: &Value, connection: u64) -> Result<Value> {
        match request["op"].as_str().unwrap_or_default() {
            "hello" => Ok(
                json!({ "app": "manager-plus", "protocol": 1, "settings": self.file.settings()? }),
            ),
            "signIn" => {
                let business = self.sign_in(&text(request, "name"), &text(request, "password"))?;
                let user =
                    serde_json::to_value(business.current_user()).expect("a user serializes");
                let token = token();
                if let Some(old) = self.token_of(connection) {
                    self.end(&old);
                }
                lock(&self.sessions).insert(token.clone(), Arc::new(business));
                self.set_token(connection, Some(token.clone()));
                Ok(json!({ "user": user, "token": token }))
            }
            "resume" => {
                let token = text(request, "token");
                let user = match lock(&self.sessions).get(&token) {
                    Some(business) => {
                        serde_json::to_value(business.current_user()).expect("a user serializes")
                    }
                    None => {
                        return refuse("sign_in_required", "That session has ended; sign in again")
                    }
                };
                self.set_token(connection, Some(token));
                Ok(user)
            }
            "signOut" => {
                if let Some(token) = self.token_of(connection) {
                    self.end(&token);
                }
                self.set_token(connection, None);
                Ok(Value::Null)
            }
            "call" => {
                let method = request["method"].as_str().unwrap_or_default();
                let Value::Array(args) = &request["args"] else {
                    return refuse("not_allowed", "A call needs its arguments as a list");
                };
                if !is_business_method(method) {
                    return Err(BusinessError::new(
                        "not_allowed",
                        format!("Not a business method: {method}"),
                    ));
                }
                let Some(token) = self.token_of(connection) else {
                    return refuse("sign_in_required", "Sign in first");
                };
                // The session is taken from the map, so a slow report never holds up sign-ins.
                let Some(business) = lock(&self.sessions).get(&token).cloned() else {
                    return refuse("sign_in_required", "Sign in first");
                };
                business.call(method, args)
            }
            _ => refuse("not_allowed", "Unknown request"),
        }
    }

    /** Answers one connection's requests in order until it closes. */
    fn serve(&self, id: u64, stream: TcpStream, config: Arc<rustls::ServerConfig>) {
        let Ok(tls) = rustls::ServerConnection::new(config) else {
            return;
        };
        let mut reader = BufReader::new(rustls::StreamOwned::new(tls, stream));
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader
                .by_ref()
                .take(MAX_LINE as u64 + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) | Err(_) => break,
                Ok(_) if line.last() != Some(&b'\n') => break, // too long, or cut off
                Ok(_) => {}
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let reply = match serde_json::from_slice::<Value>(&line) {
                Ok(request) => {
                    let rid = request["id"].as_u64().unwrap_or(0);
                    match self.handle(&request, id) {
                        Ok(value) => Reply::success(rid, value),
                        Err(error) => Reply::failure(rid, error),
                    }
                }
                Err(_) => Reply::failure(0, BusinessError::new("unexpected", "Bad request")),
            };
            let mut out = serde_json::to_vec(&reply).expect("a reply serializes");
            out.push(b'\n');
            let stream = reader.get_mut();
            if stream.write_all(&out).and_then(|_| stream.flush()).is_err() {
                break;
            }
        }
        lock(&self.connections).remove(&id);
    }
}

static CONNECTIONS: AtomicU64 = AtomicU64::new(1);

fn internal(e: impl std::fmt::Display) -> BusinessError {
    BusinessError::new("unexpected", e.to_string())
}

fn tls_config(identity: &Identity) -> Result<Arc<rustls::ServerConfig>> {
    let cert = CertificateDer::from_pem_slice(identity.cert.as_bytes()).map_err(internal)?;
    let key = PrivateKeyDer::from_pem_slice(identity.key.as_bytes()).map_err(internal)?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(internal)?
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .map_err(internal)?;
    Ok(Arc::new(config))
}

/** Keeps idle connections alive and notices a PC that vanished, so its seat can be given up. */
fn tune(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(10));
    let _ = socket2::SockRef::from(stream).set_tcp_keepalive(&keepalive);
}

/**
 * Serves `file` (the open business, signed out) on `host:port`; port 0 picks a free one. A port
 * already in use is refused with `server_port_busy`.
 */
pub fn start(file: &Business, identity: &Identity, host: &str, port: u16) -> Result<RunningServer> {
    let config = tls_config(identity)?;
    let listener = TcpListener::bind((host, port)).map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => BusinessError::new("server_port_busy", e.to_string()),
        _ => internal(e),
    })?;
    let address = listener.local_addr().map_err(internal)?;
    let shared = Arc::new(Shared {
        file: file.signed_out(),
        sessions: Mutex::new(HashMap::new()),
        connections: Mutex::new(HashMap::new()),
        stopping: AtomicBool::new(false),
    });
    let accepting = {
        let shared = shared.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if shared.stopping.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let Ok(handle) = stream.try_clone() else {
                    continue;
                };
                tune(&stream);
                let id = CONNECTIONS.fetch_add(1, Ordering::Relaxed);
                lock(&shared.connections).insert(
                    id,
                    Connection {
                        stream: handle,
                        token: None,
                    },
                );
                let shared = shared.clone();
                let config = config.clone();
                std::thread::spawn(move || shared.serve(id, stream, config));
            }
        })
    };
    Ok(RunningServer {
        port: address.port(),
        fingerprint: identity.fingerprint.clone(),
        shared,
        address,
        accepting: Some(accepting),
    })
}
