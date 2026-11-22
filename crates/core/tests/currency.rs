//! Ported from `src/core/currency.test.ts`.
mod common;

use common::*;
use manager_core::currency::to_egp;
use manager_core::purchases::{
    DebitNoteInput, PurchaseInvoiceInput, PurchaseLineInput, PurchaseMoney, ReturnedLine,
    SupplierAccount, SupplierChanges, SupplierInput,
};
use manager_core::settlements::{PartyKind, PaymentInput};
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    router: i64,
    shenzhen: i64,
    local: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let router = business
        .add_item(&piece(&business, "راوتر", 600_000))
        .unwrap();
    let supplier = |name: &str, currency: Option<&str>| SupplierInput {
        name: name.into(),
        currency: currency.map(String::from),
        ..Default::default()
    };
    let shenzhen = business
        .add_supplier(&supplier("Shenzhen Networks", Some("USD")))
        .unwrap();
    let local = business.add_supplier(&supplier("مورد محلي", None)).unwrap();
    Setup {
        business,
        main,
        router,
        shenzhen,
        local,
    }
}

fn routers(item_id: i64, units: i64) -> Vec<PurchaseLineInput> {
    vec![PurchaseLineInput {
        item_id,
        unit: "base".into(),
        quantity: (units * 1_000) as f64,
        unit_price: 10_000.0,
        serials: None,
    }]
}

impl Setup {
    /** Routers at USD 100.00 each. */
    fn buy(&self, units: i64, rate: Option<f64>, supplier_id: i64) -> manager_core::Result<i64> {
        self.buy_on("2026-02-01", units, rate, supplier_id)
    }
    fn buy_on(
        &self,
        date: &str,
        units: i64,
        rate: Option<f64>,
        supplier_id: i64,
    ) -> manager_core::Result<i64> {
        self.business.post_purchase_invoice(&PurchaseInvoiceInput {
            date: date.into(),
            supplier_id,
            warehouse_id: self.main,
            reference: "SZ-1".into(),
            rate,
            lines: routers(self.router, units),
        })
    }
    fn pay(&self, amount: i64, rate: i64, allocations: &[(i64, i64)]) {
        let mut payment = PaymentInput::new(
            "2026-03-01",
            self.shenzhen,
            role_account(&self.business, "bank"),
            amount,
        )
        .at_rate(rate);
        for &(entry, part) in allocations {
            payment = payment.allocate(entry, part);
        }
        self.business.pay_supplier(&payment).unwrap();
    }
    fn account(&self) -> SupplierAccount {
        self.business.supplier_account(self.shenzhen).unwrap()
    }
    fn open(&self) -> Vec<(i64, i64, i64)> {
        self.business
            .open_documents(PartyKind::Supplier, self.shenzhen)
            .unwrap()
            .iter()
            .map(|d| (d.entry_id, d.amount, d.open))
            .collect()
    }
}

fn usd(owed: i64, owed_egp: i64) -> SupplierAccount {
    SupplierAccount {
        currency: "USD".into(),
        owed,
        owed_egp,
    }
}

#[test]
fn usd_1000_bought_at_48_50_and_paid_at_49_20_posts_an_exchange_loss_of_egp_700() {
    let s = setup();
    s.buy(10, Some(48_500_000.0), s.shenzhen).unwrap();
    let open = s.open();
    assert_eq!((open[0].1, open[0].2), (100_000, 100_000));

    s.pay(100_000, 49_200_000, &[(open[0].0, 100_000)]);

    assert_eq!(balance_of(&s.business, "bank"), -4_920_000);
    assert_eq!(balance_of(&s.business, "exchange_loss"), 70_000);
    assert_eq!(balance_of(&s.business, "payables"), 0);
    assert_eq!(s.account(), usd(0, 0));
    assert!(s.open().is_empty());
}

