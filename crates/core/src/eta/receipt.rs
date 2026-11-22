//! E-receipts (v1.2) for till sales and returns, chained by UUID, and the QR code they print.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::document::{
    canonical, iso_seconds, item_type, js, pounds, subtype, to_fixed, units, EtaAddress,
};

/** One till line, in the app's units; amounts are VAT-inclusive as the till keeps them. */
pub struct EtaReceiptLineInput {
    pub description: String,
    pub item_code: String,
    pub internal_code: String,
    pub quantity: i64,
    /** Before discounts, VAT included. */
    pub gross: i64,
    /** After discounts, VAT excluded. */
    pub net: i64,
    pub vat: i64,
    pub vat_rate: i64,
    pub tax_kind: String,
}

pub struct EtaSeller {
    pub rin: String,
    pub name: String,
    pub activity_code: String,
    pub address: EtaAddress,
    pub device_serial_number: String,
}

pub struct EtaReceiptInput {
    /** "S" a sale, "R" a return against an earlier receipt. */
    pub kind: &'static str,
    pub receipt_number: String,
    pub issued_at: chrono::DateTime<chrono::Utc>,
    /** The UUID of the receipt this POS sent before this one; "" for its first. */
    pub previous_uuid: String,
    /** A return's original receipt. */
    pub reference_uuid: Option<String>,
    pub seller: EtaSeller,
    /** C cash, V card, O other (wallets, on account). */
    pub payment_method: &'static str,
    pub lines: Vec<EtaReceiptLineInput>,
}

/** Splits a VAT-inclusive discount into the part before VAT, at the line's rate. */
fn before_vat(amount: i64, rate: i64) -> i64 {
    crate::num::mul_div_round(amount, 10_000, 10_000 + rate)
}

/**
 * The e-receipt as the ETA takes it, with its UUID: SHA-256 of the receipt's canonical form with
 * an empty UUID, in hex. Each receipt names the one before it, so the POS's receipts form a chain.
 */
pub fn eta_receipt(input: &EtaReceiptInput) -> (Value, String) {
    let parts: Vec<(i64, i64)> = input
        .lines
        .iter()
        .map(|l| {
            let discount = before_vat(l.gross - l.net - l.vat, l.vat_rate);
            (discount, l.net + discount)
        })
        .collect();
    let lines: Vec<Value> = input
        .lines
        .iter()
        .zip(&parts)
        .map(|(l, &(discount, total_sale))| {
            let discounts = if discount > 0 {
                json!([{ "amount": pounds(discount), "description": "Discount" }])
            } else {
                json!([])
            };
            json!({
                "internalCode": l.internal_code,
                "description": l.description,
                "itemType": item_type(&l.item_code),
                "itemCode": l.item_code,
                "unitType": "EA",
                "quantity": units(l.quantity),
                "unitPrice": js(to_fixed(total_sale as f64 / 100.0 / (l.quantity as f64 / 1000.0), 5)),
                "netSale": pounds(l.net),
                "totalSale": pounds(total_sale),
                "total": pounds(l.net + l.vat),
                "commercialDiscountData": discounts,
                "itemDiscountData": [],
                "valueDifference": 0,
                "taxableItems": [{ "taxType": "T1", "amount": pounds(l.vat), "subType": subtype(&l.tax_kind), "rate": js(l.vat_rate as f64 / 100.0) }],
            })
        })
        .collect();
    let vat: i64 = input.lines.iter().map(|l| l.vat).sum();
    let net: i64 = input.lines.iter().map(|l| l.net).sum();
    let total_sales: i64 = parts.iter().map(|p| p.1).sum();
    let total_discount: i64 = parts.iter().map(|p| p.0).sum();
    let a = &input.seller.address;
    let build = |uuid: &str| {
        json!({
            "header": {
                "dateTimeIssued": iso_seconds(input.issued_at),
                "receiptNumber": input.receipt_number,
                "uuid": uuid,
                "previousUUID": input.previous_uuid,
                "referenceOldUUID": input.reference_uuid.clone().unwrap_or_default(),
                "currency": "EGP",
                "exchangeRate": 0,
                "sOrderNameCode": "",
                "orderdeliveryMode": "",
                "grossWeight": 0,
                "netWeight": 0,
            },
            "documentType": { "receiptType": if input.kind == "S" { "S" } else { "R" }, "typeVersion": "1.2" },
            "seller": {
                "rin": input.seller.rin,
                "companyTradeName": input.seller.name,
                "branchCode": "0",
                "branchAddress": { "country": "EG", "governate": a.governate, "regionCity": a.region_city, "street": a.street, "buildingNumber": a.building_number },
                "deviceSerialNumber": input.seller.device_serial_number,
                "syndicateLicenseNumber": "",
                "activityCode": input.seller.activity_code,
            },
            "buyer": { "type": "P", "id": "", "name": "", "mobileNumber": "", "paymentNumber": "" },
            "itemData": lines,
            "totalSales": pounds(total_sales),
            "totalCommercialDiscount": pounds(total_discount),
            "totalItemsDiscount": 0,
            "extraReceiptDiscountData": [],
            "netAmount": pounds(net),
            "feesAmount": 0,
            "totalAmount": pounds(net + vat),
            "taxTotals": [{ "taxType": "T1", "amount": pounds(vat) }],
            "paymentMethod": input.payment_method,
            "adjustment": 0,
        })
    };
    let uuid: String = Sha256::digest(canonical(&build("")).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (build(&uuid), uuid)
}

/** What the receipt's QR code holds: the ETA's public page for it, with its time, total and the seller's tax number. */
pub fn receipt_qr(uuid: &str, issued_at: &str, total: i64, rin: &str, production: bool) -> String {
    let host = if production {
        "invoicing.eta.gov.eg"
    } else {
        "preprod.invoicing.eta.gov.eg"
    };
    format!(
        "https://{host}/receipts/search/{uuid}/share/{issued_at}#Total:{},IssuerRIN:{rin}",
        pounds(total)
    )
}
