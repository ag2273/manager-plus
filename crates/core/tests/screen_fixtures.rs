//! What the screens print and export is drawn from the core's answers. These tests make those
//! answers for the samples the screens' own tests use, and keep them as JSON fixtures beside those
//! tests (`src/shared/__fixtures__/books`), so the printed documents are always made from what this
//! core really returns. A change here shows as a changed fixture; `MANAGER_PLUS_WRITE_FIXTURES=1`
//! writes the new ones.

use manager_core::users::Credentials;
use manager_core::{Business, BusinessSettings};
use serde_json::{json, Map, Value};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/shared/__fixtures__");
/** Times are when the test ran; fixed so the fixtures are stable. */
const WHEN: &str = "2026-11-20T18:15:00.000Z";

fn shop(name: &str) -> BusinessSettings {
    BusinessSettings {
        name: name.into(),
        address: "الدقي، الجيزة".into(),
        tax_registration_number: "123456789".into(),
        vat_registered: true,
        fiscal_year_start_month: 1,
    }
}

fn open(settings: &BusinessSettings) -> Business {
    let manager = Credentials {
        name: "أيمن".into(),
        password: "كلمة سر قوية".into(),
    };
    Business::create(":memory:", settings, &manager).unwrap()
}

fn call(business: &Business, method: &str, args: Value) -> Value {
    let Value::Array(args) = args else {
        panic!("arguments are a list")
    };
    business
        .call(method, &args)
        .unwrap_or_else(|e| panic!("{method}: {e}"))
}

fn fixed(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| {
                    let time = (k == "at" || k.ends_with("At")) && v.is_string();
                    (k, if time { json!(WHEN) } else { fixed(v) })
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(list) => Value::Array(list.into_iter().map(fixed).collect()),
        other => other,
    }
}

/** Compares `value` with the kept fixture, or writes it when asked to. */
fn keep(name: &str, value: Value) {
    let path = format!("{FIXTURES}/books/{name}.json");
    let text = format!("{}\n", serde_json::to_string_pretty(&fixed(value)).unwrap());
    if std::env::var("MANAGER_PLUS_WRITE_FIXTURES").is_ok() {
        std::fs::create_dir_all(format!("{FIXTURES}/books")).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let kept = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{path} is missing; run with MANAGER_PLUS_WRITE_FIXTURES=1"));
    assert_eq!(
        kept, text,
        "{name}: the core's answer changed; run with MANAGER_PLUS_WRITE_FIXTURES=1 and check the screens' tests"
    );
}

fn standard(business: &Business) -> Value {
    call(business, "taxCodes", json!([]))
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "standard")
        .unwrap()["id"]
        .clone()
}

fn main_warehouse(business: &Business) -> Value {
    call(business, "warehouses", json!([]))[0]["id"].clone()
}

/** An invoice to a company customer, its credit note, statement and a quotation, for the A4 documents. */
#[test]
fn a4_documents() {
    let business = open(&BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        ..shop("")
    });
    let main = main_warehouse(&business);
    let router = call(
        &business,
        "addItem",
        json!([{ "nameAr": "راوتر واي فاي 6", "nameEn": "Wi-Fi 6 router", "baseUnit": "قطعة", "salePrice": 150_000, "taxCodeId": standard(&business) }]),
    );
    let customer = call(
        &business,
        "addCustomer",
        json!([{ "name": "شركة الأمل للتجارة", "phone": "", "taxRegistrationNumber": "987654321", "address": "مدينة نصر، القاهرة" }]),
    );
    let posted = call(
        &business,
        "postSalesInvoice",
        json!([{ "date": "2026-11-20", "customerId": customer, "warehouseId": main, "reference": "PO-15", "notes": "التسليم في مقر العميل",
                 "lines": [{ "itemId": router, "unit": "base", "quantity": 2_000, "unitPrice": 120_000, "discount": 10_000 }] }]),
    );
    let invoice = call(&business, "findSalesInvoice", json!([posted["id"]]));
    let customer_row = call(&business, "customers", json!([]))[0].clone();
    let statement = call(
        &business,
        "statement",
        json!(["customer", customer, "2026-11-01", "2026-11-30"]),
    );
    call(
        &business,
        "postCreditNote",
        json!([{ "date": "2026-11-21", "invoiceId": posted["id"], "reason": "عيب", "lines": [{ "lineId": invoice["lines"][0]["lineId"], "quantity": 1_000 }] }]),
    );
    call(
        &business,
        "saveQuotation",
        json!([{ "date": "2026-11-20", "validUntil": "2026-11-30", "customerId": customer, "reference": "RFQ-3", "notes": "",
                 "lines": [{ "itemId": router, "unit": "base", "quantity": 3_000, "unitPrice": 120_000 }] }]),
    );
    keep(
        "a4",
        json!({
            "settings": call(&business, "settings", json!([])),
            "customer": customer_row,
            "invoice": invoice,
            "statement": statement,
            "creditNote": call(&business, "findCreditNote", json!([1])),
            "quotation": call(&business, "findQuotation", json!([1, "2026-11-20"])),
        }),
    );
}

