//! Items with their opening stock, and opening balances, imported from spreadsheet rows.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::customers::{add_customer, CustomerInput};
use crate::dates::assert_iso_date;
use crate::error::{BusinessError, Result};
use crate::items::{add_item, ItemInput, PackUnitInput};
use crate::ledger::{post_opening_balances, JournalLine, Piastres};
use crate::num::mul_div_round;
use crate::purchases::{add_supplier, SupplierInput};
use crate::stock::{account_by_role, active_warehouse, post_opening_stock, OpeningStockLine};

/** One sheet of a spreadsheet or CSV file, every cell as text. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    /** The date the opening stock and balances are posted on. */
    pub date: String,
    /** Where the opening stock goes. */
    pub warehouse_id: i64,
    pub sheets: Vec<ImportSheet>,
}

/** Why one row can't be imported; row numbers count from 1 as the spreadsheet shows them. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportProblem {
    pub sheet: String,
    pub row: usize,
    pub column: Option<String>,
    pub code: &'static str,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub items: i64,
    pub stock_lines: i64,
    pub stock_value: Piastres,
    pub balances: i64,
    pub new_customers: i64,
    pub new_suppliers: i64,
    pub problems: Vec<ImportProblem>,
}

/** A column of the import template, in Arabic and English (the same list as `shared/import-columns.ts`). */
struct Column {
    key: &'static str,
    ar: &'static str,
    en: &'static str,
    required: bool,
}

const fn col(key: &'static str, ar: &'static str, en: &'static str, required: bool) -> Column {
    Column {
        key,
        ar,
        en,
        required,
    }
}

const ITEM_COLUMNS: [Column; 14] = [
    col("nameAr", "اسم الصنف بالعربية", "Arabic name", true),
    col("nameEn", "الاسم بالإنجليزية", "English name", false),
    col("code", "كود الصنف", "Item code", false),
    col("baseUnit", "الوحدة", "Unit", true),
    col("barcode", "الباركود", "Barcode", false),
    col(
        "salePrice",
        "سعر البيع شامل الضريبة",
        "Sale price incl. VAT",
        true,
    ),
    col("wholesalePrice", "سعر الجملة", "Wholesale price", false),
    col("tax", "الضريبة", "Tax", false),
    col("packName", "وحدة العبوة", "Pack unit", false),
    col("packSize", "عدد الوحدات في العبوة", "Units per pack", false),
    col("packBarcode", "باركود العبوة", "Pack barcode", false),
    col("packPrice", "سعر العبوة", "Pack price", false),
    col(
        "openingQuantity",
        "الكمية الافتتاحية",
        "Opening quantity",
        false,
    ),
    col("unitCost", "تكلفة الوحدة", "Unit cost", false),
];

const BALANCE_COLUMNS: [Column; 4] = [
    col("type", "النوع", "Type", true),
    col("name", "الاسم أو كود الحساب", "Name or account code", true),
    col("debit", "مدين", "Debit", false),
    col("credit", "دائن", "Credit", false),
];

/** The words accepted in the Tax column, in either language. */
fn tax_kind(word: &str) -> Option<&'static str> {
    Some(match word {
        "" | "عام" | "خاضع" | "standard" => "standard",
        "صفر" | "zero-rated" | "zero_rated" | "zero" => "zero_rated",
        "معفى" | "معفي" | "exempt" => "exempt",
        _ => return None,
    })
}

/** The words accepted in the Type column, in either language. */
fn balance_type(word: &str) -> Option<&'static str> {
    Some(match word {
        "حساب" | "account" => "account",
        "عميل" | "customer" => "customer",
        "مورد" | "supplier" => "supplier",
        _ => return None,
    })
}

/** Which column of the template each core error points at, so a problem names the cell to fix. */
fn error_column(code: &str) -> Option<&'static str> {
    Some(match code {
        "item_name_required" => "nameAr",
        "item_unit_required" => "baseUnit",
        "item_code_taken" => "code",
        "barcode_taken" => "barcode",
        "pack_size_invalid" => "packSize",
        _ => return None,
    })
}

