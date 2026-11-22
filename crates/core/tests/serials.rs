//! The parts of `src/core/serials.test.ts` that need only opening stock, transfers, counts and
//! write-offs. Serials on purchases, sales and returns move with those slices (#75 to #77).
mod common;

use common::*;
use manager_core::inventory::{CountedLine, StockCountInput, WriteOffInput};
use manager_core::items::{ItemInput, ItemsOptions};
use manager_core::serials::{add_months, SerialSettings};
use manager_core::stock::{OpeningStockLine, TransferInput, UnitLine};
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    branch: i64,
    laptop: i64,
    cable: i64,
}

fn serials(months: f64) -> SerialSettings {
    SerialSettings {
        serialised: true,
        warranty_months: months,
    }
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let branch = business.add_warehouse("فرع مدينة نصر").unwrap();
    let laptop = business
        .add_item(&ItemInput {
            barcode: Some("6221000000500".into()),
            ..piece(&business, "لابتوب", 2_000_000)
        })
        .unwrap();
    business.set_item_serials(laptop, &serials(12.0)).unwrap();
    let cable = business
        .add_item(&ItemInput {
            base_unit: "متر".into(),
            ..piece(&business, "كابل", 1_000)
        })
        .unwrap();
    Setup {
        business,
        main,
        branch,
        laptop,
        cable,
    }
}

impl Setup {
    fn receive(&self, serials: &[&str]) -> manager_core::Result<i64> {
        self.business.post_opening_stock(
            "2026-01-10",
            self.main,
            &[OpeningStockLine {
                item_id: self.laptop,
                quantity: serials.len() as f64 * 1_000.0,
                unit_cost: 1_500_000.0,
                serials: Some(serials.iter().map(|s| s.to_string()).collect()),
            }],
        )
    }
    fn transfer(&self, from: i64, to: i64, serial: &str) -> manager_core::Result<i64> {
        self.business.transfer_stock(&TransferInput {
            date: "2026-02-01".into(),
            from,
            to,
            memo: String::new(),
            lines: vec![UnitLine::base(self.laptop, 1_000).with_serials(&[serial])],
        })
    }
}

#[test]
fn stock_received_needs_exactly_one_different_serial_per_whole_unit() {
    let s = setup();
    s.receive(&["A1"]).unwrap();
    let line = |quantity: f64, serials: &[&str]| OpeningStockLine {
        item_id: s.laptop,
        quantity,
        unit_cost: 100.0,
        serials: Some(serials.iter().map(|x| x.to_string()).collect()),
    };
    for (quantity, given) in [(2_000.0, &["D1"][..]), (1_500.0, &["E1", "E2"][..])] {
        assert_eq!(
            code(
                s.business
                    .post_opening_stock("2026-01-10", s.main, &[line(quantity, given)])
            ),
            "serials_required"
        );
    }
    assert_eq!(code(s.receive(&["B1", "B1"])), "serials_required");
    assert_eq!(code(s.receive(&["A1"])), "serial_in_stock");
    let cable = OpeningStockLine {
        item_id: s.cable,
        ..line(1_000.0, &["C1"])
    };
    assert_eq!(
        code(
            s.business
                .post_opening_stock("2026-01-10", s.main, &[cable])
        ),
        "serials_not_expected"
    );
    assert_eq!(s.business.stock_on_hand(s.laptop).unwrap().total, 1_000);
}

#[test]
fn transfers_move_each_serial_between_warehouses() {
    let s = setup();
    s.receive(&["SN-1", "SN-2", "SN-3"]).unwrap();
    s.transfer(s.main, s.branch, "SN-3").unwrap();
    let found = &s.business.find_serial(" SN-3 ", "2026-02-02").unwrap()[0];
    assert_eq!(
        (
            found.in_stock,
            found.warehouse_id,
            &found.purchase,
            &found.sale
        ),
        (true, Some(s.branch), &None, &None)
    );
    assert_eq!(
        code(s.transfer(s.main, s.branch, "SN-3")),
        "serial_not_in_stock"
    );
    assert_eq!(
        code(s.transfer(s.main, s.branch, "NOPE")),
        "serial_not_in_stock"
    );
    s.transfer(s.branch, s.main, "SN-3").unwrap();
    assert_eq!(
        s.business.find_serial("SN-3", "2026-02-02").unwrap()[0].warehouse_id,
        Some(s.main)
    );
}

#[test]
fn a_written_off_unit_leaves_stock_and_a_serialised_item_is_not_counted_by_quantity() {
    let s = setup();
    s.receive(&["SN-1", "SN-2"]).unwrap();
    let off = |serial: &str| {
        s.business.write_off_stock(&WriteOffInput {
            date: "2026-02-01".into(),
            warehouse_id: s.main,
            reason: "كسر".into(),
            lines: vec![UnitLine::base(s.laptop, 1_000).with_serials(&[serial])],
        })
    };
    off("SN-2").unwrap();
    assert_eq!(code(off("SN-2")), "serial_not_in_stock");
    let found = &s.business.find_serial("SN-2", "2026-02-02").unwrap()[0];
    assert_eq!((found.in_stock, found.warehouse_id), (false, None));
    assert_eq!(s.business.stock_on_hand(s.laptop).unwrap().total, 1_000);
    let count = |counted: f64| {
        s.business.post_stock_count(&StockCountInput {
            date: "2026-02-02".into(),
            warehouse_id: s.main,
            memo: String::new(),
            lines: vec![CountedLine {
                item_id: s.laptop,
                counted,
            }],
        })
    };
    assert_eq!(code(count(0.0)), "serials_required");
    count(1_000.0).unwrap();
}

#[test]
fn serial_tracking_can_be_switched_only_while_no_unserialised_stock_is_held() {
    let s = setup();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.cable, 5_000, 100)])
        .unwrap();
    assert_eq!(
        code(s.business.set_item_serials(s.cable, &serials(0.0))),
        "serial_setting_locked"
    );
    s.receive(&["SN-1"]).unwrap();
    let off = SerialSettings {
        serialised: false,
        warranty_months: 0.0,
    };
    assert_eq!(
        code(s.business.set_item_serials(s.laptop, &off)),
        "serial_setting_locked"
    );
    s.business
        .set_item_serials(s.laptop, &serials(24.0))
        .unwrap();
    let laptop = s
        .business
        .items(&ItemsOptions::default())
        .unwrap()
        .into_iter()
        .find(|i| i.id == s.laptop)
        .unwrap();
    assert_eq!((laptop.serialised, laptop.warranty_months), (true, 24));
    for months in [-1.0, 121.0, 1.5] {
        assert_eq!(
            code(s.business.set_item_serials(s.laptop, &serials(months))),
            "warranty_invalid"
        );
    }
    assert_eq!(
        code(s.business.set_item_serials(999, &serials(0.0))),
        "item_not_found"
    );
}

#[test]
fn warranty_months_land_on_the_same_day_or_the_months_last_day() {
    assert_eq!(add_months("2026-03-31", 12), "2027-03-31");
    assert_eq!(add_months("2026-01-31", 1), "2026-02-28");
    assert_eq!(add_months("2027-11-30", 3), "2028-02-29");
}
