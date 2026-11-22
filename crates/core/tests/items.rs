//! Ported from `src/core/items.test.ts`, with the items test from `users.test.ts`.
mod common;

use common::*;
use manager_core::items::{
    Item, ItemChanges, ItemInput, ItemsOptions, PackUnit, PackUnitInput, TaxRateInput,
};
use manager_core::users::NewUser;
use manager_core::{Business, BusinessSettings};

fn shop_with(vat_registered: bool) -> Business {
    let settings = BusinessSettings {
        vat_registered,
        ..shop()
    };
    Business::create(":memory:", &settings, &manager()).unwrap()
}

fn dish_soap(business: &Business) -> ItemInput {
    ItemInput {
        name_ar: "منظف أطباق 1 لتر".into(),
        name_en: Some("Dish soap 1 L".into()),
        code: Some("A-100".into()),
        base_unit: "قطعة".into(),
        barcode: Some("6221000000035".into()),
        sale_price: 5_700.0,
        tax_code_id: tax_code(business, "standard"),
        egs_code: Some("EG-123-456".into()),
        ..Default::default()
    }
}

fn carton(barcode: &str, size: f64, price: f64) -> PackUnitInput {
    PackUnitInput {
        name: "كرتونة".into(),
        size,
        barcode: Some(barcode.into()),
        sale_price: price,
        wholesale_price: None,
    }
}

fn all(business: &Business) -> Vec<Item> {
    business.items(&ItemsOptions::default()).unwrap()
}

fn rate(from: &str, rate: f64) -> TaxRateInput {
    TaxRateInput {
        from: from.into(),
        rate,
    }
}

#[test]
fn a_new_business_has_standard_14_zero_rated_and_exempt_tax_codes() {
    let business = new_shop();
    let codes: Vec<_> = business
        .tax_codes()
        .unwrap()
        .into_iter()
        .map(|t| (t.kind, t.name))
        .collect();
    assert_eq!(
        codes,
        [
            ("standard".to_string(), "ضريبة قيمة مضافة 14%".to_string()),
            ("zero_rated".into(), "خاضع بنسبة صفر".into()),
            ("exempt".into(), "معفى".into()),
        ]
    );
    for (kind, expected) in [("standard", 1_400), ("zero_rated", 0), ("exempt", 0)] {
        assert_eq!(
            business
                .vat_rate(tax_code(&business, kind), "2026-11-20")
                .unwrap(),
            expected
        );
    }
}

#[test]
fn the_rate_used_is_the_one_in_force_on_the_document_date() {
    let business = new_shop();
    let standard = tax_code(&business, "standard");
    business
        .add_tax_rate(standard, &rate("2027-01-01", 1_500.0))
        .unwrap();
    assert_eq!(business.vat_rate(standard, "2026-12-31").unwrap(), 1_400);
    assert_eq!(business.vat_rate(standard, "2027-01-01").unwrap(), 1_500);
}

#[test]
fn when_the_business_is_not_vat_registered_every_rate_is_zero() {
    let business = shop_with(false);
    assert_eq!(
        business
            .vat_rate(tax_code(&business, "standard"), "2026-11-20")
            .unwrap(),
        0
    );
}

#[test]
fn a_rate_must_be_whole_basis_points_between_0_and_100_percent() {
    let business = new_shop();
    let standard = tax_code(&business, "standard");
    for r in [-1.0, 10_001.0, 14.5] {
        assert_eq!(
            code(business.add_tax_rate(standard, &rate("2027-01-01", r))),
            "tax_rate_invalid",
            "{r}"
        );
    }
    assert_eq!(
        code(business.add_tax_rate(standard, &rate("2027-02-30", 1_500.0))),
        "date_invalid"
    );
}

#[test]
fn the_owner_creates_an_item_and_sees_it_in_the_item_list() {
    let business = new_shop();
    let id = business.add_item(&dish_soap(&business)).unwrap();
    assert_eq!(
        all(&business),
        [Item {
            id,
            name_ar: "منظف أطباق 1 لتر".into(),
            name_en: "Dish soap 1 L".into(),
            code: Some("A-100".into()),
            base_unit: "قطعة".into(),
            barcode: Some("6221000000035".into()),
            sale_price: 5_700,
            wholesale_price: None,
            tax_code_id: tax_code(&business, "standard"),
            egs_code: "EG-123-456".into(),
            pack: None,
            serialised: false,
            warranty_months: 0,
            active: true,
        }]
    );
}

#[test]
fn an_item_can_have_a_pack_unit_with_its_own_barcode_and_price() {
    let business = new_shop();
    let id = business
        .add_item(&ItemInput {
            pack: Some(carton("16221000000035", 12_000.0, 64_800.0)),
            ..dish_soap(&business)
        })
        .unwrap();
    let item = all(&business).into_iter().find(|i| i.id == id).unwrap();
    assert_eq!(
        item.pack,
        Some(PackUnit {
            name: "كرتونة".into(),
            size: 12_000,
            barcode: Some("16221000000035".into()),
            sale_price: 64_800,
            wholesale_price: None,
        })
    );
}

