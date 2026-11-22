//! Ported from `src/core/reports.test.ts` and `src/core/vat-return.test.ts`. The reports match the
//! TypeScript core's golden files field for field.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::invoices::{
    CreditLineInput, CreditNoteInput, InvoiceLineInput, SalesInvoiceInput,
};
use manager_core::ledger::{JournalEntryInput, JournalLine};
use manager_core::money::{ExpenseInput, PaidFrom};
use manager_core::purchases::{
    DebitNoteInput, PurchaseInvoiceInput, PurchaseLineInput, ReturnedLine, SupplierInput,
};
use manager_core::reports::{Dashboard, MethodSalesRow};
use manager_core::returns::{ReturnInput, ReturnLineInput};
use manager_core::sales::{PaymentInput, SaleInput, SaleLineInput};
use manager_core::shipments::{ImportShipmentInput, ShipmentCostInput};
use manager_core::{Business, BusinessSettings};
use serde::Serialize;

/** The report as JSON against the TypeScript core's golden file. */
fn golden(name: &str, value: &impl Serialize) {
    let path = format!(
        "{}/../../src/core/__golden__/reports/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(value).unwrap(), expected, "{name}");
}

fn computers(vat_registered: bool) -> Business {
    let settings = BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        address: String::new(),
        vat_registered,
        ..shop()
    };
    Business::create(":memory:", &settings, &manager()).unwrap()
}

fn named(business: &Business, name: &str) -> i64 {
    business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.name == name)
        .unwrap()
        .id
}

fn purchase_line(item_id: i64, quantity: f64, unit_price: f64) -> PurchaseLineInput {
    PurchaseLineInput {
        item_id,
        unit: "base".into(),
        quantity,
        unit_price,
        serials: None,
    }
}

fn expense(date: &str, account: i64, amount: f64, vat: f64, paid_from: PaidFrom) -> ExpenseInput {
    ExpenseInput {
        date: date.into(),
        expense_account_id: account,
        amount,
        vat,
        paid_from,
        memo: String::new(),
    }
}

struct Sample {
    business: Business,
    router: i64,
}

/** A fixed sample business for March 2026: a purchase, a till sale, an invoice with a credit note, and rent. */
fn sample() -> Sample {
    let business = computers(true);
    let main = main_warehouse(&business);
    let role = |r: &str| role_account(&business, r);
    let router = business
        .add_item(&piece(&business, "راوتر", 114_000))
        .unwrap();
    let supplier = business
        .add_supplier(&SupplierInput {
            name: "مورد".into(),
            ..Default::default()
        })
        .unwrap();
    let customer = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            ..Default::default()
        })
        .unwrap();
    business
        .post_journal_entry(&JournalEntryInput {
            date: "2026-03-01".into(),
            memo: "رأس المال".into(),
            lines: vec![
                JournalLine::debit(role("main_cash"), 1_000_000),
                JournalLine::credit(role("capital"), 1_000_000),
            ],
        })
        .unwrap();
    business
        .post_purchase_invoice(&PurchaseInvoiceInput {
            date: "2026-03-01".into(),
            supplier_id: supplier,
            warehouse_id: main,
            reference: String::new(),
            rate: None,
            lines: vec![purchase_line(router, 10_000.0, 60_000.0)],
        })
        .unwrap();
    business.open_shift(0.0).unwrap();
    business
        .post_sale(&SaleInput {
            date: "2026-03-02".into(),
            warehouse_id: main,
            lines: vec![SaleLineInput::base(router, 2_000)],
            payments: vec![PaymentInput::new("cash", 230_000)],
            ..Default::default()
        })
        .unwrap();
    let invoice = business
        .post_sales_invoice(&SalesInvoiceInput {
            date: "2026-03-03".into(),
            customer_id: customer,
            warehouse_id: main,
            lines: vec![InvoiceLineInput::base(router, 3_000, 100_000)],
            ..Default::default()
        })
        .unwrap();
    let line_id = business.find_sales_invoice(invoice.number).unwrap().lines[0].line_id;
    business
        .post_credit_note(&CreditNoteInput {
            date: "2026-03-04".into(),
            invoice_id: invoice.id,
            reason: "مرتجع".into(),
            lines: vec![CreditLineInput::new(line_id, 1_000)],
        })
        .unwrap();
    let rent = named(&business, "الإيجار");
    business
        .record_expense(&expense(
            "2026-03-05",
            rent,
            50_000.0,
            0.0,
            PaidFrom::Account {
                account_id: role("main_cash"),
            },
        ))
        .unwrap();
    Sample { business, router }
}

