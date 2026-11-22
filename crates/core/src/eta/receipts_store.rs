//! E-receipt settings (the POS as registered with the ETA) and the chain of till receipts and returns.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::document::{iso_seconds, EtaAddress};
use super::receipt::{eta_receipt, receipt_qr, EtaReceiptInput, EtaReceiptLineInput, EtaSeller};
use super::store::named;
use crate::error::{refuse, BusinessError, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaReceiptSettings {
    pub enabled: bool,
    /** The POS as registered with the ETA. */
    pub pos_serial: String,
    pub pos_os_version: String,
    pub pos_model: String,
    pub pos_client_id: String,
    /** Whether the POS client secret and pre-shared key are saved; they never leave the PC that sealed them. */
    pub has_pos_secrets: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaReceiptSettingsInput {
    pub enabled: bool,
    pub pos_serial: String,
    pub pos_os_version: String,
    pub pos_model: String,
    pub pos_client_id: String,
    /** Sealed by the PC; left out to keep the saved ones. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos_client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preshared_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaReceiptCredentials {
    pub production: bool,
    pub pos_serial: String,
    pub pos_os_version: String,
    pub pos_model: String,
    pub pos_client_id: String,
    pub pos_client_secret: String,
    pub preshared_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EtaReceiptRow {
    /** sale or return. */
    pub kind: String,
    pub id: i64,
    pub number: i64,
    pub at: String,
    /** pending, failed, submitted, valid or invalid. */
    pub status: String,
    pub uuid: String,
    pub error: String,
}

struct Row {
    enabled: bool,
    receipts_enabled: bool,
    environment: String,
    activity_code: String,
    address: EtaAddress,
    pos_serial: String,
    pos_os_version: String,
    pos_model: String,
    pos_client_id: String,
    pos_client_secret: String,
    pos_preshared_key: String,
    pos_last_uuid: String,
}

fn row(conn: &Connection) -> Result<Row> {
    Ok(conn.query_row(
        "SELECT enabled, receipts_enabled, environment, activity_code, governate, region_city, street, building_number,
                pos_serial, pos_os_version, pos_model, pos_client_id, pos_client_secret, pos_preshared_key, pos_last_uuid
           FROM eta_settings WHERE id = 1",
        [],
        |r| {
            Ok(Row {
                enabled: r.get::<_, i64>(0)? == 1,
                receipts_enabled: r.get::<_, i64>(1)? == 1,
                environment: r.get(2)?,
                activity_code: r.get(3)?,
                address: EtaAddress {
                    governate: r.get(4)?,
                    region_city: r.get(5)?,
                    street: r.get(6)?,
                    building_number: r.get(7)?,
                },
                pos_serial: r.get(8)?,
                pos_os_version: r.get(9)?,
                pos_model: r.get(10)?,
                pos_client_id: r.get(11)?,
                pos_client_secret: r.get(12)?,
                pos_preshared_key: r.get(13)?,
                pos_last_uuid: r.get(14)?,
            })
        },
    )?)
}

fn receipts_on(r: &Row) -> bool {
    r.enabled && r.receipts_enabled
}

pub fn eta_receipt_settings(conn: &Connection) -> Result<EtaReceiptSettings> {
    let r = row(conn)?;
    Ok(EtaReceiptSettings {
        enabled: r.receipts_enabled,
        pos_serial: r.pos_serial,
        pos_os_version: r.pos_os_version,
        pos_model: r.pos_model,
        pos_client_id: r.pos_client_id,
        has_pos_secrets: !r.pos_client_secret.is_empty() && !r.pos_preshared_key.is_empty(),
    })
}

pub fn set_eta_receipt_settings(conn: &Connection, input: &EtaReceiptSettingsInput) -> Result<()> {
    let current = row(conn)?;
    let serial = input.pos_serial.trim();
    let os = input.pos_os_version.trim();
    let model = input.pos_model.trim();
    let client = input.pos_client_id.trim();
    let secret = input
        .pos_client_secret
        .clone()
        .unwrap_or(current.pos_client_secret);
    let key = input
        .preshared_key
        .clone()
        .unwrap_or(current.pos_preshared_key);
    if input.enabled {
        if !current.enabled {
            return refuse("eta_not_enabled", "Turn on e-invoicing first");
        }
        if [serial, os, model, client, &secret, &key]
            .iter()
            .any(|v| v.is_empty())
        {
            return refuse(
                "eta_settings_incomplete",
                "Fill in every POS registration detail",
            );
        }
    }
    conn.execute(
        "UPDATE eta_settings SET receipts_enabled = ?, pos_serial = ?, pos_os_version = ?, pos_model = ?, pos_client_id = ?,
                pos_client_secret = ?, pos_preshared_key = ? WHERE id = 1",
        params![i64::from(input.enabled), serial, os, model, client, secret, key],
    )?;
    Ok(())
}

pub fn eta_receipt_credentials(conn: &Connection) -> Result<EtaReceiptCredentials> {
    let r = row(conn)?;
    if !receipts_on(&r) {
        return refuse("eta_not_enabled", "E-receipts are off");
    }
    Ok(EtaReceiptCredentials {
        production: r.environment == "production",
        pos_serial: r.pos_serial,
        pos_os_version: r.pos_os_version,
        pos_model: r.pos_model,
        pos_client_id: r.pos_client_id,
        pos_client_secret: r.pos_client_secret,
        preshared_key: r.pos_preshared_key,
    })
}

fn table(kind: &str) -> &'static str {
    if kind == "sale" {
        "sales_receipts"
    } else {
        "sales_returns"
    }
}

/**
 * Issues a just-posted till receipt or return as an e-receipt, when e-receipts are on: it gets its
 * UUID and its place in the chain now, so the printed receipt carries its QR code even offline,
 * and it waits to be sent. A return goes only when its sale was an e-receipt, since it must point to it.
 */
pub fn queue_eta_receipt(conn: &Connection, kind: &str, id: i64) -> Result<()> {
    if !receipts_on(&row(conn)?) {
        return Ok(());
    }
    if kind == "return" {
        let original: String = conn.query_row(
            "SELECT r.eta_status FROM sales_returns x JOIN sales_receipts r ON r.id = x.receipt_id WHERE x.id = ?",
            [id],
            |r| r.get(0),
        )?;
        if original.is_empty() {
            return Ok(());
        }
    }
    conn.execute(
        &format!(
            "UPDATE {} SET eta_status = 'pending' WHERE id = ?",
            table(kind)
        ),
        [id],
    )?;
    issue(conn, kind, id)
}

/** Gives a pending receipt its UUID. One that can't be issued yet (an item without a code) is failed, the sale still stands. */
fn issue(conn: &Connection, kind: &str, id: i64) -> Result<()> {
    match prepare_eta_receipt(conn, kind, id) {
        Ok(_) => Ok(()),
        Err(error) if error.code != "internal" => {
            record_eta_receipt(conn, kind, id, "failed", &reason(&error))
        }
        Err(error) => Err(error),
    }
}

/** Why a document failed, as "code" or "code: detail", for the screen to word in its language. */
pub(crate) fn reason(error: &BusinessError) -> String {
    match &error.detail {
        Some(detail) => format!("{}: {detail}", error.code),
        None => error.code.to_string(),
    }
}

const CHAIN: &str = "
  SELECT 'sale' AS kind, id, number, at, eta_status AS status, eta_uuid AS uuid, eta_error AS error FROM sales_receipts WHERE eta_status <> ''
  UNION ALL
  SELECT 'return', id, number, at, eta_status, eta_uuid, eta_error FROM sales_returns WHERE eta_status <> ''";

/** E-receipts in the order the POS issued them, oldest first; or only those in the given states. */
pub fn eta_receipts(conn: &Connection, statuses: Option<&[&str]>) -> Result<Vec<EtaReceiptRow>> {
    let filter = match statuses {
        Some(list) => format!(" WHERE status IN ({})", vec!["?"; list.len()].join(", ")),
        None => String::new(),
    };
    let mut statement = conn.prepare(&format!(
        "SELECT * FROM ({CHAIN}){filter} ORDER BY at, kind DESC, id"
    ))?;
    let rows = statement.query_map(rusqlite::params_from_iter(statuses.unwrap_or(&[])), |r| {
        Ok(EtaReceiptRow {
            kind: r.get(0)?,
            id: r.get(1)?,
            number: r.get(2)?,
            at: r.get(3)?,
            status: r.get(4)?,
            uuid: r.get(5)?,
            error: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/** The receipt's time to the second: `at` is an ISO time with milliseconds. */
fn at_second(at: &str) -> Result<DateTime<Utc>> {
    let parsed = DateTime::parse_from_rfc3339(at)
        .map_err(|e| BusinessError::new("internal", e.to_string()))?
        .with_timezone(&Utc);
    Ok(DateTime::from_timestamp(parsed.timestamp(), 0).expect("a time in range"))
}

struct Head {
    number: i64,
    at: String,
    uuid: String,
    previous: String,
    original: Option<String>,
}

/**
 * The e-receipt for a queued receipt or return, with its UUID, chained to the one issued before it.
 * The UUID and the link are kept, so sending it again after a network failure sends the same receipt.
 */
pub fn prepare_eta_receipt(conn: &Connection, kind: &str, id: i64) -> Result<(Value, String)> {
    let settings = row(conn)?;
    let (business_name, rin): (String, String) = conn.query_row(
        "SELECT name, tax_registration_number FROM business_settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let head_sql = if kind == "sale" {
        "SELECT number, at, eta_uuid, eta_previous_uuid, NULL FROM sales_receipts WHERE id = ?"
    } else {
        "SELECT x.number, x.at, x.eta_uuid, x.eta_previous_uuid, r.eta_uuid
           FROM sales_returns x JOIN sales_receipts r ON r.id = x.receipt_id WHERE x.id = ?"
    };
    let head = conn.query_row(head_sql, [id], |r| {
        Ok(Head {
            number: r.get(0)?,
            at: r.get(1)?,
            uuid: r.get(2)?,
            previous: r.get(3)?,
            original: r.get(4)?,
        })
    })?;
    let columns = "i.name_ar, i.code, i.egs_code, l.unit, u.name, CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END, l.vat_rate";
    let joins = "JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit";
    let sql = if kind == "sale" {
        format!("SELECT {columns}, l.quantity, l.gross, l.net, l.vat FROM sales_receipt_lines l {joins} WHERE l.receipt_id = ? ORDER BY l.id")
    } else {
        format!(
            "SELECT {columns}, x.quantity, x.amount, x.net, x.vat
               FROM sales_return_lines x JOIN sales_receipt_lines l ON l.id = x.receipt_line_id {joins} WHERE x.return_id = ? ORDER BY x.id"
        )
    };
    struct Line {
        name_ar: String,
        code: Option<String>,
        egs_code: String,
        unit: String,
        unit_name: String,
        tax_kind: String,
        vat_rate: i64,
        quantity: i64,
        gross: i64,
        net: i64,
        vat: i64,
    }
    let mut statement = conn.prepare(&sql)?;
    let lines: Vec<Line> = statement
        .query_map([id], |r| {
            Ok(Line {
                name_ar: r.get(0)?,
                code: r.get(1)?,
                egs_code: r.get(2)?,
                unit: r.get(3)?,
                unit_name: r.get(4)?,
                tax_kind: r.get(5)?,
                vat_rate: r.get(6)?,
                quantity: r.get(7)?,
                gross: r.get(8)?,
                net: r.get(9)?,
                vat: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(uncoded) = lines.iter().find(|l| l.egs_code.trim().is_empty()) {
        return Err(named(
            "eta_item_code_required",
            format!(
                "{} needs an EGS or GS1 code for e-receipts",
                uncoded.name_ar
            ),
            &uncoded.name_ar,
        ));
    }
    if kind == "return" && head.original.as_deref().unwrap_or("").is_empty() {
        return refuse("eta_invoice_not_valid", "The original receipt was not sent");
    }
    // The receipt before this one in the chain: the last one this POS issued.
    let previous = if head.uuid.is_empty() {
        settings.pos_last_uuid.clone()
    } else {
        head.previous.clone()
    };
    let method = if kind == "return" {
        "C"
    } else {
        payment_method(conn, id)?
    };
    let short = if kind == "sale" { "S" } else { "R" };
    let (receipt, uuid) = eta_receipt(&EtaReceiptInput {
        kind: short,
        receipt_number: format!("{short}-{}", head.number),
        issued_at: at_second(&head.at)?,
        previous_uuid: previous.clone(),
        reference_uuid: head.original.clone().filter(|o| !o.is_empty()),
        seller: EtaSeller {
            rin,
            name: business_name,
            activity_code: settings.activity_code,
            address: settings.address,
            device_serial_number: settings.pos_serial,
        },
        payment_method: method,
        lines: lines
            .into_iter()
            .map(|l| EtaReceiptLineInput {
                description: if l.unit == "pack" {
                    format!("{} ({})", l.name_ar, l.unit_name)
                } else {
                    l.name_ar
                },
                item_code: l.egs_code.trim().to_string(),
                internal_code: l.code.unwrap_or_default(),
                quantity: l.quantity,
                gross: l.gross,
                net: l.net,
                vat: l.vat,
                vat_rate: l.vat_rate,
                tax_kind: l.tax_kind,
            })
            .collect(),
    });
    if head.uuid.is_empty() {
        conn.execute(
            &format!(
                "UPDATE {} SET eta_uuid = ?, eta_previous_uuid = ? WHERE id = ?",
                table(kind)
            ),
            params![uuid, previous, id],
        )?;
        conn.execute(
            "UPDATE eta_settings SET pos_last_uuid = ? WHERE id = 1",
            [&uuid],
        )?;
    }
    Ok((receipt, uuid))
}

/** C for cash, V for card, O for wallets and sales on account: whichever paid the most. */
fn payment_method(conn: &Connection, receipt_id: i64) -> Result<&'static str> {
    let top: Option<String> = conn
        .query_row(
            "SELECT method FROM sales_receipt_payments WHERE receipt_id = ? ORDER BY amount DESC LIMIT 1",
            [receipt_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match top.as_deref() {
        Some("cash") => "C",
        Some("card") => "V",
        _ => "O",
    })
}

pub fn record_eta_receipt(
    conn: &Connection,
    kind: &str,
    id: i64,
    status: &str,
    error: &str,
) -> Result<()> {
    conn.execute(
        &format!(
            "UPDATE {} SET eta_status = ?, eta_error = ? WHERE id = ?",
            table(kind)
        ),
        params![status, error, id],
    )?;
    Ok(())
}

/** Sends a failed or invalid receipt again, once fixed. */
pub fn retry_eta_receipt(conn: &Connection, kind: &str, id: i64) -> Result<()> {
    let current: Option<String> = conn
        .query_row(
            &format!("SELECT eta_status FROM {} WHERE id = ?", table(kind)),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if !matches!(current.as_deref(), Some("failed") | Some("invalid")) {
        return refuse(
            "eta_not_retryable",
            "Only failed or invalid receipts are sent again",
        );
    }
    // The ETA doesn't keep a refused or invalid receipt, so it goes again as a new one at the end of the chain.
    conn.execute(
        &format!(
            "UPDATE {} SET eta_status = 'pending', eta_error = '', eta_uuid = '', eta_previous_uuid = '' WHERE id = ?",
            table(kind)
        ),
        [id],
    )?;
    issue(conn, kind, id)
}

/** The QR code text for a printed receipt or return, once it is issued as an e-receipt; None otherwise. */
pub fn eta_receipt_qr_of(conn: &Connection, kind: &str, number: i64) -> Result<Option<String>> {
    let found: Option<(i64, String, String, String)> = conn
        .query_row(
            &format!(
                "SELECT id, at, eta_uuid, eta_status FROM {} WHERE number = ?",
                table(kind)
            ),
            [number],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((id, at, uuid, status)) = found else {
        return Ok(None);
    };
    if uuid.is_empty() || status == "failed" || status == "invalid" {
        return Ok(None);
    }
    let total_sql = if kind == "sale" {
        "SELECT SUM(net + vat) FROM sales_receipt_lines WHERE receipt_id = ?"
    } else {
        "SELECT SUM(net + vat) FROM sales_return_lines WHERE return_id = ?"
    };
    let total: i64 = conn.query_row(total_sql, [id], |r| r.get(0))?;
    let rin: String = conn.query_row(
        "SELECT tax_registration_number FROM business_settings WHERE id = 1",
        [],
        |r| r.get(0),
    )?;
    let production = row(conn)?.environment == "production";
    Ok(Some(receipt_qr(
        &uuid,
        &iso_seconds(at_second(&at)?),
        total,
        &rin,
        production,
    )))
}