#[test]
fn scanning_a_barcode_finds_the_item_and_the_unit_with_its_size_in_base_units() {
    let business = new_shop();
    let id = business
        .add_item(&ItemInput {
            pack: Some(carton("16221000000035", 12_000.0, 64_800.0)),
            ..dish_soap(&business)
        })
        .unwrap();
    let base = business.find_by_barcode("6221000000035").unwrap().unwrap();
    assert_eq!(
        (
            base.item_id,
            base.unit.as_str(),
            base.unit_name.as_str(),
            base.quantity,
            base.sale_price
        ),
        (id, "base", "قطعة", 1_000, 5_700)
    );
    let pack = business.find_by_barcode("16221000000035").unwrap().unwrap();
    assert_eq!(
        (
            pack.item_id,
            pack.unit.as_str(),
            pack.unit_name.as_str(),
            pack.quantity,
            pack.sale_price
        ),
        (id, "pack", "كرتونة", 12_000, 64_800)
    );
    assert_eq!(business.find_by_barcode("0000").unwrap(), None);
}

#[test]
fn a_barcode_cannot_be_used_twice_across_items_and_pack_units() {
    let business = new_shop();
    business
        .add_item(&ItemInput {
            pack: Some(carton("16221000000035", 12_000.0, 64_800.0)),
            ..dish_soap(&business)
        })
        .unwrap();
    let other = ItemInput {
        code: Some("A-200".into()),
        name_ar: "صابون".into(),
        ..dish_soap(&business)
    };
    for barcode in ["6221000000035", "16221000000035"] {
        assert_eq!(
            code(business.add_item(&ItemInput {
                barcode: Some(barcode.into()),
                ..other.clone()
            })),
            "barcode_taken"
        );
    }
    assert_eq!(
        code(business.add_item(&ItemInput {
            barcode: Some("1".into()),
            pack: Some(carton("1", 6_000.0, 1.0)),
            ..other
        })),
        "barcode_taken"
    );
    assert_eq!(all(&business).len(), 1);
}

#[test]
fn two_items_cannot_share_a_code() {
    let business = new_shop();
    business.add_item(&dish_soap(&business)).unwrap();
    assert_eq!(
        code(business.add_item(&ItemInput {
            barcode: Some("999".into()),
            ..dish_soap(&business)
        })),
        "item_code_taken"
    );
}

/** Why, the change to a good item, and the refusal. */
type BadItem<'a> = (&'a str, fn(ItemInput) -> ItemInput, &'a str);

#[test]
fn an_item_with_bad_details_is_refused() {
    let cases: Vec<BadItem> = vec![
        (
            "no Arabic name",
            |i| ItemInput {
                name_ar: " ".into(),
                ..i
            },
            "item_name_required",
        ),
        (
            "no base unit",
            |i| ItemInput {
                base_unit: "".into(),
                ..i
            },
            "item_unit_required",
        ),
        (
            "a price in fractions of a piastre",
            |i| ItemInput {
                sale_price: 10.5,
                ..i
            },
            "price_invalid",
        ),
        (
            "a negative price",
            |i| ItemInput {
                sale_price: -1.0,
                ..i
            },
            "price_invalid",
        ),
        (
            "an unknown tax code",
            |i| ItemInput {
                tax_code_id: 9_999,
                ..i
            },
            "tax_code_not_found",
        ),
        (
            "a pack holding no units",
            |i| ItemInput {
                pack: Some(carton("", 0.0, 1.0)),
                ..i
            },
            "pack_size_invalid",
        ),
        (
            "a pack with a fractional size",
            |i| ItemInput {
                pack: Some(carton("", 1.5, 1.0)),
                ..i
            },
            "pack_size_invalid",
        ),
        (
            "a pack without a name",
            |i| ItemInput {
                pack: Some(PackUnitInput {
                    name: "".into(),
                    ..carton("", 6_000.0, 1.0)
                }),
                ..i
            },
            "item_unit_required",
        ),
    ];
    for (why, change, expected) in cases {
        let business = new_shop();
        assert_eq!(
            code(business.add_item(&change(dish_soap(&business)))),
            expected,
            "{why}"
        );
        assert!(all(&business).is_empty(), "{why}");
    }
}

#[test]
fn an_item_without_a_barcode_code_or_english_name_is_fine() {
    let business = new_shop();
    let id = business
        .add_item(&ItemInput {
            barcode: Some("".into()),
            code: Some("".into()),
            name_en: Some("".into()),
            ..dish_soap(&business)
        })
        .unwrap();
    let item = all(&business).into_iter().find(|i| i.id == id).unwrap();
    assert_eq!(
        (item.barcode, item.code, item.name_en.as_str()),
        (None, None, "")
    );
}