/** The till sale the receipts' tests print: two items, one with a discount, paid in cash. */
fn till_sale() -> (Business, Value) {
    let business = open(&shop("بقالة النور"));
    let main = main_warehouse(&business);
    let tax = standard(&business);
    let rice = call(
        &business,
        "addItem",
        json!([{ "nameAr": "أرز مصري 1 كجم", "nameEn": "Egyptian rice 1 kg", "baseUnit": "كيس", "barcode": "11", "salePrice": 3_800, "taxCodeId": tax }]),
    );
    let tea = call(
        &business,
        "addItem",
        json!([{ "nameAr": "شاي ناعم 250 جم", "baseUnit": "علبة", "barcode": "59", "salePrice": 4_750, "taxCodeId": tax }]),
    );
    call(&business, "openShift", json!([0]));
    call(
        &business,
        "postSale",
        json!([{ "date": "2026-11-20", "warehouseId": main,
                 "lines": [{ "itemId": rice, "unit": "base", "quantity": 2_000 },
                           { "itemId": tea, "unit": "base", "quantity": 1_000, "discount": { "kind": "amount", "value": 250 } }],
                 "payments": [{ "method": "cash", "amount": 15_000 }] }]),
    );
    let receipt = call(&business, "findReceipt", json!([1]));
    (business, receipt)
}

/** The sale's receipt, a return of part of it, and the shift's Z report. */
#[test]
fn receipts() {
    let (business, receipt) = till_sale();
    call(
        &business,
        "returnSale",
        json!([{ "date": "2026-11-20", "receiptId": receipt["id"], "lines": [{ "lineId": receipt["lines"][0]["lineId"], "quantity": 1_000 }], "refund": "cash" }]),
    );
    let returned = call(&business, "findReturn", json!([1]));

    let (closing, _) = till_sale();
    let shift = call(&closing, "currentShift", json!([]));
    call(
        &closing,
        "closeShift",
        json!([{ "date": "2026-11-20", "countedCash": 12_000 }]),
    );
    keep(
        "receipts",
        json!({
            "settings": call(&business, "settings", json!([])),
            "receipt": receipt,
            "return": returned,
            "zReport": call(&closing, "zReport", json!([shift["id"]])),
        }),
    );
}

/** Capital and a month's rent, for the printed and exported reports. */
#[test]
fn reports() {
    let business = open(&BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        ..shop("")
    });
    let accounts = call(&business, "accounts", json!([]));
    let find = |key: &str, value: &str| {
        accounts
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a[key] == value)
            .unwrap()["id"]
            .clone()
    };
    let cash = find("role", "main_cash");
    call(
        &business,
        "postJournalEntry",
        json!([{ "date": "2026-03-01", "memo": "رأس المال",
                 "lines": [{ "accountId": cash, "debit": 1_000_000 }, { "accountId": find("role", "capital"), "credit": 1_000_000 }] }]),
    );
    call(
        &business,
        "recordExpense",
        json!([{ "date": "2026-03-05", "expenseAccountId": find("name", "الإيجار"), "amount": 50_000, "vat": 0,
                 "paidFrom": { "accountId": cash }, "memo": "إيجار مارس" }]),
    );
    keep(
        "reports",
        json!({
            "settings": call(&business, "settings", json!([])),
            "profitAndLoss": call(&business, "profitAndLoss", json!(["2026-03-01", "2026-03-31"])),
            "cashLedger": call(&business, "generalLedger", json!([cash, "2026-03-01", "2026-03-31"])),
            "salesByPaymentMethod": call(&business, "salesByPaymentMethod", json!(["2026-03-01", "2026-03-31"])),
        }),
    );
}

/** The import template's example rows, as the screens read them back, import cleanly. */
#[test]
fn the_import_templates_example_rows_import_cleanly() {
    for lang in ["ar", "en"] {
        let path = format!("{FIXTURES}/import-template-{lang}.json");
        let sheets: Value = serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{path} is missing")),
        )
        .unwrap();
        let business = open(&BusinessSettings {
            name: "متجر".into(),
            address: String::new(),
            tax_registration_number: String::new(),
            vat_registered: true,
            fiscal_year_start_month: 1,
        });
        let main = main_warehouse(&business);
        let report = call(
            &business,
            "checkImport",
            json!([{ "date": "2026-01-01", "warehouseId": main, "sheets": sheets }]),
        );
        assert_eq!(report["items"], 1, "{lang}: {report}");
        assert_eq!(report["stockLines"], 1);
        assert_eq!(report["balances"], 3);
        assert_eq!(report["newCustomers"], 1);
        assert_eq!(report["newSuppliers"], 1);
        assert_eq!(report["problems"], json!([]));
    }
}
