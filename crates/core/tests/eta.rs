//! Ported from `src/core/eta.test.ts`.
mod common;
#[path = "common/eta.rs"]
mod fake;

use chrono::{DateTime, Utc};
use common::code;
use fake::{FakeEta, TestSigner};
use manager_core::eta::der::{children, read};
use manager_core::eta::document::canonical;
use manager_core::eta::store::{EtaSettingsInput, EtaState};
use manager_core::users::Credentials;
use manager_core::{Business, BusinessSettings};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn settings() -> Value {
    json!({
        "enabled": true,
        "environment": "preprod",
        "clientId": "client-id",
        "clientSecret": "sealed-secret",
        "activityCode": "4741",
        "address": { "governate": "الجيزة", "regionCity": "الدقي", "street": "شارع التحرير", "buildingNumber": "12" },
        "certificate": "AB12CD",
    })
}

fn input(v: Value) -> EtaSettingsInput {
    serde_json::from_value(v).unwrap()
}

fn call(b: &Business, method: &str, args: Value) -> Value {
    b.call(method, args.as_array().unwrap())
        .unwrap_or_else(|e| panic!("{method}: {e}"))
}

fn now() -> DateTime<Utc> {
    Utc::now()
}

fn at(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

struct Sample {
    business: Business,
    router: i64,
    card: i64,
    company: i64,
    main: i64,
}

impl Sample {
    fn new() -> Sample {
        let shop = BusinessSettings {
            name: "شركة النور للكمبيوتر".into(),
            address: String::new(),
            tax_registration_number: "123456789".into(),
            vat_registered: true,
            fiscal_year_start_month: 1,
        };
        let business = Business::create(
            ":memory:",
            &shop,
            &Credentials {
                name: "أيمن".into(),
                password: "كلمة سر قوية".into(),
            },
        )
        .unwrap();
        let main = call(&business, "warehouses", json!([]))[0]["id"]
            .as_i64()
            .unwrap();
        let tax = |kind: &str| {
            call(&business, "taxCodes", json!([]))
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["kind"] == kind)
                .unwrap()["id"]
                .clone()
        };
        let router = call(
            &business,
            "addItem",
            json!([{ "nameAr": "راوتر واي فاي 6", "baseUnit": "قطعة", "salePrice": 150_000, "taxCodeId": tax("standard"), "egsCode": "EG-123456789-1001" }]),
        )
        .as_i64()
        .unwrap();
        let card = call(
            &business,
            "addItem",
            json!([{ "nameAr": "كارت شحن", "baseUnit": "كارت", "salePrice": 10_000, "taxCodeId": tax("exempt"), "egsCode": "6221000000011" }]),
        )
        .as_i64()
        .unwrap();
        let company = call(
            &business,
            "addCustomer",
            json!([{ "name": "شركة الأمل للتجارة", "phone": "", "taxRegistrationNumber": "987654321", "address": "شارع عباس العقاد",
                     "governate": "القاهرة", "regionCity": "مدينة نصر", "buildingNumber": "5" }]),
        )
        .as_i64()
        .unwrap();
        Sample {
            business,
            router,
            card,
            company,
            main,
        }
    }

    fn invoice_with(&self, customer: i64, lines: Value) -> Value {
        call(
            &self.business,
            "postSalesInvoice",
            json!([{ "date": "2026-11-20", "customerId": customer, "warehouseId": self.main, "reference": "", "notes": "", "lines": lines }]),
        )
    }

    fn invoice(&self) -> Value {
        self.invoice_with(
            self.company,
            json!([{ "itemId": self.router, "unit": "base", "quantity": 2_000, "unitPrice": 120_000, "discount": 10_000 }]),
        )
    }

    fn on(&self) {
        self.business.set_eta_settings(&input(settings())).unwrap();
    }

    fn state(&self, kind: &str, number: i64) -> EtaState {
        self.business.eta_state(kind, number).unwrap().unwrap()
    }

    fn document_id(&self, kind: &str, number: i64) -> i64 {
        let rows = self.business.eta_documents().unwrap();
        rows.iter()
            .find(|d| d.kind == kind && d.number == number)
            .unwrap()
            .document_id
    }
}

