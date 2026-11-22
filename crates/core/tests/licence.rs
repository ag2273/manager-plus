//! The trial and the licence file, as `licence.test.ts` checks them in the TypeScript core.

use std::sync::{Arc, Mutex};

use base64::Engine;
use chrono::{DateTime, TimeZone, Utc};
use manager_core::business::LicenceLimits;
use manager_core::licence::{
    ActivationError, LicenceClient, LicenceFile, LicenceState, LicenceStatus, LicenceStore,
    Licensing, LICENCE_PUBLIC_KEY,
};
use manager_core::BusinessError;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};

const MACHINE: &str = "machine-a";
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn new_pkcs8() -> Vec<u8> {
    Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .unwrap()
        .as_ref()
        .to_vec()
}

fn key_pair() -> Ed25519KeyPair {
    Ed25519KeyPair::from_pkcs8(&new_pkcs8()).unwrap()
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

struct Keys {
    pkcs8: Vec<u8>,
    ours: Ed25519KeyPair,
    pem: String,
}

impl Keys {
    /** Our signing key again, for a fake server that owns its copy. */
    fn copy(&self) -> Ed25519KeyPair {
        Ed25519KeyPair::from_pkcs8(&self.pkcs8).unwrap()
    }
}

fn keys() -> Keys {
    let pkcs8 = new_pkcs8();
    let ours = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap();
    let pem = pem(&ours);
    Keys { pkcs8, ours, pem }
}

fn day(n: i64, hours: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 1, 9, 0, 0).unwrap()
        + chrono::Duration::days(n)
        + chrono::Duration::hours(hours)
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn payload(changes: Value) -> Value {
    let mut p = json!({
        "licenceId": "L-1",
        "company": "شركة النور للكمبيوتر",
        "machine": MACHINE,
        "users": 3,
        "supportUntil": "2027-11-30",
        "issuedAt": "2026-11-20T10:00:00Z",
    });
    for (k, v) in changes.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

fn signed_with(changes: Value, key: &Ed25519KeyPair) -> LicenceFile {
    let data = serde_json::to_vec(&payload(changes)).unwrap();
    LicenceFile {
        payload: B64.encode(&data),
        signature: B64.encode(key.sign(&data).as_ref()),
    }
}

#[derive(Clone, Default)]
struct MemoryStore(Arc<Mutex<Option<LicenceState>>>);

impl LicenceStore for MemoryStore {
    fn read(&self) -> Option<LicenceState> {
        self.0.lock().unwrap().clone()
    }
    fn write(&self, state: &LicenceState) {
        *self.0.lock().unwrap() = Some(state.clone());
    }
}

type Calls = Arc<Mutex<Vec<(String, String)>>>;
type Answer = Box<dyn Fn(&str, &str) -> Result<LicenceFile, ActivationError> + Send + Sync>;

/** A licence server that can be told what to answer, and remembers what it was asked. */
struct FakeServer {
    answer: Answer,
    calls: Calls,
}

impl LicenceClient for FakeServer {
    fn activate(&self, key: &str, machine: &str) -> Result<LicenceFile, ActivationError> {
        self.calls
            .lock()
            .unwrap()
            .push((key.to_string(), machine.to_string()));
        (self.answer)(key, machine)
    }
}

fn server(answer: Answer) -> (FakeServer, Calls) {
    let calls = Arc::new(Mutex::new(vec![]));
    (
        FakeServer {
            answer,
            calls: calls.clone(),
        },
        calls,
    )
}

/** A server that signs a licence for whichever PC asks, with `key`. */
fn issuing(key: Ed25519KeyPair) -> Answer {
    Box::new(move |_, machine| Ok(signed_with(json!({ "machine": machine }), &key)))
}

fn licensing(
    keys: &Keys,
    client: FakeServer,
    state: Option<LicenceState>,
) -> (Licensing, MemoryStore) {
    let store = MemoryStore(Arc::new(Mutex::new(state)));
    let l = Licensing {
        store: Box::new(store.clone()),
        client: Box::new(client),
        public_key_pem: keys.pem.clone(),
        machine: MACHINE.into(),
    };
    (l, store)
}

fn offline() -> FakeServer {
    server(Box::new(|_, _| {
        Err(ActivationError::Unreachable("offline".into()))
    }))
    .0
}

fn days_left(status: LicenceStatus) -> i64 {
    match status {
        LicenceStatus::Trial { days_left, .. } => days_left,
        other => panic!("expected the trial, got {other:?}"),
    }
}

fn read_only(reason: &'static str) -> LicenceStatus {
    LicenceStatus::ReadOnly { reason }
}

#[test]
fn the_trial_starts_with_the_first_file_and_lasts_14_days_then_the_books_are_read_only() {
    let keys = keys();
    let (l, _) = licensing(&keys, offline(), None);
    assert_eq!(days_left(l.status(day(0, 0))), 14);
    l.note_file(day(0, 0), day(0, 0));
    assert_eq!(days_left(l.status(day(1, 0))), 13);
    assert_eq!(days_left(l.status(day(13, 23))), 1);
    assert_eq!(l.status(day(14, 0)), read_only("trial_over"));
    assert_eq!(
        l.limits(day(14, 0)),
        LicenceLimits {
            read_only: Some("trial_over".into()),
            users: None
        }
    );
}

#[test]
fn opening_an_older_file_moves_the_start_back_so_a_fresh_install_gives_no_new_trial() {
    let keys = keys();
    let (l, _) = licensing(&keys, offline(), None);
    l.note_file(day(20, 0), day(20, 0));
    l.note_file(day(0, 0), day(20, 0));
    assert_eq!(l.status(day(20, 0)), read_only("trial_over"));
}

#[test]
fn turning_the_clock_back_is_noticed_but_a_summer_time_change_is_not() {
    let keys = keys();
    let (l, _) = licensing(&keys, offline(), None);
    l.note_file(day(0, 0), day(0, 0));
    assert!(matches!(l.status(day(10, 0)), LicenceStatus::Trial { .. }));
    assert!(matches!(l.status(day(9, 23)), LicenceStatus::Trial { .. }));
    assert_eq!(l.status(day(5, 0)), read_only("clock_back"));
    // Put right, the trial carries on where it was.
    assert_eq!(days_left(l.status(day(10, 1))), 4);
}

#[test]
fn the_state_file_keeps_the_electron_apps_format() {
    let keys = keys();
    let (l, store) = licensing(&keys, offline(), None);
    l.note_file(day(0, 0), day(0, 0));
    assert_eq!(
        serde_json::to_value(store.read()).unwrap(),
        json!({ "trialStartedAt": "2026-11-01T09:00:00.000Z", "lastSeenAt": "2026-11-01T09:00:00.000Z", "licence": null })
    );
    assert_eq!(
        serde_json::to_value(l.status(day(1, 0))).unwrap(),
        json!({ "mode": "trial", "trialEndsAt": "2026-11-15T09:00:00.000Z", "daysLeft": 13 })
    );
    assert_eq!(
        serde_json::to_value(read_only("trial_over")).unwrap(),
        json!({ "mode": "read_only", "reason": "trial_over" })
    );
}

#[test]
fn activating_keeps_the_signed_licence_and_it_is_checked_offline_at_every_start() {
    let keys = keys();
    let (client, calls) = server(issuing(keys.copy()));
    let (l, store) = licensing(&keys, client, None);
    l.note_file(day(0, 0), day(0, 0));
    let status = l.activate("  abcd-efgh ", day(20, 0)).unwrap();
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "mode": "licensed", "company": "شركة النور للكمبيوتر", "users": 3, "supportUntil": "2027-11-30" })
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec![("ABCD-EFGH".to_string(), MACHINE.to_string())]
    );
    // A later start, with the clock anywhere, reads the same licence from the saved file alone.
    let (again, _) = licensing(&keys, offline(), store.read());
    assert!(matches!(
        again.status(day(400, 0)),
        LicenceStatus::Licensed { .. }
    ));
    assert_eq!(
        again.limits(day(400, 0)),
        LicenceLimits {
            read_only: None,
            users: Some(3)
        }
    );
}

