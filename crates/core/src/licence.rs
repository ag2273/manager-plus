//! This PC's licence: a 14-day trial from the first business file, then a licence file signed by
//! our licence server, checked offline at every start. Without one the books open read-only.
//! The formats are the ones the Electron app wrote, so licences already issued keep working.

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::business::LicenceLimits;
use crate::{BusinessError, Result};

pub const TRIAL_DAYS: i64 = 14;
/** How far the clock may go back (a time-zone or summer-time fix) before it counts as turned back. */
const CLOCK_SLACK_MS: i64 = 26 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/**
 * The licence server's Ed25519 public key; licence files signed with its private key are the only
 * ones this app accepts. The private key lives only as a secret on the licence server, never here.
 *
 * Made on 2026-11-22 by the "Licence signing key" workflow, whose private key went straight into
 * the Worker at licence.nileorbit.com. Making a new pair breaks every licence issued before it.
 */
pub const LICENCE_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK0TsNNeLA7Kcrh/EcR/WGUVFyubRO97VXBjEd8t1cQY=
-----END PUBLIC KEY-----
";

/** What the licence server signs: one company, one server PC, a number of users and a support plan. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicencePayload {
    #[serde(default)]
    pub licence_id: String,
    #[serde(default)]
    pub company: String,
    /** The server PC's fingerprint. */
    pub machine: String,
    pub users: i64,
    /** The last day of the support plan (YYYY-MM-DD): updates released after it don't install. */
    pub support_until: String,
    #[serde(default)]
    pub issued_at: String,
}

/** The licence file as the server returns it and the PC keeps it: the payload's JSON in base64 and its Ed25519 signature. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenceFile {
    pub payload: String,
    pub signature: String,
}

/** What this PC keeps: when the trial started, the latest time it saw, and the licence once activated. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenceState {
    pub trial_started_at: String,
    pub last_seen_at: String,
    pub licence: Option<LicenceFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum LicenceStatus {
    #[serde(rename_all = "camelCase")]
    Trial {
        trial_ends_at: String,
        days_left: i64,
    },
    #[serde(rename_all = "camelCase")]
    Licensed {
        company: String,
        users: i64,
        support_until: String,
    },
    ReadOnly {
        reason: &'static str,
    },
}

/** Why the licence server did not hand over a licence. */
#[derive(Debug, Clone)]
pub enum ActivationError {
    /** The server answered no, with one of its codes. */
    Refused(BusinessError),
    /** The server could not be reached, or failed. */
    Unreachable(String),
}

/** The licence server, injected so tests use a fake. */
pub trait LicenceClient: Send + Sync {
    /** Activates a key on this PC; a key already on another PC moves here if the licence has a move left. */
    fn activate(
        &self,
        key: &str,
        machine: &str,
    ) -> std::result::Result<LicenceFile, ActivationError>;
}

/** Where this PC keeps its licence state. */
pub trait LicenceStore: Send + Sync {
    fn read(&self) -> Option<LicenceState>;
    fn write(&self, state: &LicenceState);
}

/** Whether `signature` (base64) is `data` signed by the Ed25519 key in `public_key_pem` (SPKI). */
pub(crate) fn ed25519_verifies(public_key_pem: &str, data: &[u8], signature: &str) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    let body: String = public_key_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let (Ok(spki), Ok(signature)) = (b64.decode(body.trim()), b64.decode(signature)) else {
        return false;
    };
    // An Ed25519 SPKI is a fixed 12-byte header and the 32-byte key.
    if spki.len() != 44 {
        return false;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &spki[12..])
        .verify(data, &signature)
        .is_ok()
}

pub(crate) fn is_day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/** The licence's payload, once its signature checks out against our public key and it is for this PC. */
pub fn verify_licence(
    file: &LicenceFile,
    public_key_pem: &str,
    machine: &str,
) -> Result<LicencePayload> {
    let invalid = || BusinessError::new("licence_invalid", "The licence file is not valid");
    let data = base64::engine::general_purpose::STANDARD
        .decode(&file.payload)
        .map_err(|_| invalid())?;
    if !ed25519_verifies(public_key_pem, &data, &file.signature) {
        return Err(invalid());
    }
    let payload: LicencePayload = serde_json::from_slice(&data).map_err(|_| invalid())?;
    if payload.users < 1 || !is_day(&payload.support_until) {
        return Err(invalid());
    }
    if payload.machine != machine {
        return Err(BusinessError::new(
            "licence_other_machine",
            "The licence is for another PC",
        ));
    }
    Ok(payload)
}

fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn ms(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| d.timestamp_millis())
}

pub struct Licensing {
    pub store: Box<dyn LicenceStore>,
    pub client: Box<dyn LicenceClient>,
    pub public_key_pem: String,
    pub machine: String,
}

