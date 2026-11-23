//! Ported from `src/core/invoices.test.ts` (the debit-note and supplier cases are in `purchases.rs`).
mod common;

use common::*;
use manager_core::customers::{CustomerChanges, CustomerInput};
use manager_core::invoices::{
    CreditLineInput, CreditNoteInput, InvoiceLineInput, SalesInvoiceInput, SalesInvoiceResult,
};
use manager_core::{Business, BusinessError, BusinessSettings};

pub struct Setup {
    pub business: Business,
    pub main: i64,
    pub router: i64,
    pub book: i64,
    pub customer: i64,
}

fn setup() -> Setup {
    let settings = BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        tax_registration_number: "123456789".into(),
        ..shop()
    };
    let business = common::ready(Business::create(":memory:", &settings, &manager()).unwrap());
    let main = main_warehouse(&business);
    let router = business
        .add_item(&piece(&business, "راوتر", 150_000))
        .unwrap();
    let book = business
        .add_item(&manager_core::items::ItemInput {
            tax_code_id: tax_code(&business, "exempt"),
            ..piece(&business, "كتاب", 5_000)
        })
        .unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-01-02",
        &[(router, 10_000, 100_000), (book, 10_000, 3_000)],
    );
    let customer = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل للتجارة".into(),
            tax_registration_number: "987654321".into(),
            address: Some("مدينة نصر".into()),
            ..Default::default()
        })
        .unwrap();
    Setup {
        business,
        main,
        router,
        book,
        customer,
    }
}

impl Setup {
    fn input(&self, lines: Vec<InvoiceLineInput>) -> SalesInvoiceInput {
        SalesInvoiceInput {
            date: "2026-02-01".into(),
            customer_id: self.customer,
            warehouse_id: self.main,
            lines,
            ..Default::default()
        }
    }
    fn invoice(&self) -> Result<SalesInvoiceResult, BusinessError> {
        self.business.post_sales_invoice(&SalesInvoiceInput {
            reference: "PO-15".into(),
            ..self.input(vec![
                InvoiceLineInput::base(self.router, 2_000, 120_000).with_discount(10_000),
                InvoiceLineInput::base(self.book, 3_000, 5_000),
            ])
        })
    }
    fn credit(
        &self,
        invoice_id: i64,
        line_id: i64,
        quantity: i64,
        date: &str,
        reason: &str,
    ) -> manager_core::Result<manager_core::invoices::PostedCreditNote> {
        self.business.post_credit_note(&CreditNoteInput {
            date: date.into(),
            invoice_id,
            reason: reason.into(),
            lines: vec![CreditLineInput::new(line_id, quantity)],
        })
    }
}

#[test]
fn an_invoice_prices_vat_exclusive_lines_puts_the_total_on_account_and_issues_stock_at_cost() {
    let s = setup();
    let posted = s.invoice().unwrap();

    // Routers: 2 × 1,200.00 − 100.00 = 2,300.00 + 14% VAT 322.00; books: 3 × 50.00 = 150.00, exempt.
    assert_eq!(
        (posted.number, posted.total, posted.below_zero.len()),
        (1, 277_200, 0)
    );
    assert_eq!(s.business.customer_balance(s.customer).unwrap(), 277_200);
    assert_eq!(balance_of(&s.business, "receivables"), 277_200);
    assert_eq!(balance_of(&s.business, "sales"), -245_000);
    assert_eq!(balance_of(&s.business, "output_vat"), -32_200);
    assert_eq!(balance_of(&s.business, "cost_of_goods_sold"), 209_000);
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 8_000);

    let found = s.business.find_sales_invoice(1).unwrap();
    assert_eq!(
        (found.customer_name.as_str(), found.reference.as_str()),
        ("شركة الأمل للتجارة", "PO-15")
    );
    assert_eq!(
        (
            found.gross,
            found.discount,
            found.net,
            found.vat,
            found.total,
            found.credited
        ),
        (255_000, 10_000, 245_000, 32_200, 277_200, 0)
    );
    let l = &found.lines[0];
    assert_eq!(
        (
            l.name_ar.as_str(),
            l.quantity,
            l.unit_price,
            l.gross,
            l.discount,
            l.net,
            l.vat_rate,
            l.vat,
            l.credited
        ),
        (
            "راوتر",
            2_000,
            120_000,
            240_000,
            10_000,
            230_000,
            1_400,
            32_200,
            0
        )
    );
    assert_eq!(s.invoice().unwrap().number, 2);
    let numbers: Vec<i64> = s
        .business
        .sales_invoices()
        .unwrap()
        .iter()
        .map(|i| i.number)
        .collect();
    assert_eq!(numbers, vec![2, 1]);
}

