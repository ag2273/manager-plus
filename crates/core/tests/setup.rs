//! The first-use setup (#97, note 10): sales and purchases wait for the opening balances.
mod common;

use common::*;
use manager_core::ledger::JournalLine;
use manager_core::setup::SetupMode;
use manager_core::Business;

fn fresh() -> Business {
    Business::create(":memory:", &shop(), &manager()).unwrap()
}

#[test]
fn a_new_business_cannot_sell_or_buy_until_its_setup_is_finished() {
    let business = fresh();
    let status = business.setup_status().unwrap();
    assert!(!status.finished);
    assert_eq!(status.mode, None);
    assert_eq!(
        status.warehouses, 1,
        "the main warehouse is there from the start"
    );
    assert_eq!(status.items, 0);
    assert_eq!(status.opening_entries, 0);
    assert_eq!(code(business.open_shift(0.0)), "setup_not_finished");
    let main = main_warehouse(&business);
    let supplier = supplier(&business);
    let item = business
        .add_item(&piece(&business, "راوتر", 150_000))
        .unwrap();
    let bought = business.post_purchase_invoice(&manager_core::purchases::PurchaseInvoiceInput {
        date: "2026-11-01".into(),
        supplier_id: supplier,
        warehouse_id: main,
        reference: String::new(),
        lines: vec![manager_core::purchases::PurchaseLineInput {
            item_id: item,
            unit: "base".into(),
            quantity: 1_000.0,
            unit_price: 100_000.0,
            serials: None,
        }],
        rate: None,
    });
    assert_eq!(code(bought), "setup_not_finished");
    // Everything that brings the business in stays open meanwhile.
    business
        .post_opening_stock(
            "2026-01-01",
            main,
            &[manager_core::stock::OpeningStockLine {
                item_id: item,
                quantity: 3_000.0,
                unit_cost: 100_000.0,
                serials: None,
            }],
        )
        .unwrap();
    assert_eq!(business.setup_status().unwrap().items, 1);
}

#[test]
fn confirming_opening_balances_needs_some_and_then_opens_trading() {
    let business = fresh();
    assert_eq!(
        code(business.finish_setup(SetupMode::Opening)),
        "opening_balances_missing"
    );
    let cash = account(&business, "1110");
    business
        .post_opening_balances(
            "2026-01-01",
            &[JournalLine {
                account_id: cash,
                debit: Some(500_000.0),
                ..Default::default()
            }],
        )
        .unwrap();
    assert_eq!(business.setup_status().unwrap().opening_entries, 1);
    let done = business.finish_setup(SetupMode::Opening).unwrap();
    assert!(done.finished);
    assert_eq!(done.mode, Some(SetupMode::Opening));
    assert!(business.open_shift(0.0).unwrap() > 0);
    assert_eq!(
        code(business.finish_setup(SetupMode::New)),
        "setup_finished"
    );
}

#[test]
fn a_new_business_with_nothing_to_bring_forward_opens_at_once() {
    let business = fresh();
    let done = business.finish_setup(SetupMode::New).unwrap();
    assert_eq!(done.mode, Some(SetupMode::New));
    assert!(business.open_shift(0.0).unwrap() > 0);
}

#[test]
fn only_a_manager_finishes_the_setup_but_everyone_sees_it() {
    let business = fresh();
    business
        .add_user(&manager_core::users::NewUser {
            name: "سارة".into(),
            role: "cashier".into(),
            password: "كلمة سر الكاشير".into(),
        })
        .unwrap();
    let cashier = business.sign_in("سارة", "كلمة سر الكاشير").unwrap();
    assert!(!cashier.setup_status().unwrap().finished);
    assert_eq!(code(cashier.finish_setup(SetupMode::New)), "not_allowed");
}

#[test]
fn reopening_a_new_file_keeps_it_in_setup() {
    let (_dir, path) = temp_file("new.mplus");
    let made = Business::create(&path, &shop(), &manager()).unwrap();
    assert!(!made.setup_status().unwrap().finished);
    made.close();
    let reopened = Business::open(&path).unwrap();
    let signed = reopened
        .sign_in(&manager().name, &manager().password)
        .unwrap();
    assert!(!signed.setup_status().unwrap().finished);
}

#[test]
fn a_file_already_in_use_counts_as_set_up() {
    let (_dir, path) = temp_file("shop.mplus");
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/made-by-typescript.mplus"
        ),
        &path,
    )
    .unwrap();
    let file = Business::open(&path).unwrap();
    let manager = file.sign_in(&manager().name, &manager().password).unwrap();
    let status = manager.setup_status().unwrap();
    assert!(status.finished);
    assert_eq!(status.mode, Some(SetupMode::Existing));
    assert!(manager.open_shift(0.0).is_ok() || manager.current_shift().unwrap().is_some());
}
