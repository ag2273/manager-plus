//! Server mode end to end: a real TLS server on a free local port, and clients calling the facade through it.

use manager_core::users::Credentials;
use manager_core::{Business, BusinessError, BusinessSettings, LicenceLimits};
use manager_lan::certificate::{self, Identity};
use manager_lan::{server, RemoteBusiness, RunningServer};
use serde_json::json;

const HOST: &str = "127.0.0.1";

fn manager() -> (&'static str, &'static str) {
    ("أيمن", "كلمة سر قوية")
}
fn cashier() -> (&'static str, &'static str) {
    ("سارة", "كلمة سر الكاشير")
}

fn code<T>(result: Result<T, BusinessError>) -> &'static str {
    match result {
        Ok(_) => panic!("expected a refusal"),
        Err(e) => e.code,
    }
}

struct Served {
    server: RunningServer,
    owner: Business,
    item: i64,
    warehouse: i64,
    _dir: tempfile::TempDir,
}

fn identity() -> (tempfile::TempDir, Identity) {
    let dir = tempfile::tempdir().unwrap();
    let identity = certificate::load_or_create(dir.path(), "shop-pc").unwrap();
    (dir, identity)
}

/** A business on its own server, with a cashier and an item in stock. */
fn serve() -> Served {
    let settings = BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        address: String::new(),
        tax_registration_number: String::new(),
        vat_registered: true,
        fiscal_year_start_month: 1,
    };
    let (name, password) = manager();
    let owner = Business::create(
        ":memory:",
        &settings,
        &Credentials {
            name: name.into(),
            password: password.into(),
        },
    )
    .unwrap();
    // Past the first-use setup, so the clients can sell.
    owner.call("finishSetup", &[json!("new")]).unwrap();
    owner
        .call(
            "addUser",
            &[json!({ "name": cashier().0, "password": cashier().1, "role": "cashier" })],
        )
        .unwrap();
    let standard = owner
        .call("taxCodes", &[])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "standard")
        .unwrap()["id"]
        .clone();
    let item = owner
        .call("addItem", &[json!({ "nameAr": "كابل شبكة", "baseUnit": "متر", "salePrice": 1000, "taxCodeId": standard })])
        .unwrap()
        .as_i64()
        .unwrap();
    let warehouse = owner.call("warehouses", &[]).unwrap()[0]["id"]
        .as_i64()
        .unwrap();
    owner
        .call(
            "postOpeningStock",
            &[
                json!("2026-01-01"),
                json!(warehouse),
                json!([{ "itemId": item, "quantity": 1_000_000, "unitCost": 500 }]),
            ],
        )
        .unwrap();
    let (dir, identity) = identity();
    let server = server::start(&owner, &identity, HOST, 0).unwrap();
    Served {
        server,
        owner,
        item,
        warehouse,
        _dir: dir,
    }
}

fn connect(served: &Served) -> RemoteBusiness {
    RemoteBusiness::connect(HOST, served.server.port, None).unwrap()
}

#[test]
fn a_client_finds_the_business_signs_in_on_the_server_and_calls_the_facade() {
    let served = serve();
    let client = connect(&served);

    assert_eq!(client.hello.settings.name, "شركة النور للكمبيوتر");
    assert_eq!(client.fingerprint, served.server.fingerprint);
    assert_eq!(code(client.call("items", &[])), "sign_in_required");
    assert_eq!(code(client.sign_in(manager().0, "خطأ")), "sign_in_failed");

    let user = client.sign_in(manager().0, manager().1).unwrap();

    assert_eq!(
        (user.name.as_str(), user.role.as_str()),
        ("أيمن", "manager")
    );
    let items = client.call("items", &[]).unwrap();
    assert_eq!(items[0]["nameAr"], "كابل شبكة");
}

#[test]
fn only_the_screens_methods_are_served_and_the_role_is_checked_on_every_call() {
    let served = serve();
    let client = connect(&served);
    client.sign_in(cashier().0, cashier().1).unwrap();

    assert_eq!(code(client.call("close", &[])), "not_allowed");
    assert_eq!(
        code(client.call("trialBalance", &[json!("2026-12-31")])),
        "not_allowed"
    );
    assert!(client.call("items", &[]).is_ok());
}

