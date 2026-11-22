//! Update manifests and installers, as `updates.test.ts` checks them in the TypeScript core.

use base64::Engine;
use manager_core::updates::{
    check_update, is_newer, verify_manifest, verify_package, Notes, SignedManifest, UpdateCheck,
    UpdateManifest, UPDATE_PUBLIC_KEY,
};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const INSTALLER: &[u8] = b"MZ pretend installer bytes";

fn pkcs8() -> Vec<u8> {
    Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .unwrap()
        .as_ref()
        .to_vec()
}

fn pem(key: &Ed25519KeyPair) -> String {
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(key.public_key().as_ref());
    format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        B64.encode(spki)
    )
}

fn manifest() -> UpdateManifest {
    UpdateManifest {
        version: "1.2.0".into(),
        release_date: "2027-03-01".into(),
        url: "https://downloads.example/Manager-Plus-Setup-1.2.0.exe".into(),
        sha256: "4f3c0b2e1d6a3b8f5d7c9e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e".into(),
        size: INSTALLER.len() as u64,
        notes: Notes {
            ar: "تحسينات".into(),
            en: "Improvements".into(),
        },
    }
}

fn signed(m: &Value, key: &Ed25519KeyPair) -> SignedManifest {
    let data = serde_json::to_vec(m).unwrap();
    SignedManifest {
        manifest: B64.encode(&data),
        signature: B64.encode(key.sign(&data).as_ref()),
    }
}

fn with(changes: Value) -> Value {
    let mut m = serde_json::to_value(manifest()).unwrap();
    for (k, v) in changes.as_object().unwrap() {
        m[k] = v.clone();
    }
    m
}

#[test]
fn only_a_manifest_signed_with_our_key_and_well_formed_is_believed() {
    let key = Ed25519KeyPair::from_pkcs8(&pkcs8()).unwrap();
    let pem = pem(&key);
    let good = signed(&with(json!({})), &key);
    assert_eq!(verify_manifest(&good, &pem).unwrap(), manifest());
    let tampered = SignedManifest {
        manifest: B64.encode(
            serde_json::to_vec(&with(json!({ "url": "https://evil.example/x.exe" }))).unwrap(),
        ),
        ..good.clone()
    };
    let stranger = Ed25519KeyPair::from_pkcs8(&pkcs8()).unwrap();
    for bad in [
        tampered,
        signed(&with(json!({})), &stranger),
        SignedManifest {
            manifest: good.manifest.clone(),
            signature: String::new(),
        },
        signed(
            &with(json!({ "url": "http://downloads.example/x.exe" })),
            &key,
        ),
        signed(&with(json!({ "version": "1.2" })), &key),
        signed(&with(json!({ "sha256": "XYZ" })), &key),
        signed(&with(json!({ "size": 0 })), &key),
    ] {
        assert_eq!(
            verify_manifest(&bad, &pem).unwrap_err().code,
            "update_invalid"
        );
    }
}

#[test]
fn versions_compare_by_number() {
    assert!(is_newer("1.10.0", "1.9.9"));
    assert!(!is_newer("1.2.0", "1.2.0"));
    assert!(!is_newer("0.9.0", "1.0.0"));
}

#[test]
fn a_newer_version_is_offered_only_when_released_within_the_support_plan() {
    let key = Ed25519KeyPair::from_pkcs8(&pkcs8()).unwrap();
    let pem = pem(&key);
    let allowed = |release: &str| release <= "2027-02-28";
    let m = signed(&with(json!({})), &key);
    assert_eq!(
        check_update(&m, &pem, "1.2.0", allowed).unwrap(),
        UpdateCheck::None
    );
    assert_eq!(
        check_update(&m, &pem, "1.1.0", allowed).unwrap(),
        UpdateCheck::NotEligible {
            manifest: manifest()
        }
    );
    let earlier = signed(&with(json!({ "releaseDate": "2027-02-28" })), &key);
    assert!(matches!(
        check_update(&earlier, &pem, "1.1.0", allowed).unwrap(),
        UpdateCheck::Available { .. }
    ));
    assert_eq!(
        serde_json::to_value(UpdateCheck::NotEligible {
            manifest: manifest()
        })
        .unwrap()["kind"],
        "not_eligible"
    );
}

#[test]
fn the_downloaded_installer_must_be_exactly_the_one_the_manifest_names() {
    let digest: String = Sha256::digest(INSTALLER)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let real = UpdateManifest {
        sha256: digest,
        ..manifest()
    };
    assert!(verify_package(INSTALLER, &real).is_ok());
    let mut changed = INSTALLER.to_vec();
    changed[0] = 0;
    assert_eq!(
        verify_package(&changed, &real).unwrap_err().code,
        "update_invalid"
    );
    assert_eq!(
        verify_package(&INSTALLER[1..], &real).unwrap_err().code,
        "update_invalid"
    );
}

/** The release script signs with a key Node reads; the app must believe what it prints. */
#[test]
fn the_release_scripts_signed_manifest_is_one_the_app_believes() {
    let node = std::process::Command::new("node").arg("--version").output();
    if node.map(|o| !o.status.success()).unwrap_or(true) {
        eprintln!("node is not installed; skipped");
        return;
    }
    let der = pkcs8();
    let key = Ed25519KeyPair::from_pkcs8(&der).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let key_file = dir.path().join("release-key.pem");
    let lines: Vec<String> = B64
        .encode(&der)
        .as_bytes()
        .chunks(64)
        .map(|c| String::from_utf8(c.to_vec()).unwrap())
        .collect();
    std::fs::write(
        &key_file,
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        ),
    )
    .unwrap();
    let exe = dir.path().join("setup.exe");
    std::fs::write(&exe, INSTALLER).unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let out = std::process::Command::new("node")
        .current_dir(root)
        .arg("scripts/release.mjs")
        .arg("sign")
        .arg(&key_file)
        .arg(&exe)
        .args([
            "https://downloads.example/setup.exe",
            "2027-03-01",
            "تحسينات",
            "Improvements",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let signed: SignedManifest = serde_json::from_slice(&out.stdout).unwrap();
    let m = verify_manifest(&signed, &pem(&key)).unwrap();
    assert_eq!(m.release_date, "2027-03-01");
    assert_eq!(m.size, INSTALLER.len() as u64);
    assert_eq!(m.notes.ar, "تحسينات");
    assert_eq!(m.version, env!("CARGO_PKG_VERSION"));
    assert!(verify_package(INSTALLER, &m).is_ok());
}

#[test]
fn the_real_update_key_is_a_well_formed_ed25519_key() {
    let body: String = UPDATE_PUBLIC_KEY
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    assert_eq!(B64.decode(body).unwrap().len(), 44);
}
