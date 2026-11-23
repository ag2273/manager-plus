//! Ported from `src/core/eta-receipts.test.ts`.
mod common;
#[path = "common/eta.rs"]
mod fake;

use common::code;
use fake::FakeEta;
use manager_core::eta::document::{canonical, EtaAddress};
use manager_core::eta::receipt::{eta_receipt, EtaReceiptInput, EtaReceiptLineInput, EtaSeller};
use manager_core::eta::receipts_store::EtaReceiptSettingsInput;
use manager_core::eta::store::EtaSettingsInput;
use manager_core::users::Credentials;
use manager_core::{Business, BusinessSettings};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn invoicing() -> EtaSettingsInput {
    serde_json::from_value(json!({
        "enabled": true,
        "environment": "preprod",
        "clientId": "client-id",
        "clientSecret": "sealed-secret",
        "activityCode": "4741",
        "address": { "governate": "الجيزة", "regionCity": "الدقي", "street": "شارع التحرير", "buildingNumber": "12" },
        "certificate": "AB12CD",
    }))
    .unwrap()
}

fn pos() -> Value {
    json!({
        "enabled": true,
        "posSerial": "POS-0001",
        "posOsVersion": "windows",
        "posModel": "Manager+",
        "posClientId": "pos-client",
        "posClientSecret": "sealed-pos-secret",
        "presharedKey": "sealed-key",
    })
}

fn pos_input(v: Value) -> EtaReceiptSettingsInput {
    serde_json::from_value(v).unwrap()
}

fn call(b: &Business, method: &str, args: Value) -> Value {
    b.call(method, args.as_array().unwrap())
        .unwrap_or_else(|e| panic!("{method}: {e}"))
}

fn header(r: &Value) -> &Value {
    &r["header"]
}

fn uuid(r: &Value) -> String {
    r["header"]["uuid"].as_str().unwrap().to_string()
}

struct Sample {
    business: Business,
    router: i64,
    cable: i64,
    main: i64,
}

impl Sample {
    fn new(receipts: bool) -> Sample {
        let shop = BusinessSettings {
            name: "شركة النور للكمبيوتر".into(),
            address: String::new(),
            tax_registration_number: "123456789".into(),
            vat_registered: true,
            fiscal_year_start_month: 1,
        };
        let business = common::ready(
            Business::create(
                ":memory:",
                &shop,
                &Credentials {
                    name: "أيمن".into(),
                    password: "كلمة سر قوية".into(),
                },
            )
            .unwrap(),
        );
        let main = call(&business, "warehouses", json!([]))[0]["id"]
            .as_i64()
            .unwrap();
        let standard = call(&business, "taxCodes", json!([]))
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == "standard")
            .unwrap()["id"]
            .clone();
        let router = call(
            &business,
            "addItem",
            json!([{ "nameAr": "راوتر واي فاي 6", "baseUnit": "قطعة", "salePrice": 114_000, "taxCodeId": standard, "egsCode": "EG-123456789-1001" }]),
        )
        .as_i64()
        .unwrap();
        let cable = call(&business, "addItem", json!([{ "nameAr": "كابل شبكة", "baseUnit": "قطعة", "salePrice": 5_700, "taxCodeId": standard }]))
            .as_i64()
            .unwrap();
        let supplier = call(
            &business,
            "addSupplier",
            json!([{ "name": "المورد", "phone": "", "taxRegistrationNumber": "" }]),
        );
        call(
            &business,
            "postPurchaseInvoice",
            json!([{ "date": "2026-11-01", "supplierId": supplier, "warehouseId": main, "reference": "", "lines": [
                { "itemId": router, "unit": "base", "quantity": 20_000, "unitPrice": 80_000 },
                { "itemId": cable, "unit": "base", "quantity": 20_000, "unitPrice": 3_000 },
            ] }]),
        );
        let s = Sample {
            business,
            router,
            cable,
            main,
        };
        if receipts {
            s.on();
        }
        call(&s.business, "openShift", json!([0]));
        s
    }

    fn on(&self) {
        self.business.set_eta_settings(&invoicing()).unwrap();
        self.business
            .set_eta_receipt_settings(&pos_input(pos()))
            .unwrap();
    }

    fn sell_with(&self, item: i64, method: &str) -> Value {
        call(
            &self.business,
            "postSale",
            json!([{ "date": "2026-11-20", "warehouseId": self.main, "lines": [{ "itemId": item, "unit": "base", "quantity": 1_000 }],
                     "payments": [{ "method": method, "amount": 114_000 }] }]),
        )
    }

    fn sell(&self) -> Value {
        self.sell_with(self.router, "cash")
    }

    fn statuses(&self) -> Vec<String> {
        self.business
            .eta_receipts()
            .unwrap()
            .into_iter()
            .map(|r| r.status)
            .collect()
    }
}