#[test]
fn two_clients_selling_at_the_same_time_both_succeed_with_no_lost_writes() {
    let served = serve();
    let a = connect(&served);
    let b = connect(&served);
    a.sign_in(manager().0, manager().1).unwrap();
    b.sign_in(cashier().0, cashier().1).unwrap();
    a.call("openShift", &[json!(0)]).unwrap();
    b.call("openShift", &[json!(0)]).unwrap();
    let sale = json!({ "date": "2026-02-01", "warehouseId": served.warehouse, "lines": [{ "itemId": served.item, "unit": "base", "quantity": 1000 }], "cashReceived": 1000 });

    let mut numbers: Vec<i64> = std::thread::scope(|s| {
        let runs: Vec<_> = [&a, &b]
            .into_iter()
            .map(|client| {
                let sale = sale.clone();
                s.spawn(move || {
                    (0..10)
                        .map(|_| {
                            client
                                .call("postCashSale", std::slice::from_ref(&sale))
                                .unwrap()["number"]
                                .as_i64()
                                .unwrap()
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        runs.into_iter().flat_map(|r| r.join().unwrap()).collect()
    });

    numbers.sort();
    assert_eq!(numbers, (1..=20).collect::<Vec<_>>());
    let stock = a.call("stockOnHand", &[json!(served.item)]).unwrap();
    assert_eq!(stock["total"], 1_000_000 - 20_000);
}

#[test]
fn a_client_that_lost_its_connection_resumes_its_session_on_the_next_call() {
    let served = serve();
    let client = connect(&served);
    client.sign_in(manager().0, manager().1).unwrap();
    client.disconnect();

    assert!(client.call("items", &[]).is_ok());
}

fn wait_for_clients(server: &RunningServer, count: usize) {
    for _ in 0..100 {
        if server.clients() == count {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("the server still has {} clients", server.clients());
}

#[test]
fn the_licences_users_are_counted_across_pcs_and_a_pc_that_went_away_gives_up_its_seat() {
    let served = serve();
    served
        .owner
        .call(
            "addUser",
            &[json!({ "name": "منى", "password": "كلمة سر منى", "role": "cashier" })],
        )
        .unwrap();
    served.owner.set_licence_limits(LicenceLimits {
        read_only: None,
        users: Some(2),
    });
    let first = connect(&served);
    let second = connect(&served);
    first.sign_in(cashier().0, cashier().1).unwrap();

    assert_eq!(
        code(second.sign_in("منى", "كلمة سر منى")),
        "licence_users_exceeded"
    );
    first.sign_out();
    assert!(second.sign_in("منى", "كلمة سر منى").is_ok());

    // A PC that drops off without signing out keeps its seat only until another is needed.
    second.sign_out();
    let third = connect(&served);
    third.sign_in(cashier().0, cashier().1).unwrap();
    drop(third);
    wait_for_clients(&served.server, 2);
    assert!(second.sign_in("منى", "كلمة سر منى").is_ok());
}

#[test]
fn a_server_that_is_off_is_unreachable_and_a_changed_certificate_is_refused() {
    let served = serve();
    let client = connect(&served);
    client.sign_in(manager().0, manager().1).unwrap();
    let port = served.server.port;
    served.server.close();

    assert_eq!(code(client.call("items", &[])), "server_unreachable");
    assert_eq!(
        code(RemoteBusiness::connect(HOST, port, None)),
        "server_unreachable"
    );

    let other = serve();
    assert_eq!(
        code(RemoteBusiness::connect(
            HOST,
            other.server.port,
            Some("00:11:22")
        )),
        "server_identity_changed"
    );
    let pinned = other.server.fingerprint.clone();
    assert!(RemoteBusiness::connect(HOST, other.server.port, Some(&pinned)).is_ok());
}

#[test]
fn the_server_keeps_its_certificate_across_restarts_so_pinned_clients_still_trust_it() {
    let (dir, first) = identity();
    let again = certificate::load_or_create(dir.path(), "shop-pc").unwrap();
    assert_eq!(again.fingerprint, first.fingerprint);
    assert_eq!(first.fingerprint.split(':').count(), 32);
    assert_eq!(
        certificate::short_fingerprint(&first.fingerprint).len(),
        8 * 3 - 1
    );
}

#[test]
fn a_port_in_use_is_refused_with_server_port_busy() {
    let served = serve();
    let (_dir, identity) = identity();
    assert_eq!(
        code(server::start(
            &served.owner,
            &identity,
            HOST,
            served.server.port
        )),
        "server_port_busy"
    );
}