#[test]
fn an_invoice_needs_an_active_customer_lines_a_total_and_discounts_that_fit() {
    let s = setup();
    let post = |lines| s.business.post_sales_invoice(&s.input(lines));
    assert_eq!(code(post(vec![])), "invoice_needs_lines");
    assert_eq!(
        code(post(vec![
            InvoiceLineInput::base(s.router, 1_000, 100).with_discount(101)
        ])),
        "discount_invalid"
    );
    assert_eq!(
        code(post(vec![InvoiceLineInput::base(s.router, 1_000, 0)])),
        "invoice_total_zero"
    );
    s.business.deactivate_customer(s.customer).unwrap();
    assert_eq!(
        code(post(vec![InvoiceLineInput::base(s.router, 1_000, 100)])),
        "customer_inactive"
    );
    assert_eq!(code(s.business.find_sales_invoice(9)), "invoice_not_found");
}

#[test]
fn a_credit_note_takes_goods_back_at_the_invoices_values_and_the_last_piece_takes_what_is_left() {
    let s = setup();
    let posted = s.invoice().unwrap();
    let router_line = s.business.find_sales_invoice(1).unwrap().lines[0].line_id;

    let first = s
        .credit(posted.id, router_line, 1_000, "2026-02-05", "عيب صناعة")
        .unwrap();

    assert_eq!((first.number, first.total), (1, 131_100));
    assert_eq!(
        s.business.customer_balance(s.customer).unwrap(),
        277_200 - 131_100
    );
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 9_000);
    assert_eq!(balance_of(&s.business, "cost_of_goods_sold"), 109_000);
    let note = s.business.find_credit_note(1).unwrap();
    assert_eq!(
        (
            note.invoice_number,
            note.customer_name.as_str(),
            note.reason.as_str()
        ),
        (1, "شركة الأمل للتجارة", "عيب صناعة")
    );
    assert_eq!((note.net, note.vat, note.total), (115_000, 16_100, 131_100));

    s.credit(posted.id, router_line, 1_000, "2026-02-06", "")
        .unwrap();

    let after = s.business.find_sales_invoice(1).unwrap();
    assert_eq!(after.credited, 262_200);
    assert_eq!(after.lines[0].credited, 2_000);
    let numbers: Vec<i64> = after.credit_notes.iter().map(|n| n.number).collect();
    assert_eq!(numbers, vec![1, 2]);
    assert_eq!(balance_of(&s.business, "output_vat"), 0);
    assert_eq!(
        code(s.credit(posted.id, router_line, 1, "2026-02-07", "")),
        "return_exceeds_sale"
    );
}

#[test]
fn customers_carry_an_address_a_price_level_and_an_optional_credit_limit() {
    let s = setup();
    s.business
        .update_customer(
            s.customer,
            &CustomerChanges {
                price_level: Some("wholesale".into()),
                credit_limit: Some(Some(5_000_000.0)),
                ..Default::default()
            },
        )
        .unwrap();
    let c = &s.business.customers().unwrap()[0];
    assert_eq!(
        (
            c.address.as_str(),
            c.price_level.as_str(),
            c.credit_limit,
            c.tax_registration_number.as_str()
        ),
        ("مدينة نصر", "wholesale", Some(5_000_000), "987654321")
    );
    s.business
        .update_customer(
            s.customer,
            &CustomerChanges {
                credit_limit: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(s.business.customers().unwrap()[0].credit_limit, None);
    assert_eq!(
        code(s.business.update_customer(
            s.customer,
            &CustomerChanges {
                credit_limit: Some(Some(-1.0)),
                ..Default::default()
            },
        )),
        "credit_limit_invalid"
    );
}
