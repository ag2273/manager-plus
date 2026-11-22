//! Ported from `src/core/purchases.test.ts`.
mod common;

use common::*;
use manager_core::items::{ItemInput, PackUnitInput};
use manager_core::purchases::{
    PurchaseInvoiceInput, PurchaseLineInput, SupplierChanges, SupplierInput,
};
use manager_core::users::NewUser;
use manager_core::{Business, BusinessSettings};

pub struct Setup {
    business: Business,
    main: i64,
    router: i64,
    book: i64,
    supplier: i64,
}

fn setup_with(vat_registered: bool) -> Setup {
    let settings = BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        vat_registered,
        ..shop()
    };
    let business = Business::create(":memory:", &settings, &manager()).unwrap();
    let main = main_warehouse(&business);
    let router = business
        .add_item(&ItemInput {
            pack: Some(PackUnitInput {
                name: "كرتونة".into(),
                size: 12_000.0,
                sale_price: 1_700_000.0,
                ..Default::default()
            }),
            ..piece(&business, "راوتر", 150_000)
        })
        .unwrap();
    let book = business
        .add_item(&ItemInput {
            tax_code_id: tax_code(&business, "exempt"),
            ..piece(&business, "كتاب", 5_000)
        })
        .unwrap();
    let supplier = business
        .add_supplier(&supplier_named("شركة الشبكات المتحدة", "0100", "123456789"))
        .unwrap();
    Setup {
        business,
        main,
        router,
        book,
        supplier,
    }
}

fn setup() -> Setup {
    setup_with(true)
}

fn supplier_named(name: &str, phone: &str, trn: &str) -> SupplierInput {
    SupplierInput {
        name: name.into(),
        phone: phone.into(),
        tax_registration_number: trn.into(),
        ..Default::default()
    }
}

fn line(item_id: i64, unit: &str, quantity: i64, unit_price: i64) -> PurchaseLineInput {
    PurchaseLineInput {
        item_id,
        unit: unit.into(),
        quantity: quantity as f64,
        unit_price: unit_price as f64,
        serials: None,
    }
}

impl Setup {
    fn invoice(&self, date: &str, lines: Vec<PurchaseLineInput>) -> PurchaseInvoiceInput {
        PurchaseInvoiceInput {
            date: date.into(),
            supplier_id: self.supplier,
            warehouse_id: self.main,
            reference: String::new(),
            rate: None,
            lines,
        }
    }
}

#[test]
fn suppliers_are_added_listed_and_renamed_names_are_unique_and_required() {
    let s = setup();
    let other = s
        .business
        .add_supplier(&supplier_named("مؤسسة الحاسب", "", ""))
        .unwrap();
    s.business
        .update_supplier(
            other,
            &SupplierChanges {
                name: Some("مؤسسة الحاسب الآلي".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let suppliers = s.business.suppliers().unwrap();
    let names: Vec<_> = suppliers.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["شركة الشبكات المتحدة", "مؤسسة الحاسب الآلي"]);
    let first = &suppliers[0];
    assert_eq!(
        (
            first.id,
            first.phone.as_str(),
            first.tax_registration_number.as_str(),
            first.active
        ),
        (s.supplier, "0100", "123456789", true)
    );
    assert_eq!(
        code(
            s.business
                .add_supplier(&supplier_named("مؤسسة الحاسب الآلي", "", ""))
        ),
        "supplier_name_taken"
    );
    assert_eq!(
        code(s.business.add_supplier(&supplier_named(" ", "", ""))),
        "supplier_name_required"
    );
    assert_eq!(
        code(s.business.add_supplier(&supplier_named("س", "", "12"))),
        "tax_registration_number_invalid"
    );
    assert_eq!(
        code(s.business.add_supplier(&SupplierInput {
            currency: Some("GBP".into()),
            ..supplier_named("س", "", "")
        })),
        "currency_invalid"
    );
}

#[test]
fn a_stopped_supplier_cannot_be_bought_from() {
    let s = setup();
    s.business.deactivate_supplier(s.supplier).unwrap();
    assert_eq!(
        code(s.business.post_purchase_invoice(
            &s.invoice("2026-03-01", vec![line(s.router, "base", 1_000, 100_000)])
        )),
        "supplier_inactive"
    );
}

#[test]
fn posting_raises_stock_and_posts_dr_stock_dr_input_vat_cr_payables_for_the_supplier() {
    let s = setup();
    let id = s
        .business
        .post_purchase_invoice(&PurchaseInvoiceInput {
            reference: "INV-77".into(),
            ..s.invoice(
                "2026-03-01",
                vec![
                    line(s.router, "base", 10_000, 100_000),
                    line(s.book, "base", 3_000, 4_000),
                ],
            )
        })
        .unwrap();
    // Router: 10 × 1,000.00 = 10,000.00 net, 14% VAT = 1,400.00. Book: exempt, 120.00.
    assert_eq!(balance_of(&s.business, "stock"), 1_000_000 + 12_000);
    assert_eq!(balance_of(&s.business, "input_vat"), 140_000);
    assert_eq!(balance_of(&s.business, "payables"), -(1_012_000 + 140_000));
    assert_eq!(s.business.supplier_balance(s.supplier).unwrap(), 1_152_000);
    let on_hand = s.business.stock_on_hand(s.router).unwrap();
    assert_eq!(on_hand.total, 10_000);
    assert_eq!(on_hand.by_warehouse[0].warehouse_id, s.main);
    let invoices = s.business.purchase_invoices().unwrap();
    assert_eq!(invoices.len(), 1);
    let i = &invoices[0];
    assert_eq!(
        (
            i.id,
            i.date.as_str(),
            i.supplier_id,
            i.reference.as_str(),
            i.net,
            i.vat,
            i.total,
            i.posted_by.as_str()
        ),
        (
            id,
            "2026-03-01",
            s.supplier,
            "INV-77",
            1_012_000,
            140_000,
            1_152_000,
            "أيمن"
        )
    );
}

#[test]
fn vat_is_rounded_half_up_on_each_line() {
    let s = setup();
    // 3 × 0.25 = 0.75 net; 14% of 75 piastres = 10.5 → 11.
    s.business
        .post_purchase_invoice(&s.invoice("2026-03-01", vec![line(s.router, "base", 3_000, 25)]))
        .unwrap();
    assert_eq!(balance_of(&s.business, "input_vat"), 11);
    let l = &s.business.purchase_invoices().unwrap()[0].lines[0];
    assert_eq!((l.net, l.vat_rate, l.vat), (75, 1_400, 11));
}

#[test]
fn a_business_that_is_not_vat_registered_puts_the_whole_cost_into_stock() {
    let s = setup_with(false);
    s.business
        .post_purchase_invoice(
            &s.invoice("2026-03-01", vec![line(s.router, "base", 1_000, 100_000)]),
        )
        .unwrap();
    assert_eq!(balance_of(&s.business, "input_vat"), 0);
    assert_eq!(s.business.supplier_balance(s.supplier).unwrap(), 100_000);
}

#[test]
fn weighted_average_cost_updates_on_each_purchase_counting_packs_in_base_units() {
    let s = setup();
    let other = s.business.add_warehouse("مخزن المعرض").unwrap();
    s.business
        .post_purchase_invoice(
            &s.invoice("2026-03-01", vec![line(s.router, "base", 10_000, 100_000)]),
        )
        .unwrap();
    assert_eq!(s.business.average_cost(s.router).unwrap(), 100_000);
    // 5 cartons of 12 at 10,800.00 each: 60 pieces for 54,000.00, into another warehouse.
    s.business
        .post_purchase_invoice(&PurchaseInvoiceInput {
            warehouse_id: other,
            ..s.invoice("2026-03-05", vec![line(s.router, "pack", 5_000, 1_080_000)])
        })
        .unwrap();
    // (10 × 1,000.00 + 54,000.00) / 70 = 914.2857… → 914.29
    assert_eq!(s.business.average_cost(s.router).unwrap(), 91_429);
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 70_000);
    assert_eq!(balance_of(&s.business, "stock"), 6_400_000);
}

#[test]
fn lines_can_be_priced_before_posting_and_pricing_writes_nothing() {
    let s = setup();
    let priced = s
        .business
        .price_purchase(
            "2026-03-01",
            &[
                line(s.router, "pack", 2_000, 1_080_000),
                line(s.book, "base", 1_000, 4_000),
            ],
            None,
        )
        .unwrap();
    let lines: Vec<_> = priced
        .lines
        .iter()
        .map(|l| (l.net, l.vat_rate, l.vat))
        .collect();
    assert_eq!(lines, [(2_160_000, 1_400, 302_400), (4_000, 0, 0)]);
    assert_eq!(
        (priced.net, priced.vat, priced.total, priced.total_egp),
        (2_164_000, 302_400, 2_466_400, 2_466_400)
    );
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 0);
}

