//! A business served by another PC. Calls return the same results as the local facade. When the
//! connection drops, the next call reconnects to the same certificate and resumes the session;
//! while the server is off, calls fail with `server_unreachable`. Writes are never queued.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use manager_core::users::User;
use manager_core::{BusinessError, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::{json, Value};

use crate::certificate::fingerprint_of_der;
use crate::protocol::{Hello, Reply, MAX_LINE};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn unreachable(message: impl Into<String>) -> BusinessError {
    BusinessError::new("server_unreachable", message)
}

/**
 * The certificate is self-signed and there is no authority on a shop's network, so the chain is
 * not checked: the fingerprint is, after the handshake (trust on first use). The handshake's
 * signature is still verified, so the server must hold the certificate's key.
 */
#[derive(Debug)]
struct Pinning(Arc<CryptoProvider>);

impl ServerCertVerifier for Pinning {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

type Stream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/** One TLS connection, answering one request at a time. */
struct Link {
    reader: BufReader<Stream>,
    next: u64,
}

impl Link {
    /** Opens TLS to the server and checks its certificate against the pinned fingerprint, if any. */
    fn open(host: &str, port: u16, pinned: Option<&str>) -> Result<(Link, String)> {
        let address = (host, port)
            .to_socket_addrs()
            .map_err(|e| unreachable(format!("Cannot find {host}: {e}")))?
            .next()
            .ok_or_else(|| unreachable(format!("Cannot find {host}")))?;
        let mut tcp = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
            .map_err(|e| unreachable(format!("Cannot reach {host}:{port}: {e}")))?;
        let _ = tcp.set_nodelay(true);
        let _ = tcp.set_read_timeout(Some(CONNECT_TIMEOUT));
        let _ = tcp.set_write_timeout(Some(REQUEST_TIMEOUT));
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|e| unreachable(e.to_string()))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinning(provider)))
            .with_no_client_auth();
        let name =
            ServerName::try_from(host.to_string()).map_err(|e| unreachable(e.to_string()))?;
        let mut tls = rustls::ClientConnection::new(Arc::new(config), name)
            .map_err(|e| unreachable(e.to_string()))?;
        while tls.is_handshaking() {
            tls.complete_io(&mut tcp)
                .map_err(|e| unreachable(format!("Cannot reach {host}:{port}: {e}")))?;
        }
        let presented = tls
            .peer_certificates()
            .and_then(|c| c.first())
            .map(|c| fingerprint_of_der(c))
            .ok_or_else(|| unreachable("The server sent no certificate"))?;
        if pinned.is_some_and(|p| p != presented) {
            return Err(BusinessError::new(
                "server_identity_changed",
                format!("The server at {host}:{port} presented a different certificate"),
            ));
        }
        let _ = tcp.set_read_timeout(Some(REQUEST_TIMEOUT));
        let link = Link {
            reader: BufReader::new(rustls::StreamOwned::new(tls, tcp)),
            next: 1,
        };
        Ok((link, presented))
    }

    /** Sends one request and waits for its reply; an error means the link is gone. */
    fn send(&mut self, mut body: Value) -> std::result::Result<Reply, String> {
        let id = self.next;
        self.next += 1;
        body["id"] = json!(id);
        let mut out = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
        out.push(b'\n');
        let stream = self.reader.get_mut();
        stream
            .write_all(&out)
            .and_then(|_| stream.flush())
            .map_err(|e| e.to_string())?;
        let mut line = Vec::new();
        loop {
            line.clear();
            let read = self
                .reader
                .by_ref()
                .take(MAX_LINE as u64 + 1)
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if read == 0 || line.last() != Some(&b'\n') {
                return Err("The connection to the server was lost".into());
            }
            let reply: Reply = serde_json::from_slice(&line).map_err(|e| e.to_string())?;
            if reply.id == id {
                return Ok(reply);
            }
        }
    }
}

struct Inner {
    link: Option<Link>,
    token: Option<String>,
}

/** The business on another PC, as this PC's screens use it. */
pub struct RemoteBusiness {
    pub host: String,
    pub port: u16,
    /** The server certificate's fingerprint, to pin for next time. */
    pub fingerprint: String,
    pub hello: Hello,
    inner: Mutex<Inner>,
}

impl RemoteBusiness {
    /**
     * Connects, signed out, checking the pinned fingerprint when given (trust on first use
     * otherwise). Fails with `server_unreachable`, `server_identity_changed` or `not_a_server`.
     */
    pub fn connect(host: &str, port: u16, pinned: Option<&str>) -> Result<RemoteBusiness> {
        let (mut link, fingerprint) = Link::open(host, port, pinned)?;
        let not_a_server = || {
            BusinessError::new(
                "not_a_server",
                format!("{host}:{port} is not a Manager+ server"),
            )
        };
        let reply = link
            .send(json!({ "op": "hello" }))
            .map_err(|_| not_a_server())?;
        let hello: Hello = reply
            .into_result()
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
            .filter(|h: &Hello| h.app == "manager-plus")
            .ok_or_else(not_a_server)?;
        Ok(RemoteBusiness {
            host: host.to_string(),
            port,
            fingerprint,
            hello,
            inner: Mutex::new(Inner {
                link: Some(link),
                token: None,
            }),
        })
    }

    /** Sends a request, first reconnecting (to the same certificate) and resuming the session if the link dropped. */
    fn send(&self, body: Value) -> Result<Value> {
        let mut inner = lock(&self.inner);
        if inner.link.is_none() {
            let (mut link, _) = Link::open(&self.host, self.port, Some(&self.fingerprint))?;
            if let Some(token) = inner.token.clone() {
                let resumed = link
                    .send(json!({ "op": "resume", "token": token }))
                    .map_err(unreachable)?;
                if !resumed.ok {
                    inner.token = None;
                    inner.link = Some(link);
                    return resumed.into_result();
                }
            }
            inner.link = Some(link);
        }
        let sent = inner.link.as_mut().expect("opened above").send(body);
        match sent {
            Ok(reply) => reply.into_result(),
            Err(message) => {
                inner.link = None;
                Err(unreachable(message))
            }
        }
    }

    pub fn sign_in(&self, name: &str, password: &str) -> Result<User> {
        let signed = self.send(json!({ "op": "signIn", "name": name, "password": password }))?;
        let user: User = serde_json::from_value(signed["user"].clone())
            .map_err(|e| BusinessError::new("unexpected", e.to_string()))?;
        lock(&self.inner).token = signed["token"].as_str().map(String::from);
        Ok(user)
    }

    pub fn sign_out(&self) {
        let _ = self.send(json!({ "op": "signOut" }));
        lock(&self.inner).token = None;
    }

    /** A facade call by the name the screens use, run on the server as the signed-in user. */
    pub fn call(&self, method: &str, args: &[Value]) -> Result<Value> {
        self.send(json!({ "op": "call", "method": method, "args": args }))
    }

    /** Drops the connection; the next call reconnects and resumes the session, as after a PC sleeps. */
    pub fn disconnect(&self) {
        if let Some(link) = lock(&self.inner).link.take() {
            let _ = link
                .reader
                .get_ref()
                .sock
                .shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Drop for RemoteBusiness {
    fn drop(&mut self) {
        self.disconnect();
    }
}
