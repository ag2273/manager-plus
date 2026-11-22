//! Ported from `src/core/shifts.test.ts`.
mod common;

use common::*;
use manager_core::sales::{CashSaleInput, SaleLineInput, SaleResult};
use manager_core::shifts::{ByMethod, CashInOut, CloseShiftInput, ShiftSales};
use manager_core::{Business, BusinessError};

struct Setup {
    business: Business,
    main: i64,
    soap: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let soap = business
        .add_item(&manager_core::items::ItemInput {
            barcode: Some("35".into()),
            ..piece(&business, "منظف أطباق", 5_700)
        })
        .unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-11-01",
        &[(soap, 100_000, 4_000)],
    );
    Setup {
        business,
        main,
        soap,
    }
}

impl Setup {
    fn sell(&self, b: &Business, pieces: i64) -> Result<SaleResult, BusinessError> {
        self.sell_for(b, pieces, pieces * 5_700)
    }
    fn sell_for(&self, b: &Business, pieces: i64, cash: i64) -> Result<SaleResult, BusinessError> {
        b.post_cash_sale(&CashSaleInput {
            date: "2026-11-20".into(),
            warehouse_id: self.main,
            lines: vec![SaleLineInput::base(self.soap, pieces * 1000)],
            cash_received: cash as f64,
        })
    }
    fn account(&self, role: &str) -> i64 {
        role_account(&self.business, role)
    }
    fn cash(&self, direction: &str, amount: i64, role: &str, reason: &str) -> CashInOut {
        CashInOut {
            date: "2026-11-20".into(),
            direction: direction.into(),
            amount: amount as f64,
            account_id: self.account(role),
            reason: reason.into(),
        }
    }
}

fn close(counted: i64) -> CloseShiftInput {
    CloseShiftInput {
        date: "2026-11-20".into(),
        counted_cash: counted as f64,
    }
}

#[test]
fn sales_need_an_open_shift() {
    let s = setup();
    assert_eq!(code(s.sell(&s.business, 1)), "shift_required");
    s.business.open_shift(50_000.0).unwrap();
    assert_eq!(s.sell(&s.business, 1).unwrap().number, 1);
}

#[test]
fn a_user_has_at_most_one_open_shift_and_each_cashier_has_their_own() {
    let s = setup();
    let sara = signed_in(&s.business, "سارة", "cashier");

    s.business.open_shift(50_000.0).unwrap();
    assert_eq!(code(s.business.open_shift(0.0)), "shift_already_open");
    assert_eq!(sara.current_shift().unwrap(), None);
    assert_eq!(code(s.sell(&sara, 1)), "shift_required");
    sara.open_shift(20_000.0).unwrap();
    s.sell(&sara, 2).unwrap();

    let shift = sara.current_shift().unwrap().unwrap();
    assert_eq!(
        (shift.user_name.as_str(), shift.opening_float, shift.status),
        ("سارة", 20_000, "open")
    );
    assert_eq!(s.business.z_report(shift.id).unwrap().sales.total, 11_400);
    let mine = s.business.current_shift().unwrap().unwrap().id;
    assert_eq!(s.business.z_report(mine).unwrap().sales.total, 0);
}

#[test]
fn cash_in_and_out_post_against_the_chosen_account() {
    let s = setup();
    s.business.open_shift(50_000.0).unwrap();

    s.business
        .cash_in_out(&s.cash("out", 3_000, "owner_drawings", "سحب صاحب المحل"))
        .unwrap();
    s.business
        .cash_in_out(&s.cash("in", 10_000, "bank", "فكة من البنك"))
        .unwrap();

    assert_eq!(balance_of(&s.business, "owner_drawings"), 3_000);
    assert_eq!(balance_of(&s.business, "bank"), -10_000);
    assert_eq!(balance_of(&s.business, "cash_drawer"), 7_000);
    assert_eq!(
        code(s.business.cash_in_out(&s.cash("out", 0, "bank", ""))),
        "line_amount_invalid"
    );
    assert_eq!(
        code(
            s.business
                .cash_in_out(&s.cash("out", 100, "cash_drawer", ""))
        ),
        "account_not_allowed"
    );
}

#[test]
fn closing_with_a_shortage_posts_cash_short_and_the_z_report_shows_every_figure() {
    let s = setup();
    s.business.open_shift(50_000.0).unwrap();
    s.sell_for(&s.business, 3, 20_000).unwrap();
    s.sell(&s.business, 1).unwrap();
    s.business
        .cash_in_out(&s.cash("out", 3_000, "owner_drawings", "سحب"))
        .unwrap();

    // Expected: 500.00 float + 228.00 sales − 30.00 out = 698.00. Counted 695.50.
    let z = s.business.close_shift(&close(69_550)).unwrap();

    assert_eq!(z.receipts, 2);
    assert_eq!(
        z.sales,
        ShiftSales {
            total: 22_800,
            net: 20_000,
            vat: 2_800,
            by_method: ByMethod {
                cash: 22_800,
                card: 0,
                wallet: 0,
                credit: 0
            }
        }
    );
    assert_eq!(
        (
            z.returns,
            z.discounts,
            z.cash_in,
            z.cash_out,
            z.opening_float
        ),
        (0, 0, 0, 3_000, 50_000)
    );
    assert_eq!(
        (z.expected_cash, z.counted_cash, z.difference),
        (69_800, Some(69_550), Some(-250))
    );
    assert_eq!(z.shift.status, "closed");
    assert_eq!(balance_of(&s.business, "cash_short"), 250);
    assert_eq!(balance_of(&s.business, "cash_drawer"), 22_800 - 3_000 - 250);
}

#[test]
fn closing_with_extra_cash_posts_cash_over_and_an_exact_count_posts_nothing() {
    let s = setup();
    s.business.open_shift(0.0).unwrap();
    s.sell(&s.business, 1).unwrap();
    s.business.close_shift(&close(5_800)).unwrap();
    assert_eq!(balance_of(&s.business, "cash_over"), -100);

    s.business.open_shift(0.0).unwrap();
    s.sell(&s.business, 1).unwrap();
    let before = s.business.trial_balance("2026-12-31").unwrap().total_debit;
    s.business.close_shift(&close(5_700)).unwrap();
    assert_eq!(
        s.business.trial_balance("2026-12-31").unwrap().total_debit,
        before
    );
}

#[test]
fn a_closed_shift_cannot_change_and_closing_needs_an_open_shift() {
    let s = setup();
    let id = s.business.open_shift(0.0).unwrap();
    s.business.close_shift(&close(0)).unwrap();

    assert_eq!(code(s.business.close_shift(&close(0))), "shift_required");
    assert_eq!(code(s.sell(&s.business, 1)), "shift_required");
    assert_eq!(
        code(s.business.cash_in_out(&s.cash("in", 100, "bank", ""))),
        "shift_required"
    );
    assert_eq!(s.business.z_report(id).unwrap().shift.status, "closed");
    let ids: Vec<i64> = s.business.shifts().unwrap().iter().map(|x| x.id).collect();
    assert_eq!(ids, vec![id]);
}

#[test]
fn a_storekeeper_may_not_open_a_shift() {
    let s = setup();
    let mahmoud = signed_in(&s.business, "محمود", "storekeeper");
    assert_eq!(code(mahmoud.open_shift(0.0)), "not_allowed");
}
