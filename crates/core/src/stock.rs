use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dates::{assert_iso_date, IsoDate};
use crate::error::{refuse, Result};
use crate::items::{Quantity, ONE_BASE_UNIT};
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, safe_int};
use crate::serials::{issue_serials, receive_serials, serials_for, Move};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Warehouse {
    pub id: i64,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseQuantity {
    pub warehouse_id: i64,
    pub quantity: Quantity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockOnHand {
    pub total: Quantity,
    pub by_warehouse: Vec<WarehouseQuantity>,
}

/**
 * A line counted in the item's base unit or its pack unit, in thousandths of that unit. A line of
 * a serialised item carries one serial number per unit.
 */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitLine {
    pub item_id: i64,
    /** "base" or "pack". */
    pub unit: String,
    pub quantity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

impl UnitLine {
    pub fn base(item_id: i64, quantity: Quantity) -> Self {
        UnitLine {
            item_id,
            unit: "base".into(),
            quantity: quantity as f64,
            serials: None,
        }
    }
    pub fn pack(item_id: i64, quantity: Quantity) -> Self {
        UnitLine {
            unit: "pack".into(),
            ..UnitLine::base(item_id, quantity)
        }
    }
    pub fn with_serials(mut self, serials: &[&str]) -> Self {
        self.serials = Some(serials.iter().map(|s| s.to_string()).collect());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferInput {
    pub date: IsoDate,
    pub from: i64,
    pub to: i64,
    pub memo: String,
    pub lines: Vec<UnitLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferLine {
    pub item_id: i64,
    pub quantity: Quantity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transfer {
    pub id: i64,
    pub date: IsoDate,
    pub from: i64,
    pub to: i64,
    pub memo: String,
    pub lines: Vec<TransferLine>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningStockLine {
    pub item_id: i64,
    pub quantity: f64,
    pub unit_cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<Vec<String>>,
}

pub fn list_warehouses(conn: &Connection) -> Result<Vec<Warehouse>> {
    Ok(conn
        .prepare("SELECT id, name, active FROM warehouses ORDER BY id")?
        .query_map([], |r| {
            Ok(Warehouse {
                id: r.get(0)?,
                name: r.get(1)?,
                active: r.get::<_, i64>(2)? == 1,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn find_warehouse(conn: &Connection, id: i64) -> Result<Warehouse> {
    let found = conn
        .query_row(
            "SELECT id, name, active FROM warehouses WHERE id = ?",
            [id],
            |r| {
                Ok(Warehouse {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    active: r.get::<_, i64>(2)? == 1,
                })
            },
        )
        .optional()?;
    match found {
        Some(w) => Ok(w),
        None => refuse("warehouse_not_found", format!("No warehouse with id {id}")),
    }
}

pub fn active_warehouse(conn: &Connection, id: i64) -> Result<Warehouse> {
    let warehouse = find_warehouse(conn, id)?;
    if !warehouse.active {
        return refuse(
            "warehouse_inactive",
            format!("Warehouse {} is stopped", warehouse.name),
        );
    }
    Ok(warehouse)
}

fn clean_warehouse_name(conn: &Connection, name: &str, except: Option<i64>) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return refuse("warehouse_name_required", "A warehouse needs a name");
    }
    let owner: Option<i64> = conn
        .query_row("SELECT id FROM warehouses WHERE name = ?", [trimmed], |r| {
            r.get(0)
        })
        .optional()?;
    if owner.is_some() && owner != except {
        return refuse(
            "warehouse_name_taken",
            format!("A warehouse called {trimmed} exists"),
        );
    }
    Ok(trimmed.to_string())
}

pub fn add_warehouse(conn: &Connection, name: &str) -> Result<i64> {
    let clean = clean_warehouse_name(conn, name, None)?;
    conn.execute("INSERT INTO warehouses (name) VALUES (?)", [clean])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_warehouse(conn: &Connection, id: i64, name: &str) -> Result<()> {
    find_warehouse(conn, id)?;
    let clean = clean_warehouse_name(conn, name, Some(id))?;
    conn.execute(
        "UPDATE warehouses SET name = ? WHERE id = ?",
        params![clean, id],
    )?;
    Ok(())
}

pub fn set_warehouse_active(conn: &Connection, id: i64, active: bool) -> Result<()> {
    let warehouse = find_warehouse(conn, id)?;
    if !active {
        let held = conn
            .query_row(
                "SELECT 1 FROM stock_movements WHERE warehouse_id = ? GROUP BY item_id HAVING SUM(quantity) <> 0 LIMIT 1",
                [id],
                |_| Ok(()),
            )
            .optional()?;
        if held.is_some() {
            return refuse(
                "warehouse_has_stock",
                format!("Warehouse {} still holds stock", warehouse.name),
            );
        }
    }
    conn.execute(
        "UPDATE warehouses SET active = ? WHERE id = ?",
        params![active as i64, id],
    )?;
    Ok(())
}

/** How much of an item one warehouse holds. */
pub fn held_in(conn: &Connection, item_id: i64, warehouse_id: i64) -> Result<Quantity> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movements WHERE item_id = ? AND warehouse_id = ?",
        params![item_id, warehouse_id],
        |r| r.get(0),
    )?)
}

/** Quantity and value held of an item, across every warehouse. */
pub fn held(conn: &Connection, item_id: i64) -> Result<(Quantity, Piastres)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(value), 0) FROM stock_movements WHERE item_id = ?",
        [item_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/** Each warehouse holding some of an item, by warehouse id. */
pub fn by_warehouse(conn: &Connection, item_id: i64) -> Result<Vec<WarehouseQuantity>> {
    Ok(conn
        .prepare(
            "SELECT warehouse_id, SUM(quantity) FROM stock_movements
              WHERE item_id = ? GROUP BY warehouse_id HAVING SUM(quantity) <> 0 ORDER BY warehouse_id",
        )?
        .query_map([item_id], |r| {
            Ok(WarehouseQuantity {
                warehouse_id: r.get(0)?,
                quantity: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn stock_on_hand(conn: &Connection, item_id: i64) -> Result<StockOnHand> {
    let rows = by_warehouse(conn, item_id)?;
    Ok(StockOnHand {
        total: rows.iter().map(|r| r.quantity).sum(),
        by_warehouse: rows,
    })
}

/**
 * Weighted average cost of one base unit, in piastres: the value of all stock
 * held divided by the quantity held, across every warehouse. Zero when none is held.
 */
pub fn average_cost(conn: &Connection, item_id: i64) -> Result<Piastres> {
    let (q, v) = held(conn, item_id)?;
    Ok(if q <= 0 {
        0
    } else {
        mul_div_round(v, ONE_BASE_UNIT, q)
    })
}

/** Value of all stock held of an item, in piastres: what the Stock account holds for it. */
pub fn stock_value(conn: &Connection, item_id: i64) -> Result<Piastres> {
    Ok(held(conn, item_id)?.1)
}

/**
 * The cost of taking a base quantity out of stock at the weighted average. Taking
 * everything held takes exactly its value, so no rounding is left behind. With
 * nothing held, the unit cost of the last receipt is used. `already_taken` is stock taken
 * earlier in the same document but not yet recorded.
 */
pub fn cost_of_issue(
    conn: &Connection,
    item_id: i64,
    quantity: Quantity,
    already_taken: (Quantity, Piastres),
) -> Result<Piastres> {
    let (q, v) = held(conn, item_id)?;
    let (q, v) = (q - already_taken.0, v - already_taken.1);
    if q > 0 {
        return Ok(if quantity == q {
            v
        } else {
            mul_div_round(quantity, v, q)
        });
    }
    let last: Option<(i64, i64)> = conn
        .query_row(
            "SELECT quantity, value FROM stock_movements WHERE item_id = ? AND quantity > 0 AND value > 0 ORDER BY id DESC LIMIT 1",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(last.map_or(0, |(lq, lv)| mul_div_round(quantity, lv, lq)))
}

pub fn assert_quantity(quantity: f64) -> Result<Quantity> {
    match safe_int(quantity) {
        Some(q) if q > 0 => Ok(q),
        _ => refuse(
            "quantity_invalid",
            format!("Quantity {quantity} is not a positive whole number of thousandths"),
        ),
    }
}

/** Converts a line in base or pack units to thousandths of the base unit. */
pub fn to_base_quantity(conn: &Connection, line: &UnitLine) -> Result<Quantity> {
    let quantity = assert_quantity(line.quantity)?;
    let unit: Option<Option<i64>> = conn
        .query_row(
            "SELECT u.size FROM items i LEFT JOIN item_units u ON u.item_id = i.id AND u.kind = ? WHERE i.id = ?",
            params![line.unit, line.item_id],
            |r| r.get(0),
        )
        .optional()?;
    let size = match unit {
        None => {
            return refuse(
                "item_not_found",
                format!("No item with id {}", line.item_id),
            )
        }
        Some(None) => {
            return refuse(
                "item_has_no_pack",
                format!("Item {} has no pack unit", line.item_id),
            )
        }
        Some(Some(size)) => size,
    };
    let n = quantity as i128 * size as i128;
    if n % ONE_BASE_UNIT as i128 != 0 {
        return refuse(
            "quantity_invalid",
            "Quantity does not convert to whole thousandths",
        );
    }
    match i64::try_from(n / ONE_BASE_UNIT as i128)
        .ok()
        .filter(|b| b.abs() <= 9_007_199_254_740_991)
    {
        Some(base) => Ok(base),
        None => refuse(
            "quantity_invalid",
            "Quantity does not convert to whole thousandths",
        ),
    }
}

pub struct NewMovement<'a> {
    pub date: &'a str,
    pub item_id: i64,
    pub warehouse_id: i64,
    pub quantity: Quantity,
    pub value: Piastres,
    pub source: &'a str,
    pub source_id: i64,
}

pub fn insert_movement(conn: &Connection, m: NewMovement) -> Result<()> {
    conn.execute(
        "INSERT INTO stock_movements (date, item_id, warehouse_id, quantity, value, source, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![m.date, m.item_id, m.warehouse_id, m.quantity, m.value, m.source, m.source_id],
    )?;
    Ok(())
}

pub fn account_by_role(conn: &Connection, role: &str) -> Result<i64> {
    Ok(
        conn.query_row("SELECT id FROM accounts WHERE role = ?", [role], |r| {
            r.get(0)
        })?,
    )
}

fn item_exists(conn: &Connection, item_id: i64) -> Result<()> {
    let found = conn
        .query_row("SELECT 1 FROM items WHERE id = ?", [item_id], |_| Ok(()))
        .optional()?;
    match found {
        Some(()) => Ok(()),
        None => refuse("item_not_found", format!("No item with id {item_id}")),
    }
}

/** Stock a business holds when it starts: Dr Stock, Cr Opening balances, at the given unit cost. */
pub fn post_opening_stock(
    conn: &Connection,
    date: &str,
    warehouse_id: i64,
    lines: &[OpeningStockLine],
) -> Result<i64> {
    assert_iso_date(date)?;
    active_warehouse(conn, warehouse_id)?;
    if lines.is_empty() {
        return refuse(
            "transfer_needs_lines",
            "Opening stock needs at least one line",
        );
    }
    let mut clean = Vec::with_capacity(lines.len());
    let mut total = 0;
    for line in lines {
        let quantity = assert_quantity(line.quantity)?;
        let unit_cost = match safe_int(line.unit_cost) {
            Some(c) if c >= 0 => c,
            _ => {
                return refuse(
                    "price_invalid",
                    format!("Unit cost {} is not whole piastres", line.unit_cost),
                )
            }
        };
        item_exists(conn, line.item_id)?;
        let value = mul_div_round(quantity, unit_cost, ONE_BASE_UNIT);
        total += value;
        clean.push((line, quantity, value));
    }
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: date.into(),
            memo: "مخزون أول المدة".into(),
            lines: vec![
                JournalLine::debit(account_by_role(conn, "stock")?, total),
                JournalLine::credit(account_by_role(conn, "opening_balances")?, total),
            ],
        },
        "opening_stock",
    )?;
    for (line, quantity, value) in clean {
        insert_movement(
            conn,
            NewMovement {
                date,
                item_id: line.item_id,
                warehouse_id,
                quantity,
                value,
                source: "opening_stock",
                source_id: entry_id,
            },
        )?;
        let serials = serials_for(conn, line.item_id, quantity, line.serials.as_deref())?;
        receive_serials(
            conn,
            line.item_id,
            &serials,
            &Move {
                date,
                warehouse_id,
                source: "opening_stock",
                source_id: entry_id,
                line_id: None,
            },
        )?;
    }
    Ok(entry_id)
}

/** Moves stock between two warehouses. Cost is one average per item, so the books do not change. */
pub fn transfer_stock(conn: &Connection, input: &TransferInput) -> Result<i64> {
    assert_iso_date(&input.date)?;
    if input.from == input.to {
        return refuse("transfer_same_warehouse", "Pick two different warehouses");
    }
    active_warehouse(conn, input.from)?;
    active_warehouse(conn, input.to)?;
    if input.lines.is_empty() {
        return refuse("transfer_needs_lines", "A transfer needs at least one line");
    }
    let mut moves: Vec<(i64, Quantity)> = Vec::new();
    for line in &input.lines {
        let base = to_base_quantity(conn, line)?;
        match moves.iter_mut().find(|(id, _)| *id == line.item_id) {
            Some((_, q)) => *q += base,
            None => moves.push((line.item_id, base)),
        }
    }
    for &(item_id, quantity) in &moves {
        if held_in(conn, item_id, input.from)? < quantity {
            return refuse(
                "stock_insufficient",
                format!("Not enough of item {item_id} in the source warehouse"),
            );
        }
    }
    conn.execute(
        "INSERT INTO stock_transfers (date, from_warehouse_id, to_warehouse_id, memo) VALUES (?, ?, ?, ?)",
        params![input.date, input.from, input.to, input.memo.trim()],
    )?;
    let id = conn.last_insert_rowid();
    for &(item_id, quantity) in &moves {
        for (warehouse_id, quantity) in [(input.from, -quantity), (input.to, quantity)] {
            insert_movement(
                conn,
                NewMovement {
                    date: &input.date,
                    item_id,
                    warehouse_id,
                    quantity,
                    value: 0,
                    source: "transfer",
                    source_id: id,
                },
            )?;
        }
    }
    for (index, line) in input.lines.iter().enumerate() {
        let base = to_base_quantity(conn, line)?;
        let serials = serials_for(conn, line.item_id, base, line.serials.as_deref())?;
        let m = |warehouse_id| Move {
            date: &input.date,
            warehouse_id,
            source: "transfer",
            source_id: id,
            line_id: Some(index as i64),
        };
        issue_serials(conn, line.item_id, &serials, &m(input.from))?;
        receive_serials(conn, line.item_id, &serials, &m(input.to))?;
    }
    Ok(id)
}

pub fn list_transfers(conn: &Connection) -> Result<Vec<Transfer>> {
    let transfers: Vec<(i64, String, i64, i64, String)> = conn
        .prepare(
            "SELECT id, date, from_warehouse_id, to_warehouse_id, memo FROM stock_transfers ORDER BY date DESC, id DESC",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut lines = conn.prepare(
        "SELECT item_id, quantity FROM stock_movements
          WHERE source = 'transfer' AND source_id = ? AND quantity > 0 ORDER BY id",
    )?;
    transfers
        .into_iter()
        .map(|(id, date, from, to, memo)| {
            let lines = lines
                .query_map([id], |r| {
                    Ok(TransferLine {
                        item_id: r.get(0)?,
                        quantity: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Transfer {
                id,
                date,
                from,
                to,
                memo,
                lines,
            })
        })
        .collect()
}

/** The last stock movement's id, so a command's own movements can be told apart afterwards. */
pub fn last_movement_id(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(id), 0) FROM stock_movements",
        [],
        |r| r.get(0),
    )?)
}
