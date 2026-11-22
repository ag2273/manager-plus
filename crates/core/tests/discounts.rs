//! Ported from `src/core/discounts.test.ts`.
mod common;

use common::*;
use manager_core::items::ItemInput;
use manager_core::sales::{
    CashSaleInput, Discount, HeldSaleInput, PaymentInput, SaleInput, SaleLineInput,
};
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    rice: i64,
    sugar: i64,
    bread: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let bag = |name: &str, price| ItemInput {
        base_unit: "كيس".into(),
        ..piece(&business, name, price)
    };
    let rice = business.add_item(&bag("أرز", 3_800)).unwrap();
    let sugar = business.add_item(&bag("سكر", 3_450)).unwrap();
    let bread = business
        .add_item(&ItemInput {
            base_unit: "رغيف".into(),
            tax_code_id: tax_code(&business, "exempt"),
            ..piece(&business, "عيش", 5_700)
        })
        .unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-11-01",
        &[
            (rice, 100_000, 1_000),
            (sugar, 100_000, 1_000),
            (bread, 100_000, 1_000),
        ],
    );
    business.open_shift(0.0).unwrap();
    Setup {
        business,
        main,
        rice,
        sugar,
        bread,
    }
}

#[test]
fn a_line_discount_by_amount_or_percentage_reduces_that_line_and_vat_is_on_the_discounted_price() {
    let s = setup();
    let priced = s
        .business
        .price_sale(
            "2026-11-20",
            &[
                // 2 × 38.00 = 76.00, less 2.50 = 73.50 → net 64.47, VAT 9.03
                SaleLineInput::base(s.rice, 2_000).with_discount(Discount::amount(250)),
                // 3 × 34.50 = 103.50, less 10% = 10.35 → 93.15 → net 81.71, VAT 11.44
                SaleLineInput::base(s.sugar, 3_000).with_discount(Discount::percent(1_000)),
            ],
            None,
        )
        .unwrap();

    let l = &priced.lines[0];
    assert_eq!(
        (l.gross, l.discount, l.amount, l.net, l.vat),
        (7_600, 250, 7_350, 6_447, 903)
    );
    let l = &priced.lines[1];
    assert_eq!(
        (l.gross, l.discount, l.amount, l.net, l.vat),
        (10_350, 1_035, 9_315, 8_171, 1_144)
    );
    assert_eq!(
        (priced.total, priced.discount, priced.gross),
        (16_665, 1_285, 17_950)
    );
}

#[test]
fn a_receipt_discount_is_spread_by_amount_and_the_remainder_goes_to_the_largest_line() {
    let s = setup();
    // Lines 76.00, 103.50, 57.00 = 236.50, less 10.00 for the receipt.
    let priced = s
        .business
        .price_sale(
            "2026-11-20",
            &[
                SaleLineInput::base(s.rice, 2_000),
                SaleLineInput::base(s.sugar, 3_000),
                SaleLineInput::base(s.bread, 1_000),
            ],
            Some(&Discount::amount(1_000)),
        )
        .unwrap();

    // Shares 3.21, 4.37 (+0.01 remainder), 2.41.
    let discounts: Vec<i64> = priced.lines.iter().map(|l| l.discount).collect();
    assert_eq!(discounts, vec![321, 438, 241]);
    assert_eq!(priced.total, 22_650);
    let l = &priced.lines[2];
    assert_eq!((l.amount, l.net, l.vat), (5_459, 5_459, 0));
}

#[test]
fn a_receipt_discount_by_percentage_comes_after_line_discounts() {
    let s = setup();
    // 10 × 38.00 = 380.00, less 20.00 = 360.00, less 5% = 18.00 → 342.00
    let priced = s
        .business
        .price_sale(
            "2026-11-20",
            &[SaleLineInput::base(s.rice, 10_000).with_discount(Discount::amount(2_000))],
            Some(&Discount::percent(500)),
        )
        .unwrap();
    assert_eq!(priced.lines[0].discount, 3_800);
    assert_eq!(priced.total, 34_200);
}

#[test]
fn a_discounted_sale_posts_sales_net_of_discount_and_the_z_report_shows_the_discounts() {
    let s = setup();
    s.business
        .post_sale(&SaleInput {
            date: "2026-11-20".into(),
            warehouse_id: s.main,
            lines: vec![
                SaleLineInput::base(s.rice, 2_000).with_discount(Discount::amount(250)),
                SaleLineInput::base(s.sugar, 3_000).with_discount(Discount::percent(1_000)),
            ],
            payments: vec![PaymentInput::new("cash", 20_000)],
            ..Default::default()
        })
        .unwrap();

    assert_eq!(balance_of(&s.business, "cash_drawer"), 16_665);
    assert_eq!(balance_of(&s.business, "sales"), -(6_447 + 8_171));
    assert_eq!(balance_of(&s.business, "output_vat"), -(903 + 1_144));
    let shift = s.business.current_shift().unwrap().unwrap().id;
    let z = s.business.z_report(shift).unwrap();
    assert_eq!((z.sales.total, z.discounts), (16_665, 1_285));
    let l = &s.business.receipts().unwrap()[0].lines[0];
    assert_eq!((l.discount, l.amount), (250, 7_350));
}

#[test]
fn discounts_must_be_sensible() {
    let s = setup();
    let line = || SaleLineInput::base(s.rice, 1_000);
    let price = |lines: Vec<SaleLineInput>, d: Option<Discount>| {
        s.business.price_sale("2026-11-20", &lines, d.as_ref())
    };

    assert_eq!(
        code(price(
            vec![line().with_discount(Discount::amount(3_801))],
            None
        )),
        "discount_invalid"
    );
    assert_eq!(
        code(price(
            vec![line().with_discount(Discount::percent(10_001))],
            None
        )),
        "discount_invalid"
    );
    assert_eq!(
        code(price(vec![line()], Some(Discount::amount(-1)))),
        "discount_invalid"
    );
    assert_eq!(
        code(price(vec![line()], Some(Discount::amount(3_801)))),
        "discount_invalid"
    );
}

#[test]
fn a_held_receipt_is_not_posted_uses_no_number_and_can_be_recalled_once() {
    let s = setup();
    let cart = HeldSaleInput {
        warehouse_id: s.main,
        lines: vec![SaleLineInput::base(s.rice, 2_000)],
        discount: None,
        note: "الزبون رجع يجيب فلوس".into(),
    };

    let held = s.business.hold_sale(&cart).unwrap();
    s.business
        .post_cash_sale(&CashSaleInput {
            date: "2026-11-20".into(),
            warehouse_id: s.main,
            lines: vec![SaleLineInput::base(s.rice, 1_000)],
            cash_received: 3_800.0,
        })
        .unwrap();

    let list = s.business.held_sales().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].id, list[0].note.as_str()),
        (held, "الزبون رجع يجيب فلوس")
    );
    assert_eq!(
        serde_json::to_value(&list[0].lines).unwrap(),
        serde_json::json!([{ "itemId": s.rice, "unit": "base", "quantity": 2000.0 }])
    );
    let numbers: Vec<i64> = s
        .business
        .receipts()
        .unwrap()
        .iter()
        .map(|r| r.number)
        .collect();
    assert_eq!(numbers, vec![1]);
    assert_eq!(s.business.stock_on_hand(s.rice).unwrap().total, 99_000);

    let recalled = s.business.recall_sale(held).unwrap();
    assert_eq!((recalled.warehouse_id, recalled.lines.len()), (s.main, 1));
    assert!(s.business.held_sales().unwrap().is_empty());
    assert_eq!(code(s.business.recall_sale(held)), "held_sale_not_found");
}
