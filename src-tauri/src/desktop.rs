use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use manager_core::file_lock::{self, LockInfo, Me};
use manager_core::users::Credentials;
use manager_core::{Business, BusinessError, BusinessSettings};
use manager_lan::discovery::{self, Advertiser, FoundServer};
use manager_lan::protocol::DEFAULT_PORT;
use manager_lan::{certificate, server, RemoteBusiness, RunningServer};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_RECENT: usize = 8;
const THEMES: [&str; 4] = ["calm", "sage", "sand", "night"];

/** The open business file, signed out, and the same business acting for the signed-in user. */
#[derive(Default)]
pub struct State {
    open: Mutex<Open>,
}

#[derive(Default)]
struct Open {
    file: Option<Business>,
    /** The signed-in business; `None` with `current_is_file` when the file itself was just created signed in. */
    current: Option<Business>,
    current_is_file: bool,
    path: Option<String>,
    /** Another PC that had the open file when this one opened it. */
    elsewhere: Option<LockInfo>,
    /** The business on another PC, when this one is a client (ADR 0002). */
    remote: Option<Arc<RemoteBusiness>>,
    /** This PC serving its open file to others. */
    serving: Option<Serving>,
}

struct Serving {
    server: RunningServer,
    _announcing: Option<Advertiser>,
}

impl Open {
    fn current(&self) -> Option<&Business> {
        if self.current_is_file {
            self.file.as_ref()
        } else {
            self.current.as_ref()
        }
    }
}

/** This PC in the lock file next to the open business file. */
fn me() -> Me {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "unknown".into());
    Me {
        host,
        pid: std::process::id(),
    }
}

/** The daily backup of the open file, and its lock kept fresh; failures are logged and tried again later. */
fn backup_if_due(open: &Open) {
    let Some(file) = &open.file else { return };
    match file.scheduled_backup(chrono::Utc::now()) {
        Ok(Some(done)) => println!("Backed up to {}", done.path),
        Ok(None) => {}
        Err(error) => eprintln!("Scheduled backup failed: {error}"),
    }
}

impl State {
    /** Every five minutes while the app runs, as the Electron main process does. */
    pub fn tick(&self) {
        let open = self.open.lock().unwrap();
        if let Some(path) = &open.path {
            file_lock::refresh_lock(path, &me(), chrono::Utc::now());
        }
        backup_if_due(&open);
    }

    /** Lets go of the open file's lock, stops serving and leaves any server when the app closes. */
    pub fn release(&self) {
        let mut open = self.open.lock().unwrap();
        open.serving = None;
        open.remote = None;
        if let Some(path) = &open.path {
            file_lock::release_lock(path, &me());
        }
        open.elsewhere = None;
    }
}

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn failure(error: BusinessError) -> Value {
    let mut out = json!({ "ok": false, "code": error.code, "message": error.message });
    if let Some(amount) = error.amount {
        out["amount"] = json!(amount);
    }
    out
}

fn result(r: Result<Value, BusinessError>) -> Value {
    r.map(ok).unwrap_or_else(failure)
}

fn not_ported(channel: &str) -> Value {
    failure(BusinessError::new(
        "not_ported",
        format!("{channel} is not in the Tauri app yet"),
    ))
}

fn data_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}

fn read_json(app: &AppHandle, name: &str) -> Value {
    data_file(app, name)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn write_json(app: &AppHandle, name: &str, value: &Value) {
    if let Some(p) = data_file(app, name) {
        let _ = std::fs::write(p, value.to_string());
    }
}

fn recent(app: &AppHandle) -> Vec<String> {
    match read_json(app, "recent-files.json") {
        Value::Array(list) => list
            .into_iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => vec![],
    }
}

fn remember_recent(app: &AppHandle, path: &str) {
    let mut list = vec![path.to_string()];
    list.extend(recent(app).into_iter().filter(|p| p != path));
    list.truncate(MAX_RECENT);
    write_json(app, "recent-files.json", &json!(list));
}

fn language(v: &Value) -> &'static str {
    if v.as_str() == Some("en") {
        "en"
    } else {
        "ar"
    }
}

/** This PC's preferences, each one checked; anything missing or odd is the default. */
fn preferences(app: &AppHandle) -> Value {
    let saved = read_json(app, "preferences.json");
    let theme = saved["theme"]
        .as_str()
        .filter(|t| THEMES.contains(t))
        .unwrap_or("calm");
    let printer = if saved["printer"].is_object() {
        saved["printer"].clone()
    } else {
        json!({ "kind": "none" })
    };
    json!({
        "theme": theme,
        "printer": printer,
        "screenLanguage": language(&saved["screenLanguage"]),
        "documentLanguage": language(&saved["documentLanguage"]),
        "digits": if saved["digits"].as_str() == Some("arabic") { "arabic" } else { "western" },
    })
}