#[test]
fn an_item_never_bought_has_no_average_cost() {
    let s = setup();
    assert_eq!(s.business.average_cost(s.book).unwrap(), 0);
}

#[test]
fn bad_invoices_are_refused_and_nothing_is_written() {
    let s = setup();
    let post = |invoice: PurchaseInvoiceInput| code(s.business.post_purchase_invoice(&invoice));
    assert_eq!(post(s.invoice("2026-03-01", vec![])), "invoice_needs_lines");
    assert_eq!(
        post(s.invoice("2026-03-01", vec![line(s.router, "base", 1_000, -1)])),
        "price_invalid"
    );
    assert_eq!(
        post(s.invoice("2026-03-01", vec![line(s.book, "pack", 1_000, 1)])),
        "item_has_no_pack"
    );
    assert_eq!(
        post(PurchaseInvoiceInput {
            supplier_id: 999,
            ..s.invoice("2026-03-01", vec![line(s.router, "base", 1_000, 1)])
        }),
        "supplier_not_found"
    );
    assert_eq!(
        post(s.invoice(
            "2026-03-01",
            vec![
                line(s.router, "base", 1_000, 100),
                line(s.router, "base", 0, 100)
            ]
        )),
        "quantity_invalid"
    );
    assert_eq!(
        post(s.invoice("2026-03-01", vec![line(s.router, "base", 1_000, 0)])),
        "invoice_total_zero"
    );
    assert!(s.business.purchase_invoices().unwrap().is_empty());
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 0);
    assert_eq!(balance_of(&s.business, "stock"), 0);
}

#[test]
fn a_cashier_may_not_post_purchases_a_storekeeper_may() {
    let s = setup();
    for (name, role) in [("سارة", "cashier"), ("محمود", "storekeeper")] {
        s.business
            .add_user(&NewUser {
                name: name.into(),
                role: role.into(),
                password: "123456".into(),
            })
            .unwrap();
    }
    let invoice = s.invoice("2026-03-01", vec![line(s.router, "base", 1_000, 100)]);
    assert_eq!(
        code(
            s.business
                .sign_in("سارة", "123456")
                .unwrap()
                .post_purchase_invoice(&invoice)
        ),
        "not_allowed"
    );
    s.business
        .sign_in("محمود", "123456")
        .unwrap()
        .post_purchase_invoice(&invoice)
        .unwrap();
    assert_eq!(
        s.business.purchase_invoices().unwrap()[0].posted_by,
        "محمود"
    );
}