#[test]
fn a_tampered_file_one_signed_with_another_key_or_one_for_another_pc_opens_read_only() {
    let keys = keys();
    let state = |licence: LicenceFile| LicenceState {
        trial_started_at: iso(day(0, 0)),
        last_seen_at: iso(day(0, 0)),
        licence: Some(licence),
    };
    let status = |licence: LicenceFile| {
        licensing(&keys, offline(), Some(state(licence)))
            .0
            .status(day(1, 0))
    };

    let good = signed_with(json!({}), &keys.ours);
    assert!(matches!(
        status(good.clone()),
        LicenceStatus::Licensed { .. }
    ));
    let raised = B64.encode(serde_json::to_vec(&payload(json!({ "users": 50 }))).unwrap());
    assert_eq!(
        status(LicenceFile {
            payload: raised,
            ..good.clone()
        }),
        read_only("licence_invalid")
    );
    assert_eq!(
        status(signed_with(json!({}), &key_pair())),
        read_only("licence_invalid")
    );
    assert_eq!(
        status(LicenceFile {
            payload: "not base64 json".into(),
            signature: String::new()
        }),
        read_only("licence_invalid")
    );
    assert_eq!(
        status(signed_with(json!({ "machine": "machine-b" }), &keys.ours)),
        read_only("licence_other_machine")
    );
}

