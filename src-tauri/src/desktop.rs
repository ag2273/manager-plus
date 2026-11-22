use std::path::PathBuf;
use std::sync::Mutex;

use manager_core::users::Credentials;
use manager_core::{Business, BusinessError, BusinessSettings};
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
    if let Some(old) = open.current.take() {
        old.sign_out();
    }
    if let Some(old) = open.file.take() {
        old.close();
    }
    open.file = Some(business);
    open.current_is_file = signed_in;
    open.path = Some(path.to_string());
    remember_recent(app, path);
    Ok(serde_json::to_value(settings).expect("settings serialize"))
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
                (Some(path), Some(_)) => {
                    json!({ "path": path, "syncFolder": null, "openElsewhere": null })
                }
                _ => Value::Null,
            }
        }
        "connection" => {
            let open = state.open.lock().unwrap();
            match (&open.path, &open.file) {
                (Some(path), Some(_)) => json!({ "mode": "local", "path": path }),
                _ => json!({ "mode": "none" }),
            }
        }
        "appVersion" => json!(app.package_info().version.to_string()),
        "licenceStatus" | "lastServer" => Value::Null,
        "printers" | "discoverServers" | "etaCertificates" => json!([]),
        "checkUpdate" => ok(json!({ "kind": "none" })),
        "serverStatus" => {
            json!({ "serving": false, "port": 0, "fingerprint": "", "addresses": [], "clients": 0 })
        }
        other => not_ported(other),
    })
}
