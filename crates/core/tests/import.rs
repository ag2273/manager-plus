//! Ported from `src/core/import.test.ts`.
mod common;

use common::*;
use manager_core::import::{parse_money, parse_quantity, ImportInput, ImportProblem, ImportSheet};
use manager_core::items::ItemsOptions;
use manager_core::Business;

const ITEMS_HEADER: [&str; 10] = [
    "اسم الصنف بالعربية",
    "الوحدة",
    "الباركود",
    "سعر البيع شامل الضريبة",
    "الضريبة",
    "وحدة العبوة",
    "عدد الوحدات في العبوة",
    "سعر العبوة",
    "الكمية الافتتاحية",
    "تكلفة الوحدة",
];

fn row(cells: &[&str]) -> Vec<String> {
    cells.iter().map(|c| c.to_string()).collect()
}

fn sheet(name: &str, rows: Vec<Vec<String>>) -> ImportSheet {
    ImportSheet {
        name: name.into(),
        rows,
    }
}

fn setup() -> (Business, i64, String) {
    let business = new_shop();
    let warehouse = main_warehouse(&business);
    let cash = business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.role.as_deref() == Some("main_cash"))
        .unwrap()
        .code;
    (business, warehouse, cash)
}

fn input(warehouse_id: i64, sheets: Vec<ImportSheet>) -> ImportInput {
    ImportInput {
        date: "2026-01-01".into(),
        warehouse_id,
        sheets,
    }
}

fn good_file(cash: &str) -> Vec<ImportSheet> {
    vec![
        sheet(
            "الأصناف",
            vec![
                vec![],
                row(&ITEMS_HEADER),
                row(&[
                    "راوتر",
                    "قطعة",
                    "6221000000017",
                    "1,140.00",
                    "عام",
                    "كرتونة",
                    "10",
                    "11000",
                    "25",
                    "600",
                ]),
                row(&[
                    "كتاب",
                    "قطعة",
                    "6221000000024",
                    "50",
                    "معفى",
                    "",
                    "",
                    "",
                    "",
                    "",
                ]),
                row(&["", "", "", "", "", "", "", "", "", ""]),
                row(&["كابل", "متر", "", "11.4", "", "", "", "", "100.5", "5.25"]),
            ],
        ),
        sheet(
            "Opening balances",
            vec![
                row(&["Type", "Name or account code", "Debit", "Credit"]),
                row(&["account", cash, "5000", ""]),
                row(&["customer", "شركة الأمل", "1250.50", ""]),
                row(&["supplier", "مورد قديم", "", "3000"]),
            ],
        ),
    ]
}

fn items(business: &Business) -> Vec<manager_core::items::Item> {
    business.items(&ItemsOptions::default()).unwrap()
}

#[test]
fn amounts_and_quantities_read_as_typed_in_either_digits() {
    assert_eq!(parse_money("1,140.00"), Some(114_000));
    assert_eq!(parse_money("١٢٥٠٫٥"), Some(125_050));
    assert_eq!(parse_money(" 11.4 "), Some(1_140));
    assert_eq!(parse_money("1.234"), None);
    assert_eq!(parse_money("-5"), None);
    assert_eq!(parse_money("abc"), None);
    assert_eq!(parse_quantity("100.5"), Some(100_500));
    assert_eq!(parse_quantity("٣"), Some(3_000));
    assert_eq!(parse_quantity("1,5"), None);
}

#[test]
fn a_dry_run_counts_what_would_be_imported_and_saves_nothing() {
    let (business, warehouse, cash) = setup();
    let report = business
        .check_import(&input(warehouse, good_file(&cash)))
        .unwrap();
    assert_eq!(
        (
            report.items,
            report.stock_lines,
            report.stock_value,
            report.balances,
            report.new_customers,
            report.new_suppliers
        ),
        (3, 2, 1_500_000 + 52_763, 3, 1, 1)
    );
    assert!(report.problems.is_empty());
    assert!(items(&business).is_empty());
    assert!(business.customers().unwrap().is_empty());
    assert!(business
        .trial_balance("2026-12-31")
        .unwrap()
        .rows
        .is_empty());
}

#[test]
fn the_import_adds_the_items_and_posts_opening_stock_and_balances() {
    let (business, warehouse, cash) = setup();
    business
        .import_data(&input(warehouse, good_file(&cash)))
        .unwrap();
    let all = items(&business);
    let router = all.iter().find(|i| i.name_ar == "راوتر").unwrap();
    let pack = router.pack.as_ref().unwrap();
    assert_eq!(
        (
            router.base_unit.as_str(),
            router.barcode.as_deref(),
            router.sale_price,
            pack.name.as_str(),
            pack.size,
            pack.sale_price
        ),
        (
            "قطعة",
            Some("6221000000017"),
            114_000,
            "كرتونة",
            10_000,
            1_100_000
        )
    );
    assert_eq!(
        all.iter()
            .find(|i| i.name_ar == "كتاب")
            .unwrap()
            .tax_code_id,
        tax_code(&business, "exempt")
    );
    assert_eq!(business.stock_on_hand(router.id).unwrap().total, 25_000);
    // 25 × 600.00 + 100.5 m × 5.25 = 15,000.00 + 527.63
    assert_eq!(balance_of(&business, "stock"), 1_552_763);
    assert_eq!(balance_of(&business, "main_cash"), 500_000);
    let customer = business.customers().unwrap()[0].id;
    assert_eq!(business.customer_balance(customer).unwrap(), 125_050);
    let supplier = business.suppliers().unwrap()[0].id;
    assert_eq!(business.supplier_balance(supplier).unwrap(), 300_000);
    assert_eq!(
        balance_of(&business, "opening_balances"),
        -(1_552_763 + 500_000 + 125_050 - 300_000)
    );
}