#[test]
fn refusals_come_through_a_network_failure_says_unreachable_and_a_bad_answer_is_not_kept() {
    let keys = keys();
    let (refusing, _) = server(Box::new(|_, _| {
        Err(ActivationError::Refused(BusinessError::new(
            "licence_moves_exhausted",
            "no moves",
        )))
    }));
    let (l, _) = licensing(&keys, refusing, None);
    assert_eq!(
        l.activate("KEY", day(0, 0)).unwrap_err().code,
        "licence_moves_exhausted"
    );

    let (down, _) = licensing(&keys, offline(), None);
    assert_eq!(
        down.activate("KEY", day(0, 0)).unwrap_err().code,
        "licence_unreachable"
    );
    assert_eq!(
        down.activate(" ", day(0, 0)).unwrap_err().code,
        "licence_key_invalid"
    );

    let (forging, _) = server(issuing(key_pair()));
    let (forged, store) = licensing(&keys, forging, None);
    assert_eq!(
        forged.activate("KEY", day(0, 0)).unwrap_err().code,
        "licence_invalid"
    );
    assert_eq!(store.read(), None);
}

#[test]
fn updates_install_only_when_released_within_the_support_plan_and_read_only_installs_none() {
    let keys = keys();
    let (l, _) = licensing(&keys, offline(), None);
    l.note_file(day(0, 0), day(0, 0));
    assert!(l.update_allowed("2030-01-01", day(1, 0)));
    let licensed = LicenceState {
        trial_started_at: iso(day(0, 0)),
        last_seen_at: iso(day(2, 0)),
        licence: Some(signed_with(json!({}), &keys.ours)),
    };
    let (l, _) = licensing(&keys, offline(), Some(licensed));
    assert!(l.update_allowed("2027-11-30", day(3, 0)));
    assert!(!l.update_allowed("2027-12-01", day(3, 0)));
    let (expired, _) = licensing(&keys, offline(), None);
    expired.note_file(day(0, 0), day(0, 0));
    assert!(!expired.update_allowed("2026-11-01", day(30, 0)));
}

#[test]
fn the_real_licence_key_is_a_well_formed_ed25519_key() {
    let body: String = LICENCE_PUBLIC_KEY
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    assert_eq!(B64.decode(body).unwrap().len(), 44);
}
