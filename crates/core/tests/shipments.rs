//! Ported from `src/core/shipments.test.ts`.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::invoices::{InvoiceLineInput, SalesInvoiceInput};
use manager_core::purchases::{PurchaseInvoiceInput, PurchaseLineInput, SupplierInput};
use manager_core::shipments::{ImportShipmentInput, ShipmentCostInput};
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    router: i64,
    sw: i64,
    shenzhen: i64,
    customs: i64,
    freight: i64,
    customer: i64,
    invoice: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let router = business
        .add_item(&piece(&business, "راوتر", 900_000))
        .unwrap();
    let sw = business
        .add_item(&piece(&business, "سويتش", 200_000))
        .unwrap();
    let supplier = |name: &str, currency: Option<&str>| {
        business
            .add_supplier(&SupplierInput {
                name: name.into(),
                currency: currency.map(String::from),
                ..Default::default()
            })
            .unwrap()
    };
    let shenzhen = supplier("Shenzhen Networks", Some("USD"));
    let customs = supplier("مصلحة الجمارك", None);
    let freight = supplier("شركة الشحن السريع", None);
    let customer = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            ..Default::default()
        })
        .unwrap();
    let line = |item_id, quantity: f64, unit_price: f64| PurchaseLineInput {
        item_id,
        unit: "base".into(),
        quantity,
        unit_price,
        serials: None,
    };
    // 10 routers at USD 100 (EGP 50,000) and 20 switches at USD 25 (EGP 25,000), at 50.00.
    let invoice = business
        .post_purchase_invoice(&PurchaseInvoiceInput {
            date: "2026-03-01".into(),
            supplier_id: shenzhen,
            warehouse_id: main,
            reference: "SZ-7".into(),
            rate: Some(50_000_000.0),
            lines: vec![
                line(router, 10_000.0, 10_000.0),
                line(sw, 20_000.0, 2_500.0),
            ],
        })
        .unwrap();
    Setup {
        business,
        main,
        router,
        sw,
        shenzhen,
        customs,
        freight,
        customer,
        invoice,
    }
}

fn cost(kind: &str, payee_id: i64, amount: i64, vat: i64) -> ShipmentCostInput {
    ShipmentCostInput {
        kind: kind.into(),
        payee_id,
        amount: amount as f64,
        vat: vat as f64,
    }
}

impl Setup {
    fn costs(&self) -> Vec<ShipmentCostInput> {
        vec![
            cost("customs_duty", self.customs, 750_000, 1_155_000),
            cost("freight", self.freight, 300_000, 0),
        ]
    }
    fn shipment(&self) -> ImportShipmentInput {
        ImportShipmentInput {
            date: "2026-03-10".into(),
            reference: String::new(),
            purchase_invoice_ids: vec![self.invoice],
            spread_by: "value".into(),
            costs: self.costs(),
        }
    }
    fn post(&self, input: ImportShipmentInput) -> manager_core::Result<i64> {
        self.business.post_import_shipment(&input)
    }
}