#[test]
fn profit_and_loss_sales_after_the_credit_note_cost_of_sales_and_rent() {
    let s = sample();
    let pnl = s
        .business
        .profit_and_loss("2026-03-01", "2026-03-31")
        .unwrap();
    assert_eq!(
        (pnl.total_income, pnl.total_expenses, pnl.net_profit),
        (400_000, 290_000, 110_000)
    );
    golden("profit-and-loss", &pnl);
}

#[test]
fn the_balance_sheet_balances_with_the_periods_profit_under_equity() {
    let s = sample();
    let bs = s.business.balance_sheet("2026-03-31").unwrap();
    assert_eq!(bs.profit, 110_000);
    assert_eq!(bs.total_assets, bs.total_liabilities_and_equity);
    golden("balance-sheet", &bs);
}

#[test]
fn the_general_ledger_brings_the_balance_forward_and_drills_down_to_each_entry() {
    let s = sample();
    let cash = s
        .business
        .general_ledger(
            role_account(&s.business, "main_cash"),
            "2026-03-02",
            "2026-03-31",
        )
        .unwrap();
    assert_eq!((cash.opening, cash.closing), (1_000_000, 950_000));
    let entry = s.business.journal_entry(cash.lines[0].entry_id).unwrap();
    assert_eq!((entry.kind.as_str(), entry.voided), ("expense", false));
    let lines: Vec<(&str, i64, i64)> = entry
        .lines
        .iter()
        .map(|l| (l.name.as_str(), l.debit, l.credit))
        .collect();
    assert_eq!(
        lines,
        vec![("الإيجار", 50_000, 0), ("الخزينة الرئيسية", 0, 50_000)]
    );
    golden("general-ledger", &cash);
    assert_eq!(code(s.business.journal_entry(9_999)), "entry_not_found");
    assert_eq!(
        code(s.business.general_ledger(9_999, "2026-03-01", "2026-03-31")),
        "account_not_found"
    );
}

#[test]
fn sales_by_item_by_day_and_by_payment_method() {
    let s = sample();
    let by_item = s
        .business
        .sales_by_item("2026-03-01", "2026-03-31")
        .unwrap();
    let rows: Vec<(&str, i64, i64, i64, i64)> = by_item
        .iter()
        .map(|r| {
            (
                r.name_ar.as_str(),
                r.quantity,
                r.net,
                r.cost,
                r.gross_profit,
            )
        })
        .collect();
    assert_eq!(rows, vec![("راوتر", 4_000, 400_000, 240_000, 160_000)]);
    let by_day = s.business.sales_by_day("2026-03-01", "2026-03-31").unwrap();
    let days: Vec<(&str, i64)> = by_day.iter().map(|r| (r.date.as_str(), r.total)).collect();
    assert_eq!(
        days,
        vec![
            ("2026-03-02", 228_000),
            ("2026-03-03", 342_000),
            ("2026-03-04", -114_000)
        ]
    );
    let method = |method, total| MethodSalesRow { method, total };
    assert_eq!(
        s.business
            .sales_by_payment_method("2026-03-01", "2026-03-31")
            .unwrap(),
        vec![
            method("cash", 228_000),
            method("card", 0),
            method("wallet", 0),
            method("credit", 228_000)
        ]
    );
    let docs: Vec<(String, i64, i64)> = s
        .business
        .sales_documents("2026-03-03", "2026-03-03")
        .unwrap()
        .into_iter()
        .map(|d| (d.kind, d.number, d.total))
        .collect();
    assert_eq!(docs, vec![("sales_invoice".into(), 1, 342_000)]);
    golden("sales-by-item", &by_item);
    golden("sales-by-day", &by_day);
    assert_eq!(
        code(s.business.sales_by_day("2026-03-31", "2026-03-01")),
        "date_range_invalid"
    );
}

