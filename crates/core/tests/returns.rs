//! Ported from `src/core/returns.test.ts`.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::returns::{ReturnInput, ReturnLineInput, ReturnResult};
use manager_core::sales::{Discount, PaymentInput, Receipt, SaleInput, SaleLineInput};
use manager_core::shifts::CloseShiftInput;
use manager_core::{Business, BusinessError};

struct Setup {
    business: Business,
    main: i64,
    rice: i64,
    soap: i64,
    receipt: Receipt,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let rice = business
        .add_item(&manager_core::items::ItemInput {
            base_unit: "كيس".into(),
            ..piece(&business, "أرز", 3_800)
        })
        .unwrap();
    let soap = business.add_item(&piece(&business, "منظف", 5_700)).unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-11-01",
        &[(rice, 30_000, 3_001), (soap, 10_000, 4_000)],
    );
    business.open_shift(0.0).unwrap();
    // Receipt 1: 3 rice with 1.00 off the receipt, 1 soap. Lines: 114.00 and 57.00 = 171.00, less 1.00.
    let sale = business
        .post_sale(&SaleInput {
            date: "2026-11-20".into(),
            warehouse_id: main,
            lines: vec![
                SaleLineInput::base(rice, 3_000),
                SaleLineInput::base(soap, 1_000),
            ],
            discount: Some(Discount::amount(100)),
            payments: vec![PaymentInput::new("cash", 17_000)],
            ..Default::default()
        })
        .unwrap();
    let receipt = business.find_receipt(sale.number).unwrap();
    Setup {
        business,
        main,
        rice,
        soap,
        receipt,
    }
}

impl Setup {
    fn back(
        &self,
        line: usize,
        quantity: i64,
        refund: &str,
    ) -> Result<ReturnResult, BusinessError> {
        self.business.return_sale(&ReturnInput {
            date: "2026-11-21".into(),
            receipt_id: self.receipt.id,
            lines: vec![ReturnLineInput::new(
                self.receipt.lines[line].line_id,
                quantity,
            )],
            refund: refund.into(),
        })
    }
    fn expect_books_balance(&self) {
        let tb = self.business.trial_balance("2026-12-31").unwrap();
        assert_eq!(tb.total_debit, tb.total_credit);
        let value = self.business.stock_value(self.rice).unwrap()
            + self.business.stock_value(self.soap).unwrap();
        assert_eq!(balance_of(&self.business, "stock"), value);
    }
}

#[test]
fn a_receipt_is_found_by_its_number_with_what_can_still_be_returned() {
    let s = setup();
    assert_eq!(s.receipt.number, 1);
    let l = &s.receipt.lines[0];
    assert_eq!(
        (l.item_id, l.quantity, l.returned, l.amount),
        (s.rice, 3_000, 0, 11_333)
    );
    assert_eq!(code(s.business.find_receipt(99)), "receipt_not_found");
}

#[test]
fn returning_reverses_sales_vat_cost_and_stock_at_the_original_values_refunded_in_cash() {
    let s = setup();
    let before = (
        balance_of(&s.business, "sales"),
        balance_of(&s.business, "output_vat"),
        balance_of(&s.business, "cost_of_goods_sold"),
    );

    let done = s.back(1, 1_000, "cash").unwrap();

    let soap_line = &s.receipt.lines[1];
    assert_eq!((done.number, done.total), (1, soap_line.amount));
    let found = s.business.find_return(1).unwrap();
    assert_eq!(
        (
            found.receipt_number,
            found.refund.as_str(),
            found.total,
            found.returned_by.as_str()
        ),
        (1, "cash", soap_line.amount, "أيمن")
    );
    assert_eq!(found.lines.len(), 1);
    assert_eq!(
        (found.lines[0].item_id, found.lines[0].quantity),
        (s.soap, 1_000)
    );
    assert_eq!(balance_of(&s.business, "sales") - before.0, soap_line.net);
    assert_eq!(
        balance_of(&s.business, "output_vat") - before.1,
        soap_line.vat
    );
    assert_eq!(
        balance_of(&s.business, "cost_of_goods_sold") - before.2,
        -4_000
    );
    assert_eq!(s.business.stock_on_hand(s.soap).unwrap().total, 10_000);
    assert_eq!(
        balance_of(&s.business, "cash_drawer"),
        s.receipt.total - soap_line.amount
    );
    s.expect_books_balance();
}

