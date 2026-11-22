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

mod with_purchases {
    use super::*;
    use manager_core::purchases::{
        DebitNoteInput, PurchaseInvoiceInput, PurchaseLineInput, ReturnedLine, SupplierInput,
    };

    fn buy(
        s: &Setup,
        supplier: i64,
        item: i64,
        quantity: f64,
        serials: &[&str],
    ) -> manager_core::Result<i64> {
        s.business.post_purchase_invoice(&PurchaseInvoiceInput {
            date: "2026-01-10".into(),
            supplier_id: supplier,
            warehouse_id: s.main,
            reference: "D-1".into(),
            rate: None,
            lines: vec![PurchaseLineInput {
                item_id: item,
                unit: "base".into(),
                quantity,
                unit_price: 1_500_000.0,
                serials: Some(serials.iter().map(|x| x.to_string()).collect()),
            }],
        })
    }

    fn dell(s: &Setup) -> i64 {
        s.business
            .add_supplier(&SupplierInput {
                name: "Dell Egypt".into(),
                ..Default::default()
            })
            .unwrap()
    }

    #[test]
    fn a_purchase_needs_exactly_one_different_serial_per_whole_unit() {
        let s = setup();
        let dell = dell(&s);
        buy(&s, dell, s.laptop, 1_000.0, &["A1"]).unwrap();
        assert_eq!(
            code(buy(&s, dell, s.laptop, 2_000.0, &["D1"])),
            "serials_required"
        );
        assert_eq!(
            code(buy(&s, dell, s.laptop, 2_000.0, &["B1", "B1"])),
            "serials_required"
        );
        assert_eq!(
            code(buy(&s, dell, s.laptop, 1_500.0, &["C1"])),
            "serials_required"
        );
        assert_eq!(
            code(buy(&s, dell, s.cable, 1_000.0, &["X"])),
            "serials_not_expected"
        );
        assert_eq!(
            code(buy(&s, dell, s.laptop, 1_000.0, &["A1"])),
            "serial_in_stock"
        );
        assert_eq!(s.business.stock_on_hand(s.laptop).unwrap().total, 1_000);
        let found = &s.business.find_serial("A1", "2026-02-01").unwrap()[0];
        let purchase = found.purchase.as_ref().unwrap();
        assert_eq!(
            (
                purchase.supplier_name.as_str(),
                purchase.reference.as_str(),
                purchase.date.as_str()
            ),
            ("Dell Egypt", "D-1", "2026-01-10")
        );
    }

    #[test]
    fn a_debit_note_sends_back_the_units_by_serial() {
        let s = setup();
        let dell = dell(&s);
        let purchase = buy(&s, dell, s.laptop, 3_000.0, &["SN-1", "SN-2", "SN-3"]).unwrap();
        let line_id = s.business.purchase_invoices().unwrap()[0].lines[0].line_id;
        let send_back = |serial: &str| {
            s.business.post_debit_note(&DebitNoteInput {
                date: "2026-02-15".into(),
                purchase_invoice_id: purchase,
                reason: String::new(),
                lines: vec![ReturnedLine {
                    line_id,
                    quantity: 1_000.0,
                    serials: Some(vec![serial.into()]),
                }],
            })
        };
        send_back("SN-2").unwrap();
        assert_eq!(code(send_back("SN-2")), "serial_not_in_stock");
        let found = &s.business.find_serial("SN-2", "2026-03-01").unwrap()[0];
        assert_eq!((found.in_stock, &found.sale), (false, &None));
        assert_eq!(s.business.stock_on_hand(s.laptop).unwrap().total, 2_000);
    }
}

mod with_sales {
    use super::*;
    use manager_core::customers::CustomerInput;
    use manager_core::returns::{ReturnInput, ReturnLineInput};
    use manager_core::sales::{PaymentInput, SaleInput, SaleLineInput, SaleResult};
    use manager_core::serials::{SerialPurchase, SerialSale};

    struct Till {
        s: Setup,
        dell: i64,
        customer: i64,
    }

    fn till(serials: &[&str]) -> Till {
        let s = setup();
        let dell = s
            .business
            .add_supplier(&manager_core::purchases::SupplierInput {
                name: "Dell Egypt".into(),
                ..Default::default()
            })
            .unwrap();
        s.business
            .post_purchase_invoice(&manager_core::purchases::PurchaseInvoiceInput {
                date: "2026-01-10".into(),
                supplier_id: dell,
                warehouse_id: s.main,
                reference: "D-1".into(),
                rate: None,
                lines: vec![manager_core::purchases::PurchaseLineInput {
                    item_id: s.laptop,
                    unit: "base".into(),
                    quantity: serials.len() as f64 * 1_000.0,
                    unit_price: 1_500_000.0,
                    serials: Some(serials.iter().map(|x| x.to_string()).collect()),
                }],
            })
            .unwrap();
        let customer = s
            .business
            .add_customer(&CustomerInput {
                name: "شركة الأمل".into(),
                ..Default::default()
            })
            .unwrap();
        s.business.open_shift(0.0).unwrap();
        Till { s, dell, customer }
    }