#[test]
fn stock_quantity_and_value_at_any_date() {
    let s = sample();
    let early: Vec<(i64, i64)> = s
        .business
        .stock_at("2026-03-02")
        .unwrap()
        .rows
        .iter()
        .map(|r| (r.quantity, r.value))
        .collect();
    assert_eq!(early, vec![(8_000, 480_000)]);
    let end = s.business.stock_at("2026-03-31").unwrap();
    assert_eq!(end.total_value, 360_000);
    assert!(s.business.stock_at("2026-02-28").unwrap().rows.is_empty());
    golden("stock", &end);
}

#[test]
fn the_dashboard_shows_the_days_sales_profit_cash_expected_and_low_stock() {
    let s = sample();
    s.business
        .set_item_minimum(s.router, Some(10_000.0))
        .unwrap();
    assert_eq!(
        s.business.dashboard("2026-03-02").unwrap(),
        Dashboard {
            date: "2026-03-02".into(),
            sales: 228_000,
            gross_profit: 80_000,
            cash_expected: Some(228_000),
            low_stock: 1
        }
    );
    let json = serde_json::to_value(s.business.dashboard("2026-03-02").unwrap()).unwrap();
    assert_eq!(json["cashExpected"], 228_000);
}

mod vat {
    use super::*;

    /**
     * The worked sample month, March 2026: a till sale and a return, an invoice with standard and
     * zero-rated lines and a credit note, a local purchase and a debit note, an import with customs
     * VAT, two expenses with VAT (one voided), and a journal posted straight to input VAT.
     */
    fn sample() -> Business {
        let business = computers(true);
        let main = main_warehouse(&business);
        let role = |r: &str| role_account(&business, r);
        let item = |name: &str, unit: &str, price, kind| {
            business
                .add_item(&manager_core::items::ItemInput {
                    base_unit: unit.into(),
                    tax_code_id: tax_code(&business, kind),
                    ..piece(&business, name, price)
                })
                .unwrap()
        };
        let router = item("راوتر", "قطعة", 114_000, "standard");
        let book = item("كتاب للتصدير", "قطعة", 5_000, "zero_rated");
        let bread = item("خبز", "رغيف", 2_000, "exempt");
        let supplier = |name: &str, currency: Option<&str>| {
            business
                .add_supplier(&SupplierInput {
                    name: name.into(),
                    currency: currency.map(String::from),
                    ..Default::default()
                })
                .unwrap()
        };
        let local = supplier("مورد محلي", None);
        let foreign = supplier("Shenzhen Networks", Some("USD"));
        let customs = supplier("مصلحة الجمارك", None);
        let customer = business
            .add_customer(&CustomerInput {
                name: "شركة الأمل".into(),
                ..Default::default()
            })
            .unwrap();

        let purchase = business
            .post_purchase_invoice(&PurchaseInvoiceInput {
                date: "2026-03-01".into(),
                supplier_id: local,
                warehouse_id: main,
                reference: "P-100".into(),
                rate: None,
                lines: vec![
                    purchase_line(router, 10_000.0, 60_000.0),
                    purchase_line(bread, 20_000.0, 1_000.0),
                    purchase_line(book, 10_000.0, 3_000.0),
                ],
            })
            .unwrap();
        business.open_shift(0.0).unwrap();
        let sale = business
            .post_sale(&SaleInput {
                date: "2026-03-02".into(),
                warehouse_id: main,
                lines: vec![
                    SaleLineInput::base(router, 2_000),
                    SaleLineInput::base(bread, 1_000),
                ],
                payments: vec![PaymentInput::new("cash", 230_000)],
                ..Default::default()
            })
            .unwrap();
        let receipt = business.find_receipt(sale.number).unwrap();
        business
            .return_sale(&ReturnInput {
                date: "2026-03-03".into(),
                receipt_id: receipt.id,
                lines: vec![ReturnLineInput::new(receipt.lines[0].line_id, 1_000)],
                refund: "cash".into(),
            })
            .unwrap();
        let invoice = business
            .post_sales_invoice(&SalesInvoiceInput {
                date: "2026-03-04".into(),
                customer_id: customer,
                warehouse_id: main,
                lines: vec![
                    InvoiceLineInput::base(router, 3_000, 100_000),
                    InvoiceLineInput::base(book, 4_000, 4_000),
                ],
                ..Default::default()
            })
            .unwrap();
        let invoice_line = business.find_sales_invoice(invoice.number).unwrap().lines[0].line_id;
        business
            .post_credit_note(&CreditNoteInput {
                date: "2026-03-05".into(),
                invoice_id: invoice.id,
                reason: "مرتجع".into(),
                lines: vec![CreditLineInput::new(invoice_line, 1_000)],
            })
            .unwrap();
        let purchase_line_id = business
            .purchase_invoices()
            .unwrap()
            .into_iter()
            .find(|p| p.id == purchase)
            .unwrap()
            .lines[0]
            .line_id;
        business
            .post_debit_note(&DebitNoteInput {
                date: "2026-03-06".into(),
                purchase_invoice_id: purchase,
                reason: "تالف".into(),
                lines: vec![ReturnedLine {
                    line_id: purchase_line_id,
                    quantity: 1_000.0,
                    serials: None,
                }],
            })
            .unwrap();
        let imported = business
            .post_purchase_invoice(&PurchaseInvoiceInput {
                date: "2026-03-07".into(),
                supplier_id: foreign,
                warehouse_id: main,
                reference: "SZ-7".into(),
                rate: Some(50_000_000.0),
                lines: vec![purchase_line(router, 5_000.0, 10_000.0)],
            })
            .unwrap();
        business
            .post_import_shipment(&ImportShipmentInput {
                date: "2026-03-07".into(),
                reference: "BL-1".into(),
                purchase_invoice_ids: vec![imported],
                spread_by: "value".into(),
                costs: vec![ShipmentCostInput {
                    kind: "customs_duty".into(),
                    payee_id: customs,
                    amount: 30_000.0,
                    vat: 70_000.0,
                }],
            })
            .unwrap();
        let utilities = business
            .accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.kind == "expense" && a.name != "الإيجار" && a.role.is_none())
            .unwrap()
            .id;
        let rent = named(&business, "الإيجار");
        let cash = || PaidFrom::Account {
            account_id: role("main_cash"),
        };
        business
            .record_expense(&expense("2026-03-08", utilities, 10_000.0, 1_400.0, cash()))
            .unwrap();
        let voided = business
            .record_expense(&expense(
                "2026-03-09",
                utilities,
                5_000.0,
                700.0,
                PaidFrom::Supplier { supplier_id: local },
            ))
            .unwrap();
        business.void_entry(voided.entry_id, "2026-03-10").unwrap();
        business
            .record_expense(&expense("2026-03-11", rent, 50_000.0, 0.0, cash()))
            .unwrap();
        business
            .post_journal_entry(&JournalEntryInput {
                date: "2026-03-15".into(),
                memo: "تسوية ضريبة مدخلات".into(),
                lines: vec![
                    JournalLine::debit(role("input_vat"), 500),
                    JournalLine::credit(role("main_cash"), 500),
                ],
            })
            .unwrap();
        // April: outside the return.
        business
            .post_sales_invoice(&SalesInvoiceInput {
                date: "2026-04-01".into(),
                customer_id: customer,
                warehouse_id: main,
                lines: vec![InvoiceLineInput::base(router, 1_000, 100_000)],
                ..Default::default()
            })
            .unwrap();
        business
    }

    #[test]
    fn the_worked_sample_month_matches_to_the_piastre_by_section_and_tax_kind() {
        let business = sample();
        let r = business.vat_return("2026-03-01", "2026-03-31").unwrap();
        let boxes: Vec<(&str, &str, i64, i64)> = r
            .boxes
            .iter()
            .map(|b| (b.section, b.tax_kind, b.net, b.vat))
            .collect();
        assert_eq!(
            boxes,
            vec![
                // Till 200,000 − return 100,000 + invoice 300,000 − credit note 100,000.
                ("sales", "standard", 300_000, 42_000),
                ("sales", "zero_rated", 16_000, 0),
                ("sales", "exempt", 2_000, 0),
                // 600,000 less one router sent back; the USD invoice is an import and stays out.
                ("purchases", "standard", 540_000, 75_600),
                ("purchases", "zero_rated", 30_000, 0),
                ("purchases", "exempt", 20_000, 0),
                // The voided expense cancels itself; rent carries no VAT.
                ("expenses", "standard", 10_000, 1_400),
                ("imports", "standard", 30_000, 70_000),
            ]
        );
        assert_eq!(
            (
                r.output_vat,
                r.input_vat,
                r.output_adjustments,
                r.input_adjustments,
                r.net_due
            ),
            (42_000, 147_000, 0, 500, -105_500)
        );
        golden("vat-return", &r);
    }

    #[test]
    fn every_figure_drills_down_to_the_documents_behind_it() {
        let business = sample();
        let r = business.vat_return("2026-03-01", "2026-03-31").unwrap();
        let behind =
            |section: &str, tax_kind: &str| -> Vec<(String, String, String, String, i64, i64)> {
                r.transactions
                    .iter()
                    .filter(|t| t.section == section && t.tax_kind == tax_kind)
                    .map(|t| {
                        (
                            t.kind.clone(),
                            t.number.clone(),
                            t.date.clone(),
                            t.party.clone(),
                            t.net,
                            t.vat,
                        )
                    })
                    .collect()
            };
        let row = |k: &str, n: &str, d: &str, p: &str, net, vat| {
            (
                k.to_string(),
                n.to_string(),
                d.to_string(),
                p.to_string(),
                net,
                vat,
            )
        };
        assert_eq!(
            behind("sales", "standard"),
            vec![
                row("sale", "1", "2026-03-02", "", 200_000, 28_000),
                row("sale_return", "1", "2026-03-03", "", -100_000, -14_000),
                row(
                    "sales_invoice",
                    "1",
                    "2026-03-04",
                    "شركة الأمل",
                    300_000,
                    42_000
                ),
                row(
                    "credit_note",
                    "1",
                    "2026-03-05",
                    "شركة الأمل",
                    -100_000,
                    -14_000
                ),
            ]
        );
        assert_eq!(
            behind("expenses", "standard"),
            vec![
                row("expense", "1", "2026-03-08", "", 10_000, 1_400),
                row("expense", "2", "2026-03-09", "مورد محلي", 5_000, 700),
                row("expense_void", "2", "2026-03-10", "مورد محلي", -5_000, -700),
            ]
        );
        let debit_note = r
            .transactions
            .iter()
            .find(|t| t.kind == "debit_note")
            .unwrap();
        assert_eq!(
            business.journal_entry(debit_note.entry_id).unwrap().kind,
            "debit_note"
        );
    }

    #[test]
    fn the_ledger_agrees_the_vat_accounts_moved_by_the_returns_figures() {
        let business = sample();
        let r = business.vat_return("2026-03-01", "2026-03-31").unwrap();
        let moved = |role: &str| {
            let ledger = business
                .general_ledger(role_account(&business, role), "2026-03-01", "2026-03-31")
                .unwrap();
            ledger.closing - ledger.opening
        };
        assert_eq!(-moved("output_vat"), r.output_vat + r.output_adjustments);
        assert_eq!(moved("input_vat"), r.input_vat + r.input_adjustments);
    }

    #[test]
    fn a_business_not_registered_for_vat_has_no_return() {
        let business = computers(false);
        assert_eq!(
            code(business.vat_return("2026-03-01", "2026-03-31")),
            "not_vat_registered"
        );
    }
}
