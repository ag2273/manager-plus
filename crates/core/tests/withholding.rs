//! Ported from `src/core/withholding.test.ts`.
mod common;

use common::*;
use manager_core::customers::{CustomerChanges, CustomerInput};
use manager_core::invoices::{InvoiceLineInput, SalesInvoiceInput};
use manager_core::purchases::{SupplierChanges, SupplierInput};
use manager_core::settlements::PaymentInput;
use manager_core::withholding::WithholdingRateInput;
use manager_core::Business;

struct Setup {
    business: Business,
    supplies: i64,
    services: i64,
    supplier: i64,
    amal: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let main = main_warehouse(&business);
    let category = |rate: i64| {
        business
            .withholding_categories()
            .unwrap()
            .into_iter()
            .find(|c| c.rates.last().unwrap().rate == rate)
            .unwrap()
            .id
    };
    let supplies = category(100);
    let services = category(300);
    let router = business
        .add_item(&piece(&business, "راوتر", 150_000))
        .unwrap();
    let supplier = business
        .add_supplier(&SupplierInput {
            name: "شركة الشبكات المتحدة".into(),
            tax_registration_number: "123456789".into(),
            withholding_category_id: Some(supplies),
            ..Default::default()
        })
        .unwrap();
    // 10 routers at 1,000.00 + 14% VAT: the supplier is owed 11,400.00.
    buy(
        &business,
        supplier,
        main,
        "2026-01-02",
        &[(router, 10_000, 100_000)],
    );
    let amal = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            tax_registration_number: "987654321".into(),
            withholding_category_id: Some(supplies),
            ..Default::default()
        })
        .unwrap();
    business
        .post_sales_invoice(&SalesInvoiceInput {
            date: "2026-02-01".into(),
            customer_id: amal,
            warehouse_id: main,
            lines: vec![InvoiceLineInput::base(router, 5_000, 150_000)],
            ..Default::default()
        })
        .unwrap();
    Setup {
        business,
        supplies,
        services,
        supplier,
        amal,
    }
}

impl Setup {
    fn account(&self, role: &str) -> i64 {
        role_account(&self.business, role)
    }
    fn tax(&self, category: i64, date: &str, base: i64) -> manager_core::Result<i64> {
        self.business.withholding_tax(category, date, base as f64)
    }
}

fn rate(from: &str, rate: f64) -> WithholdingRateInput {
    WithholdingRateInput {
        from: from.into(),
        rate,
    }
}

#[test]
fn categories_come_with_dated_rates_and_a_new_rate_takes_over_from_its_date() {
    let s = setup();
    let latest: Vec<i64> = s
        .business
        .withholding_categories()
        .unwrap()
        .iter()
        .map(|c| c.rates.last().unwrap().rate)
        .collect();
    assert_eq!(latest, vec![100, 300, 500]);
    assert_eq!(s.tax(s.services, "2026-03-01", 1_000_000).unwrap(), 30_000);

    s.business
        .add_withholding_rate(s.services, &rate("2026-07-01", 200.0))
        .unwrap();
    assert_eq!(s.tax(s.services, "2026-06-30", 1_000_000).unwrap(), 30_000);
    assert_eq!(s.tax(s.services, "2026-07-01", 1_000_000).unwrap(), 20_000);
    assert_eq!(
        code(
            s.business
                .add_withholding_rate(s.services, &rate("2026-07-01", 10_001.0))
        ),
        "tax_rate_invalid"
    );
    assert_eq!(
        code(s.tax(999, "2026-07-01", 1)),
        "withholding_category_not_found"
    );
}