    impl Till {
        fn sell(
            &self,
            serials: &[&str],
            customer: Option<i64>,
        ) -> manager_core::Result<SaleResult> {
            self.s.business.post_sale(&SaleInput {
                date: "2026-03-31".into(),
                warehouse_id: self.s.main,
                lines: vec![
                    SaleLineInput::base(self.s.laptop, serials.len() as i64 * 1_000)
                        .with_serials(serials),
                ],
                payments: vec![PaymentInput::new("cash", 2_000_000 * serials.len() as i64)],
                customer_id: customer,
                ..Default::default()
            })
        }
    }

    #[test]
    fn a_sold_unit_shows_its_supplier_customer_and_warranty_and_only_units_in_stock_sell() {
        let t = till(&["SN-1", "SN-2"]);
        t.sell(&["SN-1"], Some(t.customer)).unwrap();

        let history = &t.s.business.find_serial("SN-1", "2026-06-01").unwrap()[0];
        assert_eq!(
            (
                history.item_id,
                history.name_ar.as_str(),
                history.in_stock,
                history.warehouse_id
            ),
            (t.s.laptop, "لابتوب", false, None)
        );
        assert_eq!(
            history.purchase,
            Some(SerialPurchase {
                date: "2026-01-10".into(),
                supplier_id: t.dell,
                supplier_name: "Dell Egypt".into(),
                reference: "D-1".into()
            })
        );
        assert_eq!(
            history.sale,
            Some(SerialSale {
                date: "2026-03-31".into(),
                document: "إيصال 1".into(),
                customer_id: Some(t.customer),
                customer_name: Some("شركة الأمل".into())
            })
        );
        assert_eq!(
            (history.warranty_ends.as_deref(), history.under_warranty),
            (Some("2027-03-31"), true)
        );
        assert!(!t.s.business.find_serial("SN-1", "2027-04-01").unwrap()[0].under_warranty);
        let other = &t.s.business.find_serial("SN-2", "2026-06-01").unwrap()[0];
        assert_eq!(
            (other.in_stock, other.warehouse_id, other.sale.is_none()),
            (true, Some(t.s.main), true)
        );
        let line = &t.s.business.find_receipt(1).unwrap().lines[0];
        assert_eq!(
            (line.serials.clone(), line.warranty_ends.as_deref()),
            (vec!["SN-1".to_string()], Some("2027-03-31"))
        );
        assert_eq!(code(t.sell(&["SN-1"], None)), "serial_not_in_stock");
        assert_eq!(code(t.sell(&["NOPE"], None)), "serial_not_in_stock");
    }

    #[test]
    fn a_unit_comes_back_only_against_the_sale_it_left_on_and_can_be_sold_again() {
        let t = till(&["SN-1", "SN-2"]);
        let first = t.sell(&["SN-1"], None).unwrap();
        let second = t.sell(&["SN-2"], None).unwrap();
        let line = |n: i64| t.s.business.find_receipt(n).unwrap().lines[0].line_id;
        let back = |receipt_id: i64, line_id: i64| {
            t.s.business.return_sale(&ReturnInput {
                date: "2026-04-01".into(),
                receipt_id,
                lines: vec![ReturnLineInput::new(line_id, 1_000).with_serials(&["SN-1"])],
                refund: "cash".into(),
            })
        };

        assert_eq!(code(back(second.id, line(2))), "serial_not_on_document");
        back(first.id, line(1)).unwrap();

        let h = &t.s.business.find_serial("SN-1", "2026-04-02").unwrap()[0];
        assert_eq!(
            (h.in_stock, h.warehouse_id, h.sale.is_none()),
            (true, Some(t.s.main), true)
        );
        assert_eq!(t.sell(&["SN-1"], None).unwrap().number, 3);
    }
    #[test]
    fn invoices_and_credit_notes_carry_serials_too() {
        use manager_core::invoices::{
            CreditLineInput, CreditNoteInput, InvoiceLineInput, SalesInvoiceInput,
        };
        let t = till(&["SN-1", "SN-2"]);
        let invoice =
            t.s.business
                .post_sales_invoice(&SalesInvoiceInput {
                    date: "2026-02-10".into(),
                    customer_id: t.customer,
                    warehouse_id: t.s.main,
                    lines: vec![InvoiceLineInput::base(t.s.laptop, 1_000, 1_800_000)
                        .with_serials(&["SN-1"])],
                    ..Default::default()
                })
                .unwrap();
        let line =
            &t.s.business
                .find_sales_invoice(invoice.number)
                .unwrap()
                .lines[0];
        assert_eq!(
            (line.serials.clone(), line.warranty_ends.as_deref()),
            (vec!["SN-1".to_string()], Some("2027-02-10"))
        );
        let sale = t.s.business.find_serial("SN-1", "2026-03-01").unwrap()[0]
            .sale
            .clone()
            .unwrap();
        assert_eq!(
            (sale.document.as_str(), sale.customer_name.as_deref()),
            ("فاتورة 1", Some("شركة الأمل"))
        );
        t.s.business
            .post_credit_note(&CreditNoteInput {
                date: "2026-02-12".into(),
                invoice_id: invoice.id,
                reason: String::new(),
                lines: vec![CreditLineInput::new(line.line_id, 1_000).with_serials(&["SN-1"])],
            })
            .unwrap();
        assert!(t.s.business.find_serial("SN-1", "2026-03-01").unwrap()[0].in_stock);
    }
}