/** JavaScript's `trim()`: Unicode white space and the byte-order mark a CSV file may start with. */
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn norm(text: &str) -> String {
    js_trim(text)
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

const MAX_SAFE: u128 = 9_007_199_254_740_991;

/** Western digits for Arabic-Indic ones, and the Arabic decimal point as a dot. */
fn western(text: &str) -> String {
    js_trim(text)
        .chars()
        .map(|c| match c {
            '٠'..='٩' => char::from(b'0' + (c as u32 - 0x0660) as u8),
            '٫' => '.',
            other => other,
        })
        .collect()
}

/** `digits[.fraction]` with at most `places` decimals, as a whole number of 1/10^places. */
fn fixed(clean: &str, places: usize) -> Option<i64> {
    let (whole, fraction) = match clean.split_once('.') {
        Some((w, f)) => (w, f),
        None => (clean, ""),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(fraction) || fraction.len() > places {
        return None;
    }
    let whole: u128 = whole.parse().ok()?;
    let fraction: u128 = format!("{fraction:0<places$}").parse().ok()?;
    let value = whole
        .checked_mul(10u128.pow(places as u32))?
        .checked_add(fraction)?;
    (value <= MAX_SAFE).then_some(value as i64)
}

/** Reads a typed amount ("1,140.00", Arabic-Indic digits) into piastres, as `shared/money.ts` does. */
pub fn parse_money(text: &str) -> Option<Piastres> {
    let clean: String = western(text)
        .chars()
        .filter(|c| !(*c == ',' || *c == '٬' || c.is_whitespace()))
        .collect();
    fixed(&clean, 2)
}

/** Reads a typed quantity ("12", "6.25", Arabic-Indic digits) into thousandths, as `shared/quantity.ts` does. */
pub fn parse_quantity(text: &str) -> Option<i64> {
    fixed(&western(text), 3)
}

/** A value that can't be read stops the row with this code, against this column. */
struct CellError {
    code: &'static str,
    column: &'static str,
    value: String,
}

enum RowError {
    Cell(CellError),
    Core(BusinessError),
}

impl From<BusinessError> for RowError {
    fn from(e: BusinessError) -> Self {
        RowError::Core(e)
    }
}

fn cell_error<T>(
    code: &'static str,
    column: &'static str,
    value: &str,
) -> std::result::Result<T, RowError> {
    Err(RowError::Cell(CellError {
        code,
        column,
        value: value.into(),
    }))
}

type RowResult<T> = std::result::Result<T, RowError>;

/** Finds the header row (the first that isn't blank) and where each known column sits in it. */
fn header(
    sheet: &ImportSheet,
    columns: &[Column],
) -> Option<(usize, HashMap<&'static str, usize>)> {
    let at = sheet
        .rows
        .iter()
        .position(|r| r.iter().any(|c| !js_trim(c).is_empty()))?;
    let cells: Vec<String> = sheet.rows[at].iter().map(|c| norm(c)).collect();
    let mut index = HashMap::new();
    for c in columns {
        if let Some(i) = cells
            .iter()
            .position(|cell| *cell == norm(c.ar) || *cell == norm(c.en))
        {
            index.insert(c.key, i);
        }
    }
    index.contains_key(columns[0].key).then_some((at, index))
}

/** One row's cells by column key, with typed readers. */
struct Cells<'a> {
    row: &'a [String],
    index: &'a HashMap<&'static str, usize>,
    columns: &'a [Column],
}

impl Cells<'_> {
    fn text(&self, key: &str) -> String {
        self.index
            .get(key)
            .and_then(|&i| self.row.get(i))
            .map_or(String::new(), |c| js_trim(c).to_string())
    }
    fn required(&self, key: &'static str) -> RowResult<String> {
        let value = self.text(key);
        if value.is_empty() && self.columns.iter().any(|c| c.key == key && c.required) {
            return cell_error("import_value_required", key, &value);
        }
        Ok(value)
    }
    fn money(&self, key: &'static str, code: &'static str) -> RowResult<Option<Piastres>> {
        let value = self.text(key);
        if value.is_empty() {
            return Ok(None);
        }
        match parse_money(&value) {
            Some(amount) => Ok(Some(amount)),
            None => cell_error(code, key, &value),
        }
    }
    fn quantity(&self, key: &'static str) -> RowResult<Option<i64>> {
        let value = self.text(key);
        if value.is_empty() {
            return Ok(None);
        }
        match parse_quantity(&value) {
            Some(q) => Ok(Some(q)),
            None => cell_error("quantity_invalid", key, &value),
        }
    }
}

fn blank(row: &[String]) -> bool {
    row.iter().all(|c| js_trim(c).is_empty())
}

struct Importer<'a> {
    conn: &'a Connection,
    tax_codes: HashMap<String, i64>,
    report: ImportReport,
    stock: Vec<OpeningStockLine>,
    balances: Vec<JournalLine>,
}

