//! Ported from `src/core/warehouses.test.ts`.
mod common;

use common::*;
use manager_core::items::{ItemInput, PackUnitInput};
use manager_core::stock::{
    StockOnHand, Transfer, TransferInput, TransferLine, UnitLine, WarehouseQuantity,
};
use manager_core::users::NewUser;
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    router: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let router = business
        .add_item(&ItemInput {
            barcode: Some("111".into()),
            pack: Some(PackUnitInput {
                name: "كرتونة".into(),
                size: 10_000.0,
                sale_price: 1_400_000.0,
                ..Default::default()
            }),
            ..piece(&business, "راوتر", 150_000)
        })
        .unwrap();
    Setup {
        business,
        main,
        router,
    }
}

fn at(warehouse_id: i64, quantity: i64) -> WarehouseQuantity {
    WarehouseQuantity {
        warehouse_id,
        quantity,
    }
}

fn transfer(from: i64, to: i64, line: UnitLine) -> TransferInput {
    TransferInput {
        date: "2026-02-01".into(),
        from,
        to,
        memo: String::new(),
        lines: vec![line],
    }
}

#[test]
fn a_new_business_has_one_main_warehouse() {
    let s = setup();
    let warehouses = s.business.warehouses().unwrap();
    assert_eq!(warehouses.len(), 1);
    assert_eq!(
        (warehouses[0].name.as_str(), warehouses[0].active),
        ("المخزن الرئيسي", true)
    );
}

#[test]
fn warehouses_can_be_added_and_renamed_but_names_are_unique_and_required() {
    let s = setup();
    let id = s.business.add_warehouse("مخزن العتبة").unwrap();
    s.business.rename_warehouse(id, "مخزن وسط البلد").unwrap();
    let names: Vec<_> = s
        .business
        .warehouses()
        .unwrap()
        .into_iter()
        .map(|w| w.name)
        .collect();
    assert_eq!(names, ["المخزن الرئيسي", "مخزن وسط البلد"]);
    assert_eq!(
        code(s.business.add_warehouse("المخزن الرئيسي")),
        "warehouse_name_taken"
    );
    assert_eq!(
        code(s.business.add_warehouse(" ")),
        "warehouse_name_required"
    );
}

#[test]
fn a_warehouse_with_stock_cannot_be_stopped_an_empty_one_can() {
    let s = setup();
    let empty = s.business.add_warehouse("مخزن فاضي").unwrap();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 5_000, 120_000)])
        .unwrap();
    assert_eq!(
        code(s.business.deactivate_warehouse(s.main)),
        "warehouse_has_stock"
    );
    s.business.deactivate_warehouse(empty).unwrap();
    assert!(
        !s.business
            .warehouses()
            .unwrap()
            .iter()
            .find(|w| w.id == empty)
            .unwrap()
            .active
    );
}

#[test]
fn opening_stock_raises_quantity_in_its_warehouse_and_posts_its_value_against_opening_balances() {
    let s = setup();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 5_000, 120_000)])
        .unwrap();
    assert_eq!(
        s.business.stock_on_hand(s.router).unwrap(),
        StockOnHand {
            total: 5_000,
            by_warehouse: vec![at(s.main, 5_000)]
        }
    );
    let rows: Vec<_> = s
        .business
        .trial_balance("2026-01-01")
        .unwrap()
        .rows
        .into_iter()
        .map(|r| (r.code, r.debit, r.credit))
        .collect();
    assert_eq!(
        rows,
        [
            ("1300".to_string(), 600_000, 0),
            ("3900".to_string(), 0, 600_000)
        ]
    );
}

#[test]
fn unit_cost_must_be_whole_piastres_and_quantity_positive() {
    let s = setup();
    assert_eq!(
        code(
            s.business
                .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 0, 1)])
        ),
        "quantity_invalid"
    );
    let mut line = opening(s.router, 1_000, 0);
    line.unit_cost = 1.5;
    assert_eq!(
        code(s.business.post_opening_stock("2026-01-01", s.main, &[line])),
        "price_invalid"
    );
}

