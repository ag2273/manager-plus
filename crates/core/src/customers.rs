use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{refuse, BusinessError, Result};
use crate::ledger::Piastres;
use crate::num::{nullable, safe_int};
use crate::purchases::clean_trn;
use crate::users::{authenticate, write_audit, Credentials};
use crate::withholding::assert_withholding_category;

/** Which shelf price a customer's quotations and invoices start from. */
pub const PRICE_LEVELS: [&str; 2] = ["retail", "wholesale"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub tax_registration_number: String,
    pub address: String,
    /** Governorate, city and building number: with the address (the street), what an e-invoice needs. */
    pub governate: String,
    pub region_city: String,
    pub building_number: String,
    pub price_level: String,
    /** The most the customer may owe, in piastres; None is no limit. */
    pub credit_limit: Option<Piastres>,
    /** The withholding tax category the customer usually deducts under. */
    pub withholding_category_id: Option<i64>,
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerInput {
    pub name: String,
    pub phone: String,
    pub tax_registration_number: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub governate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit_limit: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withholding_category_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerChanges {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_registration_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub governate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_level: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub credit_limit: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub withholding_category_id: Option<Option<i64>>,
}

const COLUMNS: &str = "id, name, phone, tax_registration_number, address, governate, region_city, building_number, price_level, credit_limit, withholding_category_id, active";

fn to_customer(r: &Row) -> rusqlite::Result<Customer> {
    Ok(Customer {
        id: r.get(0)?,
        name: r.get(1)?,
        phone: r.get(2)?,
        tax_registration_number: r.get(3)?,
        address: r.get(4)?,
        governate: r.get(5)?,
        region_city: r.get(6)?,
        building_number: r.get(7)?,
        price_level: r.get(8)?,
        credit_limit: r.get(9)?,
        withholding_category_id: r.get(10)?,
        active: r.get::<_, i64>(11)? == 1,
    })
}

pub fn list_customers(conn: &Connection) -> Result<Vec<Customer>> {
    Ok(conn
        .prepare(&format!("SELECT {COLUMNS} FROM customers ORDER BY name"))?
        .query_map([], to_customer)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn find_customer(conn: &Connection, id: i64) -> Result<Customer> {
    let found = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM customers WHERE id = ?"),
            [id],
            to_customer,
        )
        .optional()?;
    match found {
        Some(c) => Ok(c),
        None => refuse("customer_not_found", format!("No customer with id {id}")),
    }
}

struct Clean {
    name: String,
    phone: String,
    trn: String,
    address: String,
    governate: String,
    region_city: String,
    building_number: String,
    price_level: String,
    credit_limit: Option<i64>,
    withholding_category_id: Option<i64>,
}

fn clean_customer(conn: &Connection, input: &CustomerInput) -> Result<Clean> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return refuse("customer_name_required", "A customer needs a name");
    }
    let trn = clean_trn(&input.tax_registration_number)?;
    let price_level = input.price_level.clone().unwrap_or_else(|| "retail".into());
    if !PRICE_LEVELS.contains(&price_level.as_str()) {
        return refuse(
            "price_level_invalid",
            format!("Unknown price level {price_level}"),
        );
    }
    let credit_limit = match input.credit_limit {
        None => None,
        Some(l) => match safe_int(l).filter(|l| *l >= 0) {
            Some(l) => Some(l),
            None => {
                return refuse(
                    "credit_limit_invalid",
                    format!("Credit limit {l} is not whole piastres"),
                )
            }
        },
    };
    assert_withholding_category(conn, input.withholding_category_id)?;
    let trim = |v: &Option<String>| v.as_deref().unwrap_or("").trim().to_string();
    Ok(Clean {
        name,
        phone: input.phone.trim().to_string(),
        trn,
        address: trim(&input.address),
        governate: trim(&input.governate),
        region_city: trim(&input.region_city),
        building_number: trim(&input.building_number),
        price_level,
        credit_limit,
        withholding_category_id: input.withholding_category_id,
    })
}

pub fn add_customer(conn: &Connection, input: &CustomerInput) -> Result<i64> {
    let s = clean_customer(conn, input)?;
    conn.execute(
        "INSERT INTO customers (name, phone, tax_registration_number, address, governate, region_city, building_number, price_level, credit_limit, withholding_category_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![s.name, s.phone, s.trn, s.address, s.governate, s.region_city, s.building_number, s.price_level, s.credit_limit, s.withholding_category_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_customer(conn: &Connection, id: i64, changes: &CustomerChanges) -> Result<()> {
    let c = find_customer(conn, id)?;
    let or = |change: &Option<String>, current: String| Some(change.clone().unwrap_or(current));
    let merged = CustomerInput {
        name: changes.name.clone().unwrap_or(c.name),
        phone: changes.phone.clone().unwrap_or(c.phone),
        tax_registration_number: changes
            .tax_registration_number
            .clone()
            .unwrap_or(c.tax_registration_number),
        address: or(&changes.address, c.address),
        governate: or(&changes.governate, c.governate),
        region_city: or(&changes.region_city, c.region_city),
        building_number: or(&changes.building_number, c.building_number),
        price_level: or(&changes.price_level, c.price_level),
        credit_limit: changes
            .credit_limit
            .unwrap_or(c.credit_limit.map(|l| l as f64)),
        withholding_category_id: changes
            .withholding_category_id
            .unwrap_or(c.withholding_category_id),
    };
    let s = clean_customer(conn, &merged)?;
    conn.execute(
        "UPDATE customers SET name = ?, phone = ?, tax_registration_number = ?, address = ?, governate = ?, region_city = ?, building_number = ?,
                price_level = ?, credit_limit = ?, withholding_category_id = ? WHERE id = ?",
        params![s.name, s.phone, s.trn, s.address, s.governate, s.region_city, s.building_number, s.price_level, s.credit_limit, s.withholding_category_id, id],
    )?;
    Ok(())
}

pub fn set_customer_active(conn: &Connection, id: i64, active: bool) -> Result<()> {
    find_customer(conn, id)?;
    conn.execute(
        "UPDATE customers SET active = ? WHERE id = ?",
        params![active as i64, id],
    )?;
    Ok(())
}

/** What the customer owes the business, from the receivables lines in the ledger. */
pub fn customer_balance(conn: &Connection, id: i64) -> Result<Piastres> {
    find_customer(conn, id)?;
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(debit) - SUM(credit), 0) FROM ledger_lines WHERE customer_id = ?",
        [id],
        |r| r.get(0),
    )?)
}

