//! Talking to the ETA from the PC that holds the file: its HTTPS APIs, the USB token through
//! Windows, sealing the API secrets with Windows DPAPI, and the background cycle that sends.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use manager_core::eta::cades::Signer;
use manager_core::eta::sender::{
    EtaClient, EtaReceiptClient, EtaSubmission, EtaVerdict, ReceiptSubmission,
};
use manager_core::{Business, BusinessError};
use serde_json::{json, Value};

/** The ETA's identity server and invoicing API, per environment. */
fn hosts(production: bool) -> (&'static str, &'static str) {
    if production {
        ("https://id.eta.gov.eg", "https://api.invoicing.eta.gov.eg")
    } else {
        (
            "https://id.preprod.eta.gov.eg",
            "https://api.preprod.invoicing.eta.gov.eg",
        )
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into()
}

/** The ETA's error as one line: its message, then each detail as "target: message". */
fn error_text(e: &Value) -> String {
    let mut parts: Vec<String> = vec![];
    if let Some(m) = e["message"].as_str().filter(|m| !m.is_empty()) {
        parts.push(m.into());
    }
    for d in e["details"].as_array().into_iter().flatten() {
        let bits: Vec<&str> = [d["target"].as_str(), d["message"].as_str()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect();
        if !bits.is_empty() {
            parts.push(bits.join(": "));
        }
    }
    if parts.is_empty() {
        "Rejected".into()
    } else {
        parts.join(" · ")
    }
}

/** The verdict in a document's or receipt's details. */
fn verdict(status: &str, body: &Value) -> EtaVerdict {
    match status.to_lowercase().as_str() {
        "valid" => EtaVerdict {
            status: "valid",
            error: None,
        },
        "cancelled" => EtaVerdict {
            status: "cancelled",
            error: None,
        },
        "invalid" | "rejected" => {
            let failed: Vec<String> = body["validationResults"]["validationSteps"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| {
                    s["status"]
                        .as_str()
                        .is_some_and(|x| x.eq_ignore_ascii_case("invalid"))
                })
                .map(|s| error_text(&s["error"]))
                .collect();
            let error = if failed.is_empty() {
                "Invalid".into()
            } else {
                failed.join(" · ")
            };
            EtaVerdict {
                status: "invalid",
                error: Some(error),
            }
        }
        _ => EtaVerdict {
            status: "submitted",
            error: None,
        },
    }
}

/** A bearer token from the identity server, kept until a minute before it runs out. */
struct Token {
    value: String,
    until: Instant,
}

struct Http {
    agent: ureq::Agent,
    api: &'static str,
    id: &'static str,
    form: Vec<(&'static str, String)>,
    headers: Vec<(&'static str, String)>,
    token: Mutex<Option<Token>>,
}

fn net(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Http {
    fn bearer(&self) -> Result<String, String> {
        let mut token = self.token.lock().unwrap();
        if let Some(t) = token.as_ref().filter(|t| t.until > Instant::now()) {
            return Ok(t.value.clone());
        }
        let mut request = self.agent.post(format!("{}/connect/token", self.id));
        for (k, v) in &self.headers {
            request = request.header(*k, v);
        }
        let form: Vec<(&str, &str)> = self.form.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let mut response = request.send_form(form).map_err(net)?;
        if !response.status().is_success() {
            return Err(format!(
                "ETA sign-in failed ({})",
                response.status().as_u16()
            ));
        }
        let body: Value = response.body_mut().read_json().map_err(net)?;
        let value = body["access_token"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let seconds = body["expires_in"]
            .as_u64()
            .unwrap_or(300)
            .saturating_sub(60);
        *token = Some(Token {
            value: value.clone(),
            until: Instant::now() + Duration::from_secs(seconds),
        });
        Ok(value)
    }

    /** Calls the API; a server error is "not reached", anything else comes back with its status. */
    fn api(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
        let url = format!("{}{path}", self.api);
        let auth = format!("Bearer {}", self.bearer()?);
        let response = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("Authorization", &auth).call(),
            ("PUT", Some(b)) => self
                .agent
                .put(&url)
                .header("Authorization", &auth)
                .send_json(b),
            (_, Some(b)) => self
                .agent
                .post(&url)
                .header("Authorization", &auth)
                .send_json(b),
            (_, None) => self
                .agent
                .post(&url)
                .header("Authorization", &auth)
                .send_empty(),
        };
        let mut response = response.map_err(net)?;
        let status = response.status().as_u16();
        if status >= 500 {
            return Err(format!("ETA error {status}"));
        }
        let body: Value = response.body_mut().read_json().unwrap_or(Value::Null);
        Ok((status, body))
    }
}

fn encode(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/** The ETA invoicing API over HTTPS, signing in with the business's client ID and secret. */
pub struct HttpEtaClient(Http);

impl HttpEtaClient {
    pub fn new(production: bool, client_id: &str, client_secret: &str) -> HttpEtaClient {
        let (id, api) = hosts(production);
        HttpEtaClient(Http {
            agent: agent(),
            api,
            id,
            form: vec![
                ("grant_type", "client_credentials".into()),
                ("client_id", client_id.into()),
                ("client_secret", client_secret.into()),
                ("scope", "InvoicingAPI".into()),
            ],
            headers: vec![],
            token: Mutex::new(None),
        })
    }
}

fn submission(status: u16, body: &Value, key: &str) -> Result<Vec<(String, String)>, String> {
    let _ = status;
    Ok(body[key]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            (
                d["internalId"].as_str().unwrap_or_default().to_string(),
                d["uuid"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect())
}

impl EtaClient for HttpEtaClient {
    fn submit(&self, documents: &[Value]) -> Result<EtaSubmission, String> {
        let (status, body) = self.0.api(
            "POST",
            "/api/v1/documentsubmissions",
            Some(&json!({ "documents": documents })),
        )?;
        if !(200..300).contains(&status) && body["rejectedDocuments"].is_null() {
            return Err(error_text(&body["error"]));
        }
        let accepted = submission(status, &body, "acceptedDocuments")?;
        let rejected = body["rejectedDocuments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                (
                    d["internalId"].as_str().unwrap_or_default().to_string(),
                    error_text(&d["error"]),
                )
            })
            .collect();
        Ok(EtaSubmission { accepted, rejected })
    }

    fn status(&self, uuid: &str) -> Result<EtaVerdict, String> {
        let (status, body) = self.0.api(
            "GET",
            &format!("/api/v1/documents/{}/details", encode(uuid)),
            None,
        )?;
        if !(200..300).contains(&status) {
            return Ok(EtaVerdict {
                status: "submitted",
                error: None,
            });
        }
        Ok(verdict(body["status"].as_str().unwrap_or_default(), &body))
    }

    fn cancel(&self, uuid: &str, reason: &str) -> Result<(), String> {
        let path = format!("/api/v1.0/documents/state/{}/state", encode(uuid));
        let (status, _) = self.0.api(
            "PUT",
            &path,
            Some(&json!({ "status": "cancelled", "reason": reason })),
        )?;
        if !(200..300).contains(&status) {
            return Err(format!("The ETA refused the cancellation ({status})"));
        }
        Ok(())
    }
}

/**
 * The ETA e-receipt API for the registered POS. It signs in as the POS, naming its serial, OS
 * and model and the pre-shared key the ETA gave it; receipts are not signed with the token.
 */
pub struct HttpEtaReceiptClient(Http);

impl HttpEtaReceiptClient {
    pub fn new(
        c: &manager_core::eta::receipts_store::EtaReceiptCredentials,
        secret: &str,
        key: &str,
    ) -> HttpEtaReceiptClient {
        let (id, api) = hosts(c.production);
        HttpEtaReceiptClient(Http {
            agent: agent(),
            api,
            id,
            form: vec![
                ("grant_type", "client_credentials".into()),
                ("client_id", c.pos_client_id.clone()),
                ("client_secret", secret.into()),
            ],
            headers: vec![
                ("posserial", c.pos_serial.clone()),
                ("pososversion", c.pos_os_version.clone()),
                ("posmodelframework", c.pos_model.clone()),
                ("presharedkey", key.into()),
            ],
            token: Mutex::new(None),
        })
    }
}

impl EtaReceiptClient for HttpEtaReceiptClient {
    fn submit_receipts(&self, receipts: &[Value]) -> Result<ReceiptSubmission, String> {
        let (status, body) = self.0.api(
            "POST",
            "/api/v1/receiptsubmissions",
            Some(&json!({ "receipts": receipts })),
        )?;
        if !(200..300).contains(&status) && body["rejectedDocuments"].is_null() {
            return Err(error_text(&body["error"]));
        }
        let accepted = submission(status, &body, "acceptedDocuments")?
            .into_iter()
            .map(|(_, uuid)| uuid)
            .collect();
        let rejected = body["rejectedDocuments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                (
                    d["uuid"].as_str().unwrap_or_default().to_string(),
                    error_text(&d["error"]),
                )
            })
            .collect();
        Ok(ReceiptSubmission { accepted, rejected })
    }

    fn receipt_status(&self, uuid: &str) -> Result<EtaVerdict, String> {
        let (status, body) = self.0.api(
            "GET",
            &format!("/api/v1/receipts/{}/details", encode(uuid)),
            None,
        )?;
        if !(200..300).contains(&status) {
            return Ok(EtaVerdict {
                status: "submitted",
                error: None,
            });
        }
        let v = verdict(
            body["receipt"]["status"].as_str().unwrap_or_default(),
            &body,
        );
        // Receipts are never cancelled through this API; anything else is still being checked.
        Ok(if v.status == "cancelled" {
            EtaVerdict {
                status: "submitted",
                error: None,
            }
        } else {
            v
        })
    }
}

/** Runs a PowerShell script on this Windows PC, with `input` on its standard input. */
fn powershell(script: &str, input: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(net)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).map_err(net)?;
    }
    let out = child.wait_with_output().map_err(net)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("PowerShell failed ({})", out.status)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/**
 * Signing certificates with a private key in the Windows certificate store. The USB token's
 * driver puts its certificate there while the token is plugged in.
 */
pub fn list_certificates() -> Value {
    if !cfg!(windows) {
        return json!([]);
    }
    let script = "@(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey } | ForEach-Object { [pscustomobject]@{ thumbprint = $_.Thumbprint; subject = $_.Subject; issuer = $_.Issuer; notAfter = $_.NotAfter.ToString('yyyy-MM-dd') } }) | ConvertTo-Json -Compress";
    match powershell(script, "")
        .ok()
        .filter(|o| !o.is_empty())
        .and_then(|o| serde_json::from_str::<Value>(&o).ok())
    {
        Some(Value::Array(list)) => Value::Array(list),
        Some(one @ Value::Object(_)) => json!([one]),
        _ => json!([]),
    }
}

/**
 * Signs with the token's private key through Windows, which asks the token's driver; the driver
 * shows its own PIN prompt. Only the SHA-256 RSA signature is asked of the token.
 */
pub struct WindowsTokenSigner {
    thumbprint: String,
}

impl WindowsTokenSigner {
    pub fn new(thumbprint: &str) -> Result<WindowsTokenSigner, String> {
        if !(thumbprint.len() == 40 && thumbprint.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err("The certificate thumbprint is not valid".into());
        }
        Ok(WindowsTokenSigner {
            thumbprint: thumbprint.into(),
        })
    }

    fn item(&self) -> String {
        format!("Get-Item \"Cert:\\CurrentUser\\My\\{}\"", self.thumbprint)
    }
}

impl Signer for WindowsTokenSigner {
    fn certificate(&self) -> Result<Vec<u8>, String> {
        let out = powershell(
            &format!("[Convert]::ToBase64String(({}).RawData)", self.item()),
            "",
        )?;
        base64::decode(&out)
    }

    fn sign(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        let script = format!(
            "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());
             $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey(({}));
             [Convert]::ToBase64String($key.SignData($bytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1))",
            self.item()
        );
        base64::decode(&powershell(&script, &base64::encode(data))?)
    }
}

mod base64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    pub fn decode(text: &str) -> Result<Vec<u8>, String> {
        let mut bits = 0u32;
        let mut count = 0;
        let mut out = vec![];
        for c in text
            .bytes()
            .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        {
            let v = ALPHABET.iter().position(|a| *a == c).ok_or("Not base64")? as u32;
            bits = (bits << 6) | v;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
            }
        }
        Ok(out)
    }

    #[cfg(test)]
    #[test]
    fn round_trips() {
        for text in ["", "a", "ab", "abc", "abcd", "سر"] {
            assert_eq!(decode(&encode(text.as_bytes())).unwrap(), text.as_bytes());
        }
        assert_eq!(encode(b"Man"), "TWFu");
        assert_eq!(encode(b"Ma"), "TWE=");
    }
}

/**
 * Seals a secret for this Windows user with DPAPI, as base64; only this user on this PC can
 * unseal it. Not available off Windows.
 */
pub fn seal(secret: &str) -> Result<String, String> {
    dpapi::protect(secret.as_bytes()).map(|b| base64::encode(&b))
}

pub fn unseal(sealed: &str) -> Result<String, String> {
    let bytes = dpapi::unprotect(&base64::decode(sealed)?)?;
    String::from_utf8(bytes).map_err(net)
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn run(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: the input blob points at `data` for the call; the output is allocated by Windows and freed below.
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            return Err("This PC could not seal or unseal the secret".into());
        }
        // SAFETY: Windows returned `cbData` bytes at `pbData`, which we copy and then free.
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Ok(bytes)
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        run(data, true)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        run(data, false)
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("This PC can't seal the secret".into())
    }

    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("This PC can't unseal the secret".into())
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/**
 * Asks the ETA about submitted documents and e-receipts, then sends the pending ones: invoices
 * signed with the token, receipts in the till's order. Runs after each posting and every few
 * minutes, one at a time; posting never waits on it. Invoices failing don't hold receipts back.
 */
pub fn cycle(file: &Business) -> Result<usize, BusinessError> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let result = run_cycle(file);
    RUNNING.store(false, Ordering::SeqCst);
    result
}

