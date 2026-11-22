use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dates::{assert_iso_date, IsoDate};
use crate::error::{refuse, Result};
use crate::items::Quantity;
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, safe_int};
use crate::serials::{issue_serials, serials_for, Move};
use crate::stock::{
    account_by_role, active_warehouse, by_warehouse, cost_of_issue, held, held_in, insert_movement,
    to_base_quantity, NewMovement, UnitLine, WarehouseQuantity,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountedLine {
    pub item_id: i64,
    /** What was found on the shelves, in thousandths of the base unit. */
    pub counted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCountInput {
    pub date: IsoDate,
    pub warehouse_id: i64,
    pub memo: String,
    pub lines: Vec<CountedLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCountLine {
    pub item_id: i64,
    pub name_ar: String,
    pub expected: Quantity,
    pub counted: Quantity,
    pub difference: Quantity,
    /** The gain (positive) or loss (negative) posted for the difference. */
    pub value: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCount {
    pub id: i64,
    pub date: IsoDate,
    pub warehouse_id: i64,
    pub memo: String,
    pub lines: Vec<StockCountLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOffInput {
    pub date: IsoDate,
    pub warehouse_id: i64,
    pub reason: String,
    pub lines: Vec<UnitLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOffLine {
    pub item_id: i64,
    pub name_ar: String,
    pub quantity: Quantity,
    pub value: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOff {
    pub id: i64,
    pub date: IsoDate,
    pub warehouse_id: i64,
    pub reason: String,
    pub value: Piastres,
    pub lines: Vec<WriteOffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LowStockRow {
    pub item_id: i64,
    pub name_ar: String,
    pub min_quantity: Quantity,
    pub on_hand: Quantity,
    pub by_warehouse: Vec<WarehouseQuantity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMovement {
    pub id: i64,
    pub date: IsoDate,
    /** The kind of document: purchase, sale, sales_invoice, transfer, write_off, stock_count, … */
    pub source: String,
    pub source_id: i64,
    pub warehouse_id: i64,
    pub warehouse_name: String,
    pub quantity: Quantity,
    pub value: Piastres,
    /** Quantity held after this movement, in the warehouses shown. */
    pub balance: Quantity,
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

/** Value of units found over the books: the average cost, or the last receipt's when none are held. */
fn gain_value(conn: &Connection, item_id: i64, quantity: Quantity) -> Result<Piastres> {
    let (q, v) = held(conn, item_id)?;
    if q > 0 {
        return Ok(mul_div_round(quantity, v, q));
    }
    cost_of_issue(conn, item_id, quantity, (0, 0))
}

/** Posts a count: each item's difference from the books goes in as a gain (Dr Stock, Cr Stock gain) or out as a loss (Dr Stock loss, Cr Stock), at average cost. */
pub fn post_stock_count(conn: &Connection, input: &StockCountInput, user_id: i64) -> Result<i64> {
    assert_iso_date(&input.date)?;
    active_warehouse(conn, input.warehouse_id)?;
    if input.lines.is_empty() {
        return refuse("count_needs_lines", "A count needs at least one item");
    }
    let mut seen = Vec::new();
    let mut lines = Vec::with_capacity(input.lines.len());
    for l in &input.lines {
        let counted = match safe_int(l.counted) {
            Some(c) if c >= 0 => c,
            _ => {
                return refuse(
                    "quantity_invalid",
                    format!("Counted {} is not whole thousandths", l.counted),
                )
            }
        };
        if seen.contains(&l.item_id) {
            return refuse(
                "quantity_invalid",
                format!("Item {} is counted twice", l.item_id),
            );
        }
        seen.push(l.item_id);
        let serialised: Option<i64> = conn
            .query_row(
                "SELECT serialised FROM items WHERE id = ?",
                [l.item_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(serialised) = serialised else {
            return refuse("item_not_found", format!("No item with id {}", l.item_id));
        };
        let expected = held_in(conn, l.item_id, input.warehouse_id)?;
        let difference = counted - expected;
        // A serialised item's units are written off or received by serial number, not by a count.
        if difference != 0 && serialised == 1 {
            return refuse(
                "serials_required",
                format!("Item {} is serialised", l.item_id),
            );
        }
        let value = match difference {
            0 => 0,
            d if d < 0 => -cost_of_issue(conn, l.item_id, -d, (0, 0))?,
            d => gain_value(conn, l.item_id, d)?,
        };
        lines.push((l.item_id, expected, counted, difference, value));
    }

    let memo = input.memo.trim();
    conn.execute(
        "INSERT INTO stock_counts (date, warehouse_id, memo, user_id) VALUES (?, ?, ?, ?)",
        params![input.date, input.warehouse_id, memo, user_id],
    )?;
    let id = conn.last_insert_rowid();
    for &(item_id, expected, counted, difference, value) in &lines {
        conn.execute(
            "INSERT INTO stock_count_lines (count_id, item_id, expected, counted, value) VALUES (?, ?, ?, ?, ?)",
            params![id, item_id, expected, counted, value],
        )?;
        if difference != 0 {
            insert_movement(
                conn,
                NewMovement {
                    date: &input.date,
                    item_id,
                    warehouse_id: input.warehouse_id,
                    quantity: difference,
                    value,
                    source: "stock_count",
                    source_id: id,
                },
            )?;
        }
    }
    let gain: Piastres = lines.iter().map(|l| l.4).filter(|v| *v > 0).sum();
    let loss: Piastres = -lines.iter().map(|l| l.4).filter(|v| *v < 0).sum::<i64>();
    let mut journal = Vec::new();
    if gain > 0 {
        journal.push(JournalLine::debit(account_by_role(conn, "stock")?, gain));
        journal.push(JournalLine::credit(
            account_by_role(conn, "stock_gain")?,
            gain,
        ));
    }
    if loss > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "stock_loss")?,
            loss,
        ));
        journal.push(JournalLine::credit(account_by_role(conn, "stock")?, loss));
    }
    if !journal.is_empty() {
        let suffix = if memo.is_empty() {
            String::new()
        } else {
            format!(" - {memo}")
        };
        let entry_id = post(
            conn,
            &input.date,
            format!("جرد مخزن رقم {id}{suffix}"),
            journal,
            "stock_count",
        )?;
        conn.execute(
            "UPDATE stock_counts SET entry_id = ? WHERE id = ?",
            params![entry_id, id],
        )?;
    }
    Ok(id)
}

pub fn list_stock_counts(conn: &Connection) -> Result<Vec<StockCount>> {
    let counts: Vec<(i64, String, i64, String)> = conn
        .prepare("SELECT id, date, warehouse_id, memo FROM stock_counts ORDER BY id DESC")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut lines = conn.prepare(
        "SELECT l.item_id, i.name_ar, l.expected, l.counted, l.counted - l.expected, l.value
           FROM stock_count_lines l JOIN items i ON i.id = l.item_id WHERE l.count_id = ? ORDER BY l.id",
    )?;
    counts
        .into_iter()
        .map(|(id, date, warehouse_id, memo)| {
            let lines = lines
                .query_map([id], |r| {
                    Ok(StockCountLine {
                        item_id: r.get(0)?,
                        name_ar: r.get(1)?,
                        expected: r.get(2)?,
                        counted: r.get(3)?,
                        difference: r.get(4)?,
                        value: r.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(StockCount {
                id,
                date,
                warehouse_id,
                memo,
                lines,
            })
        })
        .collect()
}

/** Damaged, expired or lost stock taken out of one warehouse at average cost: Dr Stock loss, Cr Stock. */
pub fn write_off_stock(conn: &Connection, input: &WriteOffInput, user_id: i64) -> Result<i64> {
    assert_iso_date(&input.date)?;
    active_warehouse(conn, input.warehouse_id)?;
    let reason = input.reason.trim();
    if reason.is_empty() {
        return refuse("reason_required", "A write-off needs a reason");
    }
    if input.lines.is_empty() {
        return refuse("count_needs_lines", "A write-off needs at least one item");
    }
    let mut taken: Vec<(i64, Quantity, Piastres)> = Vec::new();
    let mut lines = Vec::with_capacity(input.lines.len());
    for line in &input.lines {
        let base = to_base_quantity(conn, line)?;
        let before = taken
            .iter()
            .find(|t| t.0 == line.item_id)
            .map_or((0, 0), |t| (t.1, t.2));
        if held_in(conn, line.item_id, input.warehouse_id)? - before.0 < base {
            return refuse(
                "stock_insufficient",
                format!("Not enough of item {} in the warehouse", line.item_id),
            );
        }
        let serials = serials_for(conn, line.item_id, base, line.serials.as_deref())?;
        let value = cost_of_issue(conn, line.item_id, base, before)?;
        match taken.iter_mut().find(|t| t.0 == line.item_id) {
            Some(t) => {
                t.1 += base;
                t.2 += value;
            }
            None => taken.push((line.item_id, base, value)),
        }
        lines.push((line.item_id, base, value, serials));
    }
    let total: Piastres = lines.iter().map(|l| l.2).sum();
    conn.execute(
        "INSERT INTO write_offs (date, warehouse_id, reason, user_id) VALUES (?, ?, ?, ?)",
        params![input.date, input.warehouse_id, reason, user_id],
    )?;
    let id = conn.last_insert_rowid();
    for (item_id, base, value, serials) in &lines {
        conn.execute(
            "INSERT INTO write_off_lines (write_off_id, item_id, quantity, value) VALUES (?, ?, ?, ?)",
            params![id, item_id, base, value],
        )?;
        let line_id = conn.last_insert_rowid();
        issue_serials(
            conn,
            *item_id,
            serials,
            &Move {
                date: &input.date,
                warehouse_id: input.warehouse_id,
                source: "write_off",
                source_id: id,
                line_id: Some(line_id),
            },
        )?;
        insert_movement(
            conn,
            NewMovement {
                date: &input.date,
                item_id: *item_id,
                warehouse_id: input.warehouse_id,
                quantity: -base,
                value: -value,
                source: "write_off",
                source_id: id,
            },
        )?;
    }
    if total > 0 {
        let entry_id = post(
            conn,
            &input.date,
            format!("إعدام مخزون رقم {id} - {reason}"),
            vec![
                JournalLine::debit(account_by_role(conn, "stock_loss")?, total),
                JournalLine::credit(account_by_role(conn, "stock")?, total),
            ],
            "write_off",
        )?;
        conn.execute(
            "UPDATE write_offs SET entry_id = ? WHERE id = ?",
            params![entry_id, id],
        )?;
    }
    Ok(id)
}

pub fn list_write_offs(conn: &Connection) -> Result<Vec<WriteOff>> {
    let offs: Vec<(i64, String, i64, String)> = conn
        .prepare("SELECT id, date, warehouse_id, reason FROM write_offs ORDER BY id DESC")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut lines = conn.prepare(
        "SELECT l.item_id, i.name_ar, l.quantity, l.value FROM write_off_lines l JOIN items i ON i.id = l.item_id WHERE l.write_off_id = ? ORDER BY l.id",
    )?;
    offs.into_iter()
        .map(|(id, date, warehouse_id, reason)| {
            let lines: Vec<WriteOffLine> = lines
                .query_map([id], |r| {
                    Ok(WriteOffLine {
                        item_id: r.get(0)?,
                        name_ar: r.get(1)?,
                        quantity: r.get(2)?,
                        value: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(WriteOff {
                id,
                date,
                warehouse_id,
                reason,
                value: lines.iter().map(|l| l.value).sum(),
                lines,
            })
        })
        .collect()
}

pub fn set_item_minimum(conn: &Connection, item_id: i64, minimum: Option<f64>) -> Result<()> {
    let minimum = match minimum {
        None => None,
        Some(m) => match safe_int(m) {
            Some(q) if q >= 0 => Some(q),
            _ => {
                return refuse(
                    "quantity_invalid",
                    format!("Minimum {m} is not whole thousandths"),
                )
            }
        },
    };
    let changed = conn.execute(
        "UPDATE items SET min_quantity = ? WHERE id = ?",
        params![minimum, item_id],
    )?;
    if changed == 0 {
        return refuse("item_not_found", format!("No item with id {item_id}"));
    }
    Ok(())
}

/** Active items with a minimum whose stock is below it: in total, or in one warehouse. */
pub fn low_stock(conn: &Connection, warehouse_id: Option<i64>) -> Result<Vec<LowStockRow>> {
    let items: Vec<(i64, String, i64)> = conn
        .prepare(
            "SELECT id, name_ar, min_quantity FROM items WHERE active = 1 AND min_quantity IS NOT NULL ORDER BY name_ar",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut rows = Vec::new();
    for (item_id, name_ar, min_quantity) in items {
        let by = by_warehouse(conn, item_id)?;
        let on_hand = match warehouse_id {
            None => by.iter().map(|w| w.quantity).sum(),
            Some(id) => by
                .iter()
                .find(|w| w.warehouse_id == id)
                .map_or(0, |w| w.quantity),
        };
        if on_hand < min_quantity {
            rows.push(LowStockRow {
                item_id,
                name_ar,
                min_quantity,
                on_hand,
                by_warehouse: by,
            });
        }
    }
    Ok(rows)
}

/** An item's movements in date order, with the quantity held after each, in all warehouses or one. */
pub fn item_movements(
    conn: &Connection,
    item_id: i64,
    warehouse_id: Option<i64>,
) -> Result<Vec<ItemMovement>> {
    let mut balance = 0;
    let rows: Vec<ItemMovement> = conn
        .prepare(
            "SELECT m.id, m.date, m.source, m.source_id, m.warehouse_id, w.name, m.quantity, m.value
               FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
              WHERE m.item_id = ? AND (? IS NULL OR m.warehouse_id = ?)
              ORDER BY m.date, m.id",
        )?
        .query_map(params![item_id, warehouse_id, warehouse_id], |r| {
            Ok(ItemMovement {
                id: r.get(0)?,
                date: r.get(1)?,
                source: r.get(2)?,
                source_id: r.get(3)?,
                warehouse_id: r.get(4)?,
                warehouse_name: r.get(5)?,
                quantity: r.get(6)?,
                value: r.get(7)?,
                balance: 0,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .map(|mut m| {
            balance += m.quantity;
            m.balance = balance;
            m
        })
        .collect())
}

/** Issues whose cost is taken at the average on their date: the account their cost goes to, and their lines. */
fn repriced(source: &str) -> Option<(&'static str, Option<(&'static str, &'static str)>)> {
    match source {
        "sale" => Some((
            "cost_of_goods_sold",
            Some(("sales_receipt_lines", "receipt_id")),
        )),
        "sales_invoice" => Some((
            "cost_of_goods_sold",
            Some(("sales_invoice_lines", "invoice_id")),
        )),
        "write_off" => Some(("stock_loss", Some(("write_off_lines", "write_off_id")))),
        "stock_count" => Some(("stock_loss", None)),
        _ => None,
    }
}

struct Movement {
    id: i64,
    date: String,
    quantity: i64,
    value: i64,
    source: String,
    source_id: i64,
}

/**
 * After a command, finds items it moved on a date earlier than movements already there (a
 * back-dated purchase or sale) and reprices every later issue at the average as it stood on its
 * own date. Each changed cost is posted as an adjustment on that issue's date (Cost of goods sold
 * or Stock loss against Stock), and the documents' line costs follow, so the Stock account keeps
 * matching the stock value.
 */
pub fn reprice_backdated(conn: &Connection, since: i64) -> Result<()> {
    let touched: Vec<(i64, String)> = conn
        .prepare("SELECT item_id, MIN(date) FROM stock_movements WHERE id > ? GROUP BY item_id")?
        .query_map([since], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (item_id, date) in touched {
        let later = conn
            .query_row(
                "SELECT 1 FROM stock_movements WHERE item_id = ? AND id <= ? AND date > ? LIMIT 1",
                params![item_id, since, date],
                |_| Ok(()),
            )
            .optional()?;
        if later.is_some() {
            reprice_from(conn, item_id, &date)?;
        }
    }
    Ok(())
}

fn reprice_from(conn: &Connection, item_id: i64, from: &str) -> Result<()> {
    let mut moves: Vec<Movement> = conn
        .prepare("SELECT id, date, quantity, value, source, source_id FROM stock_movements WHERE item_id = ? ORDER BY date, id")?
        .query_map([item_id], |r| {
            Ok(Movement {
                id: r.get(0)?,
                date: r.get(1)?,
                quantity: r.get(2)?,
                value: r.get(3)?,
                source: r.get(4)?,
                source_id: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let (mut q, mut v) = (0i64, 0i64);
    let mut last_receipt: Option<(i64, i64)> = None;
    // (movement index, the value it had)
    let mut changed: Vec<(usize, i64)> = Vec::new();
    for (index, m) in moves.iter_mut().enumerate() {
        if m.quantity < 0 && m.date.as_str() >= from && repriced(&m.source).is_some() {
            let out = -m.quantity;
            let cost = if q > 0 {
                if out == q {
                    v
                } else {
                    mul_div_round(out, v, q)
                }
            } else {
                last_receipt.map_or(0, |(lq, lv)| mul_div_round(out, lv, lq))
            };
            if -cost != m.value {
                changed.push((index, m.value));
            }
            m.value = -cost;
        }
        q += m.quantity;
        v += m.value;
        if m.quantity > 0 && m.value > 0 {
            last_receipt = Some((m.quantity, m.value));
        }
    }
    if changed.is_empty() {
        return Ok(());
    }

    for &(index, _) in &changed {
        conn.execute(
            "UPDATE stock_movements SET value = ? WHERE id = ?",
            params![moves[index].value, moves[index].id],
        )?;
    }

    // One adjustment per date: what each account's cost moved by, against Stock.
    let name: String =
        conn.query_row("SELECT name_ar FROM items WHERE id = ?", [item_id], |r| {
            r.get(0)
        })?;
    let mut by_date: Vec<(String, Vec<(&'static str, i64)>)> = Vec::new();
    for &(index, was) in &changed {
        let m = &moves[index];
        let role = repriced(&m.source).expect("only repriced sources change").0;
        let extra = was - m.value;
        let day = match by_date.iter_mut().position(|(d, _)| *d == m.date) {
            Some(i) => &mut by_date[i].1,
            None => {
                by_date.push((m.date.clone(), Vec::new()));
                &mut by_date.last_mut().expect("just pushed").1
            }
        };
        match day.iter_mut().find(|(r, _)| *r == role) {
            Some((_, t)) => *t += extra,
            None => day.push((role, extra)),
        }
    }
    by_date.sort_by(|a, b| a.0.cmp(&b.0));
    for (date, roles) in by_date {
        let mut lines = Vec::new();
        let mut stock = 0;
        for (role, extra) in roles {
            if extra == 0 {
                continue;
            }
            let account = account_by_role(conn, role)?;
            lines.push(if extra > 0 {
                JournalLine::debit(account, extra)
            } else {
                JournalLine::credit(account, -extra)
            });
            stock -= extra;
        }
        if stock == 0 {
            continue;
        }
        let account = account_by_role(conn, "stock")?;
        lines.push(if stock > 0 {
            JournalLine::debit(account, stock)
        } else {
            JournalLine::credit(account, -stock)
        });
        post(
            conn,
            &date,
            format!("تسوية تكلفة بأثر رجعي - {name}"),
            lines,
            "cost_adjustment",
        )?;
    }

    // The documents' own line costs follow their movements, shared over their lines of this item by quantity.
    let mut docs: Vec<(&str, i64)> = Vec::new();
    for &(index, _) in &changed {
        let key = (moves[index].source.as_str(), moves[index].source_id);
        if !docs.contains(&key) {
            docs.push(key);
        }
    }
    for (source, id) in docs {
        let total: i64 = conn.query_row(
            "SELECT SUM(value) FROM stock_movements WHERE item_id = ? AND source = ? AND source_id = ?",
            params![item_id, source, id],
            |r| r.get(0),
        )?;
        if source == "stock_count" {
            conn.execute(
                "UPDATE stock_count_lines SET value = ? WHERE count_id = ? AND item_id = ?",
                params![total, id, item_id],
            )?;
            continue;
        }
        let Some((_, Some((table, key)))) = repriced(source) else {
            continue;
        };
        let cost = -total;
        let column = if source == "write_off" {
            "value"
        } else {
            "cost"
        };
        let doc_lines: Vec<(i64, i64)> = conn
            .prepare(&format!(
                "SELECT id, quantity FROM {table} WHERE {key} = ? AND item_id = ? ORDER BY id"
            ))?
            .query_map(params![id, item_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let all: i64 = doc_lines.iter().map(|l| l.1).sum();
        let mut left = cost;
        for (i, (line_id, quantity)) in doc_lines.iter().enumerate() {
            let part = if i == doc_lines.len() - 1 {
                left
            } else {
                mul_div_round(cost, *quantity, all)
            };
            left -= part;
            conn.execute(
                &format!("UPDATE {table} SET {column} = ? WHERE id = ?"),
                params![part, line_id],
            )?;
        }
    }
    Ok(())
}
