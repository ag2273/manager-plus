//! Ported from `src/core/backup.test.ts` (the safe-upgrade cases are in `business.rs`).
mod common;

use chrono::{TimeZone, Utc};
use common::*;
use manager_core::customers::CustomerInput;
use manager_core::file_lock::{release_lock, sync_folder, take_lock, LockInfo, Me};
use manager_core::invoices::{
    CreditLineInput, CreditNoteInput, InvoiceLineInput, SalesInvoiceInput,
};
use manager_core::money::{ExpenseInput, PaidFrom};
use manager_core::purchases::{PurchaseInvoiceInput, PurchaseLineInput, SupplierInput};
use manager_core::sales::{PaymentInput, SaleInput, SaleLineInput};
use manager_core::{Business, BusinessSettings};
use serde_json::{json, Value};

fn settings() -> BusinessSettings {
    BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        address: String::new(),
        ..shop()
    }
}

/** A business file with months of trading: purchases, till sales, invoices, credit notes and expenses. */
fn trading_file(path: &str, days: i64) -> Business {
    let business = Business::create(path, &settings(), &manager()).unwrap();
    let main = main_warehouse(&business);
    let items: Vec<i64> = (0..20)
        .map(|i| {
            business
                .add_item(&manager_core::items::ItemInput {
                    tax_code_id: tax_code(
                        &business,
                        if i % 5 == 0 { "exempt" } else { "standard" },
                    ),
                    ..piece(&business, &format!("صنف {i}"), 11_400 + i * 1_140)
                })
                .unwrap()
        })
        .collect();
    let supplier = business
        .add_supplier(&SupplierInput {
            name: "مورد".into(),
            ..Default::default()
        })
        .unwrap();
    let customer = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            ..Default::default()
        })
        .unwrap();
    let rent = business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.name == "الإيجار")
        .unwrap()
        .id;
    let cash = role_account(&business, "main_cash");
    business.open_shift(0.0).unwrap();
    let start = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
    for d in 0..days {
        let date = (start + chrono::Days::new(d as u64)).to_string();
        let item = items[d as usize % items.len()];
        if d % 7 == 0 {
            business
                .post_purchase_invoice(&PurchaseInvoiceInput {
                    date: date.clone(),
                    supplier_id: supplier,
                    warehouse_id: main,
                    reference: String::new(),
                    rate: None,
                    lines: items
                        .iter()
                        .map(|&item_id| PurchaseLineInput {
                            item_id,
                            unit: "base".into(),
                            quantity: 10_000.0,
                            unit_price: (5_000 + d * 10) as f64,
                            serials: None,
                        })
                        .collect(),
                })
                .unwrap();
        }
        business
            .post_sale(&SaleInput {
                date: date.clone(),
                warehouse_id: main,
                lines: vec![SaleLineInput::base(item, 1_000)],
                payments: vec![PaymentInput::new("cash", 100_000)],
                ..Default::default()
            })
            .unwrap();
        if d % 3 == 0 {
            let invoice = business
                .post_sales_invoice(&SalesInvoiceInput {
                    date: date.clone(),
                    customer_id: customer,
                    warehouse_id: main,
                    lines: vec![InvoiceLineInput::base(item, 2_000, 10_000)],
                    ..Default::default()
                })
                .unwrap();
            if d % 9 == 0 {
                let line_id = business.find_sales_invoice(invoice.number).unwrap().lines[0].line_id;
                business
                    .post_credit_note(&CreditNoteInput {
                        date: date.clone(),
                        invoice_id: invoice.id,
                        reason: "مرتجع".into(),
                        lines: vec![CreditLineInput::new(line_id, 1_000)],
                    })
                    .unwrap();
            }
        }
        if d % 30 == 0 {
            business
                .record_expense(&ExpenseInput {
                    date: date.clone(),
                    expense_account_id: rent,
                    amount: 500_000.0,
                    vat: 0.0,
                    paid_from: PaidFrom::Account { account_id: cash },
                    memo: String::new(),
                })
                .unwrap();
        }
    }
    business
}

