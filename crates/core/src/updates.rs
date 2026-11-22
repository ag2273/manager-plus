//! App updates: a manifest our release script signs, checked against our update key before
//! anything downloads, and the installer checked against the manifest before anything runs it.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::licence::{ed25519_verifies, is_day};
use crate::{BusinessError, Result};

/**
 * Our release-signing Ed25519 public key; the app installs only updates whose manifest is signed
 * with its private key, which is never in the repo or on a server.
 *
 * Made on 2026-11-22 by the "Release signing key" workflow, whose private key went straight into
 * the GitHub repo secret RELEASE_PRIVATE_KEY. Making a new pair stops every installed copy from
 * accepting updates.
 */
pub const UPDATE_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkcVRIII4iFJ1GO3znA2R0ETrJDg1cuFwKc/dNO03PqI=
-----END PUBLIC KEY-----
";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notes {
    pub ar: String,
    pub en: String,
}

/** One release, as our release script writes it and signs it. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub version: String,
    /** YYYY-MM-DD: an update installs only on a licence whose support runs to this date or later. */
    pub release_date: String,
    /** The installer, over HTTPS. */
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub notes: Notes,
}

/** The manifest's JSON in base64 and its Ed25519 signature, as the update server hands it out. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedManifest {
    pub manifest: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheck {
    None,
    Available {
        manifest: UpdateManifest,
    },
    /** A newer version exists but was released after the support plan ended; the installed one keeps working. */
    NotEligible {
        manifest: UpdateManifest,
    },
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn invalid() -> BusinessError {
    BusinessError::new("update_invalid", "The update manifest is not signed by us")
}

/** The manifest, once its signature checks out against our update key and its fields make sense. */
pub fn verify_manifest(signed: &SignedManifest, public_key_pem: &str) -> Result<UpdateManifest> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(&signed.manifest)
        .map_err(|_| invalid())?;
    if !ed25519_verifies(public_key_pem, &data, &signed.signature) {
        return Err(invalid());
    }
    let m: UpdateManifest = serde_json::from_slice(&data).map_err(|_| invalid())?;
    let hex = m.sha256.len() == 64
        && m.sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_version(&m.version)
        || !is_day(&m.release_date)
        || !m.url.starts_with("https://")
        || !hex
        || m.size == 0
    {
        return Err(invalid());
    }
    Ok(m)
}

/** Whether version a is newer than b (major.minor.patch). */
pub fn is_newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..3 {
        let (x, y) = (
            pa.get(i).copied().unwrap_or(0),
            pb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/** What to tell the owner about a signed manifest, given the installed version and the licence. */
pub fn check_update(
    signed: &SignedManifest,
    public_key_pem: &str,
    current_version: &str,
    allowed: impl Fn(&str) -> bool,
) -> Result<UpdateCheck> {
    let manifest = verify_manifest(signed, public_key_pem)?;
    if !is_newer(&manifest.version, current_version) {
        return Ok(UpdateCheck::None);
    }
    Ok(if allowed(&manifest.release_date) {
        UpdateCheck::Available { manifest }
    } else {
        UpdateCheck::NotEligible { manifest }
    })
}

/** Checks a downloaded installer is exactly the one the signed manifest names. */
pub fn verify_package(bytes: &[u8], manifest: &UpdateManifest) -> Result<()> {
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if bytes.len() as u64 != manifest.size || digest != manifest.sha256 {
        return Err(BusinessError::new(
            "update_invalid",
            "The downloaded installer doesn't match the signed manifest",
        ));
    }
    Ok(())
}