impl Licensing {
    /**
     * Notes that a business file is open, and since when it has records: the trial starts with the
     * first one, and a file older than the trial's start moves the start back, so deleting the
     * licence state doesn't start a new trial.
     */
    pub fn note_file(&self, file_started_at: DateTime<Utc>, now: DateTime<Utc>) {
        let state = self.store.read();
        let mut start = file_started_at
            .timestamp_millis()
            .min(now.timestamp_millis());
        if let Some(saved) = state.as_ref().and_then(|s| ms(&s.trial_started_at)) {
            start = start.min(saved);
        }
        self.store.write(&LicenceState {
            trial_started_at: iso(start),
            last_seen_at: state
                .as_ref()
                .map(|s| s.last_seen_at.clone())
                .unwrap_or_else(|| iso(now.timestamp_millis())),
            licence: state.and_then(|s| s.licence),
        });
    }

    /** The licence's state now. Moves the latest seen time forward, so turning the clock back is noticed. */
    pub fn status(&self, now: DateTime<Utc>) -> LicenceStatus {
        let now = now.timestamp_millis();
        let state = self.store.read();
        if let Some(licence) = state.as_ref().and_then(|s| s.licence.as_ref()) {
            return match verify_licence(licence, &self.public_key_pem, &self.machine) {
                Ok(l) => LicenceStatus::Licensed {
                    company: l.company,
                    users: l.users,
                    support_until: l.support_until,
                },
                Err(e) => LicenceStatus::ReadOnly {
                    reason: if e.code == "licence_other_machine" {
                        "licence_other_machine"
                    } else {
                        "licence_invalid"
                    },
                },
            };
        }
        // No business file yet: the trial hasn't started.
        let Some(state) = state else {
            return LicenceStatus::Trial {
                trial_ends_at: iso(now + TRIAL_DAYS * DAY_MS),
                days_left: TRIAL_DAYS,
            };
        };
        match ms(&state.last_seen_at) {
            Some(last) if now < last - CLOCK_SLACK_MS => {
                return LicenceStatus::ReadOnly {
                    reason: "clock_back",
                }
            }
            Some(last) if now <= last => {}
            _ => self.store.write(&LicenceState {
                last_seen_at: iso(now),
                ..state.clone()
            }),
        }
        let Some(ends) = ms(&state.trial_started_at).map(|s| s + TRIAL_DAYS * DAY_MS) else {
            return LicenceStatus::ReadOnly {
                reason: "trial_over",
            };
        };
        if now >= ends {
            return LicenceStatus::ReadOnly {
                reason: "trial_over",
            };
        }
        LicenceStatus::Trial {
            trial_ends_at: iso(ends),
            days_left: (ends - now + DAY_MS - 1) / DAY_MS,
        }
    }

    /** What the books enforce now. */
    pub fn limits(&self, now: DateTime<Utc>) -> LicenceLimits {
        match self.status(now) {
            LicenceStatus::ReadOnly { reason } => LicenceLimits {
                read_only: Some(reason.to_string()),
                users: None,
            },
            LicenceStatus::Licensed { users, .. } => LicenceLimits {
                read_only: None,
                users: Some(users),
            },
            LicenceStatus::Trial { .. } => LicenceLimits::default(),
        }
    }

    /** Activates a key on this PC and keeps the signed licence the server returns, once it checks out. */
    pub fn activate(&self, key: &str, now: DateTime<Utc>) -> Result<LicenceStatus> {
        let clean = key.trim().to_uppercase();
        if clean.is_empty() {
            return Err(BusinessError::new(
                "licence_key_invalid",
                "Type the licence key",
            ));
        }
        let file = self
            .client
            .activate(&clean, &self.machine)
            .map_err(|e| match e {
                ActivationError::Refused(e) => e,
                ActivationError::Unreachable(why) => BusinessError::new(
                    "licence_unreachable",
                    format!("The licence server could not be reached: {why}"),
                ),
            })?;
        verify_licence(&file, &self.public_key_pem, &self.machine)?;
        let now_iso = iso(now.timestamp_millis());
        let state = self.store.read();
        self.store.write(&LicenceState {
            trial_started_at: state
                .map(|s| s.trial_started_at)
                .unwrap_or_else(|| now_iso.clone()),
            last_seen_at: now_iso,
            licence: Some(file),
        });
        Ok(self.status(now))
    }

    /**
     * Whether an update released on `release_date` (YYYY-MM-DD) may install: licensed, only if released
     * within the support plan; during the trial, yes; read-only, no. The version installed keeps working either way.
     */
    pub fn update_allowed(&self, release_date: &str, now: DateTime<Utc>) -> bool {
        match self.status(now) {
            LicenceStatus::Licensed { support_until, .. } => release_date <= support_until.as_str(),
            LicenceStatus::Trial { .. } => true,
            LicenceStatus::ReadOnly { .. } => false,
        }
    }
}