#[test]
fn returning_in_parts_never_returns_more_than_was_sold_and_the_last_part_takes_what_is_left() {
    let s = setup();
    let line = &s.receipt.lines[0];

    let first = s.back(0, 1_000, "cash").unwrap();
    let second = s.back(0, 2_000, "cash").unwrap();

    assert_eq!(first.total + second.total, line.amount);
    assert_eq!(code(s.back(0, 1, "cash")), "return_exceeds_sale");
    assert_eq!(
        s.business.find_receipt(s.receipt.number).unwrap().lines[0].returned,
        3_000
    );
    assert_eq!(balance_of(&s.business, "sales"), -s.receipt.lines[1].net);
    assert_eq!(s.business.stock_on_hand(s.rice).unwrap().total, 30_000);
    assert_eq!(s.business.stock_value(s.rice).unwrap(), 90_030);
    s.expect_books_balance();
}

#[test]
fn a_refund_to_the_customers_account_lowers_what_they_owe() {
    let s = setup();
    let customer = s
        .business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            ..Default::default()
        })
        .unwrap();
    let sale = s
        .business
        .post_sale(&SaleInput {
            date: "2026-11-20".into(),
            warehouse_id: s.main,
            lines: vec![SaleLineInput::base(s.rice, 2_000)],
            customer_id: Some(customer),
            ..Default::default()
        })
        .unwrap();
    let receipt = s.business.find_receipt(sale.number).unwrap();

    s.business
        .return_sale(&ReturnInput {
            date: "2026-11-21".into(),
            receipt_id: receipt.id,
            lines: vec![ReturnLineInput::new(receipt.lines[0].line_id, 1_000)],
            refund: "account".into(),
        })
        .unwrap();

    assert_eq!(s.business.customer_balance(customer).unwrap(), 3_800);
}

#[test]
fn a_refund_to_an_account_needs_the_receipts_customer() {
    let s = setup();
    assert_eq!(code(s.back(0, 1_000, "account")), "customer_not_found");
}

#[test]
fn a_cash_refund_needs_an_open_shift_and_the_z_report_shows_returns() {
    let s = setup();
    let shift = s.business.current_shift().unwrap().unwrap().id;
    s.back(1, 1_000, "cash").unwrap();

    let z = s.business.z_report(shift).unwrap();
    assert_eq!(z.returns, s.receipt.lines[1].amount);
    assert_eq!(z.expected_cash, s.receipt.total - s.receipt.lines[1].amount);

    s.business
        .close_shift(&CloseShiftInput {
            date: "2026-11-21".into(),
            counted_cash: z.expected_cash as f64,
        })
        .unwrap();
    assert_eq!(code(s.back(0, 1_000, "cash")), "shift_required");
}

#[test]
fn a_return_line_must_belong_to_the_receipt() {
    let s = setup();
    let input = |lines| ReturnInput {
        date: "2026-11-21".into(),
        receipt_id: s.receipt.id,
        lines,
        refund: "cash".into(),
    };
    assert_eq!(
        code(
            s.business
                .return_sale(&input(vec![ReturnLineInput::new(999, 1_000)]))
        ),
        "return_line_invalid"
    );
    assert_eq!(
        code(s.business.return_sale(&input(vec![]))),
        "invoice_needs_lines"
    );
}

mod turned_into_an_invoice {
    use super::*;
    use manager_core::invoices::ReceiptInvoiceInput;
    use manager_core::settlements::PartyKind;

    fn company(s: &Setup) -> i64 {
        s.business
            .add_customer(&CustomerInput {
                name: "شركة الأمل للتجارة".into(),
                tax_registration_number: "987654321".into(),
                ..Default::default()
            })
            .unwrap()
    }