#[test]
fn a_payment_at_a_lower_rate_is_a_gain_and_part_payments_leave_nothing_once_settled() {
    let s = setup();
    s.buy(3, Some(48_333_333.0), s.shenzhen).unwrap(); // USD 300 = EGP 14,500.00 (14,499.9999)
    assert_eq!(s.account().owed_egp, 1_450_000);
    s.pay(10_000, 47_000_000, &[]); // USD 100 at 47 (carrying 4,833.33)
    s.pay(20_000, 47_000_000, &[]); // USD 200 at 47 (carrying the rest, 9,666.67)
    assert_eq!(
        balance_of(&s.business, "exchange_gain"),
        -(1_450_000 - 1_410_000)
    );
    assert_eq!(balance_of(&s.business, "payables"), 0);
    assert_eq!(s.account(), usd(0, 0));
}

#[test]
fn an_unallocated_payment_settles_the_oldest_invoices_first_each_at_its_own_rate() {
    let s = setup();
    s.buy_on("2026-01-10", 1, Some(48_000_000.0), s.shenzhen)
        .unwrap();
    s.buy_on("2026-01-20", 1, Some(50_000_000.0), s.shenzhen)
        .unwrap();
    s.pay(15_000, 49_000_000, &[]); // USD 100 of the first, USD 50 of the second
                                    // carrying 4,800 + 2,500 = 7,300; paid 7,350 → loss 50
    assert_eq!(balance_of(&s.business, "exchange_loss"), 5_000);
    let open: Vec<i64> = s.open().iter().map(|d| d.2).collect();
    assert_eq!(open, vec![5_000]);
    assert_eq!(s.account(), usd(5_000, 250_000));
}

#[test]
fn money_paid_before_any_invoice_is_an_advance_at_its_own_rate() {
    let s = setup();
    s.pay(10_000, 49_000_000, &[]);
    assert_eq!(balance_of(&s.business, "exchange_loss"), 0);
    assert_eq!(s.account(), usd(-10_000, -490_000));
}

#[test]
fn converts_to_piastres_exactly_rounding_half_up() {
    assert_eq!(to_egp(100_000, 48_500_000), 4_850_000);
    assert_eq!(to_egp(1, 48_505_000), 49); // 0.485050 EGP
    assert_eq!(to_egp(1, 48_495_000), 48);
    assert_eq!(to_egp(900_000_000_000, 52_123_456), 46_911_110_400_000);
    assert_eq!(to_egp(-1, 48_505_000), -49);
}

#[test]
fn a_foreign_invoice_is_owed_in_its_currency_and_carried_in_egp_at_its_rate() {
    let s = setup();
    s.buy(10, Some(48_500_000.0), s.shenzhen).unwrap();
    assert_eq!(balance_of(&s.business, "stock"), 4_850_000);
    assert_eq!(balance_of(&s.business, "input_vat"), 0);
    assert_eq!(
        s.business.supplier_account(s.shenzhen).unwrap(),
        SupplierAccount {
            currency: "USD".into(),
            owed: 100_000,
            owed_egp: 4_850_000
        }
    );
}

#[test]
fn goods_sent_back_go_at_the_invoices_rate_and_the_statement_is_in_the_suppliers_currency() {
    let s = setup();
    let id = s.buy(10, Some(48_500_000.0), s.shenzhen).unwrap();
    let invoice = s
        .business
        .purchase_invoices()
        .unwrap()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap();
    assert_eq!(
        (
            invoice.currency.as_str(),
            invoice.rate,
            invoice.total,
            invoice.total_egp
        ),
        ("USD", 48_500_000, 100_000, 4_850_000)
    );
    let note = s
        .business
        .post_debit_note(&DebitNoteInput {
            date: "2026-02-05".into(),
            purchase_invoice_id: id,
            reason: "تالف".into(),
            lines: vec![ReturnedLine {
                line_id: invoice.lines[0].line_id,
                quantity: 2_000.0,
                serials: None,
            }],
        })
        .unwrap();
    assert_eq!((note.number, note.total), (1, 20_000));
    assert_eq!(balance_of(&s.business, "stock"), 4_850_000 - 970_000);
    assert_eq!(
        s.business.supplier_account(s.shenzhen).unwrap(),
        SupplierAccount {
            currency: "USD".into(),
            owed: 80_000,
            owed_egp: 3_880_000
        }
    );
    let returned = &s.business.purchase_invoices().unwrap()[0].lines[0];
    assert_eq!(returned.returned, 2_000);
    let statement = s
        .business
        .statement(PartyKind::Supplier, s.shenzhen, "2026-01-01", "2026-12-31")
        .unwrap();
    assert_eq!(statement.currency, "USD");
    let lines: Vec<(i64, i64)> = statement
        .lines
        .iter()
        .map(|l| (l.debit, l.credit))
        .collect();
    assert_eq!(lines, vec![(0, 100_000), (20_000, 0)]);
    assert_eq!(statement.closing, 80_000);
}

