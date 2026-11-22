//! Ported from `src/core/inventory.test.ts`. The top-level tests move stock with opening stock and
//! write-offs; `with_purchases_and_sales` runs the TypeScript checks with purchases and invoices.
mod common;

use common::*;
use manager_core::inventory::{CountedLine, StockCountInput, WriteOffInput};
use manager_core::items::ItemInput;
use manager_core::stock::{TransferInput, UnitLine};
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    branch: i64,
    router: i64,
    cable: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let branch = business.add_warehouse("فرع المعادي").unwrap();
    let router = business
        .add_item(&piece(&business, "راوتر", 114_000))
        .unwrap();
    let cable = business
        .add_item(&ItemInput {
            base_unit: "متر".into(),
            ..piece(&business, "كابل", 1_140)
        })
        .unwrap();
    Setup {
        business,
        main,
        branch,
        router,
        cable,
    }
}

impl Setup {
    fn buy(&self, date: &str, item: i64, units: i64, unit_cost: i64, warehouse: i64) {
        self.business
            .post_opening_stock(date, warehouse, &[opening(item, units * 1_000, unit_cost)])
            .unwrap();
    }
    fn write_off(&self, date: &str, item: i64, units: i64, warehouse: i64) -> i64 {
        self.business
            .write_off_stock(&WriteOffInput {
                date: date.into(),
                warehouse_id: warehouse,
                reason: "تالف".into(),
                lines: vec![UnitLine::base(item, units * 1_000)],
            })
            .unwrap()
    }
    fn count(&self, date: &str, warehouse: i64, lines: &[(i64, i64)]) -> manager_core::Result<i64> {
        self.business.post_stock_count(&StockCountInput {
            date: date.into(),
            warehouse_id: warehouse,
            memo: String::new(),
            lines: lines
                .iter()
                .map(|&(item_id, counted)| CountedLine {
                    item_id,
                    counted: counted as f64,
                })
                .collect(),
        })
    }
}

#[test]
fn a_count_posts_the_difference_as_a_gain_or_a_loss_at_average_cost() {
    let s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000, s.main);
    s.buy("2026-01-01", s.cable, 100, 500, s.main);
    let count = s
        .business
        .post_stock_count(&StockCountInput {
            date: "2026-01-31".into(),
            warehouse_id: s.main,
            memo: "جرد يناير".into(),
            lines: vec![
                CountedLine {
                    item_id: s.router,
                    counted: 8_000.0,
                },
                CountedLine {
                    item_id: s.cable,
                    counted: 103_000.0,
                },
            ],
        })
        .unwrap();
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 8_000);
    assert_eq!(s.business.stock_on_hand(s.cable).unwrap().total, 103_000);
    assert_eq!(balance_of(&s.business, "stock_loss"), 120_000);
    assert_eq!(balance_of(&s.business, "stock_gain"), -1_500);
    assert_eq!(
        balance_of(&s.business, "stock"),
        600_000 - 120_000 + 50_000 + 1_500
    );
    let counts = s.business.stock_counts().unwrap();
    assert_eq!(
        (counts[0].id, counts[0].memo.as_str()),
        (count, "جرد يناير")
    );
    let lines: Vec<_> = counts[0]
        .lines
        .iter()
        .map(|l| (l.expected, l.counted, l.difference, l.value))
        .collect();
    assert_eq!(
        lines,
        [
            (10_000, 8_000, -2_000, -120_000),
            (100_000, 103_000, 3_000, 1_500)
        ]
    );
    assert_eq!(
        code(s.count("2026-01-31", s.main, &[])),
        "count_needs_lines"
    );
    assert_eq!(
        code(s.count("2026-01-31", s.main, &[(s.router, 1), (s.router, 2)])),
        "quantity_invalid"
    );
}

#[test]
fn a_write_off_takes_stock_out_of_one_warehouse_with_a_reason() {
    let s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000, s.main);
    s.business
        .write_off_stock(&WriteOffInput {
            date: "2026-01-10".into(),
            warehouse_id: s.main,
            reason: "تالف من النقل".into(),
            lines: vec![UnitLine::base(s.router, 1_000)],
        })
        .unwrap();
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 9_000);
    assert_eq!(balance_of(&s.business, "stock_loss"), 60_000);
    let offs = s.business.write_offs().unwrap();
    assert_eq!(
        (offs[0].reason.as_str(), offs[0].value),
        ("تالف من النقل", 60_000)
    );
    let refused = |warehouse_id, reason: &str| {
        code(s.business.write_off_stock(&WriteOffInput {
            date: "2026-01-10".into(),
            warehouse_id,
            reason: reason.into(),
            lines: vec![UnitLine::base(s.router, 1_000)],
        }))
    };
    assert_eq!(refused(s.branch, "تالف"), "stock_insufficient");
    assert_eq!(refused(s.main, " "), "reason_required");
}