#[test]
fn moving_stock_changes_each_warehouses_quantity_but_not_the_total_or_the_books() {
    let s = setup();
    let branch = s.business.add_warehouse("مخزن العتبة").unwrap();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 30_000, 120_000)])
        .unwrap();
    let before = s.business.trial_balance("2026-12-31").unwrap();
    s.business
        .transfer_stock(&transfer(s.main, branch, UnitLine::pack(s.router, 2_000)))
        .unwrap();
    assert_eq!(
        s.business.stock_on_hand(s.router).unwrap(),
        StockOnHand {
            total: 30_000,
            by_warehouse: vec![at(s.main, 10_000), at(branch, 20_000)]
        }
    );
    assert_eq!(s.business.trial_balance("2026-12-31").unwrap(), before);
}

#[test]
fn a_transfer_needs_two_different_active_warehouses_and_enough_stock_in_the_source() {
    let s = setup();
    let branch = s.business.add_warehouse("مخزن العتبة").unwrap();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 3_000, 120_000)])
        .unwrap();
    let move_ = |from, to, quantity| {
        s.business
            .transfer_stock(&transfer(from, to, UnitLine::base(s.router, quantity)))
    };
    assert_eq!(
        code(move_(s.main, s.main, 1_000)),
        "transfer_same_warehouse"
    );
    assert_eq!(code(move_(s.main, branch, 4_000)), "stock_insufficient");
    assert_eq!(code(move_(s.main, 999, 1_000)), "warehouse_not_found");
    assert_eq!(
        s.business.stock_on_hand(s.router).unwrap().by_warehouse,
        [at(s.main, 3_000)]
    );
}

#[test]
fn a_pack_line_needs_an_item_that_has_a_pack_unit() {
    let s = setup();
    let branch = s.business.add_warehouse("مخزن العتبة").unwrap();
    let cable = s
        .business
        .add_item(&piece(&s.business, "كابل", 5_000))
        .unwrap();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(cable, 3_000, 3_000)])
        .unwrap();
    assert_eq!(
        code(
            s.business
                .transfer_stock(&transfer(s.main, branch, UnitLine::pack(cable, 1_000)))
        ),
        "item_has_no_pack"
    );
}

#[test]
fn a_cashier_cannot_move_stock_a_storekeeper_can() {
    let s = setup();
    let branch = s.business.add_warehouse("مخزن العتبة").unwrap();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 3_000, 120_000)])
        .unwrap();
    for (name, role) in [("سارة", "cashier"), ("حسن", "storekeeper")] {
        s.business
            .add_user(&NewUser {
                name: name.into(),
                role: role.into(),
                password: "123456".into(),
            })
            .unwrap();
    }
    let t = transfer(s.main, branch, UnitLine::base(s.router, 1_000));
    assert_eq!(
        code(
            s.business
                .sign_in("سارة", "123456")
                .unwrap()
                .transfer_stock(&t)
        ),
        "not_allowed"
    );
    s.business
        .sign_in("حسن", "123456")
        .unwrap()
        .transfer_stock(&t)
        .unwrap();
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 3_000);
}

#[test]
fn transfers_are_listed_newest_first_with_their_lines() {
    let s = setup();
    let branch = s.business.add_warehouse("مخزن العتبة").unwrap();
    s.business
        .post_opening_stock("2026-01-01", s.main, &[opening(s.router, 3_000, 120_000)])
        .unwrap();
    let id = s
        .business
        .transfer_stock(&TransferInput {
            memo: "للفرع".into(),
            ..transfer(s.main, branch, UnitLine::base(s.router, 1_000))
        })
        .unwrap();
    assert_eq!(
        s.business.transfers().unwrap(),
        [Transfer {
            id,
            date: "2026-02-01".into(),
            from: s.main,
            to: branch,
            memo: "للفرع".into(),
            lines: vec![TransferLine {
                item_id: s.router,
                quantity: 1_000
            }],
        }]
    );
}