#[test]
fn a_foreign_document_needs_a_rate_an_egp_one_takes_none_and_a_suppliers_currency_is_fixed_once_posted(
) {
    let s = setup();
    assert_eq!(code(s.buy(1, Some(0.0), s.shenzhen)), "rate_invalid");
    assert_eq!(code(s.buy(1, None, s.shenzhen)), "rate_invalid");
    assert_eq!(code(s.buy(1, Some(48_000_000.0), s.local)), "rate_invalid");
    s.buy(1, Some(48_000_000.0), s.shenzhen).unwrap();
    assert_eq!(
        code(s.business.update_supplier(
            s.shenzhen,
            &SupplierChanges {
                currency: Some("EUR".into()),
                ..Default::default()
            }
        )),
        "supplier_currency_locked"
    );
    s.business
        .update_supplier(
            s.local,
            &SupplierChanges {
                currency: Some("EUR".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let priced = s
        .business
        .price_purchase(
            "2026-02-01",
            &routers(s.router, 1),
            Some(&PurchaseMoney {
                currency: "USD".into(),
                rate: 48_000_000.0,
            }),
        )
        .unwrap();
    assert_eq!(
        (priced.net, priced.vat, priced.total, priced.total_egp),
        (10_000, 0, 10_000, 480_000)
    );
}

#[test]
fn a_debit_note_cannot_send_back_more_than_was_bought_or_a_line_of_another_invoice() {
    let s = setup();
    let first = s.buy(3, Some(48_000_000.0), s.shenzhen).unwrap();
    let second = s.buy(1, Some(48_000_000.0), s.shenzhen).unwrap();
    let invoices = s.business.purchase_invoices().unwrap();
    let line_of = |id: i64| invoices.iter().find(|p| p.id == id).unwrap().lines[0].line_id;
    let note = |invoice: i64, line_id: i64, quantity: f64| {
        s.business.post_debit_note(&DebitNoteInput {
            date: "2026-02-05".into(),
            purchase_invoice_id: invoice,
            reason: String::new(),
            lines: vec![ReturnedLine {
                line_id,
                quantity,
                serials: None,
            }],
        })
    };
    note(first, line_of(first), 1_000.0).unwrap();
    assert_eq!(
        code(note(first, line_of(first), 2_001.0)),
        "return_exceeds_sale"
    );
    assert_eq!(
        code(note(first, line_of(second), 1_000.0)),
        "return_line_invalid"
    );
    assert_eq!(
        code(note(999, line_of(first), 1_000.0)),
        "invoice_not_found"
    );
    // The last of a line takes exactly what is left of its cost.
    note(first, line_of(first), 2_000.0).unwrap();
    assert_eq!(
        s.business.supplier_account(s.shenzhen).unwrap().owed_egp,
        480_000
    );
    let notes = s.business.debit_notes().unwrap();
    assert_eq!(
        notes
            .iter()
            .map(|n| (n.number, n.total))
            .collect::<Vec<_>>(),
        [(2, 20_000), (1, 10_000)]
    );
}
