//! Ported from `src/core/quotations.test.ts`.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::invoices::{InvoiceLineInput, SalesInvoiceInput};
use manager_core::items::{ItemInput, ItemsOptions, PackUnitInput};
use manager_core::quotations::{QuotationInput, SavedQuotation};
use manager_core::Business;

struct Setup {
    business: Business,
    main: i64,
    router: i64,
    cable: i64,
    amal: i64,
    walk_in: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    // Shelf price 1,140 with VAT (1,000 + 14%), wholesale 912 with VAT (800 + 14%).
    let router = business
        .add_item(&ItemInput {
            wholesale_price: Some(91_200.0),
            pack: Some(PackUnitInput {
                name: "كرتونة".into(),
                size: 10_000.0,
                sale_price: 1_026_000.0,
                wholesale_price: Some(855_000.0),
                ..Default::default()
            }),
            ..piece(&business, "راوتر", 114_000)
        })
        .unwrap();
    let cable = business
        .add_item(&ItemInput {
            base_unit: "متر".into(),
            ..piece(&business, "كابل", 1_140)
        })
        .unwrap();
    let amal = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            price_level: Some("wholesale".into()),
            ..Default::default()
        })
        .unwrap();
    let walk_in = business
        .add_customer(&CustomerInput {
            name: "عميل قطاعي".into(),
            ..Default::default()
        })
        .unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-01-01",
        &[(router, 50_000, 60_000)],
    );
    Setup {
        business,
        main,
        router,
        cable,
        amal,
        walk_in,
    }
}

impl Setup {
    fn quotation(&self) -> QuotationInput {
        QuotationInput {
            date: "2026-02-01".into(),
            valid_until: "2026-02-15".into(),
            customer_id: self.amal,
            reference: "RFQ-9".into(),
            notes: "الأسعار شاملة التركيب".into(),
            lines: vec![InvoiceLineInput::base(self.router, 5_000, 80_000).with_discount(10_000)],
        }
    }
    fn quote(&self, input: QuotationInput) -> manager_core::Result<SavedQuotation> {
        self.business.save_quotation(&input)
    }
    fn books(&self) -> Vec<(String, i64, i64)> {
        self.business
            .trial_balance("2026-12-31")
            .unwrap()
            .rows
            .into_iter()
            .map(|r| (r.code, r.debit, r.credit))
            .collect()
    }
}

#[test]
fn a_customers_level_picks_the_retail_or_wholesale_price_without_vat() {
    let s = setup();
    let items = s.business.items(&ItemsOptions::default()).unwrap();
    let item = items.iter().find(|i| i.id == s.router).unwrap();
    assert_eq!(item.wholesale_price, Some(91_200));
    assert_eq!(item.pack.as_ref().unwrap().wholesale_price, Some(855_000));

    let price = |customer, item, unit| {
        s.business
            .list_price(customer, item, unit, "2026-02-01")
            .unwrap()
    };
    assert_eq!(price(Some(s.amal), s.router, "base"), 80_000);
    assert_eq!(price(Some(s.walk_in), s.router, "base"), 100_000);
    assert_eq!(price(None, s.router, "base"), 100_000);
    assert_eq!(price(Some(s.amal), s.router, "pack"), 750_000);
    // No wholesale price set: the retail price stands.
    assert_eq!(price(Some(s.amal), s.cable, "base"), 1_000);
}

#[test]
fn a_quotation_is_priced_like_an_invoice_and_touches_neither_books_nor_stock() {
    let s = setup();
    let before = s.books();
    let saved = s.quote(s.quotation()).unwrap();

    assert_eq!(saved.number, 1);
    assert_eq!(s.books(), before);
    assert_eq!(s.business.stock_on_hand(s.router).unwrap().total, 50_000);
    let q = s.business.find_quotation(1, "2026-02-10").unwrap();
    assert_eq!(
        (
            q.number,
            q.customer_name.as_str(),
            q.valid_until.as_str(),
            q.status
        ),
        (1, "شركة الأمل", "2026-02-15", "open")
    );
    assert_eq!((q.net, q.vat, q.total), (390_000, 54_600, 444_600));
    let l = &q.lines[0];
    assert_eq!(
        (
            l.name_ar.as_str(),
            l.unit_name.as_str(),
            l.line.quantity,
            l.line.unit_price,
            l.line.discount,
            l.line.net
        ),
        ("راوتر", "قطعة", 5_000, 80_000, 10_000, 390_000)
    );
    // The screens read the line's fields flat, as the TypeScript core returns them.
    let json = serde_json::to_value(l).unwrap();
    assert_eq!(
        (json["nameAr"].as_str(), json["unitPrice"].as_i64()),
        (Some("راوتر"), Some(80_000))
    );
}

#[test]
fn a_quotation_turns_into_an_invoice_once_and_its_status_runs_open_expired_converted() {
    let s = setup();
    s.quote(s.quotation()).unwrap();
    s.quote(QuotationInput {
        valid_until: "2026-02-05".into(),
        ..s.quotation()
    })
    .unwrap();
    let statuses: Vec<(i64, &str)> = s
        .business
        .quotations("2026-02-10")
        .unwrap()
        .iter()
        .map(|q| (q.number, q.status))
        .collect();
    assert_eq!(statuses, vec![(2, "expired"), (1, "open")]);

    let q = s.business.find_quotation(1, "2026-02-10").unwrap();
    let posted = s
        .business
        .post_sales_invoice(&SalesInvoiceInput {
            date: "2026-02-10".into(),
            customer_id: q.customer_id,
            warehouse_id: s.main,
            reference: q.reference.clone(),
            notes: q.notes.clone(),
            quotation_id: Some(q.id),
            // The price was edited before posting.
            lines: q
                .lines
                .iter()
                .map(|l| {
                    InvoiceLineInput::base(l.line.item_id, l.line.quantity, 78_000)
                        .with_discount(l.line.discount)
                })
                .collect(),
            ..Default::default()
        })
        .unwrap();
    let after = s.business.find_quotation(1, "2026-02-10").unwrap();
    assert_eq!(after.status, "converted");
    assert_eq!(after.invoice_number, Some(posted.number));
    assert_eq!(
        s.business.find_sales_invoice(posted.number).unwrap().net,
        380_000
    );

    let again = |customer_id, quotation_id| {
        s.business.post_sales_invoice(&SalesInvoiceInput {
            date: "2026-02-10".into(),
            customer_id,
            warehouse_id: s.main,
            quotation_id: Some(quotation_id),
            lines: vec![InvoiceLineInput::base(s.router, 1_000, 1)],
            ..Default::default()
        })
    };
    assert_eq!(code(again(q.customer_id, q.id)), "quotation_converted");
    assert_eq!(code(again(s.walk_in, 2)), "quotation_customer_mismatch");
}

#[test]
fn a_quotation_needs_lines_a_customer_and_a_validity_on_or_after_its_date() {
    let s = setup();
    assert_eq!(
        code(s.quote(QuotationInput {
            lines: vec![],
            ..s.quotation()
        })),
        "invoice_needs_lines"
    );
    assert_eq!(
        code(s.quote(QuotationInput {
            valid_until: "2026-01-31".into(),
            ..s.quotation()
        })),
        "date_range_invalid"
    );
    assert_eq!(
        code(s.quote(QuotationInput {
            customer_id: 999,
            ..s.quotation()
        })),
        "customer_not_found"
    );
}
