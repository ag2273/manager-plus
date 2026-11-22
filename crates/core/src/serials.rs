use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dates::IsoDate;
use crate::error::{refuse, Result};
use crate::items::{Quantity, ONE_BASE_UNIT};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPurchase {
    pub date: IsoDate,
    pub supplier_id: i64,
    pub supplier_name: String,
    pub reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialSale {
    pub date: IsoDate,
    pub document: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
}

/** Where one unit of a serialised item has been and where it is now. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialHistory {
    pub item_id: i64,
    pub name_ar: String,
    pub serial: String,
    pub in_stock: bool,
    /** The warehouse it is in, or None when it is out of stock. */
    pub warehouse_id: Option<i64>,
    pub purchase: Option<SerialPurchase>,
    pub sale: Option<SerialSale>,
    /** Sale date + warranty months; None when not sold or the item has no warranty. */
    pub warranty_ends: Option<IsoDate>,
    pub under_warranty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialSettings {
    pub serialised: bool,
    pub warranty_months: f64,
}

/** Where a document moves serials: its date, warehouse, kind and id, and the line. */
#[derive(Debug, Clone)]
pub struct Move<'a> {
    pub date: &'a str,
    pub warehouse_id: i64,
    pub source: &'a str,
    pub source_id: i64,
    pub line_id: Option<i64>,
}

struct LastMove {
    warehouse_id: i64,
    source: String,
    source_id: i64,
}

/** A date some months later, kept to the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
pub fn add_months(date: &str, months: i64) -> IsoDate {
    let parts: Vec<i64> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    let (y, m, d) = (parts[0], parts[1], parts[2]);
    let total = y * 12 + (m - 1) + months;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    let first_next = if month == 12 {
        NaiveDate::from_ymd_opt(year as i32 + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year as i32, month as u32 + 1, 1)
    };
    let last = first_next
        .and_then(|n| n.pred_opt())
        .map_or(28, |n| n.day() as i64);
    format!("{year}-{month:02}-{:02}", d.min(last))
}

fn item_serial_settings(conn: &Connection, item_id: i64) -> Result<(bool, i64)> {
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT serialised, warranty_months FROM items WHERE id = ?",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.map_or((false, 0), |(s, w)| (s == 1, w)))
}

/**
 * The serials a document line must carry: exactly one per unit for a serialised item
 * (so the quantity must be whole), none for any other item. Returns them trimmed.
 */
pub fn serials_for(
    conn: &Connection,
    item_id: i64,
    base_quantity: Quantity,
    serials: Option<&[String]>,
) -> Result<Vec<String>> {
    let (serialised, _) = item_serial_settings(conn, item_id)?;
    let given: Vec<String> = serials
        .unwrap_or(&[])
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !serialised {
        if !given.is_empty() {
            return refuse(
                "serials_not_expected",
                format!("Item {item_id} does not take serial numbers"),
            );
        }
        return Ok(given);
    }
    let distinct: std::collections::HashSet<&String> = given.iter().collect();
    if base_quantity % ONE_BASE_UNIT != 0
        || given.len() as i64 != base_quantity / ONE_BASE_UNIT
        || distinct.len() != given.len()
    {
        return refuse(
            "serials_required",
            format!(
                "Item {item_id} needs {} different serial numbers, one per unit",
                base_quantity as f64 / ONE_BASE_UNIT as f64
            ),
        );
    }
    Ok(given)
}

struct State {
    id: i64,
    held: i64,
    last: Option<LastMove>,
}

