//! Egyptian withholding tax (الخصم والإضافة): a share of a payment held back by the payer and
//! paid to the tax authority on the payee's behalf, at a rate set by what is being paid for.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::ledger::Piastres;
use crate::num::{mul_div_round, safe_int};

const WHOLE: i64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WithholdingRate {
    pub from: String,
    pub rate: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WithholdingCategory {
    pub id: i64,
    pub name: String,
    pub rates: Vec<WithholdingRate>,
}

/** A rate as the screens send it. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithholdingRateInput {
    pub from: String,
    pub rate: f64,
}

/** Withholding on one payment: the category and the value it is taken on (the documents' value before VAT). */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithholdingInput {
    pub category_id: i64,
    pub base: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithholdingRow {
    /** "supplier": we withheld and owe it to the authority. "customer": the customer withheld and we hold a credit. */
    pub kind: String,
    pub date: String,
    pub number: i64,
    pub party_name: String,
    pub tax_registration_number: String,
    pub category: String,
    pub rate: i64,
    pub base: Piastres,
    pub tax: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WithholdingReport {
    pub from: String,
    pub to: String,
    pub rows: Vec<WithholdingRow>,
    pub withheld: Piastres,
    pub suffered: Piastres,
}

pub fn list_withholding_categories(conn: &Connection) -> Result<Vec<WithholdingCategory>> {
    let categories: Vec<(i64, String)> = conn
        .prepare("SELECT id, name FROM withholding_categories ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut rates = conn.prepare(
        "SELECT effective_from, rate FROM withholding_rates WHERE category_id = ? ORDER BY effective_from",
    )?;
    categories
        .into_iter()
        .map(|(id, name)| {
            let rates = rates
                .query_map([id], |r| {
                    Ok(WithholdingRate {
                        from: r.get(0)?,
                        rate: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(WithholdingCategory { id, name, rates })
        })
        .collect()
}

pub fn assert_withholding_category(conn: &Connection, id: Option<i64>) -> Result<()> {
    let Some(id) = id else { return Ok(()) };
    let found = conn
        .query_row(
            "SELECT 1 FROM withholding_categories WHERE id = ?",
            [id],
            |_| Ok(()),
        )
        .optional()?;
    match found {
        Some(()) => Ok(()),
        None => refuse(
            "withholding_category_not_found",
            format!("No withholding category with id {id}"),
        ),
    }
}

pub fn add_withholding_rate(
    conn: &Connection,
    category_id: i64,
    input: &WithholdingRateInput,
) -> Result<()> {
    assert_withholding_category(conn, Some(category_id))?;
    assert_iso_date(&input.from)?;
    let Some(rate) = safe_int(input.rate).filter(|r| (0..=WHOLE).contains(r)) else {
        return refuse(
            "tax_rate_invalid",
            format!(
                "Rate {} is not between 0 and 10000 basis points",
                input.rate
            ),
        );
    };
    conn.execute(
        "INSERT INTO withholding_rates (category_id, effective_from, rate) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET rate = excluded.rate",
        params![category_id, input.from, rate],
    )?;
    Ok(())
}

pub fn withholding_rate(conn: &Connection, category_id: i64, date: &str) -> Result<i64> {
    assert_withholding_category(conn, Some(category_id))?;
    assert_iso_date(date)?;
    let rate: Option<i64> = conn
        .query_row(
            "SELECT rate FROM withholding_rates WHERE category_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
            params![category_id, date],
            |r| r.get(0),
        )
        .optional()?;
    match rate {
        Some(rate) => Ok(rate),
        None => refuse(
            "tax_rate_missing",
            format!("No withholding rate in force on {date} for category {category_id}"),
        ),
    }
}

/** The tax on `base` at the category's rate on `date`, rounded half-up to the piastre. */
pub fn withholding_tax(
    conn: &Connection,
    category_id: i64,
    date: &str,
    base: f64,
) -> Result<Piastres> {
    let Some(base) = safe_int(base).filter(|b| *b >= 0) else {
        return refuse(
            "withholding_invalid",
            format!("Base {base} is not whole piastres"),
        );
    };
    Ok(mul_div_round(
        base,
        withholding_rate(conn, category_id, date)?,
        WHOLE,
    ))
}

/** Withholding taken on payments between two dates, both directions, for the quarterly form. */
pub fn withholding_report(conn: &Connection, from: &str, to: &str) -> Result<WithholdingReport> {
    assert_iso_date(from)?;
    assert_iso_date(to)?;
    if from > to {
        return refuse("date_range_invalid", format!("{from} is after {to}"));
    }
    let rows: Vec<WithholdingRow> = conn
        .prepare(
            "SELECT p.kind, p.date, p.number, COALESCE(c.name, s.name),
                    COALESCE(c.tax_registration_number, s.tax_registration_number),
                    w.name, p.withholding_rate, p.withholding_base, p.withholding_amount
               FROM payments p JOIN withholding_categories w ON w.id = p.withholding_category_id
               LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
              WHERE p.date BETWEEN ? AND ?
              ORDER BY p.date, p.id",
        )?
        .query_map(params![from, to], |r| {
            Ok(WithholdingRow {
                kind: r.get(0)?,
                date: r.get(1)?,
                number: r.get(2)?,
                party_name: r.get(3)?,
                tax_registration_number: r.get(4)?,
                category: r.get(5)?,
                rate: r.get(6)?,
                base: r.get(7)?,
                tax: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let total = |kind: &str| rows.iter().filter(|r| r.kind == kind).map(|r| r.tax).sum();
    Ok(WithholdingReport {
        from: from.into(),
        to: to.into(),
        withheld: total("supplier"),
        suffered: total("customer"),
        rows,
    })
}
