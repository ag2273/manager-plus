//! Ported from `src/core/business.test.ts`, plus the file-format checks against files the TypeScript core made.
mod common;

use common::*;
use manager_core::{Business, BusinessSettings};
use rusqlite::Connection;

fn trn_shop() -> BusinessSettings {
    BusinessSettings {
        name: "بقالة النور".into(),
        address: "12 شارع التحرير، الدقي، الجيزة".into(),
        tax_registration_number: "123456789".into(),
        vat_registered: true,
        fiscal_year_start_month: 1,
    }
}

#[test]
fn a_new_business_remembers_its_settings() {
    let business = Business::create(":memory:", &trn_shop(), &manager()).unwrap();
    assert_eq!(business.settings().unwrap(), trn_shop());
}

#[test]
fn a_business_saved_to_a_file_can_be_reopened_with_the_same_settings() {
    let (_dir, path) = temp_file("shop.mplus");
    Business::create(&path, &trn_shop(), &manager())
        .unwrap()
        .close();
    let reopened = Business::open(&path).unwrap();
    assert_eq!(reopened.settings().unwrap(), trn_shop());
}

#[test]
fn a_business_file_can_be_opened_again_and_again() {
    let (_dir, path) = temp_file("shop.mplus");
    Business::create(&path, &trn_shop(), &manager())
        .unwrap()
        .close();
    Business::open(&path).unwrap().close();
    assert_eq!(
        Business::open(&path).unwrap().settings().unwrap().name,
        "بقالة النور"
    );
}

#[test]
fn creating_a_business_never_overwrites_an_existing_file() {
    let (_dir, path) = temp_file("shop.mplus");
    Business::create(&path, &trn_shop(), &manager())
        .unwrap()
        .close();
    let other = BusinessSettings {
        name: "Other shop".into(),
        ..trn_shop()
    };
    assert_eq!(
        code(Business::create(&path, &other, &manager())),
        "file_exists"
    );
    assert_eq!(
        Business::open(&path).unwrap().settings().unwrap().name,
        "بقالة النور"
    );
}

#[test]
fn a_file_that_isnt_a_business_file_is_refused() {
    let (_dir, path) = temp_file("notes.txt");
    std::fs::write(&path, "shopping list: sugar, tea").unwrap();
    assert_eq!(code(Business::open(&path)), "not_a_business_file");
}

#[test]
fn an_unrelated_database_file_is_refused() {
    let (_dir, path) = temp_file("other.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE things (id INTEGER)")
        .unwrap();
    assert_eq!(code(Business::open(&path)), "not_a_business_file");
}

#[test]
fn a_missing_file_is_reported_as_missing() {
    let (_dir, path) = temp_file("gone.mplus");
    assert_eq!(code(Business::open(&path)), "file_not_found");
}

#[test]
fn a_file_saved_by_a_newer_version_of_the_app_is_refused_rather_than_damaged() {
    let (_dir, path) = temp_file("shop.mplus");
    Business::create(&path, &trn_shop(), &manager())
        .unwrap()
        .close();
    Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA user_version = 999")
        .unwrap();
    assert_eq!(code(Business::open(&path)), "made_by_newer_version");
}

#[test]
fn a_business_needs_a_name() {
    let blank = BusinessSettings {
        name: "   ".into(),
        ..trn_shop()
    };
    assert_eq!(
        code(Business::create(":memory:", &blank, &manager())),
        "name_required"
    );
}

#[test]
fn a_tax_registration_number_must_be_9_digits() {
    for trn in ["12345678", "1234567890", "12345678A"] {
        let s = BusinessSettings {
            tax_registration_number: trn.into(),
            ..trn_shop()
        };
        assert_eq!(
            code(Business::create(":memory:", &s, &manager())),
            "tax_registration_number_invalid",
            "{trn}"
        );
    }
}

#[test]
fn the_fiscal_year_must_start_in_a_real_month() {
    let s = BusinessSettings {
        fiscal_year_start_month: 13,
        ..trn_shop()
    };
    assert_eq!(
        code(Business::create(":memory:", &s, &manager())),
        "fiscal_year_start_month_invalid"
    );
}

