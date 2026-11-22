use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::business::to_western_digits;
use crate::currency::{assert_rate, is_currency, to_egp, Rate, ONE};
use crate::dates::{assert_iso_date, IsoDate};
use crate::error::{refuse, Result};
use crate::items::{vat_rate, BasisPoints, Quantity, ONE_BASE_UNIT};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, nullable, safe_int};
use crate::serials::{issue_serials, receive_serials, serials_for, Move};
use crate::shares::{next_number, share_of, take, Taken};
use crate::stock::{
    account_by_role, active_warehouse, assert_quantity, insert_movement, to_base_quantity,
    NewMovement, UnitLine,
};
use crate::withholding::assert_withholding_category;

const WHOLE: i64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub tax_registration_number: String,
    pub currency: String,
    /** The withholding tax category the business usually deducts under when paying them. */
    pub withholding_category_id: Option<i64>,
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierInput {
    pub name: String,
    pub phone: String,
    pub tax_registration_number: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withholding_category_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierChanges {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_registration_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub withholding_category_id: Option<Option<i64>>,
}

/** What the business owes the supplier in their own currency, and what that stands at in EGP in the books. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierAccount {
    pub currency: String,
    pub owed: i64,
    pub owed_egp: Piastres,
}

/** A purchase line: quantity in thousandths of the chosen unit, price per one of that unit, VAT-exclusive. */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLineInput {
    pub item_id: i64,
    pub unit: String,
    pub quantity: f64,
    pub unit_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInvoiceInput {
    pub date: IsoDate,
    pub supplier_id: i64,
    pub warehouse_id: i64,
    /** The supplier's own invoice number. */
    pub reference: String,
    /** EGP per unit of the supplier's currency, in millionths; required when they bill in another currency. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    /** In the supplier's currency: prices and amounts in its minor units. */
    pub lines: Vec<PurchaseLineInput>,
}

/** The currency an invoice is in and its rate; EGP at one when left out. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseMoney {
    pub currency: String,
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLine {
    pub item_id: i64,
    pub unit: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    pub net: Piastres,
    pub vat_rate: BasisPoints,
    pub vat: Piastres,
}

/** Amounts in the invoice's currency, and the total in EGP at the invoice's rate. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricedPurchase {
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    pub total_egp: Piastres,
    pub lines: Vec<PurchaseLine>,
}

/** A posted purchase line, with how much of it already went back to the supplier. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedPurchaseLine {
    pub line_id: i64,
    pub item_id: i64,
    pub name_ar: String,
    pub unit: String,
    pub quantity: Quantity,
    pub unit_price: Piastres,
    pub net: Piastres,
    pub vat_rate: BasisPoints,
    pub vat: Piastres,
    pub returned: Quantity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInvoice {
    pub id: i64,
    pub date: IsoDate,
    pub supplier_id: i64,
    pub warehouse_id: i64,
    pub reference: String,
    pub currency: String,
    pub rate: Rate,
    /** What the invoice put on the supplier's account in EGP. */
    pub total_egp: Piastres,
    pub posted_by: String,
    /** In the invoice's currency. */
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    pub lines: Vec<PostedPurchaseLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnedLine {
    pub line_id: i64,
    pub quantity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebitNoteInput {
    pub date: IsoDate,
    pub purchase_invoice_id: i64,
    pub reason: String,
    /** Purchase invoice lines and how much of each goes back, in thousandths of the line's unit. */
    pub lines: Vec<ReturnedLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostedNote {
    pub id: i64,
    pub number: i64,
    pub total: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebitNoteLine {
    pub item_id: i64,
    pub name_ar: String,
    pub unit: String,
    pub quantity: Quantity,
    pub net: Piastres,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebitNote {
    pub id: i64,
    pub number: i64,
    pub date: IsoDate,
    pub purchase_invoice_id: i64,
    pub supplier_id: i64,
    pub reason: String,
    pub posted_by: String,
    pub lines: Vec<DebitNoteLine>,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
}

const SUPPLIER_COLUMNS: &str =
    "id, name, phone, tax_registration_number, currency, withholding_category_id, active";

fn to_supplier(r: &Row) -> rusqlite::Result<Supplier> {
    Ok(Supplier {
        id: r.get(0)?,
        name: r.get(1)?,
        phone: r.get(2)?,
        tax_registration_number: r.get(3)?,
        currency: r.get(4)?,
        withholding_category_id: r.get(5)?,
        active: r.get::<_, i64>(6)? == 1,
    })
}

pub fn list_suppliers(conn: &Connection) -> Result<Vec<Supplier>> {
    Ok(conn
        .prepare(&format!(
            "SELECT {SUPPLIER_COLUMNS} FROM suppliers ORDER BY name"
        ))?
        .query_map([], to_supplier)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn find_supplier(conn: &Connection, id: i64) -> Result<Supplier> {
    let found = conn
        .query_row(
            &format!("SELECT {SUPPLIER_COLUMNS} FROM suppliers WHERE id = ?"),
            [id],
            to_supplier,
        )
        .optional()?;
    match found {
        Some(s) => Ok(s),
        None => refuse("supplier_not_found", format!("No supplier with id {id}")),
    }
}

/** A tax registration number as typed: Arabic-Indic digits become Western, and it must be 9 digits or none. */
pub fn clean_trn(text: &str) -> Result<String> {
    let trn = to_western_digits(text.trim());
    if !trn.is_empty() && !(trn.len() == 9 && trn.bytes().all(|b| b.is_ascii_digit())) {
        return refuse(
            "tax_registration_number_invalid",
            "Tax registration number must be 9 digits",
        );
    }
    Ok(trn)
}

struct CleanSupplier {
    name: String,
    phone: String,
    trn: String,
    currency: String,
    withholding_category_id: Option<i64>,
}

fn clean_supplier(
    conn: &Connection,
    input: &SupplierInput,
    except: Option<i64>,
) -> Result<CleanSupplier> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return refuse("supplier_name_required", "A supplier needs a name");
    }
    let owner: Option<i64> = conn
        .query_row("SELECT id FROM suppliers WHERE name = ?", [&name], |r| {
            r.get(0)
        })
        .optional()?;
    if owner.is_some() && owner != except {
        return refuse(
            "supplier_name_taken",
            format!("A supplier called {name} exists"),
        );
    }
    let trn = clean_trn(&input.tax_registration_number)?;
    let currency = input.currency.clone().unwrap_or_else(|| "EGP".into());
    if !is_currency(&currency) {
        return refuse("currency_invalid", format!("Unknown currency {currency}"));
    }
    assert_withholding_category(conn, input.withholding_category_id)?;
    Ok(CleanSupplier {
        name,
        phone: input.phone.trim().to_string(),
        trn,
        currency,
        withholding_category_id: input.withholding_category_id,
    })
}

pub fn add_supplier(conn: &Connection, input: &SupplierInput) -> Result<i64> {
    let s = clean_supplier(conn, input, None)?;
    conn.execute(
        "INSERT INTO suppliers (name, phone, tax_registration_number, currency, withholding_category_id) VALUES (?, ?, ?, ?, ?)",
        params![s.name, s.phone, s.trn, s.currency, s.withholding_category_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_supplier(conn: &Connection, id: i64, changes: &SupplierChanges) -> Result<()> {
    let current = find_supplier(conn, id)?;
    let merged = SupplierInput {
        name: changes.name.clone().unwrap_or(current.name.clone()),
        phone: changes.phone.clone().unwrap_or(current.phone),
        tax_registration_number: changes
            .tax_registration_number
            .clone()
            .unwrap_or(current.tax_registration_number),
        currency: Some(changes.currency.clone().unwrap_or(current.currency.clone())),
        withholding_category_id: changes
            .withholding_category_id
            .unwrap_or(current.withholding_category_id),
    };
    let s = clean_supplier(conn, &merged, Some(id))?;
    if s.currency != current.currency {
        let posted = conn
            .query_row(
                "SELECT 1 FROM ledger_lines WHERE supplier_id = ? LIMIT 1",
                [id],
                |_| Ok(()),
            )
            .optional()?;
        if posted.is_some() {
            return refuse(
                "supplier_currency_locked",
                format!(
                    "Supplier {} already has postings in {}",
                    current.name, current.currency
                ),
            );
        }
    }
    conn.execute(
        "UPDATE suppliers SET name = ?, phone = ?, tax_registration_number = ?, currency = ?, withholding_category_id = ? WHERE id = ?",
        params![s.name, s.phone, s.trn, s.currency, s.withholding_category_id, id],
    )?;
    Ok(())
}

pub fn set_supplier_active(conn: &Connection, id: i64, active: bool) -> Result<()> {
    find_supplier(conn, id)?;
    conn.execute(
        "UPDATE suppliers SET active = ? WHERE id = ?",
        params![active as i64, id],
    )?;
    Ok(())
}

/** What the business owes the supplier, from the payables lines in the ledger. */
pub fn supplier_balance(conn: &Connection, id: i64) -> Result<Piastres> {
    find_supplier(conn, id)?;
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(credit) - SUM(debit), 0) FROM ledger_lines WHERE supplier_id = ?",
        [id],
        |r| r.get(0),
    )?)
}

pub fn supplier_account(conn: &Connection, id: i64) -> Result<SupplierAccount> {
    let supplier = find_supplier(conn, id)?;
    let (owed, owed_egp) = conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN credit > 0 THEN COALESCE(foreign_amount, credit) ELSE -COALESCE(foreign_amount, debit) END), 0),
                COALESCE(SUM(credit) - SUM(debit), 0)
           FROM ledger_lines WHERE supplier_id = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(SupplierAccount {
        currency: supplier.currency,
        owed,
        owed_egp,
    })
}

/** A supplier that can take a new invoice, payment or note. */
pub fn assert_postable(supplier: &Supplier) -> Result<()> {
    if !supplier.active {
        return refuse(
            "supplier_inactive",
            format!("Supplier {} is stopped", supplier.name),
        );
    }
    Ok(())
}

/** The rate a supplier's document posts at: the one typed for a foreign currency, none for EGP. */
pub fn document_rate(supplier: &Supplier, rate: Option<f64>) -> Result<Rate> {
    if supplier.currency != "EGP" && rate.is_none() {
        return refuse(
            "rate_invalid",
            format!(
                "Supplier {} bills in {}; the document needs an exchange rate",
                supplier.name, supplier.currency
            ),
        );
    }
    assert_rate(&supplier.currency, rate.unwrap_or(ONE as f64))
}

pub fn vat_registered(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT vat_registered FROM business_settings WHERE id = 1",
        [],
        |r| r.get::<_, i64>(0),
    )? == 1)
}

/** A priced line, with what the books need besides what the screens see. */
pub struct PricedLine {
    pub line: PurchaseLine,
    pub base_quantity: Quantity,
    pub net_egp: Piastres,
    pub vat_egp: Piastres,
}

pub struct Priced {
    pub lines: Vec<PricedLine>,
    pub net: Piastres,
    pub vat: Piastres,
    pub net_egp: Piastres,
    pub vat_egp: Piastres,
}

impl Priced {
    pub fn summary(self) -> PricedPurchase {
        PricedPurchase {
            net: self.net,
            vat: self.vat,
            total: self.net + self.vat,
            total_egp: self.net_egp + self.vat_egp,
            lines: self.lines.into_iter().map(|l| l.line).collect(),
        }
    }
}

/**
 * Prices invoice lines without posting: net per line, and VAT rounded half-up on each line.
 * A foreign supplier charges no Egyptian VAT: VAT on imports is paid at customs.
 */
pub fn price_purchase(
    conn: &Connection,
    date: &str,
    lines: &[PurchaseLineInput],
    money: Option<&PurchaseMoney>,
) -> Result<Priced> {
    assert_iso_date(date)?;
    let (currency, rate) = match money {
        Some(m) => (m.currency.as_str(), assert_rate(&m.currency, m.rate)?),
        None => ("EGP", ONE),
    };
    let registered = vat_registered(conn)? && currency == "EGP";
    let mut priced = Vec::with_capacity(lines.len());
    for line in lines {
        let quantity = assert_quantity(line.quantity)?;
        let Some(unit_price) = safe_int(line.unit_price).filter(|p| *p >= 0) else {
            return refuse(
                "price_invalid",
                format!("Unit price {} is not whole piastres", line.unit_price),
            );
        };
        let base_quantity = to_base_quantity(
            conn,
            &UnitLine {
                item_id: line.item_id,
                unit: line.unit.clone(),
                quantity: line.quantity,
                serials: None,
            },
        )?;
        let tax_code: i64 = conn.query_row(
            "SELECT tax_code_id FROM items WHERE id = ?",
            [line.item_id],
            |r| r.get(0),
        )?;
        let net = mul_div_round(quantity, unit_price, ONE_BASE_UNIT);
        let vat_rate = vat_rate(conn, tax_code, date, registered)?;
        let vat = mul_div_round(net, vat_rate, WHOLE);
        priced.push(PricedLine {
            line: PurchaseLine {
                item_id: line.item_id,
                unit: line.unit.clone(),
                quantity,
                unit_price,
                net,
                vat_rate,
                vat,
            },
            base_quantity,
            net_egp: to_egp(net, rate),
            vat_egp: to_egp(vat, rate),
        });
    }
    Ok(Priced {
        net: priced.iter().map(|l| l.line.net).sum(),
        vat: priced.iter().map(|l| l.line.vat).sum(),
        net_egp: priced.iter().map(|l| l.net_egp).sum(),
        vat_egp: priced.iter().map(|l| l.vat_egp).sum(),
        lines: priced,
    })
}

fn post(
    conn: &Connection,
    date: &str,
    memo: String,
    lines: Vec<JournalLine>,
    kind: &str,
) -> Result<i64> {
    post_journal_entry(
        conn,
        &JournalEntryInput {
            date: date.into(),
            memo,
            lines,
        },
        kind,
    )
}

/** Posts a supplier's invoice: stock in at net cost, input VAT, and the total owed to the supplier. */
pub fn post_purchase_invoice(
    conn: &Connection,
    input: &PurchaseInvoiceInput,
    user_id: i64,
) -> Result<i64> {
    assert_iso_date(&input.date)?;
    let supplier = find_supplier(conn, input.supplier_id)?;
    assert_postable(&supplier)?;
    active_warehouse(conn, input.warehouse_id)?;
    if input.lines.is_empty() {
        return refuse("invoice_needs_lines", "An invoice needs at least one line");
    }
    let rate = document_rate(&supplier, input.rate)?;
    let money = PurchaseMoney {
        currency: supplier.currency.clone(),
        rate: rate as f64,
    };
    let priced = price_purchase(conn, &input.date, &input.lines, Some(&money))?;
    let total_egp = priced.net_egp + priced.vat_egp;
    if total_egp == 0 {
        return refuse("invoice_total_zero", "The invoice total is zero");
    }

    let mut journal = Vec::new();
    if priced.net_egp > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "stock")?,
            priced.net_egp,
        ));
    }
    if priced.vat_egp > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "input_vat")?,
            priced.vat_egp,
        ));
    }
    journal.push(JournalLine {
        supplier_id: Some(supplier.id),
        foreign: (supplier.currency != "EGP").then_some((priced.net + priced.vat) as f64),
        ..JournalLine::credit(account_by_role(conn, "payables")?, total_egp)
    });
    let reference = input.reference.trim();
    let suffix = if reference.is_empty() {
        String::new()
    } else {
        format!(" رقم {reference}")
    };
    let entry_id = post(
        conn,
        &input.date,
        format!("فاتورة مشتريات {}{suffix}", supplier.name),
        journal,
        "purchase_invoice",
    )?;
    conn.execute(
        "INSERT INTO purchase_invoices (date, supplier_id, warehouse_id, reference, currency, rate, entry_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![input.date, supplier.id, input.warehouse_id, reference, supplier.currency, rate, entry_id, user_id],
    )?;
    let id = conn.last_insert_rowid();
    for (l, given) in priced.lines.iter().zip(&input.lines) {
        conn.execute(
            "INSERT INTO purchase_invoice_lines (invoice_id, item_id, unit, quantity, unit_price, net, vat_rate, vat)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, l.line.item_id, l.line.unit, l.line.quantity, l.line.unit_price, l.line.net, l.line.vat_rate, l.line.vat],
        )?;
        let line_id = conn.last_insert_rowid();
        let serials = serials_for(
            conn,
            l.line.item_id,
            l.base_quantity,
            given.serials.as_deref(),
        )?;
        receive_serials(
            conn,
            l.line.item_id,
            &serials,
            &Move {
                date: &input.date,
                warehouse_id: input.warehouse_id,
                source: "purchase",
                source_id: id,
                line_id: Some(line_id),
            },
        )?;
        insert_movement(
            conn,
            NewMovement {
                date: &input.date,
                item_id: l.line.item_id,
                warehouse_id: input.warehouse_id,
                quantity: l.base_quantity,
                value: l.net_egp,
                source: "purchase",
                source_id: id,
            },
        )?;
    }
    Ok(id)
}