#[test]
fn two_lines_of_one_item_cannot_write_off_more_than_is_held() {
    let s = setup();
    s.buy("2026-01-01", s.router, 3, 60_000, s.main);
    let result = s.business.write_off_stock(&WriteOffInput {
        date: "2026-01-10".into(),
        warehouse_id: s.main,
        reason: "تالف".into(),
        lines: vec![
            UnitLine::base(s.router, 2_000),
            UnitLine::base(s.router, 2_000),
        ],
    });
    assert_eq!(code(result), "stock_insufficient");
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 3_000);
}

#[test]
fn items_below_their_minimum_are_listed_in_total_or_for_one_warehouse() {
    let s = setup();
    s.buy("2026-01-01", s.router, 3, 60_000, s.main);
    s.buy("2026-01-01", s.router, 4, 60_000, s.branch);
    s.buy("2026-01-01", s.cable, 100, 500, s.main);
    s.business
        .set_item_minimum(s.router, Some(5_000.0))
        .unwrap();
    s.business
        .set_item_minimum(s.cable, Some(50_000.0))
        .unwrap();
    assert!(s.business.low_stock(None).unwrap().is_empty());
    let main: Vec<_> = s
        .business
        .low_stock(Some(s.main))
        .unwrap()
        .into_iter()
        .map(|r| (r.name_ar, r.min_quantity, r.on_hand))
        .collect();
    assert_eq!(main, [("راوتر".to_string(), 5_000, 3_000)]);
    s.write_off("2026-01-05", s.router, 3, s.branch);
    let total: Vec<_> = s
        .business
        .low_stock(None)
        .unwrap()
        .into_iter()
        .map(|r| (r.name_ar, r.on_hand))
        .collect();
    assert_eq!(total, [("راوتر".to_string(), 4_000)]);
    s.business.set_item_minimum(s.router, None).unwrap();
    assert!(s.business.low_stock(None).unwrap().is_empty());
    assert_eq!(
        code(s.business.set_item_minimum(999, Some(1.0))),
        "item_not_found"
    );
}

#[test]
fn an_items_movements_with_a_running_balance_for_all_warehouses_or_one() {
    let s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000, s.main);
    s.business
        .transfer_stock(&TransferInput {
            date: "2026-01-02".into(),
            from: s.main,
            to: s.branch,
            memo: String::new(),
            lines: vec![UnitLine::base(s.router, 4_000)],
        })
        .unwrap();
    s.write_off("2026-01-03", s.router, 1, s.branch);
    let all: Vec<_> = s
        .business
        .item_movements(s.router, None)
        .unwrap()
        .into_iter()
        .map(|m| (m.source, m.warehouse_name, m.quantity, m.balance))
        .collect();
    let row = |a: &str, b: &str, q, bal| (a.to_string(), b.to_string(), q, bal);
    assert_eq!(
        all,
        [
            row("opening_stock", "المخزن الرئيسي", 10_000, 10_000),
            row("transfer", "المخزن الرئيسي", -4_000, 6_000),
            row("transfer", "فرع المعادي", 4_000, 10_000),
            row("write_off", "فرع المعادي", -1_000, 9_000),
        ]
    );
    let branch: Vec<_> = s
        .business
        .item_movements(s.router, Some(s.branch))
        .unwrap()
        .into_iter()
        .map(|m| (m.quantity, m.balance))
        .collect();
    assert_eq!(branch, [(4_000, 4_000), (-1_000, 3_000)]);
}