#[test]
fn an_item_can_be_edited_and_its_pack_unit_added_or_removed() {
    let business = new_shop();
    let id = business.add_item(&dish_soap(&business)).unwrap();
    business
        .update_item(
            id,
            &ItemChanges {
                sale_price: Some(6_000.0),
                pack: Some(Some(carton("1622", 12_000.0, 70_000.0))),
                ..Default::default()
            },
        )
        .unwrap();
    let item = &all(&business)[0];
    assert_eq!(item.sale_price, 6_000);
    assert_eq!(item.pack.as_ref().unwrap().barcode.as_deref(), Some("1622"));
    assert_eq!(
        business.find_by_barcode("1622").unwrap().unwrap().unit,
        "pack"
    );

    business
        .update_item(
            id,
            &ItemChanges {
                pack: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(all(&business)[0].pack, None);
    assert_eq!(business.find_by_barcode("1622").unwrap(), None);
}

#[test]
fn an_item_can_keep_its_own_barcode_when_edited_but_not_take_anothers() {
    let business = new_shop();
    let first = business.add_item(&dish_soap(&business)).unwrap();
    business
        .add_item(&ItemInput {
            code: Some("A-200".into()),
            barcode: Some("777".into()),
            ..dish_soap(&business)
        })
        .unwrap();
    business
        .update_item(
            first,
            &ItemChanges {
                barcode: Some("6221000000035".into()),
                name_ar: Some("منظف أطباق".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        code(business.update_item(
            first,
            &ItemChanges {
                barcode: Some("777".into()),
                ..Default::default()
            }
        )),
        "barcode_taken"
    );
}

#[test]
fn a_deactivated_item_stays_on_record_but_is_hidden_and_cant_be_scanned() {
    let business = new_shop();
    let id = business.add_item(&dish_soap(&business)).unwrap();
    business.deactivate_item(id).unwrap();
    assert!(all(&business).is_empty());
    let with_inactive = business
        .items(&ItemsOptions {
            include_inactive: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        with_inactive
            .iter()
            .map(|i| (i.id, i.active))
            .collect::<Vec<_>>(),
        [(id, false)]
    );
    assert_eq!(business.find_by_barcode("6221000000035").unwrap(), None);
    business.reactivate_item(id).unwrap();
    assert_eq!(
        business
            .find_by_barcode("6221000000035")
            .unwrap()
            .unwrap()
            .item_id,
        id
    );
}

#[test]
fn editing_an_item_that_doesnt_exist_is_refused() {
    assert_eq!(
        code(new_shop().update_item(
            42,
            &ItemChanges {
                sale_price: Some(1.0),
                ..Default::default()
            }
        )),
        "item_not_found"
    );
}

#[test]
fn searching_finds_arabic_or_english_names_codes_and_barcodes() {
    for (search, found) in [
        ("أطباق", true),
        ("اطباق", true),
        ("dish", true),
        ("DISH", true),
        ("A-100", true),
        ("6221000000035", true),
        ("أرز", false),
    ] {
        let business = new_shop();
        business.add_item(&dish_soap(&business)).unwrap();
        let hits = business
            .items(&ItemsOptions {
                search: Some(search.into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), usize::from(found), "{search}");
    }
}

#[test]
fn a_storekeeper_manages_items_a_cashier_can_only_look_them_up() {
    let as_role = |role: &str| {
        let business = new_shop();
        business
            .add_user(&NewUser {
                name: "موظف".into(),
                role: role.into(),
                password: "123456".into(),
            })
            .unwrap();
        let user = business.sign_in("موظف", "123456").unwrap();
        (business, user)
    };
    let (manager, storekeeper) = as_role("storekeeper");
    let item = ItemInput {
        barcode: Some("111".into()),
        ..piece(&manager, "راوتر", 150_000)
    };
    storekeeper.add_item(&item).unwrap();

    let (manager, cashier) = as_role("cashier");
    manager.add_item(&item).unwrap();
    assert_eq!(
        cashier.find_by_barcode("111").unwrap().unwrap().name_ar,
        "راوتر"
    );
    assert_eq!(
        code(cashier.add_item(&ItemInput {
            barcode: Some("222".into()),
            ..item
        })),
        "not_allowed"
    );
}

#[test]
fn the_screens_reach_items_through_call() {
    let business = new_shop();
    let tax = tax_code(&business, "standard");
    let id = business
        .call(
            "addItem",
            &[serde_json::json!({ "nameAr": "شاي", "baseUnit": "علبة", "salePrice": 2500, "taxCodeId": tax,
                "pack": { "name": "كرتونة", "size": 24000, "salePrice": 58000 } })],
        )
        .unwrap();
    let items = business.call("items", &[]).unwrap();
    assert_eq!(items[0]["id"], id);
    assert_eq!(items[0]["pack"]["wholesalePrice"], serde_json::Value::Null);
    business
        .call(
            "updateItem",
            &[
                id.clone(),
                serde_json::json!({ "pack": null, "wholesalePrice": 2300 }),
            ],
        )
        .unwrap();
    let items = business
        .call("items", &[serde_json::json!({ "search": "شاى" })])
        .unwrap();
    assert_eq!(items[0]["pack"], serde_json::Value::Null);
    assert_eq!(items[0]["wholesalePrice"], 2300);
    let log = business.audit_log().unwrap();
    assert!(
        log[1].detail.contains("\"salePrice\":2500"),
        "{}",
        log[1].detail
    );
}
