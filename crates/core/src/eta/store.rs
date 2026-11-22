//! E-invoice settings and the queue of sales invoices and credit notes for the ETA.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::document::{
    canonical, eta_document, EtaAddress, EtaDocumentInput, EtaLineInput, EtaParty,
};
use crate::error::{refuse, BusinessError, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaSettings {
    pub enabled: bool,
    /** preprod or production. */
    pub environment: String,
    pub client_id: String,
    /** Whether a client secret is saved; the secret itself never leaves the PC that sealed it. */
    pub has_secret: bool,
    /** The four-digit activity code the business is registered under. */
    pub activity_code: String,
    pub address: EtaAddress,
    /** Which certificate on the USB token signs: its thumbprint. */
    pub certificate: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaSettingsInput {
    pub enabled: bool,
    pub environment: String,
    pub client_id: String,
    /** The client secret, sealed by the PC; left out to keep the saved one. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub activity_code: String,
    pub address: EtaAddress,
    pub certificate: String,
}

/** What the PC needs to talk to the ETA: never shown on screens. */
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaCredentials {
    pub environment: String,
    pub client_id: String,
    pub client_secret: String,
    pub certificate: String,
}

/**
 * pending: waiting to be sent. failed: not sent, or refused at submission; fix and retry.
 * submitted: accepted for validation. valid / invalid: the ETA's verdict. cancelled.
 */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EtaState {
    pub status: String,
    pub uuid: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaDocumentRow {
    /** invoice or credit_note. */
    pub kind: String,
    pub document_id: i64,
    pub status: String,
    pub uuid: String,
    pub error: String,
    pub updated_at: String,
    pub number: i64,
    pub date: String,
    pub customer_name: String,
    pub total: i64,
}

/** What the sender learned about one document. */
#[derive(Debug, Clone, Default)]
pub struct EtaOutcome {
    pub status: &'static str,
    pub uuid: Option<String>,
    pub error: Option<String>,
}

/** A refusal that names what is missing, for the screen to show beside its message. */
pub(crate) fn named(code: &'static str, message: String, name: &str) -> BusinessError {
    let mut error = BusinessError::new(code, message);
    error.detail = Some(name.to_string());
    error
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn nine_digits(text: &str) -> bool {
    text.len() == 9 && text.bytes().all(|b| b.is_ascii_digit())
}

struct SettingsRow {
    enabled: bool,
    environment: String,
    client_id: String,
    client_secret: String,
    activity_code: String,
    address: EtaAddress,
    certificate: String,
}

fn settings_row(conn: &Connection) -> Result<SettingsRow> {
    Ok(conn.query_row(
        "SELECT enabled, environment, client_id, client_secret, activity_code, governate, region_city, street,
                building_number, certificate FROM eta_settings WHERE id = 1",
        [],
        |r| {
            Ok(SettingsRow {
                enabled: r.get::<_, i64>(0)? == 1,
                environment: r.get(1)?,
                client_id: r.get(2)?,
                client_secret: r.get(3)?,
                activity_code: r.get(4)?,
                address: EtaAddress {
                    governate: r.get(5)?,
                    region_city: r.get(6)?,
                    street: r.get(7)?,
                    building_number: r.get(8)?,
                },
                certificate: r.get(9)?,
            })
        },
    )?)
}

pub fn eta_settings(conn: &Connection) -> Result<EtaSettings> {
    let r = settings_row(conn)?;
    Ok(EtaSettings {
        enabled: r.enabled,
        environment: r.environment,
        client_id: r.client_id,
        has_secret: !r.client_secret.is_empty(),
        activity_code: r.activity_code,
        address: r.address,
        certificate: r.certificate,
    })
}

pub fn eta_enabled(conn: &Connection) -> Result<bool> {
    Ok(settings_row(conn)?.enabled)
}

pub fn set_eta_settings(conn: &Connection, input: &EtaSettingsInput) -> Result<()> {
    let current = settings_row(conn)?;
    let environment = if input.environment == "production" {
        "production"
    } else {
        "preprod"
    };
    let client_id = input.client_id.trim();
    let client_secret = input.client_secret.clone().unwrap_or(current.client_secret);
    let activity_code = input.activity_code.trim();
    let a = &input.address;
    let (governate, region_city, street, building_number) = (
        a.governate.trim(),
        a.region_city.trim(),
        a.street.trim(),
        a.building_number.trim(),
    );
    let certificate = input.certificate.trim();
    if input.enabled {
        let rin: String = conn.query_row(
            "SELECT tax_registration_number FROM business_settings WHERE id = 1",
            [],
            |r| r.get(0),
        )?;
        if !nine_digits(&rin) {
            return refuse(
                "tax_registration_number_invalid",
                "The business needs its 9-digit tax registration number",
            );
        }
        if !(activity_code.len() == 4 && activity_code.bytes().all(|b| b.is_ascii_digit())) {
            return refuse("activity_code_invalid", "The activity code is 4 digits");
        }
        let missing = [
            client_id,
            client_secret.as_str(),
            governate,
            region_city,
            street,
            building_number,
            certificate,
        ]
        .iter()
        .any(|v| v.is_empty());
        if missing {
            return refuse("eta_settings_incomplete", "Fill in every e-invoice setting");
        }
    }
    conn.execute(
        "UPDATE eta_settings SET enabled = ?, environment = ?, client_id = ?, client_secret = ?, activity_code = ?,
                governate = ?, region_city = ?, street = ?, building_number = ?, certificate = ? WHERE id = 1",
        params![
            i64::from(input.enabled),
            environment,
            client_id,
            client_secret,
            activity_code,
            governate,
            region_city,
            street,
            building_number,
            certificate
        ],
    )?;
    Ok(())
}

pub fn eta_credentials(conn: &Connection) -> Result<EtaCredentials> {
    let r = settings_row(conn)?;
    if !r.enabled {
        return refuse("eta_not_enabled", "E-invoicing is off");
    }
    Ok(EtaCredentials {
        environment: r.environment,
        client_id: r.client_id,
        client_secret: r.client_secret,
        certificate: r.certificate,
    })
}

/** Puts a just-posted document in the queue for the ETA, when e-invoicing is on. Part of the posting's transaction. */
pub fn queue_eta_document(
    conn: &Connection,
    kind: &str,
    document_id: i64,
    now: DateTime<Utc>,
) -> Result<()> {
    if !eta_enabled(conn)? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO eta_documents (kind, document_id, status, updated_at) VALUES (?, ?, 'pending', ?)",
        params![kind, document_id, iso(now)],
    )?;
    Ok(())
}

const DOCUMENTS: &str = "
  SELECT e.kind, e.document_id, e.status, e.uuid, e.error, e.updated_at,
         COALESCE(s.number, n.number), COALESCE(s.date, n.date), c.name,
         CASE e.kind WHEN 'invoice' THEN (SELECT SUM(net + vat) FROM sales_invoice_lines WHERE invoice_id = e.document_id)
                     ELSE (SELECT SUM(net + vat) FROM credit_note_lines WHERE note_id = e.document_id) END
    FROM eta_documents e
    LEFT JOIN sales_invoices s ON e.kind = 'invoice' AND s.id = e.document_id
    LEFT JOIN credit_notes n ON e.kind = 'credit_note' AND n.id = e.document_id
    LEFT JOIN sales_invoices o ON o.id = n.invoice_id
    JOIN customers c ON c.id = COALESCE(s.customer_id, o.customer_id)";

/** Every document sent or waiting to be sent, newest first; or only those in the given states. */
pub fn eta_documents(conn: &Connection, statuses: Option<&[&str]>) -> Result<Vec<EtaDocumentRow>> {
    let filter = match statuses {
        Some(list) => format!(" WHERE e.status IN ({})", vec!["?"; list.len()].join(", ")),
        None => String::new(),
    };
    let mut statement = conn.prepare(&format!("{DOCUMENTS}{filter} ORDER BY e.id DESC"))?;
    let rows = statement.query_map(rusqlite::params_from_iter(statuses.unwrap_or(&[])), |r| {
        Ok(EtaDocumentRow {
            kind: r.get(0)?,
            document_id: r.get(1)?,
            status: r.get(2)?,
            uuid: r.get(3)?,
            error: r.get(4)?,
            updated_at: r.get(5)?,
            number: r.get(6)?,
            date: r.get(7)?,
            customer_name: r.get(8)?,
            total: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn table_of(kind: &str) -> &'static str {
    if kind == "invoice" {
        "sales_invoices"
    } else {
        "credit_notes"
    }
}

/** A document's ETA state by its printed number, or None when it was never queued. */
pub fn eta_state_of(conn: &Connection, kind: &str, number: i64) -> Result<Option<EtaState>> {
    let table = table_of(kind);
    Ok(conn
        .query_row(
            &format!(
                "SELECT e.status, e.uuid, e.error FROM eta_documents e JOIN {table} d ON d.id = e.document_id
                  WHERE e.kind = ? AND d.number = ?"
            ),
            params![kind, number],
            |r| Ok(EtaState { status: r.get(0)?, uuid: r.get(1)?, error: r.get(2)? }),
        )
        .optional()?)
}

struct Queued {
    status: String,
    uuid: String,
    issued_at: Option<String>,
}

fn document_row(conn: &Connection, kind: &str, document_id: i64) -> Result<Queued> {
    conn.query_row(
        "SELECT status, uuid, issued_at FROM eta_documents WHERE kind = ? AND document_id = ?",
        params![kind, document_id],
        |r| {
            Ok(Queued {
                status: r.get(0)?,
                uuid: r.get(1)?,
                issued_at: r.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| {
        BusinessError::new(
            "eta_document_not_found",
            format!("No e-invoice record for {kind} {document_id}"),
        )
    })
}

/** Puts a failed or invalid document back in the queue. */
pub fn retry_eta_document(
    conn: &Connection,
    kind: &str,
    document_id: i64,
    now: DateTime<Utc>,
) -> Result<()> {
    let row = document_row(conn, kind, document_id)?;
    if row.status != "failed" && row.status != "invalid" {
        return refuse(
            "eta_not_retryable",
            "Only failed or invalid documents are sent again",
        );
    }
    conn.execute(
        "UPDATE eta_documents SET status = 'pending', error = '', updated_at = ? WHERE kind = ? AND document_id = ?",
        params![iso(now), kind, document_id],
    )?;
    Ok(())
}

pub fn record_eta_outcome(
    conn: &Connection,
    kind: &str,
    document_id: i64,
    outcome: &EtaOutcome,
    now: DateTime<Utc>,
) -> Result<()> {
    let row = document_row(conn, kind, document_id)?;
    conn.execute(
        "UPDATE eta_documents SET status = ?, uuid = ?, error = ?, updated_at = ? WHERE kind = ? AND document_id = ?",
        params![
            outcome.status,
            outcome.uuid.clone().unwrap_or(row.uuid),
            outcome.error.clone().unwrap_or_default(),
            iso(now),
            kind,
            document_id
        ],
    )?;
    Ok(())
}

/**
 * When a document counts as issued: the stored time if it was prepared before, else its date
 * at 10:00 in Cairo (08:00 UTC), but never later than now; the ETA refuses times in the future.
 */
fn issued_at(stored: Option<&str>, date: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let bad = |e: chrono::ParseError| BusinessError::new("internal", e.to_string());
    if let Some(stored) = stored {
        return Ok(DateTime::parse_from_rfc3339(stored)
            .map_err(bad)?
            .with_timezone(&Utc));
    }
    let morning = DateTime::parse_from_rfc3339(&format!("{date}T08:00:00Z"))
        .map_err(bad)?
        .with_timezone(&Utc);
    let at = morning.min(now);
    Ok(DateTime::from_timestamp(at.timestamp(), 0).expect("a time in range"))
}

struct Head {
    number: i64,
    date: String,
    customer_id: i64,
    invoice_id: Option<i64>,
}

struct LineRow {
    name_ar: String,
    code: Option<String>,
    egs_code: String,
    unit: String,
    unit_name: String,
    tax_kind: String,
    quantity: i64,
    discount: i64,
    net: i64,
    vat_rate: i64,
    vat: i64,
}

const LINE_COLUMNS: &str = "i.name_ar, i.code, i.egs_code, l.unit, u.name,
  CASE WHEN l.vat_rate > 0 THEN 'standard' ELSE t.kind END";
const LINE_JOINS: &str = "JOIN items i ON i.id = l.item_id JOIN tax_codes t ON t.id = i.tax_code_id
  JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit";

/**
 * The unsigned ETA document for a queued sales invoice or credit note, and the canonical text its
 * signature covers. Refuses, naming what is missing, when the document can't be sent yet.
 */
pub fn prepare_eta_document(
    conn: &Connection,
    kind: &str,
    document_id: i64,
    now: DateTime<Utc>,
) -> Result<(Value, String)> {
    let queued = document_row(conn, kind, document_id)?;
    let settings = settings_row(conn)?;
    let (business_name, business_rin): (String, String) = conn.query_row(
        "SELECT name, tax_registration_number FROM business_settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let head_sql = if kind == "invoice" {
        "SELECT number, date, customer_id, NULL FROM sales_invoices WHERE id = ?"
    } else {
        "SELECT n.number, n.date, s.customer_id, s.id FROM credit_notes n JOIN sales_invoices s ON s.id = n.invoice_id WHERE n.id = ?"
    };
    let head = conn.query_row(head_sql, [document_id], |r| {
        Ok(Head {
            number: r.get(0)?,
            date: r.get(1)?,
            customer_id: r.get(2)?,
            invoice_id: r.get(3)?,
        })
    })?;
    let (name, rin, street, governate, region_city, building_number): (String, String, String, String, String, String) =
        conn.query_row(
            "SELECT name, tax_registration_number, address, governate, region_city, building_number FROM customers WHERE id = ?",
            [head.customer_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )?;
    if !nine_digits(&rin) {
        return Err(named(
            "eta_customer_tax_number_required",
            format!("{name} needs a 9-digit tax registration number for e-invoices"),
            &name,
        ));
    }
    if [&street, &governate, &region_city, &building_number]
        .iter()
        .any(|v| v.trim().is_empty())
    {
        return Err(named(
            "eta_customer_address_required",
            format!("{name} needs a governorate, city, street and building number for e-invoices"),
            &name,
        ));
    }
    let lines_sql = if kind == "invoice" {
        format!(
            "SELECT {LINE_COLUMNS}, l.quantity, l.discount, l.net, l.vat_rate, l.vat
               FROM sales_invoice_lines l {LINE_JOINS} WHERE l.invoice_id = ? ORDER BY l.id"
        )
    } else {
        format!(
            "SELECT {LINE_COLUMNS}, x.quantity, 0, x.net, l.vat_rate, x.vat
               FROM credit_note_lines x JOIN sales_invoice_lines l ON l.id = x.invoice_line_id {LINE_JOINS}
              WHERE x.note_id = ? ORDER BY x.id"
        )
    };
    let mut statement = conn.prepare(&lines_sql)?;
    let rows: Vec<LineRow> = statement
        .query_map([document_id], |r| {
            Ok(LineRow {
                name_ar: r.get(0)?,
                code: r.get(1)?,
                egs_code: r.get(2)?,
                unit: r.get(3)?,
                unit_name: r.get(4)?,
                tax_kind: r.get(5)?,
                quantity: r.get(6)?,
                discount: r.get(7)?,
                net: r.get(8)?,
                vat_rate: r.get(9)?,
                vat: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(uncoded) = rows.iter().find(|r| r.egs_code.trim().is_empty()) {
        return Err(named(
            "eta_item_code_required",
            format!(
                "{} needs an EGS or GS1 code for e-invoices",
                uncoded.name_ar
            ),
            &uncoded.name_ar,
        ));
    }
    let mut references = None;
    if kind == "credit_note" {
        let original: Option<(String, String)> = conn
            .query_row(
                "SELECT status, uuid FROM eta_documents WHERE kind = 'invoice' AND document_id = ?",
                [head.invoice_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match original {
            Some((status, uuid)) if status == "valid" => references = Some(vec![uuid]),
            _ => {
                return refuse(
                    "eta_invoice_not_valid",
                    "A credit note goes to the ETA after its invoice is accepted as valid",
                )
            }
        }
    }
    let at = issued_at(queued.issued_at.as_deref(), &head.date, now)?;
    conn.execute(
        "UPDATE eta_documents SET issued_at = ? WHERE kind = ? AND document_id = ?",
        params![iso(at), kind, document_id],
    )?;
    let lines = rows
        .into_iter()
        .map(|r| EtaLineInput {
            description: if r.unit == "pack" {
                format!("{} ({})", r.name_ar, r.unit_name)
            } else {
                r.name_ar
            },
            item_code: r.egs_code.trim().to_string(),
            internal_code: r.code.unwrap_or_default(),
            unit_type: "EA".into(),
            quantity: r.quantity,
            sales_total: r.net + r.discount,
            discount: r.discount,
            net: r.net,
            vat: r.vat,
            vat_rate: r.vat_rate,
            tax_kind: r.tax_kind,
        })
        .collect();
    let document = eta_document(&EtaDocumentInput {
        kind: if kind == "invoice" { "I" } else { "C" },
        issuer: EtaParty {
            rin: business_rin,
            name: business_name,
            address: settings.address,
        },
        activity_code: settings.activity_code,
        receiver: EtaParty {
            rin,
            name,
            address: EtaAddress {
                governate,
                region_city,
                street,
                building_number,
            },
        },
        internal_id: format!(
            "{}-{}",
            if kind == "invoice" { "INV" } else { "CN" },
            head.number
        ),
        issued_at: at,
        lines,
        references,
    });
    let text = canonical(&document);
    Ok((document, text))
}