fn unreachable(e: String) -> BusinessError {
    BusinessError::new("eta_unreachable", e)
}

fn run_cycle(file: &Business) -> Result<usize, BusinessError> {
    let mut sent = 0;
    let mut failed: Option<BusinessError> = None;
    if let Ok(c) = file.eta_credentials() {
        let invoices = (|| {
            let secret = unseal(&c.client_secret).map_err(unreachable)?;
            let client = HttpEtaClient::new(c.environment == "production", &c.client_id, &secret);
            let signer = WindowsTokenSigner::new(&c.certificate).map_err(unreachable)?;
            file.refresh_eta_statuses(&client)?;
            file.send_pending_eta(&signer, &client, chrono::Utc::now())
        })();
        match invoices {
            Ok(n) => sent += n,
            Err(e) => failed = Some(e),
        }
    }
    if let Ok(c) = file.eta_receipt_credentials() {
        let receipts = (|| {
            let secret = unseal(&c.pos_client_secret).map_err(unreachable)?;
            let key = unseal(&c.preshared_key).map_err(unreachable)?;
            let client = HttpEtaReceiptClient::new(&c, &secret, &key);
            file.refresh_eta_receipt_statuses(&client)?;
            file.send_eta_receipts(&client)
        })();
        match receipts {
            Ok(n) => sent += n,
            Err(e) => failed = failed.or(Some(e)),
        }
    }
    match failed {
        Some(e) => Err(e),
        None => Ok(sent),
    }
}