fn state(status: &str, uuid: &str, error: &str) -> EtaState {
    EtaState {
        status: status.into(),
        uuid: uuid.into(),
        error: error.into(),
    }
}

/** The signed attributes (as the SET the token signed), the RSA signature and the message digest inside a CMS SignedData. */
fn signature_parts(base64: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let cms = decode64(base64);
    let top = read(&cms, 0).unwrap();
    let explicit = children(&top)[1];
    let signed_data_seq = children(&explicit)[0];
    let signed_data = children(&signed_data_seq);
    let infos = signed_data.last().unwrap();
    let signer_info = children(&children(infos)[0]);
    let attributes = signer_info[3];
    let mut as_set = attributes.whole.to_vec();
    as_set[0] = 0x31;
    let digest = children(&attributes)
        .into_iter()
        .map(|a| children(&a))
        .find(|parts| hex(parts[0].whole) == "06092a864886f70d010904")
        .unwrap();
    let message_digest = children(&digest[1])[0].content.to_vec();
    (as_set, signer_info[5].content.to_vec(), message_digest)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode64(text: &str) -> Vec<u8> {
    const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut count = 0;
    let mut out = vec![];
    for c in text.chars().filter(|c| *c != '=') {
        bits = (bits << 6) | ALPHABET.find(c).unwrap() as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    out
}

#[test]
fn it_is_off_by_default_posting_queues_nothing_and_the_app_works_without_it() {
    let s = Sample::new();
    let settings = s.business.eta_settings().unwrap();
    assert!(!settings.enabled && !settings.has_secret);
    s.invoice();
    assert!(s.business.eta_documents().unwrap().is_empty());
    assert_eq!(s.business.eta_state("invoice", 1).unwrap(), None);
}

#[test]
fn turning_it_on_needs_every_setting_a_4_digit_activity_code_and_the_businesss_tax_number() {
    let s = Sample::new();
    let mut short = settings();
    short["activityCode"] = json!("47");
    assert_eq!(
        code(s.business.set_eta_settings(&input(short))),
        "activity_code_invalid"
    );
    let mut no_cert = settings();
    no_cert["certificate"] = json!("");
    assert_eq!(
        code(s.business.set_eta_settings(&input(no_cert))),
        "eta_settings_incomplete"
    );
    s.on();
    let saved = s.business.eta_settings().unwrap();
    assert!(saved.enabled && saved.has_secret);
    assert_eq!(saved.activity_code, "4741");
    let credentials = s.business.eta_credentials().unwrap();
    assert_eq!(
        (
            credentials.environment.as_str(),
            credentials.client_id.as_str(),
            credentials.client_secret.as_str(),
            credentials.certificate.as_str()
        ),
        ("preprod", "client-id", "sealed-secret", "AB12CD")
    );
    // Saving again without a secret keeps the sealed one; the audit log never holds it.
    let mut kept = settings();
    kept.as_object_mut().unwrap().remove("clientSecret");
    s.business.set_eta_settings(&input(kept)).unwrap();
    assert_eq!(
        s.business.eta_credentials().unwrap().client_secret,
        "sealed-secret"
    );
    let audit = serde_json::to_string(&s.business.audit_log().unwrap()).unwrap();
    assert!(!audit.contains("sealed-secret"));
    // Only a manager changes them.
    call(
        &s.business,
        "addUser",
        json!([{ "name": "منى", "password": "كلمة سر 2", "role": "accountant" }]),
    );
    let accountant = s.business.sign_in("منى", "كلمة سر 2").unwrap();
    assert!(accountant.eta_settings().unwrap().enabled);
    assert_eq!(
        code(accountant.set_eta_settings(&input(settings()))),
        "not_allowed"
    );
}

#[test]
fn an_invoice_is_serialised_signed_with_the_tokens_certificate_and_submitted_then_reported_valid() {
    let s = Sample::new();
    s.on();
    s.invoice();
    assert_eq!(s.state("invoice", 1), state("pending", "", ""));

    let eta = FakeEta::default();
    let signer = TestSigner::new();
    assert_eq!(
        s.business
            .send_pending_eta(&signer, &eta, at("2026-11-21T09:00:00Z"))
            .unwrap(),
        1
    );

    let sent = eta.received.borrow()[0].clone();
    assert_eq!(sent["issuer"]["type"], "B");
    assert_eq!(sent["issuer"]["id"], "123456789");
    assert_eq!(sent["issuer"]["address"]["branchID"], "0");
    assert_eq!(sent["issuer"]["address"]["country"], "EG");
    assert_eq!(sent["issuer"]["address"]["governate"], "الجيزة");
    assert_eq!(sent["receiver"]["id"], "987654321");
    assert_eq!(sent["receiver"]["name"], "شركة الأمل للتجارة");
    assert_eq!(sent["receiver"]["address"]["regionCity"], "مدينة نصر");
    assert_eq!(sent["receiver"]["address"]["street"], "شارع عباس العقاد");
    assert_eq!(sent["documentType"], "I");
    assert_eq!(sent["dateTimeIssued"], "2026-11-20T08:00:00Z");
    assert_eq!(sent["taxpayerActivityCode"], "4741");
    assert_eq!(sent["internalID"], "INV-1");
    assert_eq!(sent["totalSalesAmount"], json!(2400));
    assert_eq!(sent["totalDiscountAmount"], json!(100));
    assert_eq!(sent["netAmount"], json!(2300));
    assert_eq!(
        sent["taxTotals"],
        json!([{ "taxType": "T1", "amount": 322 }])
    );
    assert_eq!(sent["totalAmount"], json!(2622));
    let line = &sent["invoiceLines"][0];
    assert_eq!(line["itemType"], "EGS");
    assert_eq!(line["itemCode"], "EG-123456789-1001");
    assert_eq!(line["quantity"], json!(2));
    assert_eq!(
        line["unitValue"],
        json!({ "currencySold": "EGP", "amountEGP": 1200 })
    );
    assert_eq!(line["salesTotal"], json!(2400));
    assert_eq!(line["discount"]["amount"], json!(100));
    assert_eq!(line["netTotal"], json!(2300));
    assert_eq!(
        line["taxableItems"],
        json!([{ "taxType": "T1", "amount": 322, "subType": "V009", "rate": 14 }])
    );
    assert_eq!(line["total"], json!(2622));

    // The signature covers the canonical text of the document without its signatures.
    let mut unsigned = sent.clone();
    let signatures = unsigned
        .as_object_mut()
        .unwrap()
        .remove("signatures")
        .unwrap();
    assert_eq!(signatures[0]["signatureType"], "I");
    let (as_set, signature, digest) = signature_parts(signatures[0]["value"].as_str().unwrap());
    assert_eq!(
        hex(&digest),
        hex(&Sha256::digest(canonical(&unsigned).as_bytes()))
    );
    assert!(signer.verifies(&as_set, &signature));

    assert_eq!(s.state("invoice", 1), state("submitted", "UUID-INV-1", ""));
    eta.verdict("UUID-INV-1", "valid", None);
    s.business.refresh_eta_statuses(&eta).unwrap();
    assert_eq!(s.state("invoice", 1), state("valid", "UUID-INV-1", ""));
}

#[test]
fn a_credit_note_follows_its_valid_invoice_and_refers_to_it() {
    let s = Sample::new();
    s.on();
    let posted = s.invoice();
    let line_id = call(&s.business, "findSalesInvoice", json!([1]))["lines"][0]["lineId"].clone();
    call(
        &s.business,
        "postCreditNote",
        json!([{ "date": "2026-11-21", "invoiceId": posted["id"], "reason": "عيب", "lines": [{ "lineId": line_id, "quantity": 1_000 }] }]),
    );
    let eta = FakeEta::default();
    let signer = TestSigner::new();

    s.business.send_pending_eta(&signer, &eta, now()).unwrap();
    assert_eq!(
        s.state("credit_note", 1),
        state("failed", "", "eta_invoice_not_valid")
    );

    eta.verdict("UUID-INV-1", "valid", None);
    s.business.refresh_eta_statuses(&eta).unwrap();
    s.business
        .retry_eta("credit_note", s.document_id("credit_note", 1))
        .unwrap();
    s.business.send_pending_eta(&signer, &eta, now()).unwrap();
    let received = eta.received.borrow();
    let note = received.iter().find(|d| d["documentType"] == "C").unwrap();
    assert_eq!(note["internalID"], "CN-1");
    assert_eq!(note["references"], json!(["UUID-INV-1"]));
    assert_eq!(note["netAmount"], json!(1150));
    assert_eq!(note["taxTotals"][0]["amount"], json!(161));
    assert_eq!(note["totalAmount"], json!(1311));
    assert_eq!(s.state("credit_note", 1).status, "submitted");
}

#[test]
fn missing_codes_tax_numbers_and_addresses_are_named_and_the_document_goes_once_fixed() {
    let s = Sample::new();
    s.on();
    call(
        &s.business,
        "updateItem",
        json!([s.router, { "egsCode": "" }]),
    );
    s.invoice();
    let walk_in = call(
        &s.business,
        "addCustomer",
        json!([{ "name": "عميل نقدي", "phone": "", "taxRegistrationNumber": "" }]),
    );
    s.invoice_with(walk_in.as_i64().unwrap(), json!([{ "itemId": s.card, "unit": "base", "quantity": 1_000, "unitPrice": 10_000, "discount": 0 }]));
    let eta = FakeEta::default();

    s.business
        .send_pending_eta(&TestSigner::new(), &eta, now())
        .unwrap();
    assert_eq!(
        s.state("invoice", 1),
        state("failed", "", "eta_item_code_required: راوتر واي فاي 6")
    );
    assert_eq!(
        s.state("invoice", 2),
        state("failed", "", "eta_customer_tax_number_required: عميل نقدي")
    );
    assert!(eta.received.borrow().is_empty());

    call(
        &s.business,
        "updateItem",
        json!([s.router, { "egsCode": "EG-123456789-1001" }]),
    );
    call(
        &s.business,
        "updateCustomer",
        json!([s.company, { "address": "" }]),
    );
    let first = s.document_id("invoice", 1);
    s.business.retry_eta("invoice", first).unwrap();
    s.business
        .send_pending_eta(&TestSigner::new(), &eta, now())
        .unwrap();
    assert_eq!(
        s.state("invoice", 1).error,
        "eta_customer_address_required: شركة الأمل للتجارة"
    );

    call(
        &s.business,
        "updateCustomer",
        json!([s.company, { "address": "شارع عباس العقاد" }]),
    );
    s.business.retry_eta("invoice", first).unwrap();
    s.business
        .send_pending_eta(&TestSigner::new(), &eta, now())
        .unwrap();
    assert_eq!(s.state("invoice", 1).status, "submitted");
    assert_eq!(
        code(s.business.retry_eta("invoice", first)),
        "eta_not_retryable"
    );
}

#[test]
fn posting_never_waits_on_the_eta_when_it_is_down_the_documents_stay_pending() {
    let s = Sample::new();
    s.on();
    s.invoice();
    let down = FakeEta {
        down: true,
        ..Default::default()
    };
    assert_eq!(
        code(
            s.business
                .send_pending_eta(&TestSigner::new(), &down, now())
        ),
        "eta_unreachable"
    );
    assert_eq!(s.state("invoice", 1).status, "pending");
    assert_eq!(
        call(&s.business, "findSalesInvoice", json!([1]))["total"],
        json!(262_200)
    );
}

#[test]
fn a_refused_or_invalid_document_is_listed_with_the_etas_reason_and_an_accepted_one_can_be_cancelled(
) {
    let s = Sample::new();
    s.on();
    s.invoice();
    s.invoice();
    let mut eta = FakeEta::default();
    eta.refuse
        .insert("INV-2".into(), "Receiver tax number not registered".into());
    assert_eq!(
        s.business
            .send_pending_eta(&TestSigner::new(), &eta, now())
            .unwrap(),
        1
    );
    assert_eq!(
        s.state("invoice", 2),
        state(
            "failed",
            "",
            "eta_rejected: Receiver tax number not registered"
        )
    );

    eta.verdict("UUID-INV-1", "invalid", Some("Total amount mismatch"));
    s.business.refresh_eta_statuses(&eta).unwrap();
    assert_eq!(
        s.state("invoice", 1),
        state(
            "invalid",
            "UUID-INV-1",
            "eta_rejected: Total amount mismatch"
        )
    );
    let listed: Vec<(i64, String)> = s
        .business
        .eta_documents()
        .unwrap()
        .into_iter()
        .map(|d| (d.number, d.status))
        .collect();
    assert_eq!(
        listed,
        vec![(2, "failed".to_string()), (1, "invalid".to_string())]
    );

    let first = s.document_id("invoice", 1);
    s.business.retry_eta("invoice", first).unwrap();
    s.business
        .send_pending_eta(&TestSigner::new(), &FakeEta::default(), now())
        .unwrap();
    eta.verdict("UUID-INV-1", "valid", None);
    s.business.refresh_eta_statuses(&eta).unwrap();
    s.business
        .cancel_eta(&eta, "invoice", first, "خطأ في السعر")
        .unwrap();
    assert_eq!(*eta.cancelled.borrow(), vec!["UUID-INV-1".to_string()]);
    assert_eq!(s.state("invoice", 1).status, "cancelled");
    assert_eq!(
        code(s.business.cancel_eta(&eta, "invoice", first, "")),
        "eta_not_cancellable"
    );
}

#[test]
fn a_document_is_the_same_bytes_as_javascript_writes_it() {
    let s = Sample::new();
    s.on();
    s.invoice();
    let eta = FakeEta::default();
    s.business
        .send_pending_eta(&TestSigner::new(), &eta, at("2026-11-21T09:00:00Z"))
        .unwrap();
    let mut sent = eta.received.borrow()[0].clone();
    sent.as_object_mut().unwrap().remove("signatures");
    // The canonical text as the TypeScript core made it for this invoice.
    let expected = concat!(
        r#""ISSUER""ADDRESS""BRANCHID""0""COUNTRY""EG""GOVERNATE""الجيزة""REGIONCITY""الدقي""STREET""شارع التحرير""BUILDINGNUMBER""12""TYPE""B""ID""123456789""NAME""شركة النور للكمبيوتر""#,
        r#""RECEIVER""ADDRESS""COUNTRY""EG""GOVERNATE""القاهرة""REGIONCITY""مدينة نصر""STREET""شارع عباس العقاد""BUILDINGNUMBER""5""TYPE""B""ID""987654321""NAME""شركة الأمل للتجارة""#,
        r#""DOCUMENTTYPE""I""DOCUMENTTYPEVERSION""1.0""DATETIMEISSUED""2026-11-20T08:00:00Z""TAXPAYERACTIVITYCODE""4741""INTERNALID""INV-1""#,
        r#""INVOICELINES""INVOICELINES""DESCRIPTION""راوتر واي فاي 6""ITEMTYPE""EGS""ITEMCODE""EG-123456789-1001""UNITTYPE""EA""QUANTITY""2""INTERNALCODE""""#,
        r#""SALESTOTAL""2400""TOTAL""2622""VALUEDIFFERENCE""0""TOTALTAXABLEFEES""0""NETTOTAL""2300""ITEMSDISCOUNT""0""#,
        r#""UNITVALUE""CURRENCYSOLD""EGP""AMOUNTEGP""1200""DISCOUNT""RATE""0""AMOUNT""100""#,
        r#""TAXABLEITEMS""TAXABLEITEMS""TAXTYPE""T1""AMOUNT""322""SUBTYPE""V009""RATE""14""#,
        r#""TOTALDISCOUNTAMOUNT""100""TOTALSALESAMOUNT""2400""NETAMOUNT""2300""TAXTOTALS""TAXTOTALS""TAXTYPE""T1""AMOUNT""322""#,
        r#""TOTALAMOUNT""2622""EXTRADISCOUNTAMOUNT""0""TOTALITEMSDISCOUNTAMOUNT""0""#,
    );
    assert_eq!(canonical(&sent), expected);
}