#[test]
fn customs_and_freight_are_spread_by_value_into_the_items_cost_and_customs_vat_is_input_vat() {
    let s = setup();
    s.post(ImportShipmentInput {
        reference: "BL-1".into(),
        ..s.shipment()
    })
    .unwrap();

    // EGP 10,500 of costs over goods of 50,000 + 25,000: routers take 7,000, switches 3,500.
    assert_eq!(balance_of(&s.business, "stock"), 7_500_000 + 1_050_000);
    assert_eq!(balance_of(&s.business, "input_vat"), 1_155_000);
    assert_eq!(s.business.supplier_balance(s.customs).unwrap(), 1_905_000);
    assert_eq!(s.business.supplier_balance(s.freight).unwrap(), 300_000);
    assert_eq!(s.business.average_cost(s.router).unwrap(), 570_000);
    assert_eq!(s.business.average_cost(s.sw).unwrap(), 142_500);

    let shipment = &s.business.import_shipments().unwrap()[0];
    assert_eq!(
        (
            shipment.number,
            shipment.reference.as_str(),
            shipment.spread_by.as_str(),
            shipment.goods,
            shipment.costs,
            shipment.vat
        ),
        (1, "BL-1", "value", 7_500_000, 1_050_000, 1_155_000)
    );
    let lines: Vec<(&str, i64, i64, i64, i64)> = shipment
        .lines
        .iter()
        .map(|l| {
            (
                l.name_ar.as_str(),
                l.quantity,
                l.goods,
                l.allocated,
                l.landed_unit_cost,
            )
        })
        .collect();
    assert_eq!(
        lines,
        vec![
            ("راوتر", 10_000, 5_000_000, 700_000, 570_000),
            ("سويتش", 20_000, 2_500_000, 350_000, 142_500),
        ]
    );
    assert_eq!(shipment.purchase_invoice_ids, vec![s.invoice]);
    assert_eq!(shipment.cost_lines[0].payee, "مصلحة الجمارك");
}

#[test]
fn spread_by_quantity_puts_the_rounding_remainder_on_the_largest_line() {
    let s = setup();
    s.post(ImportShipmentInput {
        spread_by: "quantity".into(),
        costs: vec![cost("clearance", s.freight, 100_001, 0)],
        ..s.shipment()
    })
    .unwrap();
    // 30 units: routers 10/30 → 33,333.67 → 33,334; switches 66,667.33 → 66,667, and the rounding leaves nothing over.
    let allocated: Vec<i64> = s.business.import_shipments().unwrap()[0]
        .lines
        .iter()
        .map(|l| l.allocated)
        .collect();
    assert_eq!(allocated, vec![33_334, 66_667]);
    assert_eq!(balance_of(&s.business, "stock"), 7_500_000 + 100_001);
}

#[test]
fn the_part_of_the_costs_for_units_already_sold_goes_to_cost_of_goods_sold() {
    let s = setup();
    s.business
        .post_sales_invoice(&SalesInvoiceInput {
            date: "2026-03-05".into(),
            customer_id: s.customer,
            warehouse_id: s.main,
            lines: vec![InvoiceLineInput::base(s.router, 4_000, 900_000)],
            ..Default::default()
        })
        .unwrap();
    let cogs_before = balance_of(&s.business, "cost_of_goods_sold");
    s.post(s.shipment()).unwrap();

    // Routers take 7,000; 4 of the 10 are sold, so 2,800 goes to cost of sales and 4,200 to the 6 still held.
    assert_eq!(
        balance_of(&s.business, "cost_of_goods_sold") - cogs_before,
        280_000
    );
    assert_eq!(s.business.average_cost(s.router).unwrap(), 570_000);
    assert_eq!(
        balance_of(&s.business, "stock"),
        7_500_000 - 2_000_000 + 1_050_000 - 280_000
    );
}

#[test]
fn an_invoice_goes_into_one_shipment_only_payees_bill_in_egp_and_a_shipment_needs_costs() {
    let s = setup();
    assert_eq!(
        code(s.post(ImportShipmentInput {
            costs: vec![],
            ..s.shipment()
        })),
        "shipment_needs_costs"
    );
    assert_eq!(
        code(s.post(ImportShipmentInput {
            purchase_invoice_ids: vec![],
            ..s.shipment()
        })),
        "shipment_needs_invoices"
    );
    assert_eq!(
        code(s.post(ImportShipmentInput {
            costs: vec![cost("freight", s.shenzhen, 1_000, 0)],
            ..s.shipment()
        })),
        "payee_not_egp"
    );
    assert_eq!(
        code(s.post(ImportShipmentInput {
            costs: vec![cost("freight", s.freight, -5, 0)],
            ..s.shipment()
        })),
        "amount_invalid"
    );
    s.post(s.shipment()).unwrap();
    assert_eq!(code(s.post(s.shipment())), "invoice_in_shipment");
}