/** Every report over the year, as one value to compare. */
fn reports(business: &Business) -> Value {
    let (from, to) = ("2026-01-01", "2026-12-31");
    json!({
        "trial": business.trial_balance(to).unwrap(),
        "pnl": business.profit_and_loss(from, to).unwrap(),
        "balance": business.balance_sheet(to).unwrap(),
        "byItem": business.sales_by_item(from, to).unwrap(),
        "byDay": business.sales_by_day(from, to).unwrap(),
        "byMethod": business.sales_by_payment_method(from, to).unwrap(),
        "stock": business.stock_at(to).unwrap(),
        "vat": business.vat_return(from, to).unwrap(),
    })
}

fn signed_in_manager(business: &Business) -> Business {
    let m = manager();
    business.sign_in(&m.name, &m.password).unwrap()
}

fn customer_names(business: &Business) -> Vec<String> {
    business
        .customers()
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect()
}

#[test]
fn backing_up_needs_a_folder_copies_the_open_file_and_keeps_the_newest_thirty() {
    let (dir, path) = temp_file("shop.mplus");
    let folder = dir.path().join("USB");
    std::fs::create_dir(&folder).unwrap();
    let folder = folder.to_string_lossy().into_owned();
    let business = trading_file(&path, 10);
    assert_eq!(code(business.backup_now()), "backup_folder_required");
    let missing = dir.path().join("missing").to_string_lossy().into_owned();
    assert_eq!(
        code(business.set_backup_folder(Some(&missing))),
        "backup_folder_invalid"
    );
    business.set_backup_folder(Some(&folder)).unwrap();
    std::fs::write(format!("{folder}/notes.txt"), "not a backup").unwrap();

    let first = business.backup_now().unwrap();
    let rest = first.name.strip_prefix("shop نسخة احتياطية ").unwrap();
    assert!(
        rest.ends_with(".mplus") && rest.len() == "2026-11-21 080509.mplus".len(),
        "{}",
        first.name
    );
    let copy = signed_in_manager(&Business::open(&first.path).unwrap());
    assert_eq!(reports(&copy), reports(&business));
    copy.close();

    for day in 1..=32 {
        let at = Utc.with_ymd_and_hms(2027, 1, 1, 9, 0, 0).unwrap() + chrono::Days::new(day - 1);
        business.scheduled_backup(at).unwrap();
    }
    let status = business.backup_status().unwrap();
    assert_eq!(status.backups.len(), 30);
    assert_eq!(status.backups[0].at, "2027-02-01T09:00:00Z");
    assert_eq!(status.backups[29].at, "2027-01-03T09:00:00Z");
    assert_eq!(
        status.last_backup_at.as_deref(),
        Some("2027-02-01T09:00:00.000Z")
    );
    assert!(std::path::Path::new(&format!("{folder}/notes.txt")).exists());
    business.close();
}

#[test]
fn the_daily_backup_runs_once_a_day_and_not_at_all_without_a_folder() {
    let (dir, path) = temp_file("shop.mplus");
    let business = trading_file(&path, 3);
    let at = |h, m| Utc.with_ymd_and_hms(2027, 1, 1, h, m, 0).unwrap();
    assert!(business.scheduled_backup(at(8, 0)).unwrap().is_none());
    business
        .set_backup_folder(Some(&dir.path().to_string_lossy()))
        .unwrap();
    assert!(business.scheduled_backup(at(8, 0)).unwrap().is_some());
    assert!(business.scheduled_backup(at(8, 30)).unwrap().is_none());
    let next_day = Utc.with_ymd_and_hms(2027, 1, 2, 8, 0, 0).unwrap();
    assert!(business.scheduled_backup(next_day).unwrap().is_some());
    business.close();
}