impl Importer<'_> {
    fn problem(
        &mut self,
        sheet: &str,
        row: usize,
        column: Option<&str>,
        code: &'static str,
        value: &str,
    ) {
        self.report.problems.push(ImportProblem {
            sheet: sheet.into(),
            row,
            column: column.map(String::from),
            code,
            value: value.into(),
        });
    }

    /** Runs one row in its own savepoint; a core refusal or unreadable cell becomes a problem against that row. */
    fn attempt(
        &mut self,
        sheet: &str,
        row: usize,
        work: impl FnOnce(&mut Self) -> RowResult<()>,
    ) -> Result<()> {
        self.conn.execute_batch("SAVEPOINT import_row")?;
        // What the row added to the report and the postings is kept only if the row goes through.
        let (report, stock, balances) =
            (self.report.clone(), self.stock.len(), self.balances.len());
        match work(self) {
            Ok(()) => {
                self.conn.execute_batch("RELEASE import_row")?;
                Ok(())
            }
            Err(error) => {
                self.conn
                    .execute_batch("ROLLBACK TO import_row; RELEASE import_row")?;
                self.report = report;
                self.stock.truncate(stock);
                self.balances.truncate(balances);
                match error {
                    RowError::Cell(e) => self.problem(sheet, row, Some(e.column), e.code, &e.value),
                    RowError::Core(e) if e.code == "internal" => return Err(e),
                    RowError::Core(e) => self.problem(sheet, row, error_column(e.code), e.code, ""),
                }
                Ok(())
            }
        }
    }

    fn item(&mut self, cell: &Cells) -> RowResult<()> {
        let tax_word = cell.text("tax");
        let Some(kind) = tax_kind(&norm(&tax_word)) else {
            return cell_error("tax_code_unknown", "tax", &tax_word);
        };
        let Some(sale_price) = cell.money("salePrice", "price_invalid")? else {
            return cell_error("import_value_required", "salePrice", "");
        };
        let pack_name = cell.text("packName");
        let pack_size = cell.quantity("packSize")?;
        let pack_price = cell.money("packPrice", "price_invalid")?;
        let item = ItemInput {
            name_ar: cell.required("nameAr")?,
            name_en: Some(cell.text("nameEn")),
            code: Some(cell.text("code")),
            base_unit: cell.required("baseUnit")?,
            barcode: Some(cell.text("barcode")),
            sale_price: sale_price as f64,
            wholesale_price: cell
                .money("wholesalePrice", "price_invalid")?
                .map(|p| p as f64),
            tax_code_id: self.tax_codes[kind],
            pack: (!pack_name.is_empty()).then(|| PackUnitInput {
                name: pack_name,
                size: pack_size.unwrap_or(0) as f64,
                barcode: Some(cell.text("packBarcode")),
                sale_price: pack_price
                    .unwrap_or_else(|| mul_div_round(sale_price, pack_size.unwrap_or(0), 1000))
                    as f64,
                ..Default::default()
            }),
            ..Default::default()
        };
        let quantity = cell.quantity("openingQuantity")?;
        let unit_cost = cell.money("unitCost", "price_invalid")?;
        let opening = quantity.filter(|q| *q > 0);
        if opening.is_some() && unit_cost.is_none() {
            return cell_error("cost_required", "unitCost", "");
        }
        let item_id = add_item(self.conn, &item)?;
        self.report.items += 1;
        if let (Some(quantity), Some(unit_cost)) = (opening, unit_cost) {
            self.stock.push(OpeningStockLine {
                item_id,
                quantity: quantity as f64,
                unit_cost: unit_cost as f64,
                serials: None,
            });
            self.report.stock_lines += 1;
            self.report.stock_value += mul_div_round(quantity, unit_cost, 1000);
        }
        Ok(())
    }

    fn balance(&mut self, cell: &Cells) -> RowResult<()> {
        let type_word = cell.required("type")?;
        let Some(kind) = balance_type(&norm(&type_word)) else {
            return cell_error("party_type_unknown", "type", &type_word);
        };
        let name = cell.required("name")?;
        let debit = cell.money("debit", "line_amount_invalid")?.unwrap_or(0);
        let credit = cell.money("credit", "line_amount_invalid")?.unwrap_or(0);
        if (debit > 0) == (credit > 0) {
            return cell_error(
                "line_amount_invalid",
                if debit > 0 { "credit" } else { "debit" },
                "",
            );
        }
        let amounts = |account_id: i64| {
            if debit > 0 {
                JournalLine::debit(account_id, debit)
            } else {
                JournalLine::credit(account_id, credit)
            }
        };
        let conn = self.conn;
        let line = match kind {
            "account" => {
                let account: Option<(i64, Option<String>)> = conn
                    .query_row(
                        "SELECT id, role FROM accounts WHERE code = ? OR name = ? ORDER BY code = ? DESC LIMIT 1",
                        [&name, &name, &name],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(BusinessError::from)?;
                let Some((id, role)) = account else {
                    return cell_error("account_not_found", "name", &name);
                };
                if role.as_deref().is_some_and(|r| {
                    ["opening_balances", "receivables", "payables", "stock"].contains(&r)
                }) {
                    return cell_error("account_not_allowed", "name", &name);
                }
                amounts(id)
            }
            "customer" => {
                let found: Option<i64> = conn
                    .query_row("SELECT id FROM customers WHERE name = ?", [&name], |r| {
                        r.get(0)
                    })
                    .optional()
                    .map_err(BusinessError::from)?;
                let customer = match found {
                    Some(id) => id,
                    None => {
                        self.report.new_customers += 1;
                        add_customer(
                            conn,
                            &CustomerInput {
                                name: name.clone(),
                                ..Default::default()
                            },
                        )?
                    }
                };
                JournalLine {
                    customer_id: Some(customer),
                    ..amounts(account_by_role(conn, "receivables")?)
                }
            }
            _ => {
                let found: Option<(i64, String)> = conn
                    .query_row(
                        "SELECT id, currency FROM suppliers WHERE name = ?",
                        [&name],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(BusinessError::from)?;
                if found
                    .as_ref()
                    .is_some_and(|(_, currency)| currency != "EGP")
                {
                    return cell_error("supplier_not_egp", "name", &name);
                }
                let supplier = match found {
                    Some((id, _)) => id,
                    None => {
                        self.report.new_suppliers += 1;
                        add_supplier(
                            conn,
                            &SupplierInput {
                                name: name.clone(),
                                ..Default::default()
                            },
                        )?
                    }
                };
                JournalLine {
                    supplier_id: Some(supplier),
                    ..amounts(account_by_role(conn, "payables")?)
                }
            }
        };
        self.balances.push(line);
        self.report.balances += 1;
        Ok(())
    }

    fn run(&mut self, input: &ImportInput) -> Result<()> {
        let mut recognised = 0;
        for sheet in &input.sheets {
            let items = header(sheet, &ITEM_COLUMNS);
            let (found, columns): (_, &[Column]) = match items {
                Some(found) => (found, &ITEM_COLUMNS),
                None => match header(sheet, &BALANCE_COLUMNS) {
                    Some(found) => (found, &BALANCE_COLUMNS),
                    None => continue,
                },
            };
            let is_items = columns.len() == ITEM_COLUMNS.len();
            recognised += 1;
            let (at, index) = found;
            let missing: Vec<&Column> = columns
                .iter()
                .filter(|c| c.required && !index.contains_key(c.key))
                .collect();
            for c in &missing {
                self.problem(
                    &sheet.name,
                    at + 1,
                    Some(c.key),
                    "import_column_missing",
                    c.ar,
                );
            }
            if !missing.is_empty() {
                continue;
            }
            for (r, row) in sheet.rows.iter().enumerate().skip(at + 1) {
                if blank(row) {
                    continue;
                }
                let cell = Cells {
                    row,
                    index: &index,
                    columns,
                };
                if is_items {
                    self.attempt(&sheet.name, r + 1, |me| me.item(&cell))?;
                } else {
                    self.attempt(&sheet.name, r + 1, |me| me.balance(&cell))?;
                }
            }
        }
        if recognised == 0 {
            self.problem("", 0, None, "import_nothing", "");
        }
        if self.report.problems.is_empty() && !self.stock.is_empty() {
            post_opening_stock(self.conn, &input.date, input.warehouse_id, &self.stock)?;
        }
        if self.report.problems.is_empty() && !self.balances.is_empty() {
            post_opening_balances(self.conn, &input.date, &self.balances)?;
        }
        Ok(())
    }
}

/**
 * Imports items with their opening stock, and opening balances, from spreadsheet rows. Each row
 * goes through the same commands as typing it in; a dry run, or any row that fails, saves nothing.
 */
pub fn import_data(conn: &Connection, input: &ImportInput, dry_run: bool) -> Result<ImportReport> {
    assert_iso_date(&input.date)?;
    active_warehouse(conn, input.warehouse_id)?;
    let tax_codes = conn
        .prepare("SELECT kind, id FROM tax_codes")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut importer = Importer {
        conn,
        tax_codes,
        report: ImportReport::default(),
        stock: Vec::new(),
        balances: Vec::new(),
    };
    conn.execute_batch("SAVEPOINT import")?;
    let outcome = importer.run(input);
    if outcome.is_ok() && !dry_run && importer.report.problems.is_empty() {
        conn.execute_batch("RELEASE import")?;
    } else {
        conn.execute_batch("ROLLBACK TO import; RELEASE import")?;
    }
    outcome.map(|()| importer.report)
}