fn set_preferences(app: &AppHandle, changes: &Value) {
    let mut next = preferences(app);
    if let Some(t) = changes["theme"].as_str().filter(|t| THEMES.contains(t)) {
        next["theme"] = json!(t);
    }
    if changes["printer"].is_object() {
        next["printer"] = changes["printer"].clone();
    }
    for key in ["screenLanguage", "documentLanguage"] {
        if !changes[key].is_null() {
            next[key] = json!(language(&changes[key]));
        }
    }
    if let Some(d) = changes["digits"].as_str() {
        next["digits"] = json!(if d == "arabic" { "arabic" } else { "western" });
    }
    write_json(app, "preferences.json", &next);
}

fn arg<T: serde::de::DeserializeOwned>(args: &[Value], i: usize) -> Result<T, BusinessError> {
    serde_json::from_value(args.get(i).cloned().unwrap_or(Value::Null))
        .map_err(|e| BusinessError::new("unexpected", format!("Argument {i}: {e}")))
}

/** Makes `business` the open file, closing the one before. */
fn switch_to(
    app: &AppHandle,
    open: &mut Open,
    business: Business,
    path: &str,
    signed_in: bool,
) -> Result<Value, BusinessError> {
    let settings = business.settings()?;
    open.serving = None;
    open.remote = None;
    if let Some(old) = open.current.take() {
        old.sign_out();
    }
    if let Some(old) = open.file.take() {
        old.close();
    }
    if let Some(old) = &open.path {
        file_lock::release_lock(old, &me());
    }
    open.file = Some(business);
    open.current_is_file = signed_in;
    open.path = Some(path.to_string());
    // A read-only folder gets no lock, but the file still opens.
    open.elsewhere = file_lock::take_lock(path, &me(), chrono::Utc::now());
    backup_if_due(open);
    remember_recent(app, path);
    if let Some(serve) = read_network(app).serve.filter(|s| s.path == path) {
        if let Err(error) = start_serving(app, open, serve.port) {
            eprintln!("Serving the file failed: {error}");
        }
    }
    Ok(serde_json::to_value(settings).expect("settings serialize"))
}

// Server mode (ADR 0002)

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkFile {
    /** Certificate fingerprints pinned on first connect, by "host:port". */
    #[serde(default)]
    known_servers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    last_server: Option<FoundServer>,
    /** The file this PC serves whenever it is open, and on which port. */
    #[serde(default)]
    serve: Option<Serve>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Serve {
    path: String,
    port: u16,
}

fn read_network(app: &AppHandle) -> NetworkFile {
    serde_json::from_value(read_json(app, "network.json")).unwrap_or_default()
}

fn write_network(app: &AppHandle, network: &NetworkFile) {
    write_json(
        app,
        "network.json",
        &serde_json::to_value(network).expect("serializes"),
    );
}

fn server_status(app: &AppHandle, open: &Open) -> Value {
    match &open.serving {
        Some(serving) => json!({
            "serving": true,
            "port": serving.server.port,
            "fingerprint": certificate::short_fingerprint(&serving.server.fingerprint),
            "addresses": discovery::lan_addresses(),
            "clients": serving.server.clients(),
        }),
        None => json!({
            "serving": false,
            "port": read_network(app).serve.map_or(DEFAULT_PORT, |s| s.port),
            "fingerprint": "",
            "addresses": discovery::lan_addresses(),
            "clients": 0,
        }),
    }
}

fn start_serving(app: &AppHandle, open: &mut Open, port: u16) -> Result<(), BusinessError> {
    let Some(file) = &open.file else {
        return Err(BusinessError::new(
            "sign_in_required",
            "No business is open",
        ));
    };
    open.serving = None;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| BusinessError::new("unexpected", e.to_string()))?
        .join("server");
    let host = me().host;
    let identity = certificate::load_or_create(&dir, &host)?;
    let running = server::start(file, &identity, "0.0.0.0", port)?;
    let announcing = discovery::advertise(&file.settings()?.name, &host, running.port);
    open.serving = Some(Serving {
        server: running,
        _announcing: announcing,
    });
    Ok(())
}

