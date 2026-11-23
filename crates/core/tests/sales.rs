//! Ported from `src/core/sales.test.ts`.
mod common;

use common::*;
use manager_core::items::{ItemInput, PackUnitInput};
use manager_core::sales::{CashSaleInput, EtaState, SaleLineInput};
use manager_core::{Business, BusinessSettings};

struct Setup {
    business: Business,
    main: i64,
    soap: i64,
    bread: i64,
}

fn setup_with(settings: BusinessSettings) -> Setup {
    let business = common::ready(Business::create(":memory:", &settings, &manager()).unwrap());
    let main = main_warehouse(&business);
    // Shelf price 57.00 incl. 14% VAT; a pack of 6 at 330.00.
    let soap = business
        .add_item(&ItemInput {
            barcode: Some("6221000000035".into()),
            pack: Some(PackUnitInput {
                name: "كرتونة".into(),
                size: 6_000.0,
                barcode: Some("6221000000036".into()),
                sale_price: 33_000.0,
                ..Default::default()
            }),
            ..piece(&business, "منظف أطباق 1 لتر", 5_700)
        })
        .unwrap();
    let bread = business
        .add_item(&ItemInput {
            barcode: Some("111".into()),
            tax_code_id: tax_code(&business, "exempt"),
            ..piece(&business, "عيش فينو", 150)
        })
        .unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-11-01",
        &[(soap, 30_000, 4_000), (bread, 100_000, 100)],
    );
    business.open_shift(0.0).unwrap();
    Setup {
        business,
        main,
        soap,
        bread,
    }
}

fn setup() -> Setup {
    setup_with(shop())
}

impl Setup {
    fn cash_sale(&self, lines: Vec<SaleLineInput>, cash: i64) -> CashSaleInput {
        CashSaleInput {
            date: "2026-11-20".into(),
            warehouse_id: self.main,
            lines,
            cash_received: cash as f64,
        }
    }
    /** The invariants every sale must keep. */
    fn expect_books_balance(&self) {
        let tb = self.business.trial_balance("2026-12-31").unwrap();
        assert_eq!(tb.total_debit, tb.total_credit);
        let value: i64 = [self.soap, self.bread]
            .iter()
            .map(|&id| self.business.stock_value(id).unwrap())
            .sum();
        assert_eq!(balance_of(&self.business, "stock"), value);
    }
}

#[test]
fn vat_inclusive_lines_net_is_gross_over_1_14_and_the_total_is_the_shelf_prices() {
    let s = setup();
    let priced = s
        .business
        .price_sale(
            "2026-11-20",
            &[
                SaleLineInput::base(s.soap, 3_000),
                SaleLineInput::base(s.bread, 10_000),
            ],
            None,
        )
        .unwrap();

    // 3 × 57.00 = 171.00; 17100 / 1.14 = 15000 exactly; VAT 2100.
    let l = &priced.lines[0];
    assert_eq!(
        (l.unit_price, l.gross, l.net, l.vat, l.vat_rate),
        (5_700, 17_100, 15_000, 2_100, 1400)
    );
    let l = &priced.lines[1];
    assert_eq!((l.gross, l.net, l.vat), (1_500, 1_500, 0));
    assert_eq!((priced.total, priced.vat), (18_600, 2_100));
}

#[test]
fn net_is_rounded_half_up_per_line() {
    let s = setup();
    let priced = s
        .business
        .price_sale("2026-11-20", &[SaleLineInput::pack(s.soap, 1_000)], None)
        .unwrap();
    let l = &priced.lines[0];
    assert_eq!(
        (l.unit_price, l.gross, l.net, l.vat),
        (33_000, 33_000, 28_947, 4_053)
    );
}

#[test]
fn a_cash_sale_posts_sales_vat_and_cost_lowers_stock_and_gives_change() {
    let s = setup();
    let sale = s
        .business
        .post_cash_sale(&s.cash_sale(
            vec![
                SaleLineInput::base(s.soap, 3_000),
                SaleLineInput::base(s.bread, 10_000),
            ],
            20_000,
        ))
        .unwrap();

    assert_eq!(
        (sale.number, sale.total, sale.change, sale.below_zero.len()),
        (1, 18_600, 1_400, 0)
    );
    assert_eq!(balance_of(&s.business, "cash_drawer"), 18_600);
    assert_eq!(balance_of(&s.business, "sales"), -16_500);
    assert_eq!(balance_of(&s.business, "output_vat"), -2_100);
    assert_eq!(
        balance_of(&s.business, "cost_of_goods_sold"),
        12_000 + 1_000
    );
    assert_eq!(s.business.stock_on_hand(s.soap).unwrap().total, 27_000);
    assert_eq!(s.business.stock_on_hand(s.bread).unwrap().total, 90_000);
    s.expect_books_balance();
}

