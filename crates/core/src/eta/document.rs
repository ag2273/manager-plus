//! Sales invoices and credit notes in the ETA's JSON document format (v1.0), and the canonical
//! text a document's signature covers. Numbers come out as JavaScript writes them, so a document
//! is byte for byte the one the Electron app sent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaAddress {
    pub governate: String,
    pub region_city: String,
    pub street: String,
    pub building_number: String,
}

pub struct EtaParty {
    pub rin: String,
    pub name: String,
    pub address: EtaAddress,
}

/** One line, in the app's own units: thousandths, piastres and basis points. */
pub struct EtaLineInput {
    pub description: String,
    /** An EGS code ("EG-<RIN>-<code>") or a GS1 barcode (GTIN). */
    pub item_code: String,
    pub internal_code: String,
    pub unit_type: String,
    pub quantity: i64,
    /** Before discount and VAT: quantity × unit price. */
    pub sales_total: i64,
    pub discount: i64,
    pub net: i64,
    pub vat: i64,
    pub vat_rate: i64,
    /** standard, zero_rated or exempt. */
    pub tax_kind: String,
}

pub struct EtaDocumentInput {
    /** "I" an invoice, "C" a credit note. */
    pub kind: &'static str,
    pub issuer: EtaParty,
    pub activity_code: String,
    pub receiver: EtaParty,
    pub internal_id: String,
    /** UTC, to the second. */
    pub issued_at: chrono::DateTime<chrono::Utc>,
    pub lines: Vec<EtaLineInput>,
    /** A credit note's original invoice, by its ETA UUID. */
    pub references: Option<Vec<String>>,
}

/** T1 (VAT) subtypes. Zero-rated sales are exports (V001); exempt goods V003; everything else V009. */
pub fn subtype(tax_kind: &str) -> &'static str {
    match tax_kind {
        "zero_rated" => "V001",
        "exempt" => "V003",
        _ => "V009",
    }
}

/**
 * JavaScript's `Number(x.toFixed(digits))`: rounded to `digits` decimals from the exact binary
 * value, a tie going to the larger magnitude.
 */
pub fn to_fixed(x: f64, digits: usize) -> f64 {
    let exact = format!("{:.1100}", x.abs());
    let (whole, decimals) = exact.split_once('.').unwrap_or((&exact, ""));
    let tie = decimals.as_bytes().get(digits) == Some(&b'5')
        && decimals.as_bytes()[digits + 1..].iter().all(|b| *b == b'0');
    let rounded: f64 = if tie {
        // Exactly halfway: the larger of the two neighbours, one step above the truncated value.
        let truncated: f64 = format!("{whole}.{}", &decimals[..digits]).parse().unwrap();
        format!("{:.*}", digits, truncated + 10f64.powi(-(digits as i32)))
            .parse()
            .unwrap()
    } else {
        format!("{:.*}", digits, x.abs()).parse().unwrap()
    };
    if x < 0.0 {
        -rounded
    } else {
        rounded
    }
}

/** A number as JSON the way JavaScript writes it: whole numbers without a decimal point. */
pub fn js(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

/** Piastres as pounds. */
pub fn pounds(piastres: i64) -> Value {
    js(to_fixed(piastres as f64 / 100.0, 2))
}

/** Thousandths as units. */
pub fn units(thousandths: i64) -> Value {
    js(to_fixed(thousandths as f64 / 1000.0, 3))
}

/** The item type ETA expects for a code: EGS for the business's own "EG-…" codes, GS1 otherwise. */
pub fn item_type(code: &str) -> &'static str {
    if code.to_uppercase().starts_with("EG-") {
        "EGS"
    } else {
        "GS1"
    }
}

fn address(a: &EtaAddress, branch: Option<&str>) -> Value {
    let mut out = Map::new();
    if let Some(b) = branch {
        out.insert("branchID".into(), json!(b));
    }
    out.insert("country".into(), json!("EG"));
    out.insert("governate".into(), json!(a.governate));
    out.insert("regionCity".into(), json!(a.region_city));
    out.insert("street".into(), json!(a.street));
    out.insert("buildingNumber".into(), json!(a.building_number));
    Value::Object(out)
}