#[tauri::command]
pub async fn desktop(
    app: AppHandle,
    state: tauri::State<'_, State>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, ()> {
    let filter = ("Manager+ business", &["mplus"][..]);
    Ok(match channel.as_str() {
        "createBusiness" => {
            let made = (|| {
                let settings: BusinessSettings = arg(&args, 0)?;
                let manager: Credentials = arg(&args, 1)?;
                let name = if settings.name.trim().is_empty() {
                    "business".to_string()
                } else {
                    settings.name.trim().to_string()
                };
                // The end-to-end journeys answer the save dialog with this, as the Electron ones mock it.
                let path = match std::env::var("MANAGER_PLUS_E2E_SAVE_AS") {
                    Ok(path) => path,
                    Err(_) => {
                        let picked = app
                            .dialog()
                            .file()
                            .add_filter(filter.0, filter.1)
                            .set_file_name(format!("{name}.mplus"))
                            .blocking_save_file();
                        let Some(target) = picked else {
                            return Ok(Value::Null);
                        };
                        let path = target
                            .into_path()
                            .map_err(|e| BusinessError::new("unexpected", e.to_string()))?;
                        path.to_string_lossy().into_owned()
                    }
                };
                let business = Business::create(&path, &settings, &manager)?;
                switch_to(&app, &mut state.open.lock().unwrap(), business, &path, true)
            })();
            result(made)
        }
        "openBusiness" => {
            let opened = (|| {
                let given: Option<String> = arg(&args, 0)?;
                let path = match given {
                    Some(p) => p,
                    None => match app
                        .dialog()
                        .file()
                        .add_filter(filter.0, filter.1)
                        .blocking_pick_file()
                    {
                        None => return Ok(Value::Null),
                        Some(p) => p
                            .into_path()
                            .map_err(|e| BusinessError::new("unexpected", e.to_string()))?
                            .to_string_lossy()
                            .into_owned(),
                    },
                };
                let business = Business::open(&path)?;
                switch_to(
                    &app,
                    &mut state.open.lock().unwrap(),
                    business,
                    &path,
                    false,
                )
            })();
            result(opened)
        }
        "recentFiles" => json!(recent(&app)),
        "signIn" => {
            let remote = state.open.lock().unwrap().remote.clone();
            if let Some(remote) = remote {
                let signed = (|| {
                    let credentials: Credentials = arg(&args, 0)?;
                    let user = remote.sign_in(&credentials.name, &credentials.password)?;
                    Ok(serde_json::to_value(user).expect("user serializes"))
                })();
                return Ok(result(signed));
            }
            let mut open = state.open.lock().unwrap();
            let signed = (|| {
                let credentials: Credentials = arg(&args, 0)?;
                let Some(file) = &open.file else {
                    return Err(BusinessError::new("unexpected", "No business is open"));
                };
                let session = file.sign_in(&credentials.name, &credentials.password)?;
                let user = serde_json::to_value(session.current_user()).expect("user serializes");
                if let Some(old) = open.current.replace(session) {
                    old.sign_out();
                }
                open.current_is_file = false;
                Ok(user)
            })();
            result(signed)
        }
        "signOut" => {
            let mut open = state.open.lock().unwrap();
            // The file itself stays signed in when it was just created; only a sign-in made here ends.
            if let Some(old) = open.current.take() {
                old.sign_out();
            }
            open.current_is_file = false;
            let remote = open.remote.clone();
            drop(open);
            if let Some(remote) = remote {
                remote.sign_out();
            }
            Value::Null
        }
        "call" => {
            let open = state.open.lock().unwrap();
            let method: String = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let call_args: Vec<Value> = match args.get(1) {
                Some(Value::Array(a)) => a.clone(),
                _ => vec![],
            };
            if let Some(remote) = open.remote.clone() {
                drop(open);
                return Ok(result(remote.call(&method, &call_args)));
            }
            match open.current() {
                None => failure(BusinessError::new("sign_in_required", "Sign in first")),
                Some(business) => result(business.call(&method, &call_args)),
            }
        }
        "preferences" => preferences(&app),
        "setPreferences" => {
            set_preferences(&app, args.first().unwrap_or(&Value::Null));
            Value::Null
        }
        "fileStatus" => {
            let open = state.open.lock().unwrap();
            match (&open.path, &open.file) {
                (Some(path), Some(_)) => json!({
                    "path": path,
                    "syncFolder": file_lock::sync_folder(path),
                    "openElsewhere": open.elsewhere,
                }),
                _ => Value::Null,
            }
        }
        "connection" => {
            let open = state.open.lock().unwrap();
            match (&open.remote, &open.path, &open.file) {
                (Some(r), _, _) => {
                    json!({ "mode": "client", "host": r.host, "port": r.port, "name": r.hello.settings.name })
                }
                (None, Some(path), Some(_)) => json!({ "mode": "local", "path": path }),
                _ => json!({ "mode": "none" }),
            }
        }
        "discoverServers" => json!(discovery::discover(Duration::from_millis(1500))),
        "lastServer" => json!(read_network(&app).last_server),
        "serverStatus" => server_status(&app, &state.open.lock().unwrap()),
        "connectServer" => {
            let connected = (|| {
                let host: String = arg(&args, 0)?;
                let port: u16 = arg(&args, 1)?;
                let key = format!("{host}:{port}");
                let mut network = read_network(&app);
                let remote = RemoteBusiness::connect(
                    &host,
                    port,
                    network.known_servers.get(&key).map(String::as_str),
                )?;
                let settings = remote.hello.settings.clone();
                let mut open = state.open.lock().unwrap();
                open.serving = None;
                if let Some(old) = open.current.take() {
                    old.sign_out();
                }
                if let Some(old) = open.file.take() {
                    old.close();
                }
                if let Some(old) = open.path.take() {
                    file_lock::release_lock(&old, &me());
                }
                open.current_is_file = false;
                open.elsewhere = None;
                network
                    .known_servers
                    .insert(key, remote.fingerprint.clone());
                network.last_server = Some(FoundServer {
                    name: settings.name.clone(),
                    host,
                    port,
                });
                open.remote = Some(Arc::new(remote));
                write_network(&app, &network);
                Ok(serde_json::to_value(settings).expect("settings serialize"))
            })();
            result(connected)
        }
        "setServing" => {
            let set = (|| {
                let on: bool = arg(&args, 0)?;
                let port: f64 = arg::<Option<f64>>(&args, 1)?.unwrap_or(0.0);
                let mut open = state.open.lock().unwrap();
                let manager = open
                    .current()
                    .and_then(|b| b.current_user())
                    .is_some_and(|u| u.role == "manager");
                let Some(path) = open
                    .path
                    .clone()
                    .filter(|_| manager && open.remote.is_none())
                else {
                    return Err(BusinessError::new(
                        "not_allowed",
                        "Only a manager on the PC that holds the file can serve it",
                    ));
                };
                let chosen = if port.fract() == 0.0 && port > 1023.0 && port < 65536.0 {
                    port as u16
                } else {
                    DEFAULT_PORT
                };
                if on {
                    start_serving(&app, &mut open, chosen)?;
                } else {
                    open.serving = None;
                }
                let mut network = read_network(&app);
                network.serve = on.then_some(Serve { path, port: chosen });
                write_network(&app, &network);
                Ok(server_status(&app, &open))
            })();
            result(set)
        }
        "chooseFolder" => match app.dialog().file().blocking_pick_folder() {
            Some(folder) => match folder.into_path() {
                Ok(p) => json!(p.to_string_lossy()),
                Err(_) => Value::Null,
            },
            None => Value::Null,
        },
        "restoreBackup" => {
            let restored = (|| {
                let given: Option<String> = arg(&args, 0)?;
                {
                    let open = state.open.lock().unwrap();
                    let manager = open
                        .current()
                        .and_then(|b| b.current_user())
                        .is_some_and(|u| u.role == "manager");
                    if !manager || open.path.is_none() {
                        return Err(BusinessError::new(
                            "restore_needs_manager",
                            "Only a manager on the PC that holds the file can restore",
                        ));
                    }
                }
                let backup = match given {
                    Some(p) => p,
                    None => match app
                        .dialog()
                        .file()
                        .add_filter(filter.0, filter.1)
                        .blocking_pick_file()
                    {
                        None => return Ok(Value::Null),
                        Some(p) => p
                            .into_path()
                            .map_err(|e| BusinessError::new("unexpected", e.to_string()))?
                            .to_string_lossy()
                            .into_owned(),
                    },
                };
                let mut open = state.open.lock().unwrap();
                let path = open.path.clone().expect("checked above");
                // Clients would see the file change under them; serving starts again on the restored file.
                open.serving = None;
                let restored = open.current().expect("checked above").restore(&backup)?;
                // The old handles now hold nothing; the restored file opens signed out.
                if let Some(old) = open.current.take() {
                    old.sign_out();
                }
                open.current_is_file = false;
                switch_to(&app, &mut open, restored, &path, false)
            })();
            result(restored)
        }
        "appVersion" => json!(app.package_info().version.to_string()),
        "licenceStatus" => Value::Null,
        "printers" => json!(crate::printing::installed()),
        "printRaw" => {
            let sent = (|| {
                let printer: crate::printing::Printer = arg(&args, 0)?;
                let bytes: Vec<u8> = arg(&args, 1)?;
                crate::printing::send(&printer, &bytes)
                    .map_err(|e| BusinessError::new("printer_failed", e))?;
                Ok(Value::Null)
            })();
            result(sent)
        }
        "etaCertificates" => json!([]),
        "checkUpdate" => ok(json!({ "kind": "none" })),
        other => not_ported(other),
    })
}
