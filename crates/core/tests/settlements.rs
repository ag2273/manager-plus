//! Ported from `src/core/settlements.test.ts`.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::invoices::{
    CreditLineInput, CreditNoteInput, InvoiceLineInput, SalesInvoiceInput, SalesInvoiceResult,
};
use manager_core::purchases::{DebitNoteInput, ReturnedLine, SupplierInput};
use manager_core::sales::{SaleInput, SaleLineInput};
use manager_core::settlements::{AgingRow, PartyKind, PaymentInput};
use manager_core::{Business, BusinessSettings};

use PartyKind::{Customer, Supplier};

struct Setup {
    business: Business,
    main: i64,
    router: i64,
    supplier: i64,
    amal: i64,
    nour: i64,
}

fn setup() -> Setup {
    let settings = BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        ..shop()
    };
    let business = Business::create(":memory:", &settings, &manager()).unwrap();
    let main = main_warehouse(&business);
    let router = business
        .add_item(&piece(&business, "راوتر", 150_000))
        .unwrap();
    let supplier = business
        .add_supplier(&SupplierInput {
            name: "شركة الشبكات المتحدة".into(),
            ..Default::default()
        })
        .unwrap();
    buy(
        &business,
        supplier,
        main,
        "2026-01-02",
        &[(router, 20_000, 100_000)],
    );
    let customer = |name: &str| {
        business
            .add_customer(&CustomerInput {
                name: name.into(),
                ..Default::default()
            })
            .unwrap()
    };
    let amal = customer("شركة الأمل");
    let nour = customer("مكتب النور");
    Setup {
        business,
        main,
        router,
        supplier,
        amal,
        nour,
    }
}

impl Setup {
    fn account(&self, role: &str) -> i64 {
        role_account(&self.business, role)
    }
    /** An invoice of `routers` at 1,000.00 + 14% VAT = 1,140.00 each. */
    fn sell(&self, customer_id: i64, date: &str, routers: i64) -> SalesInvoiceResult {
        self.business
            .post_sales_invoice(&SalesInvoiceInput {
                date: date.into(),
                customer_id,
                warehouse_id: self.main,
                lines: vec![InvoiceLineInput::base(
                    self.router,
                    routers * 1_000,
                    100_000,
                )],
                ..Default::default()
            })
            .unwrap()
    }
    fn receive(&self, payment: PaymentInput) -> manager_core::Result<i64> {
        self.business
            .receive_customer_payment(&payment)
            .map(|p| p.number)
    }
    fn open(&self, kind: PartyKind, id: i64) -> Vec<(i64, i64, i64)> {
        self.business
            .open_documents(kind, id)
            .unwrap()
            .iter()
            .map(|d| (d.entry_id, d.amount, d.open))
            .collect()
    }
    fn credit_one(&self, invoice: &SalesInvoiceResult, date: &str) {
        let line = self
            .business
            .find_sales_invoice(invoice.number)
            .unwrap()
            .lines[0]
            .line_id;
        self.business
            .post_credit_note(&CreditNoteInput {
                date: date.into(),
                invoice_id: invoice.id,
                reason: String::new(),
                lines: vec![CreditLineInput::new(line, 1_000)],
            })
            .unwrap();
    }
    fn debit_note(&self, date: &str, quantity: f64) {
        let purchase = &self.business.purchase_invoices().unwrap()[0];
        self.business
            .post_debit_note(&DebitNoteInput {
                date: date.into(),
                purchase_invoice_id: purchase.id,
                reason: String::new(),
                lines: vec![ReturnedLine {
                    line_id: purchase.lines[0].line_id,
                    quantity,
                    serials: None,
                }],
            })
            .unwrap();
    }
}

#[test]
fn a_customer_payment_goes_into_the_bank_and_off_their_account_settling_the_invoice_it_names() {
    let s = setup();
    s.sell(s.amal, "2026-02-01", 1);
    let second = s.sell(s.amal, "2026-02-10", 2);
    let second_doc = s.open(Customer, s.amal)[1].0;

    let paid = s
        .business
        .receive_customer_payment(&PaymentInput {
            reference: "شيك 4411".into(),
            ..PaymentInput::new("2026-02-15", s.amal, s.account("bank"), 200_000)
                .allocate(second_doc, 200_000)
        })
        .unwrap();

    assert_eq!(paid.number, 1);
    assert_eq!(second.total, 228_000);
    assert_eq!(
        s.business.customer_balance(s.amal).unwrap(),
        114_000 + 228_000 - 200_000
    );
    assert_eq!(balance_of(&s.business, "bank"), 200_000);
    let open: Vec<(i64, i64)> = s
        .open(Customer, s.amal)
        .iter()
        .map(|d| (d.1, d.2))
        .collect();
    assert_eq!(open, vec![(114_000, 114_000), (228_000, 28_000)]);
    assert_eq!(
        s.receive(PaymentInput::new(
            "2026-02-16",
            s.nour,
            s.account("main_cash"),
            100
        ))
        .unwrap(),
        2
    );
}

