#![allow(dead_code)]
use manager_core::users::Credentials;
use manager_core::{Business, BusinessError, BusinessSettings};

pub fn manager() -> Credentials {
    Credentials {
        name: "أيمن".into(),
        password: "كلمة سر قوية".into(),
    }
}

pub fn shop() -> BusinessSettings {
    BusinessSettings {
        name: "بقالة النور".into(),
        address: "الدقي".into(),
        tax_registration_number: String::new(),
        vat_registered: true,
        fiscal_year_start_month: 1,
    }
}

pub fn new_shop() -> Business {
    ready(Business::create(":memory:", &shop(), &manager()).expect("a new shop"))
}

/** A path in a fresh temporary folder; the folder lives as long as the returned guard. */
pub fn temp_file(name: &str) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(name).to_string_lossy().into_owned();
    (dir, path)
}

pub fn account(business: &Business, code: &str) -> i64 {
    business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.code == code)
        .unwrap_or_else(|| panic!("no account {code}"))
        .id
}

/** The refusal's code, for `assert_eq!(code(...), "...")`. */
pub fn code<T: std::fmt::Debug>(result: Result<T, BusinessError>) -> &'static str {
    match result {
        Ok(v) => panic!("expected a refusal, got {v:?}"),
        Err(e) => e.code,
    }
}

pub fn tax_code(business: &Business, kind: &str) -> i64 {
    business
        .tax_codes()
        .unwrap()
        .into_iter()
        .find(|t| t.kind == kind)
        .unwrap_or_else(|| panic!("no tax code {kind}"))
        .id
}

pub fn main_warehouse(business: &Business) -> i64 {
    business.warehouses().unwrap()[0].id
}

/** An item sold by the piece, at 14% VAT. */
pub fn piece(business: &Business, name: &str, price: i64) -> manager_core::items::ItemInput {
    manager_core::items::ItemInput {
        name_ar: name.into(),
        base_unit: "قطعة".into(),
        sale_price: price as f64,
        tax_code_id: tax_code(business, "standard"),
        ..Default::default()
    }
}

pub fn opening(
    item_id: i64,
    quantity: i64,
    unit_cost: i64,
) -> manager_core::stock::OpeningStockLine {
    manager_core::stock::OpeningStockLine {
        item_id,
        quantity: quantity as f64,
        unit_cost: unit_cost as f64,
        serials: None,
    }
}

/** An account's balance by role, debit positive, on the last day of 2026. */
pub fn balance_of(business: &Business, role: &str) -> i64 {
    let account = business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.role.as_deref() == Some(role))
        .unwrap_or_else(|| panic!("no account for {role}"));
    business
        .trial_balance("2026-12-31")
        .unwrap()
        .rows
        .into_iter()
        .find(|r| r.account_id == account.id)
        .map_or(0, |r| r.debit - r.credit)
}

/** A supplier to buy stock from. */
pub fn supplier(business: &Business) -> i64 {
    business
        .add_supplier(&manager_core::purchases::SupplierInput {
            name: "المورد".into(),
            ..Default::default()
        })
        .unwrap()
}

/** Buys `(item, quantity, unit price)` lines in base units into a warehouse. */
pub fn buy(
    business: &Business,
    supplier_id: i64,
    warehouse_id: i64,
    date: &str,
    lines: &[(i64, i64, i64)],
) -> i64 {
    business
        .post_purchase_invoice(&manager_core::purchases::PurchaseInvoiceInput {
            date: date.into(),
            supplier_id,
            warehouse_id,
            reference: String::new(),
            rate: None,
            lines: lines
                .iter()
                .map(
                    |&(item_id, quantity, price)| manager_core::purchases::PurchaseLineInput {
                        item_id,
                        unit: "base".into(),
                        quantity: quantity as f64,
                        unit_price: price as f64,
                        serials: None,
                    },
                )
                .collect(),
        })
        .unwrap()
}

/** Adds a user with the role and signs them in, password 123456. */
pub fn signed_in(business: &Business, name: &str, role: &str) -> Business {
    business
        .add_user(&manager_core::users::NewUser {
            name: name.into(),
            role: role.into(),
            password: "123456".into(),
        })
        .unwrap();
    business.sign_in(name, "123456").unwrap()
}

/** An account's id by role. */
pub fn role_account(business: &Business, role: &str) -> i64 {
    business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.role.as_deref() == Some(role))
        .unwrap_or_else(|| panic!("no account for {role}"))
        .id
}

/** A new business past its first-use setup, so it can trade. */
pub fn ready(business: Business) -> Business {
    business
        .finish_setup(manager_core::setup::SetupMode::New)
        .expect("the setup finishes");
    business
}