#[test]
fn they_are_off_by_default_need_e_invoicing_on_and_every_pos_detail() {
    let s = Sample::new(false);
    let settings = s.business.eta_receipt_settings().unwrap();
    assert!(!settings.enabled && !settings.has_pos_secrets);
    s.sell();
    assert!(s.business.eta_receipts().unwrap().is_empty());
    assert_eq!(
        code(s.business.set_eta_receipt_settings(&pos_input(pos()))),
        "eta_not_enabled"
    );
    s.business.set_eta_settings(&invoicing()).unwrap();
    let mut blank = pos();
    blank["posSerial"] = json!(" ");
    assert_eq!(
        code(s.business.set_eta_receipt_settings(&pos_input(blank))),
        "eta_settings_incomplete"
    );
    s.business
        .set_eta_receipt_settings(&pos_input(pos()))
        .unwrap();
    let saved = s.business.eta_receipt_settings().unwrap();
    assert!(saved.enabled && saved.has_pos_secrets);
    assert_eq!(saved.pos_serial, "POS-0001");
    // Saving without the secrets keeps the sealed ones.
    let mut kept = pos();
    kept.as_object_mut().unwrap().remove("posClientSecret");
    kept.as_object_mut().unwrap().remove("presharedKey");
    s.business
        .set_eta_receipt_settings(&pos_input(kept))
        .unwrap();
    let credentials = s.business.eta_receipt_credentials().unwrap();
    assert!(!credentials.production);
    assert_eq!(
        (
            credentials.pos_client_secret.as_str(),
            credentials.preshared_key.as_str()
        ),
        ("sealed-pos-secret", "sealed-key")
    );
}

#[test]
fn sales_made_offline_wait_then_go_in_order_each_naming_the_one_before_it() {
    let s = Sample::new(true);
    s.sell();
    s.sell_with(s.router, "card");
    assert_eq!(s.statuses(), ["pending", "pending"]);

    let mut eta = FakeEta {
        down: true,
        ..Default::default()
    };
    assert_eq!(code(s.business.send_eta_receipts(&eta)), "eta_unreachable");
    assert_eq!(s.statuses(), ["pending", "pending"]);

    eta.down = false;
    s.sell();
    assert_eq!(s.business.send_eta_receipts(&eta).unwrap(), 3);
    let received = eta.received.borrow();
    let sent = &received[received.len() - 3..];
    let numbers: Vec<&str> = sent
        .iter()
        .map(|r| header(r)["receiptNumber"].as_str().unwrap())
        .collect();
    assert_eq!(numbers, ["S-1", "S-2", "S-3"]);
    assert_eq!(header(&sent[0])["previousUUID"], "");
    assert_eq!(header(&sent[1])["previousUUID"], json!(uuid(&sent[0])));
    assert_eq!(header(&sent[2])["previousUUID"], json!(uuid(&sent[1])));
    let methods: Vec<&Value> = sent.iter().map(|r| &r["paymentMethod"]).collect();
    assert_eq!(methods, [&json!("C"), &json!("V"), &json!("C")]);
    assert_eq!(s.statuses(), ["submitted", "submitted", "submitted"]);
}