#[test]
fn a_supplier_payment_comes_out_of_the_cash_box_and_off_what_is_owed_to_them() {
    let s = setup();
    let paid = s
        .business
        .pay_supplier(&PaymentInput::new(
            "2026-01-20",
            s.supplier,
            s.account("main_cash"),
            1_000_000,
        ))
        .unwrap();
    assert_eq!(paid.number, 1);
    assert_eq!(
        s.business.supplier_balance(s.supplier).unwrap(),
        2_280_000 - 1_000_000
    );
    assert_eq!(balance_of(&s.business, "main_cash"), -1_000_000);
    assert_eq!(balance_of(&s.business, "payables"), -1_280_000);
}

#[test]
fn a_payment_needs_a_money_account_a_positive_amount_and_allocations_that_fit() {
    let s = setup();
    s.sell(s.amal, "2026-02-01", 1);
    let doc = s.open(Customer, s.amal)[0].0;
    let base = || PaymentInput::new("2026-02-15", s.amal, s.account("bank"), 100_000);

    assert_eq!(
        code(s.receive(PaymentInput {
            account_id: s.account("stock"),
            ..base()
        })),
        "account_not_allowed"
    );
    assert_eq!(
        code(s.receive(PaymentInput {
            amount: 0.0,
            ..base()
        })),
        "amount_invalid"
    );
    assert_eq!(
        code(s.receive(base().allocate(doc, 100_001))),
        "allocation_invalid"
    );
    assert_eq!(
        code(
            s.receive(
                PaymentInput {
                    amount: 500_000.0,
                    ..base()
                }
                .allocate(doc, 114_001)
            )
        ),
        "allocation_invalid"
    );
    assert_eq!(s.business.customer_balance(s.amal).unwrap(), 114_000);
}

#[test]
fn a_statement_shows_the_balance_brought_forward_each_posting_with_a_running_balance_and_the_balance_at_the_end(
) {
    let s = setup();
    s.sell(s.amal, "2026-01-15", 1);
    let invoice = s.sell(s.amal, "2026-02-01", 2);
    s.receive(PaymentInput::new(
        "2026-02-10",
        s.amal,
        s.account("bank"),
        100_000,
    ))
    .unwrap();
    s.credit_one(&invoice, "2026-02-12");
    s.sell(s.amal, "2026-03-01", 1);

    let february = s
        .business
        .statement(Customer, s.amal, "2026-02-01", "2026-02-28")
        .unwrap();

    assert_eq!(february.opening, 114_000);
    let lines: Vec<(&str, i64, i64, i64)> = february
        .lines
        .iter()
        .map(|l| (l.date.as_str(), l.debit, l.credit, l.balance))
        .collect();
    assert_eq!(
        lines,
        vec![
            ("2026-02-01", 228_000, 0, 342_000),
            ("2026-02-10", 0, 100_000, 242_000),
            ("2026-02-12", 0, 114_000, 128_000),
        ]
    );
    let memos: Vec<&str> = february.lines.iter().map(|l| l.memo.as_str()).collect();
    assert_eq!(
        memos,
        vec![
            "فاتورة مبيعات رقم 2 - شركة الأمل",
            "سند قبض رقم 1 من شركة الأمل",
            "إشعار دائن رقم 1 على فاتورة 2"
        ]
    );
    assert_eq!(february.closing, 128_000);
    assert_eq!(
        code(
            s.business
                .statement(Customer, s.amal, "2026-03-01", "2026-02-01")
        ),
        "date_range_invalid"
    );
}

#[test]
fn a_supplier_statement_counts_what_the_business_owes_as_the_balance() {
    let s = setup();
    s.business
        .pay_supplier(&PaymentInput::new(
            "2026-01-20",
            s.supplier,
            s.account("bank"),
            280_000,
        ))
        .unwrap();
    let all = s
        .business
        .statement(Supplier, s.supplier, "2026-01-01", "2026-12-31")
        .unwrap();
    assert_eq!(all.opening, 0);
    let lines: Vec<(i64, i64, i64)> = all
        .lines
        .iter()
        .map(|l| (l.debit, l.credit, l.balance))
        .collect();
    assert_eq!(
        lines,
        vec![(0, 2_280_000, 2_280_000), (280_000, 0, 2_000_000)]
    );
    assert_eq!(
        all.closing,
        s.business.supplier_balance(s.supplier).unwrap()
    );
}