#[test]
fn parties_carry_a_default_category() {
    let s = setup();
    let supplier = s
        .business
        .suppliers()
        .unwrap()
        .into_iter()
        .find(|x| x.id == s.supplier)
        .unwrap();
    assert_eq!(supplier.withholding_category_id, Some(s.supplies));
    s.business
        .update_customer(
            s.amal,
            &CustomerChanges {
                withholding_category_id: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
    let customer = s
        .business
        .customers()
        .unwrap()
        .into_iter()
        .find(|x| x.id == s.amal)
        .unwrap();
    assert_eq!(customer.withholding_category_id, None);
    assert_eq!(
        code(s.business.update_supplier(
            s.supplier,
            &SupplierChanges {
                withholding_category_id: Some(Some(999)),
                ..Default::default()
            }
        )),
        "withholding_category_not_found"
    );
}

#[test]
fn paying_a_supplier_takes_the_full_amount_off_their_account_the_net_out_of_the_cash_and_owes_the_tax(
) {
    let s = setup();
    // 1% of the 10,000.00 before VAT is 100.00; the supplier gets 11,300.00.
    s.business
        .pay_supplier(
            &PaymentInput::new("2026-01-20", s.supplier, s.account("main_cash"), 1_140_000)
                .withholding(s.supplies, 1_000_000),
        )
        .unwrap();
    assert_eq!(s.business.supplier_balance(s.supplier).unwrap(), 0);
    assert_eq!(balance_of(&s.business, "main_cash"), -1_130_000);
    assert_eq!(balance_of(&s.business, "withholding_payable"), -10_000);
}

#[test]
fn a_company_customer_paying_us_puts_the_net_in_the_bank_and_holds_the_tax_as_a_credit() {
    let s = setup();
    // 5 routers at 1,500.00 + VAT = 8,550.00; 1% of 7,500.00 is 75.00.
    s.business
        .receive_customer_payment(
            &PaymentInput::new("2026-02-10", s.amal, s.account("bank"), 855_000)
                .withholding(s.supplies, 750_000),
        )
        .unwrap();
    assert_eq!(s.business.customer_balance(s.amal).unwrap(), 0);
    assert_eq!(balance_of(&s.business, "bank"), 847_500);
    assert_eq!(balance_of(&s.business, "withholding_receivable"), 7_500);
}

#[test]
fn the_report_lists_both_directions_for_the_period_with_tax_registration_numbers() {
    let s = setup();
    let bank = s.account("bank");
    s.business
        .pay_supplier(
            &PaymentInput::new("2026-01-20", s.supplier, bank, 1_140_000)
                .withholding(s.supplies, 1_000_000),
        )
        .unwrap();
    s.business
        .receive_customer_payment(
            &PaymentInput::new("2026-02-10", s.amal, bank, 400_000)
                .withholding(s.services, 300_000),
        )
        .unwrap();
    s.business
        .receive_customer_payment(&PaymentInput::new("2026-02-11", s.amal, bank, 100_000))
        .unwrap();
    s.business
        .receive_customer_payment(
            &PaymentInput::new("2026-04-02", s.amal, bank, 100_000).withholding(s.supplies, 80_000),
        )
        .unwrap();

    let report = s
        .business
        .withholding_report("2026-01-01", "2026-03-31")
        .unwrap();
    let rows: Vec<(&str, &str, &str, &str, i64, i64, i64)> = report
        .rows
        .iter()
        .map(|r| {
            (
                r.kind.as_str(),
                r.date.as_str(),
                r.party_name.as_str(),
                r.tax_registration_number.as_str(),
                r.rate,
                r.base,
                r.tax,
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "supplier",
                "2026-01-20",
                "شركة الشبكات المتحدة",
                "123456789",
                100,
                1_000_000,
                10_000
            ),
            (
                "customer",
                "2026-02-10",
                "شركة الأمل",
                "987654321",
                300,
                300_000,
                9_000
            ),
        ]
    );
    assert_eq!(
        report.rows[0].category,
        s.business.withholding_categories().unwrap()[0].name
    );
    assert_eq!((report.withheld, report.suffered), (10_000, 9_000));
    assert_eq!(
        code(s.business.withholding_report("2026-04-01", "2026-03-01")),
        "date_range_invalid"
    );
}

#[test]
fn the_tax_must_be_less_than_the_payment_and_only_on_egp() {
    let s = setup();
    let base = || PaymentInput::new("2026-02-10", s.amal, s.account("bank"), 1_000);
    assert_eq!(
        code(
            s.business
                .receive_customer_payment(&base().withholding(s.services, 100_000))
        ),
        "withholding_invalid"
    );
    assert_eq!(
        code(
            s.business
                .receive_customer_payment(&base().withholding(s.services, -1))
        ),
        "withholding_invalid"
    );
    let usd = s
        .business
        .add_supplier(&SupplierInput {
            name: "Shenzhen".into(),
            currency: Some("USD".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        code(
            s.business.pay_supplier(
                &PaymentInput {
                    party_id: usd,
                    ..base()
                }
                .at_rate(50_000_000)
                .withholding(s.supplies, 100)
            )
        ),
        "withholding_not_egp"
    );
}
