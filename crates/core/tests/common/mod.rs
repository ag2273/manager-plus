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
    Business::create(":memory:", &shop(), &manager()).expect("a new shop")
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
