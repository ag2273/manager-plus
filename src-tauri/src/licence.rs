//! This PC's side of licensing and updates: its fingerprint, the licence file in the app's data
//! folder, our licence server over HTTPS, and downloading and running an update's installer.
//! The rules themselves (the trial, the signatures, who may install what) are in `manager-core`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use manager_core::licence::{
    ActivationError, LicenceClient, LicenceFile, LicenceState, LicenceStore,
};
use manager_core::updates::{verify_package, SignedManifest, UpdateManifest};
use manager_core::BusinessError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/** The licence and update server; a test build can point elsewhere. */
pub fn server() -> String {
    std::env::var("MANAGER_PLUS_LICENCE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://licence.nileorbit.com".into())
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build()
        .into()
}

/** Windows's machine GUID, as `reg query` prints it. */
#[cfg(windows)]
fn machine_id() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
            "/reg:64",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("MachineGuid"))?;
    let mut words = line.split_whitespace();
    words.find(|w| *w == "REG_SZ")?;
    words.next().map(String::from)
}

#[cfg(not(windows))]
fn machine_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/**
 * This PC's fingerprint: Windows's machine GUID, hashed, exactly as the Electron app made it. It
 * stays the same across reboots and hardware changes, and changes only when Windows is
 * reinstalled, which counts as a move.
 */
pub fn machine_fingerprint(host: &str) -> String {
    let id = machine_id().unwrap_or_else(|| host.to_string());
    let digest = Sha256::digest(format!("manager-plus:{}", id.to_lowercase()));
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..32]
        .to_string()
}

/** The licence state in a JSON file in the app's data folder, written whole so a crash can't half-write it. */
pub struct FileStore(pub PathBuf);

impl LicenceStore for FileStore {
    fn read(&self) -> Option<LicenceState> {
        let text = std::fs::read_to_string(&self.0).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn write(&self, state: &LicenceState) {
        let tmp = self.0.with_extension("json.tmp");
        let text = serde_json::to_string(state).expect("the state serializes");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.0);
        }
    }
}

const REFUSALS: [&str; 4] = [
    "licence_key_invalid",
    "licence_moves_exhausted",
    "licence_revoked",
    "licence_rate_limited",
];

/** Our licence server over HTTPS. Its refusals come back as their codes; anything else means it couldn't be reached. */
pub struct HttpLicenceClient {
    pub server: String,
    pub app_version: String,
}

impl LicenceClient for HttpLicenceClient {
    fn activate(&self, key: &str, machine: &str) -> Result<LicenceFile, ActivationError> {
        let unreachable = |e: String| ActivationError::Unreachable(e);
        let mut response = agent(Duration::from_secs(30))
            .post(&format!("{}/v1/activate", self.server))
            .send_json(json!({ "key": key, "machine": machine, "appVersion": self.app_version }))
            .map_err(|e| unreachable(e.to_string()))?;
        let status = response.status().as_u16();
        if status >= 500 {
            return Err(unreachable(format!("Licence server error {status}")));
        }
        let body: Value = response.body_mut().read_json().unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            if let Ok(licence) = serde_json::from_value::<LicenceFile>(body["licence"].clone()) {
                return Ok(licence);
            }
        }
        let said = body["error"].as_str().unwrap_or_default();
        let code = REFUSALS
            .iter()
            .find(|c| **c == said)
            .copied()
            .unwrap_or("licence_key_invalid");
        let shown = if said.is_empty() {
            status.to_string()
        } else {
            said.to_string()
        };
        Err(ActivationError::Refused(BusinessError::new(
            code,
            format!("The licence server refused: {shown}"),
        )))
    }
}

fn update_unreachable(message: String) -> BusinessError {
    BusinessError::new("update_unreachable", message)
}

/** The newest release's signed manifest from our server, or None when there is none yet. */
pub fn fetch_manifest(server: &str) -> Result<Option<SignedManifest>, BusinessError> {
    let mut response = agent(Duration::from_secs(30))
        .get(&format!("{server}/v1/update"))
        .header("Cache-Control", "no-cache")
        .call()
        .map_err(|e| update_unreachable(format!("The update server could not be reached: {e}")))?;
    let status = response.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(update_unreachable(format!("Update server error {status}")));
    }
    response
        .body_mut()
        .read_json()
        .map(Some)
        .map_err(|e| update_unreachable(format!("The update server's answer is not readable: {e}")))
}

/** Downloads the installer the manifest names into `folder` and checks it is exactly that one before anything runs it. */
pub fn download_installer(
    manifest: &UpdateManifest,
    folder: &Path,
) -> Result<PathBuf, BusinessError> {
    let failed =
        |e: String| update_unreachable(format!("The installer could not be downloaded: {e}"));
    let mut response = agent(Duration::from_secs(15 * 60))
        .get(&manifest.url)
        .call()
        .map_err(|e| failed(e.to_string()))?;
    if !response.status().is_success() {
        return Err(failed(format!("HTTP {}", response.status().as_u16())));
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(manifest.size.saturating_add(1))
        .read_to_vec()
        .map_err(|e| failed(e.to_string()))?;
    verify_package(&bytes, manifest)?;
    let path = folder.join(format!("Manager-Plus-Setup-{}.exe", manifest.version));
    std::fs::write(&path, bytes).map_err(|e| failed(e.to_string()))?;
    Ok(path)
}

/** Starts the installer silently, on its own, and opens the app again when it's done (`/R`); the caller then quits. */
pub fn run_installer(path: &Path) -> Result<(), BusinessError> {
    std::process::Command::new(path)
        .args(["/S", "/R"])
        .spawn()
        .map(|_| ())
        .map_err(|e| BusinessError::new("unexpected", format!("The installer did not start: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fingerprint_is_32_hex_characters_and_stable() {
        let a = machine_fingerprint("shop-pc");
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(a, machine_fingerprint("shop-pc"));
    }

    #[test]
    fn the_file_store_round_trips_and_a_missing_file_is_none() {
        let dir = std::env::temp_dir().join(format!("mplus-licence-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = FileStore(dir.join("licence.json"));
        assert_eq!(store.read(), None);
        let state = LicenceState {
            trial_started_at: "2026-11-01T09:00:00.000Z".into(),
            last_seen_at: "2026-11-02T09:00:00.000Z".into(),
            licence: None,
        };
        store.write(&state);
        assert_eq!(store.read(), Some(state));
        let _ = std::fs::remove_dir_all(dir);
    }
}