/** Cancels an accepted document with the ETA. */
pub fn cancel(
    file: &Business,
    kind: &str,
    document_id: i64,
    reason: &str,
) -> Result<(), BusinessError> {
    let c = file.eta_credentials()?;
    let secret = unseal(&c.client_secret).map_err(unreachable)?;
    let client = HttpEtaClient::new(c.environment == "production", &c.client_id, &secret);
    file.cancel_eta(&client, kind, document_id, reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_etas_errors_read_as_one_line() {
        let e = json!({ "message": "Validation error", "details": [{ "target": "receiver.id", "message": "Not registered" }, { "message": "Totals" }] });
        assert_eq!(
            error_text(&e),
            "Validation error · receiver.id: Not registered · Totals"
        );
        assert_eq!(error_text(&Value::Null), "Rejected");
    }

    #[test]
    fn an_invalid_documents_failed_steps_are_its_error() {
        let body = json!({ "validationResults": { "validationSteps": [
            { "status": "Valid" }, { "status": "Invalid", "error": { "message": "Total amount mismatch" } }
        ] } });
        assert_eq!(
            verdict("Invalid", &body),
            EtaVerdict {
                status: "invalid",
                error: Some("Total amount mismatch".into())
            }
        );
        assert_eq!(verdict("Valid", &body).status, "valid");
        assert_eq!(verdict("Submitted", &body).status, "submitted");
    }

    #[test]
    fn a_uuid_is_escaped_in_a_path() {
        assert_eq!(encode("ab/c d"), "ab%2Fc%20d");
    }
}