#[test]
fn every_bad_row_is_reported_and_the_import_saves_nothing() {
    let (business, warehouse, _) = setup();
    let sheets = vec![
        sheet(
            "الأصناف",
            vec![
                row(&ITEMS_HEADER),
                row(&["راوتر", "قطعة", "111", "1140", "", "", "", "", "", ""]),
                row(&["سويتش", "قطعة", "111", "500", "", "", "", "", "", ""]),
                row(&["كابل", "متر", "", "", "", "", "", "", "", ""]),
                row(&["فلاشة", "قطعة", "", "100", "مخفض", "", "", "", "", ""]),
                row(&["ماوس", "قطعة", "", "100", "", "", "", "", "5", ""]),
                row(&["كيبورد", "قطعة", "", "abc", "", "", "", "", "", ""]),
            ],
        ),
        sheet(
            "أرصدة",
            vec![
                row(&["النوع", "الاسم أو كود الحساب", "مدين", "دائن"]),
                row(&["حساب", "9999", "10", ""]),
                row(&["شريك", "x", "10", ""]),
                row(&["عميل", "أ", "10", "5"]),
            ],
        ),
    ];
    let report = business
        .check_import(&input(warehouse, sheets.clone()))
        .unwrap();
    let problems: Vec<(&str, usize, Option<&str>, &str)> = report
        .problems
        .iter()
        .map(|p| (p.sheet.as_str(), p.row, p.column.as_deref(), p.code))
        .collect();
    assert_eq!(
        problems,
        vec![
            ("الأصناف", 3, Some("barcode"), "barcode_taken"),
            ("الأصناف", 4, Some("salePrice"), "import_value_required"),
            ("الأصناف", 5, Some("tax"), "tax_code_unknown"),
            ("الأصناف", 6, Some("unitCost"), "cost_required"),
            ("الأصناف", 7, Some("salePrice"), "price_invalid"),
            ("أرصدة", 2, Some("name"), "account_not_found"),
            ("أرصدة", 3, Some("type"), "party_type_unknown"),
            ("أرصدة", 4, Some("credit"), "line_amount_invalid"),
        ]
    );
    assert_eq!(
        code(business.import_data(&input(warehouse, sheets))),
        "import_invalid"
    );
    assert!(items(&business).is_empty());
    assert!(business.customers().unwrap().is_empty());
}

#[test]
fn a_sheet_without_a_required_column_or_a_file_with_no_known_sheet_is_refused() {
    let (business, warehouse, _) = setup();
    let no_unit = business
        .check_import(&input(
            warehouse,
            vec![sheet(
                "Items",
                vec![
                    row(&["Arabic name", "Sale price incl. VAT"]),
                    row(&["x", "1"]),
                ],
            )],
        ))
        .unwrap();
    assert_eq!(
        no_unit.problems,
        vec![ImportProblem {
            sheet: "Items".into(),
            row: 1,
            column: Some("baseUnit".into()),
            code: "import_column_missing",
            value: "الوحدة".into()
        }]
    );
    let nothing = business
        .check_import(&input(
            warehouse,
            vec![sheet("Sheet1", vec![row(&["a", "b"])])],
        ))
        .unwrap();
    let codes: Vec<&str> = nothing.problems.iter().map(|p| p.code).collect();
    assert_eq!(codes, vec!["import_nothing"]);
}

#[test]
fn a_csv_header_with_a_byte_order_mark_is_still_recognised() {
    let (business, warehouse, _) = setup();
    let mut header = row(&ITEMS_HEADER);
    header[0] = format!("\u{feff}{}", header[0]);
    let report = business
        .check_import(&input(
            warehouse,
            vec![sheet(
                "items.csv",
                vec![
                    header,
                    row(&["راوتر", "قطعة", "", "1140", "", "", "", "", "", ""]),
                ],
            )],
        ))
        .unwrap();
    assert_eq!((report.items, report.problems.len()), (1, 0));
}

#[test]
fn five_thousand_items_with_opening_stock_import_in_under_30_seconds() {
    let (business, warehouse, _) = setup();
    let mut rows = vec![row(&ITEMS_HEADER)];
    for i in 0..5_000 {
        let name = format!("صنف {i}");
        let barcode = (6_220_000_000_000_i64 + i).to_string();
        rows.push(row(&[
            &name, "قطعة", &barcode, "114", "", "", "", "", "3", "60",
        ]));
    }
    let started = std::time::Instant::now();
    let report = business
        .import_data(&input(warehouse, vec![sheet("الأصناف", rows)]))
        .unwrap();
    assert!(started.elapsed().as_secs() < 30);
    assert_eq!(
        (report.items, report.stock_lines, report.problems.len()),
        (5_000, 5_000, 0)
    );
    assert_eq!(items(&business).len(), 5_000);
}
