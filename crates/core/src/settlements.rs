//! Customer receipts and supplier payments, what is still open on a party's account, their
//! statements and the aged receivables and payables.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::currency::{assert_rate, to_egp, ONE};
use crate::customers::find_customer;
use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, safe_int};
use crate::purchases::{document_rate, find_supplier};
use crate::stock::account_by_role;
use crate::withholding::{withholding_rate, WithholdingInput};

/** Customers owe the business (their documents are debits); the business owes suppliers (credits). */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PartyKind {
    Customer,
    Supplier,
}

impl PartyKind {
    fn as_str(self) -> &'static str {
        match self {
            PartyKind::Customer => "customer",
            PartyKind::Supplier => "supplier",
        }
    }
    fn column(self) -> &'static str {
        match self {
            PartyKind::Customer => "customer_id",
            PartyKind::Supplier => "supplier_id",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationInput {
    pub entry_id: i64,
    pub amount: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    pub date: String,
    /** The customer paying, or the supplier being paid. */
    pub party_id: i64,
    /** The cash, bank or wallet account the money goes into or comes out of. */
    pub account_id: i64,
    /** In the party's currency: piastres, or the minor units of a foreign supplier's currency. */
    pub amount: f64,
    /** EGP per unit of a foreign supplier's currency, in millionths; left out for EGP. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    pub reference: String,
    /** Documents this payment settles, by their journal entry. Any rest settles the oldest first. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocations: Option<Vec<AllocationInput>>,
    /** Withholding tax held back from `amount`, which stays the full amount settled. EGP only. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withholding: Option<WithholdingInput>,
}

impl PaymentInput {
    pub fn new(date: &str, party_id: i64, account_id: i64, amount: i64) -> Self {
        PaymentInput {
            date: date.into(),
            party_id,
            account_id,
            amount: amount as f64,
            ..Default::default()
        }
    }
    pub fn allocate(mut self, entry_id: i64, amount: i64) -> Self {
        self.allocations
            .get_or_insert_with(Vec::new)
            .push(AllocationInput {
                entry_id,
                amount: amount as f64,
            });
        self
    }
    pub fn at_rate(mut self, rate: i64) -> Self {
        self.rate = Some(rate as f64);
        self
    }
    pub fn withholding(mut self, category_id: i64, base: i64) -> Self {
        self.withholding = Some(WithholdingInput {
            category_id,
            base: base as f64,
        });
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaymentResult {
    pub id: i64,
    pub number: i64,
}

/** A document that raised what a party owes (an invoice, a credit sale, an opening balance). */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocument {
    pub entry_id: i64,
    pub date: String,
    pub memo: String,
    pub amount: i64,
    pub open: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementLine {
    pub date: String,
    pub entry_id: i64,
    pub memo: String,
    pub debit: i64,
    pub credit: i64,
    pub balance: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub party_id: i64,
    pub name: String,
    pub currency: String,
    pub from: String,
    pub to: String,
    pub opening: i64,
    pub lines: Vec<StatementLine>,
    pub closing: i64,
}

/** What a party owes by the age of the documents still open: 0–30, 31–60, 61–90, over 90 days. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgingRow {
    pub party_id: i64,
    pub name: String,
    pub buckets: [Piastres; 4],
    pub unapplied: Piastres,
    pub balance: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aging {
    pub as_of: String,
    pub rows: Vec<AgingRow>,
    pub totals: [Piastres; 4],
    pub unapplied: Piastres,
    pub balance: Piastres,
}

/** Money accounts a payment may use: the drawer, the main cash box, the bank, wallets, or any asset account without a role. */
pub const MONEY_ROLES: [&str; 4] = ["cash_drawer", "main_cash", "bank", "wallet"];

fn party_name(conn: &Connection, kind: PartyKind, id: i64) -> Result<String> {
    Ok(match kind {
        PartyKind::Customer => find_customer(conn, id)?.name,
        PartyKind::Supplier => find_supplier(conn, id)?.name,
    })
}

fn party_currency(conn: &Connection, kind: PartyKind, id: i64) -> Result<String> {
    Ok(match kind {
        PartyKind::Customer => "EGP".into(),
        PartyKind::Supplier => find_supplier(conn, id)?.currency,
    })
}

/** A party line's debit and credit in the party's currency: a foreign supplier's lines carry it, all others are EGP. */
const DEBIT: &str = "CASE WHEN l.debit > 0 THEN COALESCE(l.foreign_amount, l.debit) ELSE 0 END";
const CREDIT: &str = "CASE WHEN l.credit > 0 THEN COALESCE(l.foreign_amount, l.credit) ELSE 0 END";

struct PartyEntry {
    entry_id: i64,
    date: String,
    memo: String,
    amount: i64,
    egp: Piastres,
}

/**
 * Each journal entry touching the party, netted to the side that raises what is owed (+) or
 * settles it (−): `amount` in the party's currency, `egp` as it stands in the books.
 */
fn party_entries(
    conn: &Connection,
    kind: PartyKind,
    id: i64,
    as_of: &str,
) -> Result<Vec<PartyEntry>> {
    let (raise, settle, raise_foreign, settle_foreign) = match kind {
        PartyKind::Customer => ("debit", "credit", DEBIT, CREDIT),
        PartyKind::Supplier => ("credit", "debit", CREDIT, DEBIT),
    };
    let sql = format!(
        "SELECT e.id, e.date, e.memo, SUM({raise_foreign}) - SUM({settle_foreign}), SUM(l.{raise}) - SUM(l.{settle})
           FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.{} = ? AND e.date <= ?
          GROUP BY e.id ORDER BY e.date, e.id",
        kind.column()
    );
    let rows = conn
        .prepare(&sql)?
        .query_map(params![id, as_of], |r| {
            Ok(PartyEntry {
                entry_id: r.get(0)?,
                date: r.get(1)?,
                memo: r.get(2)?,
                amount: r.get(3)?,
                egp: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

struct Link {
    source: i64,
    target: i64,
    amount: i64,
    egp: Piastres,
}

/**
 * Which settling entry was meant for which document: payment allocations, notes and returns
 * against their invoice; `amount` in the party's currency, `egp` what it took off in the books.
 */
fn links(conn: &Connection) -> Result<Vec<Link>> {
    let rows = conn
        .prepare_cached(
            "SELECT p.entry_id, a.entry_id, a.amount, COALESCE(a.egp_amount, a.amount)
               FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
             UNION ALL
             SELECT n.entry_id, s.entry_id, t.amount, t.amount
               FROM credit_notes n JOIN sales_invoices s ON s.id = n.invoice_id
               JOIN (SELECT note_id, SUM(net + vat) AS amount FROM credit_note_lines GROUP BY note_id) t ON t.note_id = n.id
             UNION ALL
             SELECT r.entry_id, s.entry_id, t.amount, t.amount
               FROM sales_returns r JOIN sales_receipts s ON s.id = r.receipt_id
               JOIN (SELECT return_id, SUM(amount) AS amount FROM sales_return_lines GROUP BY return_id) t ON t.return_id = r.id
              WHERE r.refund = 'account'
             UNION ALL
             SELECT n.entry_id, p.entry_id, (SELECT SUM(x.net + x.vat) FROM debit_note_lines x WHERE x.note_id = n.id),
                    (SELECT SUM(x.debit) FROM ledger_lines x WHERE x.entry_id = n.entry_id AND x.supplier_id IS NOT NULL)
               FROM debit_notes n JOIN purchase_invoices p ON p.id = n.purchase_invoice_id",
        )?
        .query_map([], |r| {
            Ok(Link {
                source: r.get(0)?,
                target: r.get(1)?,
                amount: r.get(2)?,
                egp: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/** The EGP part of `egp` that goes with `part` of `whole`, so that taking all of it leaves exactly nothing. */
fn portion(egp: Piastres, part: i64, whole: i64) -> Piastres {
    if part == whole {
        egp
    } else {
        mul_div_round(egp, part, whole)
    }
}

struct Document {
    entry_id: i64,
    date: String,
    memo: String,
    amount: i64,
    open: i64,
    open_egp: Piastres,
}

struct Matched {
    documents: Vec<Document>,
    balance_egp: Piastres,
}

/**
 * Matches what settled the party's account against what raised it: first as linked
 * (allocations, notes, returns), then the rest against the oldest documents first.
 * `fifo` false stops after the links, which is what is still free to allocate.
 */
fn match_entries(
    conn: &Connection,
    kind: PartyKind,
    id: i64,
    as_of: &str,
    fifo: bool,
) -> Result<Matched> {
    let entries = party_entries(conn, kind, id, as_of)?;
    let balance_egp = entries.iter().map(|e| e.egp).sum();
    let mut credits: HashMap<i64, i64> = HashMap::new();
    let mut credit_order: Vec<i64> = Vec::new();
    let mut documents: Vec<Document> = Vec::new();
    for e in entries {
        if e.amount > 0 {
            documents.push(Document {
                entry_id: e.entry_id,
                date: e.date,
                memo: e.memo,
                amount: e.amount,
                open: e.amount,
                open_egp: e.egp,
            });
        } else if e.amount < 0 {
            credit_order.push(e.entry_id);
            credits.insert(e.entry_id, -e.amount);
        }
    }
    let by_entry: HashMap<i64, usize> = documents
        .iter()
        .enumerate()
        .map(|(i, d)| (d.entry_id, i))
        .collect();
    for link in links(conn)? {
        let (Some(remaining), Some(&i)) =
            (credits.get_mut(&link.source), by_entry.get(&link.target))
        else {
            continue;
        };
        let document = &mut documents[i];
        let applied = link.amount.min(*remaining).min(document.open);
        if applied <= 0 {
            continue;
        }
        *remaining -= applied;
        document.open_egp -= if applied == document.open {
            document.open_egp
        } else {
            portion(link.egp, applied, link.amount)
        };
        document.open -= applied;
    }
    let mut unapplied: i64 = credit_order.iter().map(|e| credits[e]).sum();
    if fifo {
        for document in &mut documents {
            let applied = unapplied.min(document.open);
            document.open_egp -= portion(document.open_egp, applied, document.open);
            document.open -= applied;
            unapplied -= applied;
        }
    }
    Ok(Matched {
        documents,
        balance_egp,
    })
}

fn still_open(conn: &Connection, kind: PartyKind, id: i64) -> Result<Vec<Document>> {
    Ok(match_entries(conn, kind, id, "9999-12-31", false)?
        .documents
        .into_iter()
        .filter(|d| d.open > 0)
        .collect())
}

/** The party's documents that still have something not yet allocated, oldest first, in the party's currency. */
pub fn open_documents(conn: &Connection, kind: PartyKind, id: i64) -> Result<Vec<OpenDocument>> {
    party_name(conn, kind, id)?;
    Ok(still_open(conn, kind, id)?
        .into_iter()
        .map(|d| OpenDocument {
            entry_id: d.entry_id,
            date: d.date,
            memo: d.memo,
            amount: d.amount,
            open: d.open,
        })
        .collect())
}

struct Withheld {
    category_id: i64,
    rate: i64,
    base: Piastres,
    tax: Piastres,
}

/** Checks a payment's withholding and works out the tax at the category's rate on the payment date. */
fn withheld(
    conn: &Connection,
    w: &WithholdingInput,
    date: &str,
    amount: i64,
    currency: &str,
) -> Result<Withheld> {
    if currency != "EGP" {
        return refuse(
            "withholding_not_egp",
            "Withholding tax is taken on EGP payments only",
        );
    }
    let rate = withholding_rate(conn, w.category_id, date)?;
    let Some(base) = safe_int(w.base).filter(|b| *b > 0) else {
        return refuse(
            "withholding_invalid",
            format!("Base {} is not a positive amount", w.base),
        );
    };
    let tax = mul_div_round(base, rate, 10_000);
    if tax >= amount {
        return refuse(
            "withholding_invalid",
            format!("Withholding {tax} is not less than the payment {amount}"),
        );
    }
    Ok(Withheld {
        category_id: w.category_id,
        rate,
        base,
        tax,
    })
}

struct Allocation {
    entry_id: i64,
    amount: i64,
    egp: Piastres,
}

/**
 * Records money from a customer (Dr the money account, Cr Receivables) or to a
 * supplier (Dr Payables, Cr the money account), both tagged with the party, with an
 * optional split over the documents it settles.
 */
pub fn record_payment(
    conn: &Connection,
    kind: PartyKind,
    input: &PaymentInput,
    user_id: i64,
) -> Result<PaymentResult> {
    assert_iso_date(&input.date)?;
    let name = party_name(conn, kind, input.party_id)?;
    let (currency, rate) = match kind {
        PartyKind::Supplier => {
            let supplier = find_supplier(conn, input.party_id)?;
            let rate = document_rate(&supplier, input.rate)?;
            (supplier.currency, rate)
        }
        PartyKind::Customer => (
            "EGP".to_string(),
            assert_rate("EGP", input.rate.unwrap_or(ONE as f64))?,
        ),
    };
    let Some(amount) = safe_int(input.amount).filter(|a| *a > 0) else {
        return refuse(
            "amount_invalid",
            format!(
                "Amount {} is not a positive whole number of piastres",
                input.amount
            ),
        );
    };
    let account: Option<(i64, String, Option<String>, i64)> = conn
        .query_row(
            "SELECT id, type, role, active FROM accounts WHERE id = ?",
            [input.account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let account_id = match account {
        Some((id, kind, role, 1))
            if kind == "asset" && role.as_deref().is_none_or(|r| MONEY_ROLES.contains(&r)) =>
        {
            id
        }
        _ => {
            return refuse(
                "account_not_allowed",
                format!(
                    "Account {} is not a cash, bank or wallet account",
                    input.account_id
                ),
            )
        }
    };

    let withholding = match &input.withholding {
        Some(w) => Some(withheld(conn, w, &input.date, amount, &currency)?),
        None => None,
    };
    let tax = withholding.as_ref().map_or(0, |w| w.tax);

    let mut documents = still_open(conn, kind, input.party_id)?;
    let index: HashMap<i64, usize> = documents
        .iter()
        .enumerate()
        .map(|(i, d)| (d.entry_id, i))
        .collect();
    let mut allocations: Vec<Allocation> = Vec::new();
    // Takes part of a document's open amount, with what that part stands at in EGP at the document's own rate.
    let mut allocate = |documents: &mut Vec<Document>, entry_id: i64, part: f64| -> Result<i64> {
        let document = index.get(&entry_id).map(|&i| &mut documents[i]);
        let free = document.as_ref().map_or(0, |d| d.open);
        let (Some(d), Some(part)) = (document, safe_int(part).filter(|p| *p > 0 && *p <= free))
        else {
            return refuse(
                "allocation_invalid",
                format!("Entry {entry_id} has {free} open, not {part}"),
            );
        };
        let egp = portion(d.open_egp, part, d.open);
        d.open -= part;
        d.open_egp -= egp;
        allocations.push(Allocation {
            entry_id,
            amount: part,
            egp,
        });
        Ok(part)
    };
    let mut allocated = 0;
    for a in input.allocations.iter().flatten() {
        allocated += allocate(&mut documents, a.entry_id, a.amount)?;
    }
    if allocated > amount {
        return refuse(
            "allocation_invalid",
            format!("Allocated {allocated} of a payment of {amount}"),
        );
    }
    // A foreign payment settles the oldest invoices with what is left, so that each part is taken at its invoice's rate.
    if currency != "EGP" {
        let order: Vec<(i64, i64)> = documents.iter().map(|d| (d.entry_id, d.open)).collect();
        for (entry_id, open) in order {
            let part = (amount - allocated).min(open);
            if part <= 0 {
                continue;
            }
            allocated += allocate(&mut documents, entry_id, part as f64)?;
        }
    }
    // What the payment takes off the books: allocated parts at their documents' rates, any advance at the payment's rate.
    let paid_egp = to_egp(amount, rate);
    let allocated_at_payment_rate = to_egp(allocated, rate);
    let carrying: Piastres = allocations.iter().map(|a| a.egp).sum();
    let settled_egp = carrying + (paid_egp - allocated_at_payment_rate);
    let difference = allocated_at_payment_rate - carrying;

    let number: i64 = conn.query_row(
        "SELECT COALESCE(MAX(number), 0) + 1 FROM payments WHERE kind = ?",
        [kind.as_str()],
        |r| r.get(0),
    )?;
    let mut journal: Vec<JournalLine> = Vec::new();
    match kind {
        PartyKind::Customer => {
            journal.push(JournalLine::debit(account_id, amount - tax));
            if tax > 0 {
                journal.push(JournalLine::debit(
                    account_by_role(conn, "withholding_receivable")?,
                    tax,
                ));
            }
            journal.push(JournalLine {
                customer_id: Some(input.party_id),
                ..JournalLine::credit(account_by_role(conn, "receivables")?, amount)
            });
        }
        PartyKind::Supplier => {
            journal.push(JournalLine {
                supplier_id: Some(input.party_id),
                foreign: (currency != "EGP").then_some(amount as f64),
                ..JournalLine::debit(account_by_role(conn, "payables")?, settled_egp)
            });
            if difference > 0 {
                journal.push(JournalLine::debit(
                    account_by_role(conn, "exchange_loss")?,
                    difference,
                ));
            }
            if difference < 0 {
                journal.push(JournalLine::credit(
                    account_by_role(conn, "exchange_gain")?,
                    -difference,
                ));
            }
            journal.push(JournalLine::credit(account_id, paid_egp - tax));
            if tax > 0 {
                journal.push(JournalLine::credit(
                    account_by_role(conn, "withholding_payable")?,
                    tax,
                ));
            }
        }
    }
    let memo = match kind {
        PartyKind::Customer => format!("سند قبض رقم {number} من {name}"),
        PartyKind::Supplier if currency == "EGP" => format!("سند صرف رقم {number} إلى {name}"),
        PartyKind::Supplier => format!("سند صرف رقم {number} إلى {name} ({currency})"),
    };
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo,
            lines: journal,
        },
        &format!("{}_payment", kind.as_str()),
    )?;
    conn.execute(
        "INSERT INTO payments (kind, number, date, customer_id, supplier_id, account_id, amount, reference, entry_id, user_id, currency, rate,
                               withholding_category_id, withholding_rate, withholding_base, withholding_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            kind.as_str(),
            number,
            input.date,
            (kind == PartyKind::Customer).then_some(input.party_id),
            (kind == PartyKind::Supplier).then_some(input.party_id),
            account_id,
            amount,
            input.reference.trim(),
            entry_id,
            user_id,
            currency,
            rate,
            withholding.as_ref().map(|w| w.category_id),
            withholding.as_ref().map_or(0, |w| w.rate),
            withholding.as_ref().map_or(0, |w| w.base),
            tax,
        ],
    )?;
    let id = conn.last_insert_rowid();
    let mut insert = conn.prepare_cached(
        "INSERT INTO payment_allocations (payment_id, entry_id, amount, egp_amount) VALUES (?, ?, ?, ?)",
    )?;
    for a in &allocations {
        insert.execute(params![id, a.entry_id, a.amount, a.egp])?;
    }
    Ok(PaymentResult { id, number })
}

/** Every posting to the party's account between two dates, with the balance before, after each line, and at the end. */
pub fn statement(
    conn: &Connection,
    kind: PartyKind,
    id: i64,
    from: &str,
    to: &str,
) -> Result<Statement> {
    assert_iso_date(from)?;
    assert_iso_date(to)?;
    if from > to {
        return refuse("date_range_invalid", format!("{from} is after {to}"));
    }
    let name = party_name(conn, kind, id)?;
    let currency = party_currency(conn, kind, id)?;
    let sign = match kind {
        PartyKind::Customer => 1,
        PartyKind::Supplier => -1,
    };
    let column = kind.column();
    let owed: i64 = conn.query_row(
        &format!(
            "SELECT COALESCE(SUM({DEBIT}) - SUM({CREDIT}), 0)
               FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.{column} = ? AND e.date < ?"
        ),
        params![id, from],
        |r| r.get(0),
    )?;
    let opening = sign * owed;
    let mut balance = opening;
    let lines = conn
        .prepare(&format!(
            "SELECT e.date, e.id, e.memo, SUM({DEBIT}), SUM({CREDIT})
               FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.{column} = ? AND e.date BETWEEN ? AND ?
              GROUP BY e.id ORDER BY e.date, e.id"
        ))?
        .query_map(params![id, from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<Vec<(String, i64, String, i64, i64)>>>()?
        .into_iter()
        .map(|(date, entry_id, memo, debit, credit)| {
            balance += sign * (debit - credit);
            StatementLine {
                date,
                entry_id,
                memo,
                debit,
                credit,
                balance,
            }
        })
        .collect();
    Ok(Statement {
        party_id: id,
        name,
        currency,
        from: from.into(),
        to: to.into(),
        opening,
        lines,
        closing: balance,
    })
}

fn days_between(from: &str, to: &str) -> i64 {
    let day = |d: &str| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
    match (day(from), day(to)) {
        (Some(a), Some(b)) => (b - a).num_days(),
        _ => 0,
    }
}

fn bucket_of(age: i64) -> usize {
    match age {
        ..=30 => 0,
        31..=60 => 1,
        61..=90 => 2,
        _ => 3,
    }
}

/**
 * Aged receivables or payables: every party with something owed either way, by the age of their
 * open documents, in EGP as the books carry them (a foreign supplier's documents at their own rates).
 */
pub fn aging(conn: &Connection, kind: PartyKind, as_of: &str) -> Result<Aging> {
    assert_iso_date(as_of)?;
    let parties: Vec<(i64, String)> = conn
        .prepare(&format!(
            "SELECT DISTINCT p.id, p.name FROM {}s p JOIN ledger_lines l ON l.{} = p.id ORDER BY p.name",
            kind.as_str(),
            kind.column()
        ))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut rows = Vec::new();
    for (party_id, name) in parties {
        let matched = match_entries(conn, kind, party_id, as_of, true)?;
        let mut buckets = [0; 4];
        for d in &matched.documents {
            buckets[bucket_of(days_between(&d.date, as_of))] += d.open_egp;
        }
        let balance = matched.balance_egp;
        let unapplied = buckets.iter().sum::<i64>() - balance;
        if balance != 0 || unapplied != 0 {
            rows.push(AgingRow {
                party_id,
                name,
                buckets,
                unapplied,
                balance,
            });
        }
    }
    let totals = std::array::from_fn(|i| rows.iter().map(|r: &AgingRow| r.buckets[i]).sum());
    Ok(Aging {
        as_of: as_of.into(),
        totals,
        unapplied: rows.iter().map(|r| r.unapplied).sum(),
        balance: rows.iter().map(|r| r.balance).sum(),
        rows,
    })
}