#[test]
fn restoring_backs_up_the_file_as_it_is_then_opens_the_chosen_backup_signed_out() {
    let (dir, path) = temp_file("shop.mplus");
    let business = trading_file(&path, 10);
    business
        .set_backup_folder(Some(&dir.path().to_string_lossy()))
        .unwrap();
    let before = reports(&business);
    let backup = business.backup_now().unwrap();
    business
        .add_customer(&CustomerInput {
            name: "عميل بعد النسخة".into(),
            ..Default::default()
        })
        .unwrap();

    let restored = business.restore(&backup.path).unwrap();
    business.close();
    assert!(restored.current_user().is_none());
    let signed_in = signed_in_manager(&restored);
    assert_eq!(reports(&signed_in), before);
    assert_eq!(customer_names(&signed_in), vec!["شركة الأمل"]);
    // The file as it was just before the restore is the newest backup.
    let latest = signed_in.backup_status().unwrap().backups[0].clone();
    let kept = signed_in_manager(&Business::open(&latest.path).unwrap());
    assert!(customer_names(&kept).contains(&"عميل بعد النسخة".to_string()));
    kept.close();

    let junk = dir.path().join("junk.mplus").to_string_lossy().into_owned();
    std::fs::write(&junk, "junk").unwrap();
    assert_eq!(code(signed_in.restore(&junk)), "not_a_business_file");
    signed_in.close();
}

#[test]
fn without_a_folder_a_restore_or_an_update_keeps_a_copy_beside_the_file() {
    let (dir, path) = temp_file("shop.mplus");
    let business = trading_file(&path, 2);
    let copy = business.backup_before_update("1.4.0").unwrap();
    assert!(
        copy.ends_with("shop قبل تحديث البرنامج 1.4.0.mplus"),
        "{copy}"
    );
    let again = business.backup_before_update("1.4.0").unwrap();
    assert!(
        again.ends_with("shop قبل تحديث البرنامج 1.4.0 (2).mplus"),
        "{again}"
    );
    let restored = business.restore(&copy).unwrap();
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().any(|n| n.starts_with("shop قبل الاسترجاع ")),
        "{names:?}"
    );
    restored.close();
    assert_eq!(code(new_shop().restore(&copy)), "file_not_found");
}

#[test]
fn another_pcs_fresh_lock_is_reported_this_pcs_own_or_a_stale_one_is_taken_over() {
    let (_dir, path) = temp_file("shop.mplus");
    let me = |host: &str, pid| Me {
        host: host.into(),
        pid,
    };
    let at = |h, m| Utc.with_ymd_and_hms(2027, 1, 1, h, m, 0).unwrap();
    assert_eq!(take_lock(&path, &me("SHOP-PC", 1), at(10, 0)), None);
    assert_eq!(
        take_lock(&path, &me("OFFICE-PC", 7), at(10, 5)),
        Some(LockInfo {
            host: "SHOP-PC".into(),
            pid: 1,
            at: "2027-01-01T10:00:00.000Z".into()
        })
    );
    assert_eq!(take_lock(&path, &me("OFFICE-PC", 8), at(10, 6)), None);
    assert_eq!(take_lock(&path, &me("SHOP-PC", 2), at(11, 0)), None);
    release_lock(&path, &me("OFFICE-PC", 8));
    assert!(std::path::Path::new(&format!("{path}.lock")).exists());
    release_lock(&path, &me("SHOP-PC", 2));
    assert!(!std::path::Path::new(&format!("{path}.lock")).exists());
}

#[test]
fn sync_folders_are_recognised() {
    assert_eq!(
        sync_folder("C:\\Users\\Ayman\\OneDrive - Al Nour\\Shop\\shop.mplus"),
        Some("OneDrive")
    );
    assert_eq!(
        sync_folder("C:\\Users\\Ayman\\Dropbox\\shop.mplus"),
        Some("Dropbox")
    );
    assert_eq!(
        sync_folder("G:\\My Drive\\shop.mplus"),
        Some("Google Drive")
    );
    assert_eq!(sync_folder("D:\\Accounts\\shop.mplus"), None);
}