/** "2026-11-20T08:00:00Z": UTC to the second, as `toISOString` without its milliseconds. */
pub fn iso_seconds(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/** The document as the ETA takes it, without its signatures. */
pub fn eta_document(input: &EtaDocumentInput) -> Value {
    let sum = |pick: fn(&EtaLineInput) -> i64| input.lines.iter().map(pick).sum::<i64>();
    let lines: Vec<Value> = input
        .lines
        .iter()
        .map(|l| {
            json!({
                "description": l.description,
                "itemType": item_type(&l.item_code),
                "itemCode": l.item_code,
                "unitType": l.unit_type,
                "quantity": units(l.quantity),
                "internalCode": l.internal_code,
                "salesTotal": pounds(l.sales_total),
                "total": pounds(l.net + l.vat),
                "valueDifference": 0,
                "totalTaxableFees": 0,
                "netTotal": pounds(l.net),
                "itemsDiscount": 0,
                "unitValue": {
                    "currencySold": "EGP",
                    "amountEGP": js(to_fixed(l.sales_total as f64 / 100.0 / (l.quantity as f64 / 1000.0), 5)),
                },
                "discount": { "rate": 0, "amount": pounds(l.discount) },
                "taxableItems": [{
                    "taxType": "T1",
                    "amount": pounds(l.vat),
                    "subType": subtype(&l.tax_kind),
                    "rate": js(l.vat_rate as f64 / 100.0),
                }],
            })
        })
        .collect();
    let mut out = Map::new();
    out.insert(
        "issuer".into(),
        json!({ "address": address(&input.issuer.address, Some("0")), "type": "B", "id": input.issuer.rin, "name": input.issuer.name }),
    );
    out.insert(
        "receiver".into(),
        json!({ "address": address(&input.receiver.address, None), "type": "B", "id": input.receiver.rin, "name": input.receiver.name }),
    );
    out.insert("documentType".into(), json!(input.kind));
    out.insert("documentTypeVersion".into(), json!("1.0"));
    out.insert("dateTimeIssued".into(), json!(iso_seconds(input.issued_at)));
    out.insert("taxpayerActivityCode".into(), json!(input.activity_code));
    out.insert("internalID".into(), json!(input.internal_id));
    if let Some(references) = &input.references {
        out.insert("references".into(), json!(references));
    }
    out.insert("invoiceLines".into(), Value::Array(lines));
    out.insert("totalDiscountAmount".into(), pounds(sum(|l| l.discount)));
    out.insert("totalSalesAmount".into(), pounds(sum(|l| l.sales_total)));
    out.insert("netAmount".into(), pounds(sum(|l| l.net)));
    out.insert(
        "taxTotals".into(),
        json!([{ "taxType": "T1", "amount": pounds(sum(|l| l.vat)) }]),
    );
    out.insert("totalAmount".into(), pounds(sum(|l| l.net + l.vat)));
    out.insert("extraDiscountAmount".into(), json!(0));
    out.insert("totalItemsDiscountAmount".into(), json!(0));
    Value::Object(out)
}

/**
 * The ETA's canonical serialisation, which the signature covers: every property name in capitals
 * and quotes, followed by its value in quotes; an array repeats its property name before each element.
 */
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let name = format!("\"{}\"", js_upper(key));
                out.push_str(&name);
                match child {
                    Value::Array(items) => {
                        for item in items {
                            out.push_str(&name);
                            write_canonical(item, out);
                        }
                    }
                    other => write_canonical(other, out),
                }
            }
        }
        // `String([a, b])` in JavaScript: the elements joined by commas. Never in a document.
        Value::Array(items) => {
            let text: Vec<String> = items.iter().map(js_string).collect();
            out.push('"');
            out.push_str(&text.join(","));
            out.push('"');
        }
        other => {
            out.push('"');
            out.push_str(&js_string(other));
            out.push('"');
        }
    }
}

/** `String(value)` for a JSON scalar, as JavaScript writes it. */
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/** `toUpperCase()`: property names here are ASCII, but Unicode case mapping is what JavaScript does. */
fn js_upper(text: &str) -> String {
    text.to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_as_javascript_does() {
        assert_eq!(to_fixed(0.015625, 5), 0.01563);
        assert_eq!(to_fixed(1.005, 2), 1.0); // 1.005 is just below in binary
        assert_eq!(to_fixed(2.5, 0), 3.0);
        assert_eq!(to_fixed(1200.0, 5), 1200.0);
        assert_eq!(pounds(262_200).to_string(), "2622");
        assert_eq!(pounds(115_050).to_string(), "1150.5");
        assert_eq!(units(1_500).to_string(), "1.5");
    }

    #[test]
    fn the_canonical_form_names_in_capitals_values_in_quotes_array_elements_under_their_name() {
        let value = json!({ "issuer": { "id": "123", "type": "B" }, "invoiceLines": [{ "quantity": 2 }, { "quantity": 1.5 }], "taxTotals": [] });
        assert_eq!(
            canonical(&value),
            r#""ISSUER""ID""123""TYPE""B""INVOICELINES""INVOICELINES""QUANTITY""2""INVOICELINES""QUANTITY""1.5""TAXTOTALS""#
        );
    }
}
