//! Import shipments: customs, freight and other costs spread into the cost of the goods they brought.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::currency::to_egp;
use crate::dates::assert_iso_date;
use crate::error::{refuse, Result};
use crate::items::Quantity;
use crate::ledger::{post_journal_entry, JournalEntryInput, JournalLine, Piastres};
use crate::num::{mul_div_round, safe_int};
use crate::purchases::{assert_postable, find_supplier, Supplier};
use crate::shares::next_number;
use crate::stock::{account_by_role, insert_movement, NewMovement};

pub const SHIPMENT_COST_KINDS: [&str; 5] =
    ["customs_duty", "freight", "clearance", "insurance", "other"];

const ONE_UNIT: i64 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentCostInput {
    /** customs_duty, freight, clearance, insurance or other. */
    pub kind: String,
    /** The supplier billing this cost (customs, the shipping line, the clearing agent), in EGP. */
    pub payee_id: i64,
    /** The cost in piastres, without VAT. */
    pub amount: f64,
    /** VAT paid on it: input VAT, not cost. */
    pub vat: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportShipmentInput {
    pub date: String,
    /** The bill of lading or customs declaration number. */
    pub reference: String,
    pub purchase_invoice_ids: Vec<i64>,
    /** How the costs are shared over the item lines: "value" or "quantity". */
    pub spread_by: String,
    pub costs: Vec<ShipmentCostInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentCost {
    pub kind: String,
    pub payee_id: i64,
    pub payee: String,
    pub amount: Piastres,
    pub vat: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentLine {
    pub item_id: i64,
    pub name_ar: String,
    /** In thousandths of the item's base unit. */
    pub quantity: Quantity,
    /** The goods' cost in EGP, as the purchase invoice put it into stock. */
    pub goods: Piastres,
    pub allocated: Piastres,
    /** Goods plus allocated costs, per one base unit. */
    pub landed_unit_cost: Piastres,
    pub to_cost_of_sales: Piastres,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportShipment {
    pub id: i64,
    pub number: i64,
    pub date: String,
    pub reference: String,
    pub spread_by: String,
    pub purchase_invoice_ids: Vec<i64>,
    pub cost_lines: Vec<ShipmentCost>,
    /** The goods in EGP, the costs spread over them (without VAT), and the VAT paid on the costs. */
    pub goods: Piastres,
    pub costs: Piastres,
    pub vat: Piastres,
    pub lines: Vec<ShipmentLine>,
}

/**
 * Shares `total` over `weights` in proportion, each rounded half-up; whatever rounding leaves
 * over (or takes too much) goes to the line with the largest weight, so the parts add up exactly.
 */
fn spread(total: Piastres, weights: &[i64]) -> Vec<Piastres> {
    let sum: i64 = weights.iter().sum();
    if sum == 0 {
        return (0..weights.len())
            .map(|i| if i == 0 { total } else { 0 })
            .collect();
    }
    let mut parts: Vec<Piastres> = weights
        .iter()
        .map(|&w| mul_div_round(total, w, sum))
        .collect();
    // The first of the largest, as JavaScript's indexOf(Math.max(...)) finds it.
    let max = weights.iter().copied().max().unwrap_or(0);
    let largest = weights.iter().position(|&w| w == max).unwrap_or(0);
    let rest = total - parts.iter().sum::<i64>();
    if let Some(p) = parts.get_mut(largest) {
        *p += rest;
    }
    parts
}

fn whole(amount: f64) -> Result<Piastres> {
    match safe_int(amount) {
        Some(a) if a >= 0 => Ok(a),
        _ => refuse(
            "amount_invalid",
            format!("Amount {amount} is not whole piastres"),
        ),
    }
}

struct Bought {
    id: i64,
    item_id: i64,
    warehouse_id: i64,
    base: Quantity,
    goods: Piastres,
}

fn unique(ids: &[i64]) -> Vec<i64> {
    let mut seen = Vec::new();
    for &id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

/**
 * Posts an import shipment: its costs spread over the items of its purchase invoices.
 * Dr Stock with the costs of units still held (raising their average cost), Dr Cost of
 * sales with the share of units already sold, Dr Input VAT, Cr each payee.
 */
pub fn post_import_shipment(
    conn: &Connection,
    input: &ImportShipmentInput,
    user_id: i64,
) -> Result<i64> {
    assert_iso_date(&input.date)?;
    if input.purchase_invoice_ids.is_empty() {
        return refuse(
            "shipment_needs_invoices",
            "A shipment needs at least one purchase invoice",
        );
    }
    if input.costs.is_empty() {
        return refuse("shipment_needs_costs", "A shipment needs at least one cost");
    }
    if input.spread_by != "value" && input.spread_by != "quantity" {
        return refuse(
            "spread_invalid",
            format!("Unknown spread {}", input.spread_by),
        );
    }
    let mut costs: Vec<(Piastres, Piastres, Supplier)> = Vec::new();
    for c in &input.costs {
        if !SHIPMENT_COST_KINDS.contains(&c.kind.as_str()) {
            return refuse("cost_kind_invalid", format!("Unknown cost {}", c.kind));
        }
        let (amount, vat) = (whole(c.amount)?, whole(c.vat)?);
        let payee = find_supplier(conn, c.payee_id)?;
        assert_postable(&payee)?;
        if payee.currency != "EGP" {
            return refuse(
                "payee_not_egp",
                format!(
                    "{} bills in {}; shipment costs are in EGP",
                    payee.name, payee.currency
                ),
            );
        }
        costs.push((amount, vat, payee));
    }
    let total: Piastres = costs.iter().map(|c| c.0).sum();
    let vat: Piastres = costs.iter().map(|c| c.1).sum();
    if total + vat == 0 {
        return refuse("amount_invalid", "The shipment's costs are zero");
    }

    let invoice_ids = unique(&input.purchase_invoice_ids);
    let mut lines_of = conn.prepare_cached(
        "SELECT l.id, l.item_id, p.warehouse_id, l.quantity, COALESCE(u.size, 1000), l.net, p.rate
           FROM purchase_invoice_lines l JOIN purchase_invoices p ON p.id = l.invoice_id
           LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
          WHERE l.invoice_id = ? ORDER BY l.id",
    )?;
    let mut lines: Vec<Bought> = Vec::new();
    for &id in &invoice_ids {
        let exists = conn
            .query_row("SELECT 1 FROM purchase_invoices WHERE id = ?", [id], |_| {
                Ok(())
            })
            .optional()?;
        if exists.is_none() {
            return refuse(
                "invoice_not_found",
                format!("No purchase invoice with id {id}"),
            );
        }
        let taken = conn
            .query_row(
                "SELECT 1 FROM import_shipment_invoices WHERE purchase_invoice_id = ?",
                [id],
                |_| Ok(()),
            )
            .optional()?;
        if taken.is_some() {
            return refuse(
                "invoice_in_shipment",
                format!("Purchase invoice {id} is already in a shipment"),
            );
        }
        let rows = lines_of
            .query_map([id], |r| {
                let (quantity, size, net, rate): (i64, i64, i64, i64) =
                    (r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?);
                Ok(Bought {
                    id: r.get(0)?,
                    item_id: r.get(1)?,
                    warehouse_id: r.get(2)?,
                    base: mul_div_round(quantity, size, ONE_UNIT),
                    goods: to_egp(net, rate),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        lines.extend(rows);
    }
    let weights: Vec<i64> = lines
        .iter()
        .map(|l| {
            if input.spread_by == "value" {
                l.goods
            } else {
                l.base
            }
        })
        .collect();
    let allocated = spread(total, &weights);

    // Units of an item already gone since it arrived take their share to cost of sales.
    let mut held: std::collections::HashMap<i64, Quantity> = std::collections::HashMap::new();
    let mut split: Vec<(Piastres, Piastres)> = Vec::new();
    for (l, &share) in lines.iter().zip(&allocated) {
        let left = match held.get(&l.item_id) {
            Some(&q) => q,
            None => conn
                .query_row(
                    "SELECT COALESCE(SUM(quantity), 0) FROM stock_movements WHERE item_id = ?",
                    [l.item_id],
                    |r| r.get::<_, i64>(0),
                )?
                .max(0),
        };
        let in_stock = left.min(l.base);
        held.insert(l.item_id, left - in_stock);
        let to_stock = if in_stock == l.base {
            share
        } else {
            mul_div_round(share, in_stock, l.base)
        };
        split.push((to_stock, share - to_stock));
    }
    let to_stock: Piastres = split.iter().map(|s| s.0).sum();
    let to_cost_of_sales: Piastres = split.iter().map(|s| s.1).sum();

    let number = next_number(conn, "import_shipments")?;
    let reference = input.reference.trim();
    let mut journal = Vec::new();
    if to_stock > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "stock")?,
            to_stock,
        ));
    }
    if to_cost_of_sales > 0 {
        journal.push(JournalLine::debit(
            account_by_role(conn, "cost_of_goods_sold")?,
            to_cost_of_sales,
        ));
    }
    if vat > 0 {
        journal.push(JournalLine::debit(account_by_role(conn, "input_vat")?, vat));
    }
    for (amount, vat, payee) in &costs {
        if amount + vat > 0 {
            journal.push(JournalLine {
                supplier_id: Some(payee.id),
                ..JournalLine::credit(account_by_role(conn, "payables")?, amount + vat)
            });
        }
    }
    let memo = if reference.is_empty() {
        format!("شحنة استيراد رقم {number}")
    } else {
        format!("شحنة استيراد رقم {number} - {reference}")
    };
    let entry_id = post_journal_entry(
        conn,
        &JournalEntryInput {
            date: input.date.clone(),
            memo,
            lines: journal,
        },
        "import_shipment",
    )?;
    conn.execute(
        "INSERT INTO import_shipments (number, date, reference, spread_by, entry_id, user_id) VALUES (?, ?, ?, ?, ?, ?)",
        params![number, input.date, reference, input.spread_by, entry_id, user_id],
    )?;
    let id = conn.last_insert_rowid();
    for invoice_id in &invoice_ids {
        conn.execute(
            "INSERT INTO import_shipment_invoices (shipment_id, purchase_invoice_id) VALUES (?, ?)",
            params![id, invoice_id],
        )?;
    }
    for (c, (amount, vat, _)) in input.costs.iter().zip(&costs) {
        conn.execute(
            "INSERT INTO import_shipment_costs (shipment_id, kind, supplier_id, amount, vat) VALUES (?, ?, ?, ?, ?)",
            params![id, c.kind, c.payee_id, amount, vat],
        )?;
    }
    for ((l, &share), &(to_stock, to_cost_of_sales)) in lines.iter().zip(&allocated).zip(&split) {
        conn.execute(
            "INSERT INTO import_shipment_lines (shipment_id, purchase_line_id, allocated, to_stock, to_cost_of_sales) VALUES (?, ?, ?, ?, ?)",
            params![id, l.id, share, to_stock, to_cost_of_sales],
        )?;
        // A value-only movement: no units move, the units held carry the cost.
        if to_stock != 0 {
            insert_movement(
                conn,
                NewMovement {
                    date: &input.date,
                    item_id: l.item_id,
                    warehouse_id: l.warehouse_id,
                    quantity: 0,
                    value: to_stock,
                    source: "import_shipment",
                    source_id: id,
                },
            )?;
        }
    }
    Ok(id)
}

/** Import shipments, newest first, with each item's landed unit cost. */
pub fn list_import_shipments(conn: &Connection) -> Result<Vec<ImportShipment>> {
    let rows: Vec<(i64, i64, String, String, String)> = conn
        .prepare(
            "SELECT id, number, date, reference, spread_by FROM import_shipments ORDER BY number DESC",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut invoices = conn.prepare(
        "SELECT purchase_invoice_id FROM import_shipment_invoices WHERE shipment_id = ? ORDER BY purchase_invoice_id",
    )?;
    let mut costs = conn.prepare(
        "SELECT c.kind, c.supplier_id, s.name, c.amount, c.vat
           FROM import_shipment_costs c JOIN suppliers s ON s.id = c.supplier_id WHERE c.shipment_id = ? ORDER BY c.id",
    )?;
    let mut lines = conn.prepare(
        "SELECT l.item_id, i.name_ar, l.quantity, COALESCE(u.size, 1000), l.net, p.rate, x.allocated, x.to_cost_of_sales
           FROM import_shipment_lines x JOIN purchase_invoice_lines l ON l.id = x.purchase_line_id
           JOIN purchase_invoices p ON p.id = l.invoice_id JOIN items i ON i.id = l.item_id
           LEFT JOIN item_units u ON u.item_id = l.item_id AND u.kind = l.unit
          WHERE x.shipment_id = ? ORDER BY x.id",
    )?;
    rows.into_iter()
        .map(|(id, number, date, reference, spread_by)| {
            let cost_lines: Vec<ShipmentCost> = costs
                .query_map([id], |r| {
                    Ok(ShipmentCost {
                        kind: r.get(0)?,
                        payee_id: r.get(1)?,
                        payee: r.get(2)?,
                        amount: r.get(3)?,
                        vat: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let shipment_lines: Vec<ShipmentLine> = lines
                .query_map([id], |r| {
                    let (quantity, size, net, rate): (i64, i64, i64, i64) =
                        (r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?);
                    let allocated: i64 = r.get(6)?;
                    let quantity = mul_div_round(quantity, size, ONE_UNIT);
                    let goods = to_egp(net, rate);
                    Ok(ShipmentLine {
                        item_id: r.get(0)?,
                        name_ar: r.get(1)?,
                        quantity,
                        goods,
                        allocated,
                        landed_unit_cost: if quantity == 0 {
                            0
                        } else {
                            mul_div_round(goods + allocated, ONE_UNIT, quantity)
                        },
                        to_cost_of_sales: r.get(7)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let purchase_invoice_ids = invoices
                .query_map([id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(ImportShipment {
                id,
                number,
                date,
                reference,
                spread_by,
                purchase_invoice_ids,
                goods: shipment_lines.iter().map(|l| l.goods).sum(),
                costs: cost_lines.iter().map(|c| c.amount).sum(),
                vat: cost_lines.iter().map(|c| c.vat).sum(),
                cost_lines,
                lines: shipment_lines,
            })
        })
        .collect()
}