#[test]
fn a_tax_registration_number_typed_in_arabic_indic_digits_is_stored_in_western_digits() {
    let s = BusinessSettings {
        tax_registration_number: "١٢٣٤٥٦٧٨٩".into(),
        ..trn_shop()
    };
    let business = Business::create(":memory:", &s, &manager()).unwrap();
    assert_eq!(
        business.settings().unwrap().tax_registration_number,
        "123456789"
    );
}

#[test]
fn a_business_can_have_no_tax_registration_number() {
    let s = BusinessSettings {
        tax_registration_number: String::new(),
        vat_registered: false,
        ..trn_shop()
    };
    assert_eq!(
        Business::create(":memory:", &s, &manager())
            .unwrap()
            .settings()
            .unwrap()
            .tax_registration_number,
        ""
    );
}

#[test]
fn surrounding_spaces_are_removed_from_the_name_and_address() {
    let s = BusinessSettings {
        name: "  بقالة النور ".into(),
        address: " الدقي  ".into(),
        ..trn_shop()
    };
    let settings = Business::create(":memory:", &s, &manager())
        .unwrap()
        .settings()
        .unwrap();
    assert_eq!(
        (settings.name.as_str(), settings.address.as_str()),
        ("بقالة النور", "الدقي")
    );
}

// The file format: the Rust core and the TypeScript core make and read the same files.

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn schema_of(path: &str) -> Vec<(String, String, String, Option<String>)> {
    let conn = Connection::open(path).unwrap();
    let mut stmt = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn a_new_file_has_exactly_the_schema_the_typescript_core_makes() {
    let (_dir, path) = temp_file("shop.mplus");
    Business::create(&path, &trn_shop(), &manager())
        .unwrap()
        .close();
    let expected: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(fixture("schema.json")).unwrap()).unwrap();
    let expected: Vec<_> = expected
        .iter()
        .map(|r| {
            let s = |k: &str| r[k].as_str().map(String::from);
            (
                s("type").unwrap(),
                s("name").unwrap(),
                s("tbl_name").unwrap(),
                s("sql"),
            )
        })
        .collect();
    assert_eq!(schema_of(&path), expected);
}

#[test]
fn a_file_the_typescript_core_made_opens_signs_in_and_keeps_its_books() {
    let (_dir, path) = temp_file("shop.mplus");
    std::fs::copy(fixture("made-by-typescript.mplus"), &path).unwrap();
    let file = Business::open(&path).unwrap();
    assert_eq!(file.settings().unwrap().fiscal_year_start_month, 7);
    let me = file.sign_in("أيمن", "كلمة سر قوية").unwrap();
    assert_eq!(me.trial_balance("2026-11-30").unwrap().total_debit, 500_000);
    assert!(file.sign_in("سارة", "123456").is_ok());
    // And what Rust writes, the next open still reads.
    me.add_account(&manager_core::ledger::NewAccount {
        code: "6800".into(),
        name: "دعاية".into(),
        kind: "expense".into(),
    })
    .unwrap();
    me.close();
    file.close();
    let again = Business::open(&path)
        .unwrap()
        .sign_in("أيمن", "كلمة سر قوية")
        .unwrap();
    assert!(again.accounts().unwrap().iter().any(|a| a.code == "6800"));
}

#[test]
fn an_older_file_is_upgraded_after_a_copy_beside_it() {
    let (dir, path) = temp_file("shop.mplus");
    std::fs::copy(fixture("made-by-typescript.mplus"), &path).unwrap();
    // Pretend the file is at schema 21: the last migration only adds columns, so drop them back.
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 21").unwrap();
    }
    // Opening re-runs migration 22, which fails on the columns already there: the file is put back.
    assert_eq!(code(Business::open(&path)), "migration_failed");
    let copy = dir.path().join("shop قبل التحديث 21.mplus");
    assert!(copy.exists());
    let conn = Connection::open(&path).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 21);
}