#[test]
fn back_dated_stock_reprices_the_write_offs_after_it() {
    let s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000, s.main);
    let off = s.write_off("2026-01-10", s.router, 10, s.main);
    // Received before the write-off but entered after: the write-off took 10 at 600.00; with 10
    // more at 900.00 held first, the average on the 10th is 750.00.
    s.buy("2026-01-05", s.router, 10, 90_000, s.main);
    assert_eq!(balance_of(&s.business, "stock_loss"), 750_000);
    assert_eq!(balance_of(&s.business, "stock"), 750_000);
    assert_eq!(s.business.stock_value(s.router).unwrap(), 750_000);
    assert_eq!(s.business.average_cost(s.router).unwrap(), 75_000);
    let offs = s.business.write_offs().unwrap();
    let repriced = offs.iter().find(|w| w.id == off).unwrap();
    assert_eq!(
        (repriced.value, repriced.lines[0].value),
        (750_000, 750_000)
    );
}

#[test]
fn a_back_dated_write_off_takes_the_average_as_it_was_on_its_date() {
    let s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000, s.main);
    s.buy("2026-01-20", s.router, 10, 90_000, s.main);
    s.write_off("2026-01-10", s.router, 5, s.main);
    assert_eq!(balance_of(&s.business, "stock_loss"), 300_000);
    assert_eq!(s.business.stock_value(s.router).unwrap(), 1_200_000);
    assert_eq!(s.business.write_offs().unwrap()[0].value, 300_000);
}

#[test]
fn a_back_dated_count_reprices_too_and_its_lines_follow() {
    let s = setup();
    s.buy("2026-01-01", s.router, 10, 60_000, s.main);
    let count = s.count("2026-01-10", s.main, &[(s.router, 8_000)]).unwrap();
    s.buy("2026-01-05", s.router, 10, 90_000, s.main);
    assert_eq!(balance_of(&s.business, "stock_loss"), 150_000);
    let counts = s.business.stock_counts().unwrap();
    let line = &counts.iter().find(|c| c.id == count).unwrap().lines[0];
    assert_eq!(line.value, -150_000);
    assert_eq!(
        balance_of(&s.business, "stock"),
        s.business.stock_value(s.router).unwrap()
    );
}

#[test]
fn random_receipts_write_offs_transfers_counts_and_back_dated_entries_keep_the_stock_account_equal_to_the_stock_value(
) {
    let mut seed: i64 = 20261121;
    let mut random = |n: i64| {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        seed % n
    };
    for run in 0..15 {
        let s = setup();
        let items = [s.router, s.cable];
        let warehouses = [s.main, s.branch];
        for _ in 0..30 {
            let date = format!("2026-0{}-{:02}", 1 + random(3), 1 + random(28));
            let item = items[random(2) as usize];
            let warehouse = warehouses[random(2) as usize];
            let held = s
                .business
                .stock_on_hand(item)
                .unwrap()
                .by_warehouse
                .iter()
                .find(|w| w.warehouse_id == warehouse)
                .map_or(0, |w| w.quantity);
            match random(5) {
                0 | 1 => s.buy(
                    &date,
                    item,
                    1 + random(9),
                    1_000 + random(90_000),
                    warehouse,
                ),
                2 => {
                    let units = 1 + random(5);
                    if held >= units * 1_000 {
                        s.write_off(&date, item, units, warehouse);
                    }
                }
                3 if held >= 1_000 => {
                    let other = *warehouses.iter().find(|w| **w != warehouse).unwrap();
                    s.business
                        .transfer_stock(&TransferInput {
                            date,
                            from: warehouse,
                            to: other,
                            memo: String::new(),
                            lines: vec![UnitLine::base(item, 1_000)],
                        })
                        .unwrap();
                }
                4 => {
                    let counted = (held - 1_000 + random(3) * 1_000).max(0);
                    s.count(&date, warehouse, &[(item, counted)]).unwrap();
                }
                _ => {}
            }
        }
        let value: i64 = items
            .iter()
            .map(|i| s.business.stock_value(*i).unwrap())
            .sum();
        assert_eq!(balance_of(&s.business, "stock"), value, "run {run}");
    }
}

/** The same back-dated checks with purchases and sales invoices, as the TypeScript tests run them. */
mod with_purchases_and_sales {
    use super::*;
    use manager_core::customers::CustomerInput;
    use manager_core::invoices::{InvoiceLineInput, SalesInvoiceInput};

    struct Trade {
        s: Setup,
        supplier: i64,
        customer: i64,
    }

    fn trade() -> Trade {
        let s = setup();
        let supplier = supplier(&s.business);
        let customer = s
            .business
            .add_customer(&CustomerInput {
                name: "شركة الأمل".into(),
                ..Default::default()
            })
            .unwrap();
        Trade {
            s,
            supplier,
            customer,
        }
    }