#[test]
fn receipt_numbers_are_gap_free_a_refused_sale_does_not_use_a_number() {
    let s = setup();
    let line = || vec![SaleLineInput::base(s.soap, 1_000)];
    s.business
        .post_cash_sale(&s.cash_sale(line(), 5_700))
        .unwrap();
    assert_eq!(
        code(s.business.post_cash_sale(&s.cash_sale(line(), 100))),
        "payment_short"
    );
    s.business
        .post_cash_sale(&s.cash_sale(line(), 5_700))
        .unwrap();

    let numbers: Vec<i64> = s
        .business
        .receipts()
        .unwrap()
        .iter()
        .map(|r| r.number)
        .collect();
    assert_eq!(numbers, vec![2, 1]);
}

#[test]
fn each_receipt_stores_empty_eta_fields_the_lines_and_who_sold_it() {
    let s = setup();
    s.business
        .post_cash_sale(&s.cash_sale(vec![SaleLineInput::pack(s.soap, 1_000)], 50_000))
        .unwrap();

    let r = &s.business.receipts().unwrap()[0];
    assert_eq!(
        (
            r.number,
            r.date.as_str(),
            r.total,
            r.vat,
            r.cash_received,
            r.change
        ),
        (1, "2026-11-20", 33_000, 4_053, 50_000, 17_000)
    );
    assert_eq!(r.sold_by, "أيمن");
    assert_eq!(
        r.eta,
        EtaState {
            uuid: String::new(),
            previous_uuid: String::new(),
            status: String::new()
        }
    );
    assert_eq!(r.lines.len(), 1);
    let l = &r.lines[0];
    assert_eq!(
        (l.item_id, l.unit.as_str(), l.quantity, l.gross),
        (s.soap, "pack", 1_000, 33_000)
    );
    assert_eq!(s.business.stock_on_hand(s.soap).unwrap().total, 24_000);
}

#[test]
fn selling_more_than_is_on_hand_is_allowed_with_a_warning() {
    let s = setup();
    let sale = s
        .business
        .post_cash_sale(&s.cash_sale(vec![SaleLineInput::base(s.soap, 31_000)], 31 * 5_700))
        .unwrap();

    assert_eq!(sale.below_zero, vec![s.soap]);
    assert_eq!(s.business.stock_on_hand(s.soap).unwrap().total, -1_000);
    assert_eq!(balance_of(&s.business, "cost_of_goods_sold"), 31 * 4_000);
    s.expect_books_balance();
}

#[test]
fn cost_of_goods_takes_exactly_the_stock_value_when_the_last_unit_is_sold() {
    let s = setup();
    let supplier = s.business.suppliers().unwrap()[0].id;
    // 30 at 40.00 + 1 at 40.01 → value 1240.01 for 31: the average does not divide evenly.
    buy(
        &s.business,
        supplier,
        s.main,
        "2026-11-02",
        &[(s.soap, 1_000, 4_001)],
    );

    for _ in 0..3 {
        s.business
            .post_cash_sale(&s.cash_sale(vec![SaleLineInput::base(s.soap, 7_000)], 7 * 5_700))
            .unwrap();
    }
    s.business
        .post_cash_sale(&s.cash_sale(vec![SaleLineInput::base(s.soap, 10_000)], 10 * 5_700))
        .unwrap();

    assert_eq!(s.business.stock_on_hand(s.soap).unwrap().total, 0);
    assert_eq!(s.business.stock_value(s.soap).unwrap(), 0);
    assert_eq!(balance_of(&s.business, "cost_of_goods_sold"), 124_001);
    s.expect_books_balance();
}