fn state_of(conn: &Connection, item_id: i64, serial: &str) -> Result<Option<State>> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM serials WHERE item_id = ? AND serial = ?",
            params![item_id, serial],
            |r| r.get(0),
        )
        .optional()?;
    let Some(id) = id else { return Ok(None) };
    let held: i64 = conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0) FROM serial_movements WHERE serial_id = ?",
        [id],
        |r| r.get(0),
    )?;
    let last = conn
        .query_row(
            "SELECT warehouse_id, source, source_id FROM serial_movements WHERE serial_id = ? ORDER BY id DESC LIMIT 1",
            [id],
            |r| {
                Ok(LastMove {
                    warehouse_id: r.get(0)?,
                    source: r.get(1)?,
                    source_id: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(Some(State { id, held, last }))
}

fn record(conn: &Connection, serial_id: i64, quantity: i64, m: &Move) -> Result<()> {
    conn.execute(
        "INSERT INTO serial_movements (serial_id, date, warehouse_id, quantity, source, source_id, line_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![serial_id, m.date, m.warehouse_id, quantity, m.source, m.source_id, m.line_id],
    )?;
    Ok(())
}

/** Units received from outside (a purchase, opening stock): none may already be in stock. */
pub fn receive_serials(
    conn: &Connection,
    item_id: i64,
    serials: &[String],
    m: &Move,
) -> Result<()> {
    for serial in serials {
        let state = state_of(conn, item_id, serial)?;
        if state.as_ref().is_some_and(|s| s.held > 0) {
            return refuse(
                "serial_in_stock",
                format!("Serial {serial} is already in stock"),
            );
        }
        let id = match state {
            Some(s) => s.id,
            None => {
                conn.execute(
                    "INSERT INTO serials (item_id, serial) VALUES (?, ?)",
                    params![item_id, serial],
                )?;
                conn.last_insert_rowid()
            }
        };
        record(conn, id, 1, m)?;
    }
    Ok(())
}

/** Units leaving a warehouse (a sale, a transfer out, back to the supplier): each must be in stock there. */
pub fn issue_serials(conn: &Connection, item_id: i64, serials: &[String], m: &Move) -> Result<()> {
    for serial in serials {
        let state = state_of(conn, item_id, serial)?;
        match state {
            Some(s)
                if s.held > 0
                    && s.last.as_ref().map(|l| l.warehouse_id) == Some(m.warehouse_id) =>
            {
                record(conn, s.id, -1, m)?
            }
            _ => {
                return refuse(
                    "serial_not_in_stock",
                    format!(
                        "Serial {serial} is not in stock in warehouse {}",
                        m.warehouse_id
                    ),
                )
            }
        }
    }
    Ok(())
}

/** Units coming back from a customer: each must have last left on the given sale document. */
pub fn return_serials(
    conn: &Connection,
    item_id: i64,
    serials: &[String],
    sold_on: (&str, i64),
    m: &Move,
) -> Result<()> {
    for serial in serials {
        let state = state_of(conn, item_id, serial)?;
        match state {
            Some(s)
                if s.held <= 0
                    && s.last
                        .as_ref()
                        .is_some_and(|l| l.source == sold_on.0 && l.source_id == sold_on.1) =>
            {
                record(conn, s.id, 1, m)?
            }
            _ => {
                return refuse(
                    "serial_not_on_document",
                    format!("Serial {serial} was not sold on this document"),
                )
            }
        }
    }
    Ok(())
}

/** The serials that moved on one document line. */
pub fn serials_on_line(
    conn: &Connection,
    source: &str,
    source_id: i64,
    line_id: i64,
) -> Result<Vec<String>> {
    Ok(conn
        .prepare(
            "SELECT s.serial FROM serial_movements m JOIN serials s ON s.id = m.serial_id
              WHERE m.source = ? AND m.source_id = ? AND m.line_id = ? ORDER BY m.id",
        )?
        .query_map(params![source, source_id, line_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/** Marks an item serialised (or not) with a warranty; only while it holds no stock that lacks serials. */
pub fn set_item_serials(conn: &Connection, item_id: i64, input: &SerialSettings) -> Result<()> {
    let months = input.warranty_months;
    if months.fract() != 0.0 || !(0.0..=120.0).contains(&months) {
        return refuse(
            "warranty_invalid",
            format!("Warranty of {months} months is not 0–120"),
        );
    }
    let current: Option<i64> = conn
        .query_row(
            "SELECT serialised FROM items WHERE id = ?",
            [item_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(current) = current else {
        return refuse("item_not_found", format!("No item with id {item_id}"));
    };
    if (current == 1) != input.serialised {
        let held: i64 = conn.query_row(
            "SELECT COALESCE(SUM(quantity), 0) FROM stock_movements WHERE item_id = ?",
            [item_id],
            |r| r.get(0),
        )?;
        let serials_held: i64 = conn.query_row(
            "SELECT COUNT(*) FROM (SELECT m.serial_id FROM serial_movements m JOIN serials s ON s.id = m.serial_id WHERE s.item_id = ? GROUP BY m.serial_id HAVING SUM(m.quantity) > 0)",
            [item_id],
            |r| r.get(0),
        )?;
        let all_serialised = held == serials_held * ONE_BASE_UNIT;
        let locked = if input.serialised {
            !all_serialised
        } else {
            held != 0
        };
        if locked {
            return refuse(
                "serial_setting_locked",
                format!(
                    "Item {item_id} holds stock; serial tracking can change only with none on hand"
                ),
            );
        }
    }
    conn.execute(
        "UPDATE items SET serialised = ?, warranty_months = ? WHERE id = ?",
        params![input.serialised as i64, months as i64, item_id],
    )?;
    Ok(())
}

const SALE_SOURCES: [&str; 2] = ["sale", "sales_invoice"];

/** Every unit with this serial (normally one item), with where it came from, where it went, and its warranty on `today`. */
pub fn find_serial(conn: &Connection, serial: &str, today: &str) -> Result<Vec<SerialHistory>> {
    let serial = serial.trim();
    let rows: Vec<(i64, i64, String, i64)> = conn
        .prepare("SELECT s.id, s.item_id, i.name_ar, i.warranty_months FROM serials s JOIN items i ON i.id = s.item_id WHERE s.serial = ?")?
        .query_map([serial], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, item_id, name_ar, months) in rows {
        let state = state_of(conn, item_id, serial)?.expect("the serial was just found");
        let purchase = conn
            .query_row(
                "SELECT p.date, p.supplier_id, x.name, p.reference
                   FROM serial_movements m JOIN purchase_invoices p ON p.id = m.source_id JOIN suppliers x ON x.id = p.supplier_id
                  WHERE m.serial_id = ? AND m.source = 'purchase' ORDER BY m.id DESC LIMIT 1",
                [id],
                |r| {
                    Ok(SerialPurchase {
                        date: r.get(0)?,
                        supplier_id: r.get(1)?,
                        supplier_name: r.get(2)?,
                        reference: r.get(3)?,
                    })
                },
            )
            .optional()?;
        let last_out: Option<(String, i64, String)> = conn
            .query_row(
                "SELECT source, source_id, date FROM serial_movements WHERE serial_id = ? AND quantity = -1 AND source IN ('sale', 'sales_invoice') ORDER BY id DESC LIMIT 1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        // Sold, and not back in stock since: a returned unit is no longer the customer's.
        let last_source = state.last.as_ref().map(|l| l.source.as_str()).unwrap_or("");
        let sold = last_out.filter(|_| state.held <= 0 && SALE_SOURCES.contains(&last_source));
        let sale = match sold {
            None => None,
            Some((source, source_id, date)) => {
                let sql = if source == "sale" {
                    "SELECT 'إيصال ' || r.number, r.customer_id, c.name FROM sales_receipts r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?"
                } else {
                    "SELECT 'فاتورة ' || s.number, s.customer_id, c.name FROM sales_invoices s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?"
                };
                conn.query_row(sql, [source_id], |r| {
                    Ok(SerialSale {
                        date: date.clone(),
                        document: r.get(0)?,
                        customer_id: r.get(1)?,
                        customer_name: r.get(2)?,
                    })
                })
                .optional()?
            }
        };
        let warranty_ends = match &sale {
            Some(s) if months > 0 => Some(add_months(&s.date, months)),
            _ => None,
        };
        out.push(SerialHistory {
            item_id,
            name_ar,
            serial: serial.to_string(),
            in_stock: state.held > 0,
            warehouse_id: if state.held > 0 {
                state.last.as_ref().map(|l| l.warehouse_id)
            } else {
                None
            },
            purchase,
            sale,
            under_warranty: warranty_ends.as_deref().is_some_and(|end| today <= end),
            warranty_ends,
        });
    }
    Ok(out)
}

/** The warranty end for a unit sold on `date`, or None for an item without warranty. */
pub fn warranty_end(conn: &Connection, item_id: i64, date: &str) -> Result<Option<IsoDate>> {
    let (_, months) = item_serial_settings(conn, item_id)?;
    Ok((months > 0).then(|| add_months(date, months)))
}

#[cfg(test)]
mod tests {
    use super::add_months;

    #[test]
    fn a_month_later_keeps_to_the_last_day_of_a_shorter_month() {
        assert_eq!(add_months("2026-01-31", 1), "2026-02-28");
        assert_eq!(add_months("2028-01-31", 1), "2028-02-29");
        assert_eq!(add_months("2026-03-31", 12), "2027-03-31");
        assert_eq!(add_months("2026-11-15", 3), "2027-02-15");
    }
}
