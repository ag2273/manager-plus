//! Reports drawn from the ledger and stock movements: profit and loss, balance sheet, general
//! ledger, a journal entry, sales by item, day and method, stock at a date, and the dashboard.

use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::Serialize;

use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::inventory::low_stock;
use crate::items::Quantity;
use crate::ledger::Piastres;
use crate::shifts::{open_shift_of, z_report};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRow {
    pub account_id: i64,
    pub code: String,
    pub name: String,
    pub amount: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitAndLoss {
    pub from: String,
    pub to: String,
    pub income: Vec<ReportRow>,
    pub expenses: Vec<ReportRow>,
    pub total_income: Piastres,
    pub total_expenses: Piastres,
    pub net_profit: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSheet {
    pub as_of: String,
    pub assets: Vec<ReportRow>,
    pub liabilities: Vec<ReportRow>,
    pub equity: Vec<ReportRow>,
    /** Income less expenses to date, not yet closed into retained earnings. */
    pub profit: Piastres,
    pub total_assets: Piastres,
    /** Liabilities, equity and profit: equal to the assets when the books balance. */
    pub total_liabilities_and_equity: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerLine {
    pub entry_id: i64,
    pub date: String,
    pub memo: String,
    pub debit: Piastres,
    pub credit: Piastres,
    pub balance: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralLedger {
    pub account_id: i64,
    pub code: String,
    pub name: String,
    pub from: String,
    pub to: String,
    pub opening: Piastres,
    pub lines: Vec<LedgerLine>,
    pub closing: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryLine {
    pub account_id: i64,
    pub code: String,
    pub name: String,
    pub debit: Piastres,
    pub credit: Piastres,
    pub party: Option<String>,
}

/** One journal entry with its lines: where every report figure drills down to. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryDetail {
    pub id: i64,
    pub date: String,
    pub memo: String,
    /** The kind of document that posted it: sale, sales_invoice, purchase, expense, journal, … */
    pub kind: String,
    pub voided: bool,
    pub lines: Vec<EntryLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSalesRow {
    pub item_id: i64,
    pub name_ar: String,
    pub quantity: Quantity,
    pub net: Piastres,
    pub cost: Piastres,
    pub gross_profit: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DaySalesRow {
    pub date: String,
    pub documents: i64,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MethodSalesRow {
    /** cash, card, wallet or credit. */
    pub method: &'static str,
    pub total: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesDocument {
    /** sale, sales_invoice, sale_return or credit_note. */
    pub kind: String,
    pub number: i64,
    pub date: String,
    pub net: Piastres,
    pub vat: Piastres,
    pub total: Piastres,
    pub entry_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockRow {
    pub item_id: i64,
    pub name_ar: String,
    pub quantity: Quantity,
    pub value: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockReport {
    pub as_of: String,
    pub rows: Vec<StockRow>,
    pub total_value: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub date: String,
    /** Sales with VAT, less returns and credit notes. */
    pub sales: Piastres,
    /** Net sales less their cost. */
    pub gross_profit: Piastres,
    /** In the signed-in user's open shift; None with no shift open. */
    pub cash_expected: Option<Piastres>,
    pub low_stock: usize,
}

pub(crate) fn range(from: &str, to: &str) -> Result<()> {
    assert_iso_date(from)?;
    assert_iso_date(to)?;
    if from > to {
        return refuse("date_range_invalid", format!("{from} is after {to}"));
    }
    Ok(())
}

fn sums(
    conn: &Connection,
    types: &[&str],
    filter: &str,
    args: &[&dyn ToSql],
) -> Result<Vec<(ReportRow, String)>> {
    let marks = vec!["?"; types.len()].join(", ");
    let sql = format!(
        "SELECT a.id, a.code, a.name, a.type, SUM(l.debit) - SUM(l.credit)
           FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
          WHERE a.type IN ({marks}) AND {filter}
          GROUP BY a.id HAVING SUM(l.debit) - SUM(l.credit) <> 0 ORDER BY a.code"
    );
    let mut all: Vec<&dyn ToSql> = types.iter().map(|t| t as &dyn ToSql).collect();
    all.extend_from_slice(args);
    let rows = conn
        .prepare(&sql)?
        .query_map(all.as_slice(), |r| {
            Ok((
                ReportRow {
                    account_id: r.get(0)?,
                    code: r.get(1)?,
                    name: r.get(2)?,
                    amount: r.get(4)?,
                },
                r.get(3)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn of_type(rows: &[(ReportRow, String)], kind: &str, sign: i64) -> Vec<ReportRow> {
    rows.iter()
        .filter(|(_, t)| t == kind)
        .map(|(r, _)| ReportRow {
            amount: sign * r.amount,
            ..r.clone()
        })
        .collect()
}

fn total(rows: &[ReportRow]) -> Piastres {
    rows.iter().map(|r| r.amount).sum()
}

pub fn profit_and_loss(conn: &Connection, from: &str, to: &str) -> Result<ProfitAndLoss> {
    range(from, to)?;
    let rows = sums(
        conn,
        &["income", "expense"],
        "e.date BETWEEN ? AND ?",
        &[&from, &to],
    )?;
    let income = of_type(&rows, "income", -1);
    let expenses = of_type(&rows, "expense", 1);
    let (total_income, total_expenses) = (total(&income), total(&expenses));
    Ok(ProfitAndLoss {
        from: from.into(),
        to: to.into(),
        income,
        expenses,
        total_income,
        total_expenses,
        net_profit: total_income - total_expenses,
    })
}

pub fn balance_sheet(conn: &Connection, as_of: &str) -> Result<BalanceSheet> {
    assert_iso_date(as_of)?;
    let rows = sums(
        conn,
        &["asset", "liability", "equity", "income", "expense"],
        "e.date <= ?",
        &[&as_of],
    )?;
    let assets = of_type(&rows, "asset", 1);
    let liabilities = of_type(&rows, "liability", -1);
    let equity = of_type(&rows, "equity", -1);
    let profit = -rows
        .iter()
        .filter(|(_, t)| t == "income" || t == "expense")
        .map(|(r, _)| r.amount)
        .sum::<i64>();
    Ok(BalanceSheet {
        as_of: as_of.into(),
        total_assets: total(&assets),
        total_liabilities_and_equity: total(&liabilities) + total(&equity) + profit,
        assets,
        liabilities,
        equity,
        profit,
    })
}

pub fn general_ledger(
    conn: &Connection,
    account_id: i64,
    from: &str,
    to: &str,
) -> Result<GeneralLedger> {
    range(from, to)?;
    let account: Option<(String, String)> = conn
        .query_row(
            "SELECT code, name FROM accounts WHERE id = ?",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((code, name)) = account else {
        return refuse(
            "account_not_found",
            format!("No account with id {account_id}"),
        );
    };
    let opening: i64 = conn.query_row(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date < ?",
        params![account_id, from],
        |r| r.get(0),
    )?;
    let mut balance = opening;
    let lines = conn
        .prepare(
            "SELECT e.id, e.date, e.memo, l.debit, l.credit FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.account_id = ? AND e.date BETWEEN ? AND ? ORDER BY e.date, e.id, l.id",
        )?
        .query_map(params![account_id, from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<Vec<(i64, String, String, i64, i64)>>>()?
        .into_iter()
        .map(|(entry_id, date, memo, debit, credit)| {
            balance += debit - credit;
            LedgerLine {
                entry_id,
                date,
                memo,
                debit,
                credit,
                balance,
            }
        })
        .collect();
    Ok(GeneralLedger {
        account_id,
        code,
        name,
        from: from.into(),
        to: to.into(),
        opening,
        lines,
        closing: balance,
    })
}

/** One journal entry with its lines: where every report figure drills down to. */
pub fn journal_entry(conn: &Connection, entry_id: i64) -> Result<EntryDetail> {
    let entry: Option<(String, String, String, bool)> = conn
        .query_row(
            "SELECT date, memo, kind, voided_by IS NOT NULL FROM journal_entries WHERE id = ?",
            [entry_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((date, memo, kind, voided)) = entry else {
        return refuse(
            "entry_not_found",
            format!("No journal entry with id {entry_id}"),
        );
    };
    let lines = conn
        .prepare(
            "SELECT a.id, a.code, a.name, l.debit, l.credit, COALESCE(c.name, s.name)
               FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
               LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN suppliers s ON s.id = l.supplier_id
              WHERE l.entry_id = ? ORDER BY l.id",
        )?
        .query_map([entry_id], |r| {
            Ok(EntryLine {
                account_id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                debit: r.get(3)?,
                credit: r.get(4)?,
                party: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(EntryDetail {
        id: entry_id,
        date,
        memo,
        kind,
        voided,
        lines,
    })
}

/**
 * Every sales line in the period with its base quantity, net and cost: till sales and invoices as
 * they are, returns and credit notes negative.
 */
const SALES_LINES: &str = "
  SELECT r.date, l.item_id AS itemId, l.quantity * u.size / 1000 AS quantity, l.net, l.cost
    FROM sales_receipt_lines l JOIN sales_receipts r ON r.id = l.receipt_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
  UNION ALL
  SELECT i.date, l.item_id, l.quantity * u.size / 1000, l.net, l.cost
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
  UNION ALL
  SELECT x.date, o.item_id, -(l.quantity * u.size / 1000), -l.net, -l.cost
    FROM sales_return_lines l JOIN sales_returns x ON x.id = l.return_id JOIN sales_receipt_lines o ON o.id = l.receipt_line_id
    JOIN item_units u ON u.item_id = o.item_id AND u.kind = o.unit
  UNION ALL
  SELECT n.date, o.item_id, -(l.quantity * u.size / 1000), -l.net, -l.cost
    FROM credit_note_lines l JOIN credit_notes n ON n.id = l.note_id JOIN sales_invoice_lines o ON o.id = l.invoice_line_id
    JOIN item_units u ON u.item_id = o.item_id AND u.kind = o.unit";

pub fn sales_by_item(conn: &Connection, from: &str, to: &str) -> Result<Vec<ItemSalesRow>> {
    range(from, to)?;
    let rows = conn
        .prepare(&format!(
            "SELECT s.itemId, i.name_ar, SUM(s.quantity), SUM(s.net), SUM(s.cost), SUM(s.net) - SUM(s.cost)
               FROM ({SALES_LINES}) s JOIN items i ON i.id = s.itemId
              WHERE s.date BETWEEN ? AND ? GROUP BY s.itemId ORDER BY SUM(s.net) DESC, i.name_ar"
        ))?
        .query_map(params![from, to], |r| {
            Ok(ItemSalesRow {
                item_id: r.get(0)?,
                name_ar: r.get(1)?,
                quantity: r.get(2)?,
                net: r.get(3)?,
                cost: r.get(4)?,
                gross_profit: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/** Sales documents in the period, newest first: what the sales-by-day and by-method figures drill down to. */
pub fn sales_documents(conn: &Connection, from: &str, to: &str) -> Result<Vec<SalesDocument>> {
    range(from, to)?;
    let rows = conn
        .prepare_cached(
            "SELECT * FROM (
               SELECT 'sale' AS kind, r.number, r.date, SUM(l.net) AS net, SUM(l.vat) AS vat, SUM(l.net + l.vat) AS total, r.entry_id AS entryId
                 FROM sales_receipts r JOIN sales_receipt_lines l ON l.receipt_id = r.id GROUP BY r.id
               UNION ALL
               SELECT 'sales_invoice', i.number, i.date, SUM(l.net), SUM(l.vat), SUM(l.net + l.vat), i.entry_id
                 FROM sales_invoices i JOIN sales_invoice_lines l ON l.invoice_id = i.id GROUP BY i.id
               UNION ALL
               SELECT 'sale_return', x.number, x.date, -SUM(l.net), -SUM(l.vat), -SUM(l.net + l.vat), x.entry_id
                 FROM sales_returns x JOIN sales_return_lines l ON l.return_id = x.id GROUP BY x.id
               UNION ALL
               SELECT 'credit_note', n.number, n.date, -SUM(l.net), -SUM(l.vat), -SUM(l.net + l.vat), n.entry_id
                 FROM credit_notes n JOIN credit_note_lines l ON l.note_id = n.id GROUP BY n.id
             ) WHERE date BETWEEN ? AND ? ORDER BY date DESC, entryId DESC",
        )?
        .query_map(params![from, to], |r| {
            Ok(SalesDocument {
                kind: r.get(0)?,
                number: r.get(1)?,
                date: r.get(2)?,
                net: r.get(3)?,
                vat: r.get(4)?,
                total: r.get(5)?,
                entry_id: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn sales_by_day(conn: &Connection, from: &str, to: &str) -> Result<Vec<DaySalesRow>> {
    let mut days: Vec<DaySalesRow> = Vec::new();
    for d in sales_documents(conn, from, to)? {
        let row = match days.iter_mut().find(|r| r.date == d.date) {
            Some(row) => row,
            None => {
                days.push(DaySalesRow {
                    date: d.date.clone(),
                    documents: 0,
                    net: 0,
                    vat: 0,
                    total: 0,
                });
                days.last_mut().expect("just pushed")
            }
        };
        row.documents += 1;
        row.net += d.net;
        row.vat += d.vat;
        row.total += d.total;
    }
    days.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(days)
}

/** Till takings by method (cash after change, less cash refunds), and what sales left on customers' accounts. */
pub fn sales_by_payment_method(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<MethodSalesRow>> {
    range(from, to)?;
    let methods: Vec<(String, i64)> = conn
        .prepare(
            "SELECT p.method, SUM(p.amount) FROM sales_receipt_payments p JOIN sales_receipts r ON r.id = p.receipt_id
              WHERE r.date BETWEEN ? AND ? GROUP BY p.method",
        )?
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let refunds: Vec<(String, i64)> = conn
        .prepare(
            "SELECT x.refund, COALESCE(SUM(l.amount), 0) FROM sales_returns x JOIN sales_return_lines l ON l.return_id = x.id
              WHERE x.date BETWEEN ? AND ? GROUP BY x.refund",
        )?
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let refund = |kind: &str| {
        refunds
            .iter()
            .find(|(k, _)| k == kind)
            .map_or(0, |(_, t)| *t)
    };
    // What the receipts and invoices left unpaid, less credit notes.
    let docs = sales_documents(conn, from, to)?;
    let till_sales: i64 = docs
        .iter()
        .filter(|d| d.kind == "sale")
        .map(|d| d.total)
        .sum();
    let invoices: i64 = docs
        .iter()
        .filter(|d| d.kind == "sales_invoice" || d.kind == "credit_note")
        .map(|d| d.total)
        .sum();
    let paid: i64 = methods.iter().map(|m| m.1).sum();
    let by = |m: &str| methods.iter().find(|x| x.0 == m).map_or(0, |x| x.1);
    Ok(vec![
        MethodSalesRow {
            method: "cash",
            total: by("cash") - refund("cash"),
        },
        MethodSalesRow {
            method: "card",
            total: by("card"),
        },
        MethodSalesRow {
            method: "wallet",
            total: by("wallet"),
        },
        MethodSalesRow {
            method: "credit",
            total: till_sales - paid + invoices - refund("account"),
        },
    ])
}

/** Each item's quantity and value at the end of a date, from its movements. */
pub fn stock_at(conn: &Connection, as_of: &str) -> Result<StockReport> {
    assert_iso_date(as_of)?;
    let rows: Vec<StockRow> = conn
        .prepare(
            "SELECT m.item_id, i.name_ar, SUM(m.quantity), SUM(m.value)
               FROM stock_movements m JOIN items i ON i.id = m.item_id WHERE m.date <= ?
              GROUP BY m.item_id HAVING SUM(m.quantity) <> 0 OR SUM(m.value) <> 0 ORDER BY i.name_ar",
        )?
        .query_map([as_of], |r| {
            Ok(StockRow {
                item_id: r.get(0)?,
                name_ar: r.get(1)?,
                quantity: r.get(2)?,
                value: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(StockReport {
        as_of: as_of.into(),
        total_value: rows.iter().map(|r| r.value).sum(),
        rows,
    })
}

pub fn dashboard(conn: &Connection, date: &str, user_id: i64) -> Result<Dashboard> {
    assert_iso_date(date)?;
    let docs = sales_documents(conn, date, date)?;
    let items = sales_by_item(conn, date, date)?;
    let cash_expected = match open_shift_of(conn, user_id)? {
        Some(shift) => Some(z_report(conn, shift.id)?.expected_cash),
        None => None,
    };
    Ok(Dashboard {
        date: date.into(),
        sales: docs.iter().map(|d| d.total).sum(),
        gross_profit: items.iter().map(|i| i.gross_profit).sum(),
        cash_expected,
        low_stock: low_stock(conn, None)?.len(),
    })
}