#[test]
fn the_uuid_is_the_sha256_of_the_receipts_canonical_form_with_an_empty_uuid() {
    let s = Sample::new(true);
    s.sell();
    let eta = FakeEta::default();
    s.business.send_eta_receipts(&eta).unwrap();
    let receipt = eta.received.borrow()[0].clone();
    let mut blank = receipt.clone();
    blank["header"]["uuid"] = json!("");
    let digest: String = Sha256::digest(canonical(&blank).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(uuid(&receipt), digest);
    assert_eq!(
        receipt["documentType"],
        json!({ "receiptType": "S", "typeVersion": "1.2" })
    );
    assert_eq!(receipt["seller"]["rin"], "123456789");
    assert_eq!(receipt["seller"]["deviceSerialNumber"], "POS-0001");
    assert_eq!(receipt["seller"]["activityCode"], "4741");
    assert_eq!(receipt["totalAmount"], json!(1140));
    assert_eq!(receipt["netAmount"], json!(1000));
    assert_eq!(
        receipt["taxTotals"],
        json!([{ "taxType": "T1", "amount": 140 }])
    );
}

#[test]
fn a_receipt_that_cant_be_issued_fails_and_the_till_goes_on_fixed_it_goes_again_at_the_end_of_the_chain(
) {
    let s = Sample::new(true);
    s.sell();
    s.sell_with(s.cable, "cash");
    s.sell();
    let rows: Vec<(i64, String)> = s
        .business
        .eta_receipts()
        .unwrap()
        .into_iter()
        .map(|r| (r.number, r.status))
        .collect();
    assert_eq!(
        rows,
        vec![
            (1, "pending".into()),
            (2, "failed".into()),
            (3, "pending".into())
        ]
    );
    assert_eq!(
        s.business.eta_receipts().unwrap()[1].error,
        "eta_item_code_required: كابل شبكة"
    );
    let eta = FakeEta::default();
    s.business.send_eta_receipts(&eta).unwrap();
    {
        let received = eta.received.borrow();
        let numbers: Vec<&str> = received
            .iter()
            .map(|r| header(r)["receiptNumber"].as_str().unwrap())
            .collect();
        assert_eq!(numbers, ["S-1", "S-3"]);
        assert_eq!(
            header(&received[1])["previousUUID"],
            json!(uuid(&received[0]))
        );
    }

    call(
        &s.business,
        "updateItem",
        json!([s.cable, { "egsCode": "EG-123456789-1002" }]),
    );
    s.business
        .retry_eta_receipt("sale", s.business.eta_receipts().unwrap()[1].id)
        .unwrap();
    s.business.send_eta_receipts(&eta).unwrap();
    assert_eq!(s.statuses(), ["submitted", "submitted", "submitted"]);
    let received = eta.received.borrow();
    assert_eq!(header(&received[2])["receiptNumber"], "S-2");
    assert_eq!(
        header(&received[2])["previousUUID"],
        json!(uuid(&received[1]))
    );
}

#[test]
fn a_refused_receipt_fails_with_the_etas_reason_an_invalid_one_goes_again_with_a_new_uuid() {
    let s = Sample::new(true);
    let mut eta = FakeEta::default();
    eta.refuse
        .insert("S-1".into(), "Seller activity code is not valid".into());
    s.sell();
    s.business.send_eta_receipts(&eta).unwrap();
    let first = &s.business.eta_receipts().unwrap()[0];
    assert_eq!(
        (first.status.as_str(), first.error.as_str()),
        ("failed", "eta_rejected: Seller activity code is not valid")
    );

    s.sell();
    let ok = FakeEta::default();
    s.business
        .retry_eta_receipt("sale", s.business.eta_receipts().unwrap()[0].id)
        .unwrap();
    s.business.send_eta_receipts(&ok).unwrap();
    let second = s.business.eta_receipts().unwrap()[1].clone();
    ok.verdict(&second.uuid, "invalid", Some("Total is wrong"));
    s.business.refresh_eta_receipt_statuses(&ok).unwrap();
    let now = &s.business.eta_receipts().unwrap()[1];
    assert_eq!(
        (now.status.as_str(), now.error.as_str()),
        ("invalid", "eta_rejected: Total is wrong")
    );
    assert_eq!(
        code(
            s.business
                .retry_eta_receipt("sale", s.business.eta_receipts().unwrap()[0].id)
        ),
        "eta_not_retryable"
    );

    s.business.retry_eta_receipt("sale", second.id).unwrap();
    s.business.send_eta_receipts(&ok).unwrap();
    let received = ok.received.borrow();
    let again = header(received.last().unwrap());
    assert_ne!(again["uuid"], json!(second.uuid));
    // It names the last receipt issued: the first one, sent again before it.
    assert_eq!(
        again["previousUUID"],
        json!(s.business.eta_receipts().unwrap()[0].uuid)
    );
}

#[test]
fn a_return_names_its_sale_a_return_of_a_sale_made_before_e_receipts_is_not_sent() {
    let s = Sample::new(false);
    let before = call(&s.business, "findReceipt", json!([s.sell()["number"]]));
    s.on();
    let after = call(&s.business, "findReceipt", json!([s.sell()["number"]]));
    for receipt in [&before, &after] {
        call(
            &s.business,
            "returnSale",
            json!([{ "date": "2026-11-21", "receiptId": receipt["id"], "lines": [{ "lineId": receipt["lines"][0]["lineId"], "quantity": 1_000 }], "refund": "cash" }]),
        );
    }
    let rows: Vec<(String, i64)> = s
        .business
        .eta_receipts()
        .unwrap()
        .into_iter()
        .map(|r| (r.kind, r.number))
        .collect();
    assert_eq!(rows, vec![("sale".into(), 2), ("return".into(), 2)]);

    let eta = FakeEta::default();
    s.business.send_eta_receipts(&eta).unwrap();
    let received = eta.received.borrow();
    let (sale, refund) = (&received[0], &received[1]);
    assert_eq!(refund["documentType"]["receiptType"], "R");
    assert_eq!(refund["totalAmount"], json!(1140));
    assert_eq!(header(refund)["receiptNumber"], "R-2");
    assert_eq!(header(refund)["referenceOldUUID"], json!(uuid(sale)));
    assert_eq!(header(refund)["previousUUID"], json!(uuid(sale)));
}

#[test]
fn the_printed_receipt_carries_its_qr_code_from_the_sale_on_even_offline() {
    let s = Sample::new(true);
    s.sell();
    s.sell_with(s.cable, "cash");
    assert_eq!(s.business.eta_receipt_qr("sale", 2).unwrap(), None);
    let id = s.business.eta_receipts().unwrap()[0].uuid.clone();
    let qr = s.business.eta_receipt_qr("sale", 1).unwrap().unwrap();
    let prefix = format!("https://preprod.invoicing.eta.gov.eg/receipts/search/{id}/share/");
    assert!(qr.starts_with(&prefix), "{qr}");
    let rest = &qr[prefix.len()..];
    assert_eq!(
        rest.len(),
        "2026-11-20T10:11:12Z".len() + "#Total:1140,IssuerRIN:123456789".len()
    );
    assert!(rest.ends_with("Z#Total:1140,IssuerRIN:123456789"), "{qr}");
    let eta = FakeEta::default();
    s.business.send_eta_receipts(&eta).unwrap();
    assert_eq!(uuid(&eta.received.borrow()[0]), id);
}

#[test]
fn a_receipt_is_the_same_bytes_and_uuid_as_the_typescript_core_made() {
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/eta-receipt.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let line = |description: &str, item: &str, internal: &str, q, g, n, v, rate, kind: &str| {
        EtaReceiptLineInput {
            description: description.into(),
            item_code: item.into(),
            internal_code: internal.into(),
            quantity: q,
            gross: g,
            net: n,
            vat: v,
            vat_rate: rate,
            tax_kind: kind.into(),
        }
    };
    let (receipt, id) = eta_receipt(&EtaReceiptInput {
        kind: "S",
        receipt_number: "S-7".into(),
        issued_at: chrono::DateTime::parse_from_rfc3339("2026-11-20T10:11:12Z")
            .unwrap()
            .with_timezone(&chrono::Utc),
        previous_uuid: "abc".into(),
        reference_uuid: None,
        seller: EtaSeller {
            rin: "123456789".into(),
            name: "شركة".into(),
            activity_code: "4741".into(),
            address: EtaAddress {
                governate: "g".into(),
                region_city: "r".into(),
                street: "s".into(),
                building_number: "1".into(),
            },
            device_serial_number: "POS-1".into(),
        },
        payment_method: "V",
        lines: vec![
            line(
                "x",
                "6221000000011",
                "A1",
                1_500,
                17_100,
                13_000,
                1_820,
                1400,
                "standard",
            ),
            line(
                "y (علبة)",
                "EG-1-2",
                "",
                3_000,
                1_000,
                1_000,
                0,
                0,
                "exempt",
            ),
        ],
    });
    assert_eq!(id, fixture["uuid"].as_str().unwrap());
    assert_eq!(
        serde_json::to_string(&receipt).unwrap(),
        fixture["json"].as_str().unwrap()
    );
}