/**
 * Refuses a document that would put `adding` more on the customer's account past their credit
 * limit, with the amount over, unless a manager signs in on it. The approval goes to the audit
 * log under the manager's name, with who asked and for which command.
 */
pub fn check_credit_limit(
    conn: &Connection,
    customer: &Customer,
    adding: Piastres,
    approval: Option<&Credentials>,
    document: &str,
    requested_by: &str,
) -> Result<()> {
    let Some(limit) = customer.credit_limit else {
        return Ok(());
    };
    if adding <= 0 {
        return Ok(());
    }
    let over = customer_balance(conn, customer.id)? + adding - limit;
    if over <= 0 {
        return Ok(());
    }
    let Some(approval) = approval else {
        let mut error = BusinessError::new(
            "credit_limit_exceeded",
            format!("{} would go {over} past their credit limit", customer.name),
        );
        error.amount = Some(over);
        return Err(error);
    };
    let approver = authenticate(conn, approval)?;
    if approver.role != "manager" {
        return refuse(
            "approval_not_manager",
            format!("{} is not a manager", approver.name),
        );
    }
    let detail = serde_json::json!({
        "over": over, "limit": limit, "adding": adding, "document": document, "requestedBy": requested_by
    });
    write_audit(
        conn,
        approver.id,
        "approveCreditLimit",
        Some(customer.id),
        &detail.to_string(),
    )
}