    fn invoice(
        s: &Setup,
        receipt_id: i64,
        customer: i64,
    ) -> manager_core::Result<manager_core::invoices::ReceiptInvoiced> {
        s.business.invoice_receipt(&ReceiptInvoiceInput {
            date: "2026-11-22".into(),
            receipt_id,
            customer_id: customer,
            reference: "PO-9".into(),
        })
    }

    #[test]
    fn a_receipt_becomes_an_invoice_to_the_customer_and_the_sale_counts_once() {
        let s = setup();
        let customer = company(&s);
        let before = (
            balance_of(&s.business, "sales"),
            balance_of(&s.business, "output_vat"),
            balance_of(&s.business, "cash_drawer"),
            s.business.stock_on_hand(s.rice).unwrap().total,
        );

        let done = invoice(&s, s.receipt.id, customer).unwrap();

        assert_eq!(done.total, s.receipt.total);
        let after = (
            balance_of(&s.business, "sales"),
            balance_of(&s.business, "output_vat"),
            balance_of(&s.business, "cash_drawer"),
            s.business.stock_on_hand(s.rice).unwrap().total,
        );
        assert_eq!(after, before, "sales, VAT, cash and stock are as they were");
        assert_eq!(s.business.customer_balance(customer).unwrap(), 0);
        assert!(s
            .business
            .open_documents(PartyKind::Customer, customer)
            .unwrap()
            .is_empty());
        let inv = s.business.find_sales_invoice(done.invoice_number).unwrap();
        assert_eq!(
            (inv.customer_id, inv.reference.as_str(), inv.net, inv.vat),
            (customer, "PO-9", s.receipt.net, s.receipt.vat)
        );
        assert!(inv.notes.contains(&s.receipt.number.to_string()));
        let receipt = s.business.find_receipt(s.receipt.number).unwrap();
        assert_eq!(receipt.invoice_number, Some(done.invoice_number));
        assert!(receipt.lines.iter().all(|l| l.returned == l.quantity));
        s.expect_books_balance();
    }

    #[test]
    fn a_receipt_is_invoiced_once_whole_and_only_to_its_own_customer() {
        let s = setup();
        let customer = company(&s);
        invoice(&s, s.receipt.id, customer).unwrap();
        assert_eq!(
            code(invoice(&s, s.receipt.id, customer)),
            "receipt_invoiced"
        );
        assert_eq!(code(invoice(&s, 9_999, customer)), "receipt_not_found");

        let sale = s
            .business
            .post_sale(&SaleInput {
                date: "2026-11-20".into(),
                warehouse_id: s.main,
                lines: vec![SaleLineInput::base(s.soap, 2_000)],
                payments: vec![PaymentInput::new("cash", 11_400)],
                ..Default::default()
            })
            .unwrap();
        let partly = s.business.find_receipt(sale.number).unwrap();
        s.business
            .return_sale(&ReturnInput {
                date: "2026-11-21".into(),
                receipt_id: partly.id,
                lines: vec![ReturnLineInput::new(partly.lines[0].line_id, 1_000)],
                refund: "cash".into(),
            })
            .unwrap();
        assert_eq!(
            code(invoice(&s, partly.id, customer)),
            "receipt_has_returns"
        );

        let other = s
            .business
            .add_customer(&CustomerInput {
                name: "عميل آخر".into(),
                ..Default::default()
            })
            .unwrap();
        let on_account = s
            .business
            .post_sale(&SaleInput {
                date: "2026-11-20".into(),
                warehouse_id: s.main,
                lines: vec![SaleLineInput::base(s.soap, 1_000)],
                customer_id: Some(other),
                ..Default::default()
            })
            .unwrap();
        let theirs = s.business.find_receipt(on_account.number).unwrap();
        assert_eq!(
            code(invoice(&s, theirs.id, customer)),
            "receipt_customer_differs"
        );
        invoice(&s, theirs.id, other).unwrap();
        assert_eq!(s.business.customer_balance(other).unwrap(), 5_700);
        s.expect_books_balance();
    }
}