/** Purchase invoices, newest first. */
pub fn list_purchase_invoices(conn: &Connection) -> Result<Vec<PurchaseInvoice>> {
    let invoices: Vec<PurchaseInvoice> = conn
        .prepare(
            "SELECT p.id, p.date, p.supplier_id, p.warehouse_id, p.reference, p.currency, p.rate,
                    (SELECT SUM(x.credit) FROM ledger_lines x WHERE x.entry_id = p.entry_id AND x.supplier_id IS NOT NULL),
                    u.name
               FROM purchase_invoices p JOIN users u ON u.id = p.user_id
              ORDER BY p.date DESC, p.id DESC",
        )?
        .query_map([], |r| {
            Ok(PurchaseInvoice {
                id: r.get(0)?,
                date: r.get(1)?,
                supplier_id: r.get(2)?,
                warehouse_id: r.get(3)?,
                reference: r.get(4)?,
                currency: r.get(5)?,
                rate: r.get(6)?,
                total_egp: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                posted_by: r.get(8)?,
                net: 0,
                vat: 0,
                total: 0,
                lines: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut lines = conn.prepare(
        "SELECT l.id, l.item_id, i.name_ar, l.unit, l.quantity, l.unit_price, l.net, l.vat_rate, l.vat,
                COALESCE((SELECT SUM(x.quantity) FROM debit_note_lines x WHERE x.purchase_line_id = l.id), 0)
           FROM purchase_invoice_lines l JOIN items i ON i.id = l.item_id WHERE l.invoice_id = ? ORDER BY l.id",
    )?;
    invoices
        .into_iter()
        .map(|mut invoice| {
            invoice.lines = lines
                .query_map([invoice.id], |r| {
                    Ok(PostedPurchaseLine {
                        line_id: r.get(0)?,
                        item_id: r.get(1)?,
                        name_ar: r.get(2)?,
                        unit: r.get(3)?,
                        quantity: r.get(4)?,
                        unit_price: r.get(5)?,
                        net: r.get(6)?,
                        vat_rate: r.get(7)?,
                        vat: r.get(8)?,
                        returned: r.get(9)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            invoice.net = invoice.lines.iter().map(|l| l.net).sum();
            invoice.vat = invoice.lines.iter().map(|l| l.vat).sum();
            invoice.total = invoice.net + invoice.vat;
            Ok(invoice)
        })
        .collect()
}

/**
 * Goods sent back to a supplier against their invoice, at that invoice's cost and VAT:
 * Dr Payables (tagged with the supplier), Cr Stock, Cr Input VAT; stock out of the
 * warehouse the goods came into.
 */
pub fn post_debit_note(
    conn: &Connection,
    input: &DebitNoteInput,
    user_id: i64,
) -> Result<PostedNote> {
    assert_iso_date(&input.date)?;
    let invoice: Option<(i64, i64, i64, String, String, i64)> = conn
        .query_row(
            "SELECT id, supplier_id, warehouse_id, reference, currency, rate FROM purchase_invoices WHERE id = ?",
            [input.purchase_invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?;
    let Some((invoice_id, supplier_id, warehouse_id, reference, currency, rate)) = invoice else {
        return refuse(
            "invoice_not_found",
            format!("No purchase invoice with id {}", input.purchase_invoice_id),
        );
    };
    let supplier = find_supplier(conn, supplier_id)?;
    if input.lines.is_empty() {
        return refuse(
            "invoice_needs_lines",
            "A debit note needs at least one line",
        );
    }

    struct Back {
        line_id: i64,
        item_id: i64,
        quantity: Quantity,
        base: Quantity,
        net: Piastres,
        vat: Piastres,
        net_egp: Piastres,
        vat_egp: Piastres,
        serials: Vec<String>,
    }
    let mut taken: Vec<(i64, Taken)> = Vec::new();
    let mut backs = Vec::with_capacity(input.lines.len());
    for given in &input.lines {
        let quantity = assert_quantity(given.quantity)?;
        let line: Option<(i64, i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT l.item_id, l.quantity, l.net, l.vat, COALESCE(u.size, 1000)
                   FROM purchase_invoice_lines l LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
                  WHERE l.id = ? AND l.invoice_id = ?",
                params![given.line_id, invoice_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((item_id, bought, net, vat, size)) = line else {
            return refuse(
                "return_line_invalid",
                format!(
                    "Line {} is not on purchase invoice {invoice_id}",
                    given.line_id
                ),
            );
        };
        let before = match taken.iter().find(|t| t.0 == given.line_id) {
            Some((_, t)) => t.clone(),
            None => conn.query_row(
                "SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(net), 0), COALESCE(SUM(vat), 0) FROM debit_note_lines WHERE purchase_line_id = ?",
                [given.line_id],
                |r| {
                    Ok(Taken {
                        quantity: r.get(0)?,
                        values: vec![r.get(1)?, r.get(2)?],
                    })
                },
            )?,
        };
        if before.quantity + quantity > bought {
            return refuse(
                "return_exceeds_sale",
                format!(
                    "Only {} of line {} can still go back",
                    bought - before.quantity,
                    given.line_id
                ),
            );
        }
        let share = share_of(&[net, vat], bought, &before, quantity);
        let after = take(&before, quantity, &share);
        match taken.iter_mut().find(|t| t.0 == given.line_id) {
            Some(t) => t.1 = after,
            None => taken.push((given.line_id, after)),
        }
        let base = mul_div_round(quantity, size, ONE_BASE_UNIT);
        backs.push(Back {
            line_id: given.line_id,
            item_id,
            quantity,
            base,
            net: share[0],
            vat: share[1],
            net_egp: to_egp(share[0], rate),
            vat_egp: to_egp(share[1], rate),
            serials: serials_for(conn, item_id, base, given.serials.as_deref())?,
        });
    }
    // Amounts on the note are in the invoice's currency; the books take them at the invoice's rate.
    let net: Piastres = backs.iter().map(|b| b.net).sum();
    let vat: Piastres = backs.iter().map(|b| b.vat).sum();
    let net_egp: Piastres = backs.iter().map(|b| b.net_egp).sum();
    let vat_egp: Piastres = backs.iter().map(|b| b.vat_egp).sum();
    let number = next_number(conn, "debit_notes")?;

    let mut journal = Vec::new();
    if net_egp + vat_egp > 0 {
        journal.push(JournalLine {
            supplier_id: Some(supplier.id),
            foreign: (currency != "EGP").then_some((net + vat) as f64),
            ..JournalLine::debit(account_by_role(conn, "payables")?, net_egp + vat_egp)
        });
    }
    if net_egp > 0 {
        journal.push(JournalLine::credit(
            account_by_role(conn, "stock")?,
            net_egp,
        ));
    }
    if vat_egp > 0 {
        journal.push(JournalLine::credit(
            account_by_role(conn, "input_vat")?,
            vat_egp,
        ));
    }
    let of_invoice = if reference.is_empty() {
        String::new()
    } else {
        format!(" فاتورة {reference}")
    };
    let entry_id = post(
        conn,
        &input.date,
        format!(
            "إشعار مدين رقم {number} - مرتجع إلى {}{of_invoice}",
            supplier.name
        ),
        journal,
        "debit_note",
    )?;
    conn.execute(
        "INSERT INTO debit_notes (number, date, purchase_invoice_id, reason, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?)",
        params![number, input.date, invoice_id, input.reason.trim(), entry_id, user_id],
    )?;
    let id = conn.last_insert_rowid();
    for b in &backs {
        conn.execute(
            "INSERT INTO debit_note_lines (note_id, purchase_line_id, quantity, net, vat) VALUES (?, ?, ?, ?, ?)",
            params![id, b.line_id, b.quantity, b.net, b.vat],
        )?;
        let line_id = conn.last_insert_rowid();
        issue_serials(
            conn,
            b.item_id,
            &b.serials,
            &Move {
                date: &input.date,
                warehouse_id,
                source: "debit_note",
                source_id: id,
                line_id: Some(line_id),
            },
        )?;
        insert_movement(
            conn,
            NewMovement {
                date: &input.date,
                item_id: b.item_id,
                warehouse_id,
                quantity: -b.base,
                value: -b.net_egp,
                source: "debit_note",
                source_id: id,
            },
        )?;
    }
    Ok(PostedNote {
        id,
        number,
        total: net + vat,
    })
}

/** Debit notes, newest first. */
pub fn list_debit_notes(conn: &Connection) -> Result<Vec<DebitNote>> {
    let rows: Vec<(i64, i64, String, i64, i64, String, String)> = conn
        .prepare(
            "SELECT n.id, n.number, n.date, n.purchase_invoice_id, p.supplier_id, n.reason, u.name
               FROM debit_notes n JOIN purchase_invoices p ON p.id = n.purchase_invoice_id JOIN users u ON u.id = n.user_id
              ORDER BY n.number DESC",
        )?
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut lines = conn.prepare(
        "SELECT l.item_id, i.name_ar, l.unit, x.quantity, x.net, x.vat
           FROM debit_note_lines x JOIN purchase_invoice_lines l ON l.id = x.purchase_line_id JOIN items i ON i.id = l.item_id
          WHERE x.note_id = ? ORDER BY x.id",
    )?;
    rows.into_iter()
        .map(
            |(id, number, date, purchase_invoice_id, supplier_id, reason, posted_by)| {
                let ls: Vec<DebitNoteLine> = lines
                    .query_map([id], |r| {
                        Ok(DebitNoteLine {
                            item_id: r.get(0)?,
                            name_ar: r.get(1)?,
                            unit: r.get(2)?,
                            quantity: r.get(3)?,
                            net: r.get(4)?,
                            vat: r.get(5)?,
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                let net = ls.iter().map(|l| l.net).sum();
                let vat = ls.iter().map(|l| l.vat).sum();
                Ok(DebitNote {
                    id,
                    number,
                    date,
                    purchase_invoice_id,
                    supplier_id,
                    reason,
                    posted_by,
                    lines: ls,
                    net,
                    vat,
                    total: net + vat,
                })
            },
        )
        .collect()
}
