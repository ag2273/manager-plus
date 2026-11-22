//! The server's identity: a self-signed certificate made on first start and kept, so clients that
//! pinned its fingerprint keep trusting it across restarts.

use std::fs;
use std::path::Path;

use chrono::Datelike;
use manager_core::{BusinessError, Result};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use sha2::{Digest, Sha256};

/** The server's key and certificate as PEM, and the certificate's fingerprint. */
#[derive(Clone)]
pub struct Identity {
    pub key: String,
    pub cert: String,
    pub fingerprint: String,
}

fn internal(e: impl std::fmt::Display) -> BusinessError {
    BusinessError::new("unexpected", e.to_string())
}

/** A certificate's SHA-256 fingerprint as "AB:CD:…", the form the Electron app pinned. */
pub fn fingerprint_of_der(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

pub fn fingerprint_of(cert_pem: &str) -> Result<String> {
    let der = CertificateDer::from_pem_slice(cert_pem.as_bytes()).map_err(internal)?;
    Ok(fingerprint_of_der(&der))
}

/** A short form of a fingerprint for people to compare by eye: the first 8 bytes. */
pub fn short_fingerprint(fingerprint: &str) -> String {
    fingerprint.split(':').take(8).collect::<Vec<_>>().join(":")
}

/** This PC's server certificate, made on first use (P-256, ten years) and kept in `dir`. */
pub fn load_or_create(dir: &Path, host: &str) -> Result<Identity> {
    let key_path = dir.join("server-key.pem");
    let cert_path = dir.join("server-cert.pem");
    if key_path.exists() && cert_path.exists() {
        let cert = fs::read_to_string(&cert_path).map_err(internal)?;
        let key = fs::read_to_string(&key_path).map_err(internal)?;
        let fingerprint = fingerprint_of(&cert)?;
        return Ok(Identity {
            key,
            cert,
            fingerprint,
        });
    }
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(internal)?;
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).map_err(internal)?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, format!("Manager+ {host}"));
    let today = chrono::Utc::now().date_naive();
    let (y, m, d) = (today.year(), today.month() as u8, today.day() as u8);
    params.not_before = rcgen::date_time_ymd(y, m, d.min(28));
    params.not_after = rcgen::date_time_ymd(y + 10, m, d.min(28));
    let cert = params.self_signed(&key).map_err(internal)?;
    fs::create_dir_all(dir).map_err(internal)?;
    let identity = Identity {
        key: key.serialize_pem(),
        cert: cert.pem(),
        fingerprint: fingerprint_of_der(cert.der()),
    };
    write_private(&key_path, &identity.key)?;
    fs::write(&cert_path, &identity.cert).map_err(internal)?;
    Ok(identity)
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(internal)?;
        f.write_all(text.as_bytes()).map_err(internal)
    }
    #[cfg(not(unix))]
    {
        fs::write(path, text).map_err(internal)
    }
}