#[test]
fn a_business_that_is_not_vat_registered_posts_the_whole_price_as_sales() {
    let s = setup_with(BusinessSettings {
        vat_registered: false,
        ..shop()
    });
    s.business
        .post_cash_sale(&s.cash_sale(vec![SaleLineInput::base(s.soap, 1_000)], 5_700))
        .unwrap();
    assert_eq!(balance_of(&s.business, "sales"), -5_700);
    assert_eq!(balance_of(&s.business, "output_vat"), 0);
}

#[test]
fn bad_sales_are_refused() {
    let s = setup();
    assert_eq!(
        code(s.business.post_cash_sale(&s.cash_sale(vec![], 100_000))),
        "invoice_needs_lines"
    );
    assert_eq!(
        code(
            s.business
                .post_cash_sale(&s.cash_sale(vec![SaleLineInput::base(s.soap, 0)], 100_000))
        ),
        "quantity_invalid"
    );
    assert_eq!(
        code(
            s.business
                .post_cash_sale(&s.cash_sale(vec![SaleLineInput::base(999, 1_000)], 100_000))
        ),
        "item_not_found"
    );
    assert!(s.business.receipts().unwrap().is_empty());
}

#[test]
fn a_cashier_can_sell_and_a_storekeeper_cannot() {
    let s = setup();
    let sara = signed_in(&s.business, "سارة", "cashier");
    let mahmoud = signed_in(&s.business, "محمود", "storekeeper");
    let sale = s.cash_sale(vec![SaleLineInput::base(s.soap, 1_000)], 5_700);

    sara.open_shift(0.0).unwrap();
    sara.post_cash_sale(&sale).unwrap();
    assert_eq!(code(mahmoud.post_cash_sale(&sale)), "not_allowed");
    assert_eq!(s.business.receipts().unwrap()[0].sold_by, "سارة");
}

#[test]
fn receipts_are_found_by_date_shift_and_cashier_and_a_cashier_sees_only_their_own() {
    use manager_core::sales::ReceiptFilter;
    let s = setup();
    let sara = signed_in(&s.business, "سارة", "cashier");
    let sale = |date: &str| CashSaleInput {
        date: date.into(),
        ..s.cash_sale(vec![SaleLineInput::base(s.soap, 1_000)], 5_700)
    };
    // The manager's shift (opened in setup) sells on the 20th and 21st; Sara's on the 21st.
    s.business.post_cash_sale(&sale("2026-11-20")).unwrap();
    s.business.post_cash_sale(&sale("2026-11-21")).unwrap();
    let sara_shift = sara.open_shift(0.0).unwrap();
    sara.post_cash_sale(&sale("2026-11-21")).unwrap();
    let all = |filter: ReceiptFilter| -> Vec<i64> {
        s.business
            .search_receipts(&filter)
            .unwrap()
            .iter()
            .map(|r| r.number)
            .collect()
    };
    let month = ReceiptFilter {
        from: "2026-11-01".into(),
        to: "2026-11-30".into(),
        ..Default::default()
    };
    assert_eq!(all(month.clone()), vec![3, 2, 1], "newest first");
    assert_eq!(
        all(ReceiptFilter {
            from: "2026-11-21".into(),
            to: "2026-11-21".into(),
            ..Default::default()
        }),
        vec![3, 2]
    );
    assert_eq!(
        all(ReceiptFilter {
            shift_id: Some(sara_shift),
            ..month.clone()
        }),
        vec![3]
    );
    let manager_id = s.business.current_user().unwrap().id;
    assert_eq!(
        all(ReceiptFilter {
            user_id: Some(manager_id),
            ..month.clone()
        }),
        vec![2, 1]
    );
    let third = &s.business.search_receipts(&month).unwrap()[0];
    assert_eq!(
        (third.sold_by.as_str(), third.shift_id),
        ("سارة", Some(sara_shift))
    );
    // Asking for someone else's receipts, a cashier still gets only their own.
    let mine: Vec<i64> = sara
        .search_receipts(&ReceiptFilter {
            user_id: Some(manager_id),
            ..month.clone()
        })
        .unwrap()
        .iter()
        .map(|r| r.number)
        .collect();
    assert_eq!(mine, vec![3]);
    assert_eq!(
        code(s.business.search_receipts(&ReceiptFilter {
            from: "2026-11-30".into(),
            to: "2026-11-01".into(),
            ..Default::default()
        })),
        "date_range_invalid"
    );
}