#[test]
fn open_invoices_fall_into_age_buckets_and_unallocated_money_settles_the_oldest_first() {
    let s = setup();
    s.sell(s.amal, "2026-01-10", 1); // 111 days old on 1 May
    s.sell(s.amal, "2026-03-15", 1); // 47 days
    let recent = s.sell(s.amal, "2026-04-25", 2); // 6 days
    s.sell(s.nour, "2026-02-20", 1); // 70 days
    let recent_doc = s.open(Customer, s.amal)[2].0;
    s.receive(
        PaymentInput::new("2026-04-28", s.amal, s.account("bank"), 300_000)
            .allocate(recent_doc, 100_000),
    )
    .unwrap();

    let report = s.business.aging(Customer, "2026-05-01").unwrap();

    // 100.00 settles part of the recent invoice; the other 2,000.00 clears the January invoice and 860.00 of March's.
    assert_eq!(recent.total, 228_000);
    assert_eq!(
        report.rows,
        vec![
            AgingRow {
                party_id: s.amal,
                name: "شركة الأمل".into(),
                buckets: [128_000, 28_000, 0, 0],
                unapplied: 0,
                balance: 156_000
            },
            AgingRow {
                party_id: s.nour,
                name: "مكتب النور".into(),
                buckets: [0, 0, 114_000, 0],
                unapplied: 0,
                balance: 114_000
            },
        ]
    );
    assert_eq!(report.totals, [128_000, 28_000, 114_000, 0]);
    assert_eq!(report.balance, balance_of(&s.business, "receivables"));
}

#[test]
fn money_paid_ahead_of_any_invoice_shows_as_unapplied_and_documents_after_the_date_are_left_out() {
    let s = setup();
    s.receive(PaymentInput::new(
        "2026-01-05",
        s.nour,
        s.account("main_cash"),
        50_000,
    ))
    .unwrap();
    s.sell(s.nour, "2026-06-01", 1);
    let report = s.business.aging(Customer, "2026-05-01").unwrap();
    assert_eq!(
        report.rows,
        vec![AgingRow {
            party_id: s.nour,
            name: "مكتب النور".into(),
            buckets: [0, 0, 0, 0],
            unapplied: 50_000,
            balance: -50_000
        }]
    );
}

#[test]
fn aged_payables_age_the_suppliers_invoices_less_debit_notes_and_payments() {
    let s = setup();
    s.debit_note("2026-01-05", 2_000.0);
    s.business
        .pay_supplier(&PaymentInput::new(
            "2026-01-20",
            s.supplier,
            s.account("bank"),
            1_000_000,
        ))
        .unwrap();
    let report = s.business.aging(Supplier, "2026-02-15").unwrap();
    assert_eq!(
        report.rows,
        vec![AgingRow {
            party_id: s.supplier,
            name: "شركة الشبكات المتحدة".into(),
            buckets: [0, 1_052_000, 0, 0],
            unapplied: 0,
            balance: 1_052_000
        }]
    );
    assert_eq!(report.balance, -balance_of(&s.business, "payables"));
}

#[test]
fn the_receivables_and_payables_accounts_always_equal_the_sum_of_the_parties_balances() {
    let s = setup();
    let first = s.sell(s.amal, "2026-02-01", 3);
    s.sell(s.nour, "2026-02-02", 1);
    s.business.open_shift(0.0).unwrap();
    s.business
        .post_sale(&SaleInput {
            date: "2026-02-03".into(),
            warehouse_id: s.main,
            lines: vec![SaleLineInput::base(s.router, 1_000)],
            payments: vec![],
            customer_id: Some(s.nour),
            ..Default::default()
        })
        .unwrap();
    s.receive(PaymentInput::new(
        "2026-02-05",
        s.amal,
        s.account("bank"),
        200_000,
    ))
    .unwrap();
    s.credit_one(&first, "2026-02-06");
    s.business
        .pay_supplier(&PaymentInput::new(
            "2026-02-07",
            s.supplier,
            s.account("main_cash"),
            500_000,
        ))
        .unwrap();
    s.debit_note("2026-02-08", 1_000.0);

    let customers: i64 = s
        .business
        .customers()
        .unwrap()
        .iter()
        .map(|c| s.business.customer_balance(c.id).unwrap())
        .sum();
    let suppliers: i64 = s
        .business
        .suppliers()
        .unwrap()
        .iter()
        .map(|x| s.business.supplier_balance(x.id).unwrap())
        .sum();
    assert_eq!(customers, balance_of(&s.business, "receivables"));
    assert_eq!(
        customers,
        s.business.aging(Customer, "2026-12-31").unwrap().balance
    );
    assert_eq!(suppliers, -balance_of(&s.business, "payables"));
    assert_eq!(
        suppliers,
        s.business.aging(Supplier, "2026-12-31").unwrap().balance
    );
    let tb = s.business.trial_balance("2026-12-31").unwrap();
    assert_eq!(tb.total_debit, tb.total_credit);
}