    impl Trade {
        fn buy(&self, date: &str, item: i64, units: i64, price: i64, warehouse: i64) {
            buy(
                &self.s.business,
                self.supplier,
                warehouse,
                date,
                &[(item, units * 1_000, price)],
            );
        }
        fn sell(&self, date: &str, item: i64, units: i64, warehouse: i64) {
            self.s
                .business
                .post_sales_invoice(&SalesInvoiceInput {
                    date: date.into(),
                    customer_id: self.customer,
                    warehouse_id: warehouse,
                    lines: vec![InvoiceLineInput::base(item, units * 1_000, 100_000)],
                    ..Default::default()
                })
                .unwrap();
        }
    }

    #[test]
    fn a_back_dated_purchase_reprices_the_sales_after_it_and_adjusts_cost_of_sales() {
        let t = trade();
        let (b, main, router) = (&t.s.business, t.s.main, t.s.router);
        t.buy("2026-01-01", router, 10, 60_000, main);
        t.sell("2026-01-10", router, 10, main);
        // Bought before the sale but entered after: with 10 more at 900.00 held first, the
        // average on the 10th is 750.00.
        t.buy("2026-01-05", router, 10, 90_000, main);
        assert_eq!(balance_of(b, "cost_of_goods_sold"), 750_000);
        assert_eq!(balance_of(b, "stock"), 750_000);
        assert_eq!(b.stock_value(router).unwrap(), 750_000);
        assert_eq!(b.average_cost(router).unwrap(), 75_000);
    }

    #[test]
    fn a_back_dated_sale_takes_the_average_as_it_was_on_its_date() {
        let t = trade();
        let (b, main, router) = (&t.s.business, t.s.main, t.s.router);
        t.buy("2026-01-01", router, 10, 60_000, main);
        t.buy("2026-01-20", router, 10, 90_000, main);
        t.sell("2026-01-10", router, 5, main);
        assert_eq!(balance_of(b, "cost_of_goods_sold"), 300_000);
        assert_eq!(b.stock_value(router).unwrap(), 1_200_000);
    }

    #[test]
    fn random_purchases_sales_transfers_counts_and_back_dated_entries_keep_stock_equal_to_its_value(
    ) {
        // The TypeScript test's generator, in JavaScript's floating-point arithmetic, so both
        // cores run the same sequence. With exact arithmetic the sequence differs and one run
        // goes wrong in both cores alike: see #87 (selling below zero with back-dated entries).
        let mut seed: f64 = 20261121.0;
        let mut random = |n: i64| {
            seed = (seed * 1_103_515_245.0 + 12_345.0) % 2_147_483_648.0;
            (seed % n as f64) as i64
        };
        for run in 0..15 {
            let t = trade();
            let items = [t.s.router, t.s.cable];
            let warehouses = [t.s.main, t.s.branch];
            for _ in 0..30 {
                let date = format!("2026-0{}-{:02}", 1 + random(3), 1 + random(28));
                let item = items[random(2) as usize];
                let warehouse = warehouses[random(2) as usize];
                let held =
                    t.s.business
                        .stock_on_hand(item)
                        .unwrap()
                        .by_warehouse
                        .iter()
                        .find(|w| w.warehouse_id == warehouse)
                        .map_or(0, |w| w.quantity);
                match random(5) {
                    0 | 1 => t.buy(
                        &date,
                        item,
                        1 + random(9),
                        1_000 + random(90_000),
                        warehouse,
                    ),
                    2 => t.sell(&date, item, 1 + random(5), warehouse),
                    3 if held >= 1_000 => {
                        let other = *warehouses.iter().find(|w| **w != warehouse).unwrap();
                        t.s.business
                            .transfer_stock(&TransferInput {
                                date,
                                from: warehouse,
                                to: other,
                                memo: String::new(),
                                lines: vec![UnitLine::base(item, 1_000)],
                            })
                            .unwrap();
                    }
                    4 => {
                        let counted = (held - 1_000 + random(3) * 1_000).max(0);
                        t.s.count(&date, warehouse, &[(item, counted)]).unwrap();
                    }
                    _ => {}
                }
            }
            let value: i64 = items
                .iter()
                .map(|i| t.s.business.stock_value(*i).unwrap())
                .sum();
            assert_eq!(balance_of(&t.s.business, "stock"), value, "run {run}");
        }
    }
}
