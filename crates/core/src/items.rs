use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::dates::{assert_iso_date, IsoDate};
use crate::error::{refuse, Result};
use crate::ledger::Piastres;
use crate::num::{nullable, safe_int};

/** Integer thousandths of an item's base unit: 1000 = one piece or one kilogram. */
pub type Quantity = i64;
/** Basis points: 1400 = 14%. */
pub type BasisPoints = i64;

pub const ONE_BASE_UNIT: Quantity = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaxRate {
    pub from: IsoDate,
    pub rate: BasisPoints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaxCode {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub rates: Vec<TaxRate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxRateInput {
    pub from: IsoDate,
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUnit {
    pub name: String,
    pub size: Quantity,
    pub barcode: Option<String>,
    pub sale_price: Piastres,
    pub wholesale_price: Option<Piastres>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub name_ar: String,
    pub name_en: String,
    pub code: Option<String>,
    pub base_unit: String,
    pub barcode: Option<String>,
    /** VAT-inclusive price of one base unit. */
    pub sale_price: Piastres,
    /** VAT-inclusive price for wholesale customers; the retail price when not set. */
    pub wholesale_price: Option<Piastres>,
    pub tax_code_id: i64,
    pub egs_code: String,
    pub pack: Option<PackUnit>,
    /** Every unit carries its own serial number on every document. */
    pub serialised: bool,
    pub warranty_months: i64,
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUnitInput {
    pub name: String,
    pub size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub barcode: Option<String>,
    pub sale_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wholesale_price: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub name_ar: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub base_unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub barcode: Option<String>,
    pub sale_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wholesale_price: Option<f64>,
    pub tax_code_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egs_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<PackUnitInput>,
}

/** What to change; a field left out stays. `pack: Some(None)` removes the pack unit. */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemChanges {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_ar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub barcode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sale_price: Option<f64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub wholesale_price: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_code_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egs_code: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub pack: Option<Option<PackUnitInput>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsOptions {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub include_inactive: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedUnit {
    pub item_id: i64,
    pub name_ar: String,
    pub unit: String,
    pub unit_name: String,
    /** How much of the base unit one of this unit is. */
    pub quantity: Quantity,
    pub sale_price: Piastres,
    pub tax_code_id: i64,
    /** A serialised item is added at the till by scanning each unit's serial, not its barcode. */
    pub serialised: bool,
}

pub fn list_tax_codes(conn: &Connection) -> Result<Vec<TaxCode>> {
    let mut codes = conn.prepare("SELECT id, kind, name FROM tax_codes ORDER BY id")?;
    let mut rates = conn.prepare(
        "SELECT effective_from, rate FROM tax_rates WHERE tax_code_id = ? ORDER BY effective_from",
    )?;
    let list: Vec<(i64, String, String)> = codes
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    list.into_iter()
        .map(|(id, kind, name)| {
            let rates = rates
                .query_map([id], |r| {
                    Ok(TaxRate {
                        from: r.get(0)?,
                        rate: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(TaxCode {
                id,
                kind,
                name,
                rates,
            })
        })
        .collect()
}

fn assert_tax_code(conn: &Connection, id: i64) -> Result<()> {
    let found = conn
        .query_row("SELECT 1 FROM tax_codes WHERE id = ?", [id], |_| Ok(()))
        .optional()?;
    match found {
        Some(()) => Ok(()),
        None => refuse("tax_code_not_found", format!("No tax code with id {id}")),
    }
}

pub fn add_tax_rate(conn: &Connection, tax_code_id: i64, input: &TaxRateInput) -> Result<()> {
    assert_tax_code(conn, tax_code_id)?;
    assert_iso_date(&input.from)?;
    let rate = match safe_int(input.rate) {
        Some(r) if (0..=10_000).contains(&r) => r,
        _ => {
            return refuse(
                "tax_rate_invalid",
                format!(
                    "Rate {} is not between 0 and 10000 basis points",
                    input.rate
                ),
            )
        }
    };
    conn.execute(
        "INSERT INTO tax_rates (tax_code_id, effective_from, rate) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET rate = excluded.rate",
        params![tax_code_id, input.from, rate],
    )?;
    Ok(())
}

/** The VAT rate in force on `date`. Zero for everything when the business is not VAT-registered. */
pub fn vat_rate(
    conn: &Connection,
    tax_code_id: i64,
    date: &str,
    vat_registered: bool,
) -> Result<BasisPoints> {
    assert_tax_code(conn, tax_code_id)?;
    assert_iso_date(date)?;
    if !vat_registered {
        return Ok(0);
    }
    let rate: Option<i64> = conn
        .query_row(
            "SELECT rate FROM tax_rates WHERE tax_code_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
            params![tax_code_id, date],
            |r| r.get(0),
        )
        .optional()?;
    match rate {
        Some(r) => Ok(r),
        None => refuse(
            "tax_rate_missing",
            format!("No rate in force on {date} for tax code {tax_code_id}"),
        ),
    }
}

const SELECT_ITEMS: &str = "
  SELECT i.id, i.name_ar, i.name_en, i.code, i.tax_code_id, i.egs_code, i.active, i.serialised, i.warranty_months,
         b.name AS base_name, b.barcode AS base_barcode, b.sale_price AS base_price, b.wholesale_price AS base_wholesale, p.wholesale_price AS pack_wholesale,
         p.name AS pack_name, p.size AS pack_size, p.barcode AS pack_barcode, p.sale_price AS pack_price
    FROM items i
    JOIN item_units b ON b.item_id = i.id AND b.kind = 'base'
    LEFT JOIN item_units p ON p.item_id = i.id AND p.kind = 'pack'";

fn to_item(r: &Row) -> rusqlite::Result<Item> {
    let pack_name: Option<String> = r.get("pack_name")?;
    Ok(Item {
        id: r.get("id")?,
        name_ar: r.get("name_ar")?,
        name_en: r.get("name_en")?,
        code: r.get("code")?,
        base_unit: r.get("base_name")?,
        barcode: r.get("base_barcode")?,
        sale_price: r.get("base_price")?,
        wholesale_price: r.get("base_wholesale")?,
        tax_code_id: r.get("tax_code_id")?,
        egs_code: r.get("egs_code")?,
        pack: match pack_name {
            None => None,
            Some(name) => Some(PackUnit {
                name,
                size: r.get::<_, Option<i64>>("pack_size")?.unwrap_or(0),
                barcode: r.get("pack_barcode")?,
                sale_price: r.get::<_, Option<i64>>("pack_price")?.unwrap_or(0),
                wholesale_price: r.get("pack_wholesale")?,
            }),
        },
        serialised: r.get::<_, i64>("serialised")? == 1,
        warranty_months: r.get("warranty_months")?,
        active: r.get::<_, i64>("active")? == 1,
    })
}

/** Folds the Arabic letter variants people type interchangeably, and English case, so search finds either. */
fn for_search(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '\u{064B}'..='\u{0652}' | '\u{0640}'))
        .map(|c| match c {
            'أ' | 'إ' | 'آ' => 'ا',
            'ة' => 'ه',
            'ى' => 'ي',
            c => c,
        })
        .collect()
}

pub fn list_items(conn: &Connection, options: &ItemsOptions) -> Result<Vec<Item>> {
    let filter = if options.include_inactive == Some(true) {
        ""
    } else {
        "WHERE i.active = 1"
    };
    let items: Vec<Item> = conn
        .prepare(&format!("{SELECT_ITEMS} {filter} ORDER BY i.name_ar"))?
        .query_map([], to_item)?
        .collect::<rusqlite::Result<_>>()?;
    let term = for_search(options.search.as_deref().unwrap_or("").trim());
    if term.is_empty() {
        return Ok(items);
    }
    Ok(items
        .into_iter()
        .filter(|i| {
            [
                Some(&i.name_ar),
                Some(&i.name_en),
                i.code.as_ref(),
                i.barcode.as_ref(),
                i.pack.as_ref().and_then(|p| p.barcode.as_ref()),
            ]
            .into_iter()
            .flatten()
            .any(|field| !field.is_empty() && for_search(field).contains(&term))
        })
        .collect())
}

fn blank_to_null(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or("").trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn price(value: f64) -> Result<Piastres> {
    match safe_int(value) {
        Some(p) if p >= 0 => Ok(p),
        _ => refuse(
            "price_invalid",
            format!("Price {value} is not whole piastres"),
        ),
    }
}

fn optional_price(value: Option<f64>) -> Result<Option<Piastres>> {
    value.map(price).transpose()
}

fn required(value: &str, what: &str, code: &'static str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return refuse(code, format!("{what} is required"));
    }
    Ok(trimmed.to_string())
}

struct CleanItem {
    name_ar: String,
    name_en: String,
    code: Option<String>,
    base_unit: String,
    barcode: Option<String>,
    sale_price: Piastres,
    wholesale_price: Option<Piastres>,
    tax_code_id: i64,
    egs_code: String,
    pack: Option<PackUnit>,
}

fn clean_item(conn: &Connection, input: &ItemInput) -> Result<CleanItem> {
    let name_ar = required(&input.name_ar, "Arabic name", "item_name_required")?;
    let base_unit = required(&input.base_unit, "Base unit", "item_unit_required")?;
    let sale_price = price(input.sale_price)?;
    assert_tax_code(conn, input.tax_code_id)?;
    let pack = match &input.pack {
        None => None,
        Some(p) => {
            let name = required(&p.name, "Pack unit name", "item_unit_required")?;
            let size = match safe_int(p.size) {
                Some(s) if s > 0 => s,
                _ => {
                    return refuse(
                        "pack_size_invalid",
                        format!("Pack size {} is not a positive whole quantity", p.size),
                    )
                }
            };
            Some(PackUnit {
                name,
                size,
                barcode: blank_to_null(p.barcode.as_deref()),
                sale_price: price(p.sale_price)?,
                wholesale_price: optional_price(p.wholesale_price)?,
            })
        }
    };
    let clean = CleanItem {
        name_ar,
        name_en: input.name_en.as_deref().unwrap_or("").trim().to_string(),
        code: blank_to_null(input.code.as_deref()),
        base_unit,
        barcode: blank_to_null(input.barcode.as_deref()),
        sale_price,
        wholesale_price: optional_price(input.wholesale_price)?,
        tax_code_id: input.tax_code_id,
        egs_code: input.egs_code.as_deref().unwrap_or("").trim().to_string(),
        pack,
    };
    if let Some(b) = &clean.barcode {
        if clean.pack.as_ref().and_then(|p| p.barcode.as_ref()) == Some(b) {
            return refuse(
                "barcode_taken",
                format!("Barcode {b} is used for both units"),
            );
        }
    }
    Ok(clean)
}

fn assert_free(conn: &Connection, item: &CleanItem, item_id: Option<i64>) -> Result<()> {
    if let Some(code) = &item.code {
        let owner: Option<i64> = conn
            .query_row("SELECT id FROM items WHERE code = ?", [code], |r| r.get(0))
            .optional()?;
        if owner.is_some() && owner != item_id {
            return refuse(
                "item_code_taken",
                format!("Item code {code} is already used"),
            );
        }
    }
    let pack_barcode = item.pack.as_ref().and_then(|p| p.barcode.as_ref());
    for barcode in [item.barcode.as_ref(), pack_barcode].into_iter().flatten() {
        let owner: Option<i64> = conn
            .query_row(
                "SELECT item_id FROM item_units WHERE barcode = ?",
                [barcode],
                |r| r.get(0),
            )
            .optional()?;
        if owner.is_some() && owner != item_id {
            return refuse(
                "barcode_taken",
                format!("Barcode {barcode} is already used"),
            );
        }
    }
    Ok(())
}

fn write_units(conn: &Connection, item_id: i64, item: &CleanItem) -> Result<()> {
    conn.execute("DELETE FROM item_units WHERE item_id = ?", [item_id])?;
    let mut insert = conn.prepare(
        "INSERT INTO item_units (item_id, kind, name, size, barcode, sale_price, wholesale_price) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )?;
    insert.execute(params![
        item_id,
        "base",
        item.base_unit,
        ONE_BASE_UNIT,
        item.barcode,
        item.sale_price,
        item.wholesale_price
    ])?;
    if let Some(p) = &item.pack {
        insert.execute(params![
            item_id,
            "pack",
            p.name,
            p.size,
            p.barcode,
            p.sale_price,
            p.wholesale_price
        ])?;
    }
    Ok(())
}

pub fn add_item(conn: &Connection, input: &ItemInput) -> Result<i64> {
    let item = clean_item(conn, input)?;
    assert_free(conn, &item, None)?;
    conn.execute(
        "INSERT INTO items (name_ar, name_en, code, tax_code_id, egs_code) VALUES (?, ?, ?, ?, ?)",
        params![
            item.name_ar,
            item.name_en,
            item.code,
            item.tax_code_id,
            item.egs_code
        ],
    )?;
    let id = conn.last_insert_rowid();
    write_units(conn, id, &item)?;
    Ok(id)
}

pub fn find_item(conn: &Connection, id: i64) -> Result<Item> {
    let item = conn
        .query_row(&format!("{SELECT_ITEMS} WHERE i.id = ?"), [id], to_item)
        .optional()?;
    match item {
        Some(i) => Ok(i),
        None => refuse("item_not_found", format!("No item with id {id}")),
    }
}

pub fn update_item(conn: &Connection, id: i64, changes: &ItemChanges) -> Result<()> {
    let current = find_item(conn, id)?;
    let current_pack = current.pack.map(|p| PackUnitInput {
        name: p.name,
        size: p.size as f64,
        barcode: Some(p.barcode.unwrap_or_default()),
        sale_price: p.sale_price as f64,
        wholesale_price: p.wholesale_price.map(|w| w as f64),
    });
    let merged = ItemInput {
        name_ar: changes.name_ar.clone().unwrap_or(current.name_ar),
        name_en: Some(changes.name_en.clone().unwrap_or(current.name_en)),
        code: Some(
            changes
                .code
                .clone()
                .unwrap_or(current.code.unwrap_or_default()),
        ),
        base_unit: changes.base_unit.clone().unwrap_or(current.base_unit),
        barcode: Some(
            changes
                .barcode
                .clone()
                .unwrap_or(current.barcode.unwrap_or_default()),
        ),
        sale_price: changes.sale_price.unwrap_or(current.sale_price as f64),
        wholesale_price: changes
            .wholesale_price
            .unwrap_or(current.wholesale_price.map(|w| w as f64)),
        tax_code_id: changes.tax_code_id.unwrap_or(current.tax_code_id),
        egs_code: Some(changes.egs_code.clone().unwrap_or(current.egs_code)),
        pack: changes.pack.clone().unwrap_or(current_pack),
    };
    let item = clean_item(conn, &merged)?;
    assert_free(conn, &item, Some(id))?;
    conn.execute(
        "UPDATE items SET name_ar = ?, name_en = ?, code = ?, tax_code_id = ?, egs_code = ? WHERE id = ?",
        params![item.name_ar, item.name_en, item.code, item.tax_code_id, item.egs_code, id],
    )?;
    write_units(conn, id, &item)
}

pub fn set_item_active(conn: &Connection, id: i64, active: bool) -> Result<()> {
    find_item(conn, id)?;
    conn.execute(
        "UPDATE items SET active = ? WHERE id = ?",
        params![active as i64, id],
    )?;
    Ok(())
}

/** What a scanned barcode rings up: the item, which unit, and how much stock that unit is. Active items only. */
pub fn find_by_barcode(conn: &Connection, barcode: &str) -> Result<Option<ScannedUnit>> {
    Ok(conn
        .query_row(
            "SELECT i.id, i.name_ar, u.kind, u.name, u.size, u.sale_price, i.tax_code_id, i.serialised
               FROM item_units u JOIN items i ON i.id = u.item_id
              WHERE u.barcode = ? AND i.active = 1",
            [barcode.trim()],
            |r| {
                Ok(ScannedUnit {
                    item_id: r.get(0)?,
                    name_ar: r.get(1)?,
                    unit: r.get(2)?,
                    unit_name: r.get(3)?,
                    quantity: r.get(4)?,
                    sale_price: r.get(5)?,
                    tax_code_id: r.get(6)?,
                    serialised: r.get::<_, i64>(7)? == 1,
                })
            },
        )
        .optional()?)
}
