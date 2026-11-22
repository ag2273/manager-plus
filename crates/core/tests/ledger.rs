//! Ported from `src/core/ledger.test.ts`.
mod common;

use common::*;
use manager_core::ledger::{
    AccountChanges, JournalEntryInput, JournalLine, NewAccount, TrialBalance, TrialBalanceRow,
};
use manager_core::Business;

fn entry(date: &str, lines: Vec<JournalLine>) -> JournalEntryInput {
    JournalEntryInput {
        date: date.into(),
        memo: String::new(),
        lines,
    }
}

fn rent_paid(business: &Business, date: &str, amount: i64) -> JournalEntryInput {
    entry(
        date,
        vec![
            JournalLine::debit(account(business, "6100"), amount),
            JournalLine::credit(account(business, "1110"), amount),
        ],
    )
}

fn line(business: &Business, code: &str, debit: Option<f64>, credit: Option<f64>) -> JournalLine {
    JournalLine {
        account_id: account(business, code),
        debit,
        credit,
        ..Default::default()
    }
}

#[test]
fn a_new_business_starts_with_the_egyptian_retail_chart_of_accounts() {
    let accounts: Vec<_> = new_shop()
        .accounts()
        .unwrap()
        .into_iter()
        .map(|a| (a.code, a.name, a.kind))
        .collect();
    for (code, name, kind) in [
        ("1100", "نقدية الدرج", "asset"),
        ("1200", "العملاء", "asset"),
        ("1300", "المخزون", "asset"),
        ("2100", "الموردون", "liability"),
        ("2200", "ضريبة القيمة المضافة على المبيعات", "liability"),
        ("3100", "رأس المال", "equity"),
        ("3900", "أرصدة افتتاحية", "equity"),
        ("4100", "المبيعات", "income"),
        ("5100", "تكلفة البضاعة المباعة", "expense"),
        ("6100", "الإيجار", "expense"),
    ] {
        assert!(
            accounts.contains(&(code.into(), name.into(), kind.into())),
            "{code}"
        );
    }
}

#[test]
fn a_new_business_has_an_empty_balanced_trial_balance() {
    assert_eq!(
        new_shop().trial_balance("2026-12-31").unwrap(),
        TrialBalance {
            rows: vec![],
            total_debit: 0,
            total_credit: 0
        }
    );
}

#[test]
fn a_balanced_entry_shows_in_the_trial_balance() {
    let business = new_shop();
    let (rent, cash) = (account(&business, "6100"), account(&business, "1110"));
    business
        .post_journal_entry(&JournalEntryInput {
            date: "2026-11-01".into(),
            memo: "إيجار نوفمبر".into(),
            lines: vec![
                JournalLine::debit(rent, 500_000),
                JournalLine::credit(cash, 500_000),
            ],
        })
        .unwrap();
    let row = |id, code: &str, name: &str, kind: &str, debit, credit| TrialBalanceRow {
        account_id: id,
        code: code.into(),
        name: name.into(),
        kind: kind.into(),
        debit,
        credit,
    };
    assert_eq!(
        business.trial_balance("2026-11-30").unwrap(),
        TrialBalance {
            rows: vec![
                row(cash, "1110", "الخزينة الرئيسية", "asset", 0, 500_000),
                row(rent, "6100", "الإيجار", "expense", 500_000, 0)
            ],
            total_debit: 500_000,
            total_credit: 500_000,
        }
    );
}

/** An account code with its debit and credit. */
type Line<'a> = (&'a str, Option<f64>, Option<f64>);

#[test]
fn bad_entries_are_refused_and_nothing_is_written() {
    let cases: Vec<(&str, Vec<Line>, &str)> = vec![
        (
            "debits and credits differ",
            vec![
                ("6100", Some(500_000.0), None),
                ("1110", None, Some(499_999.0)),
            ],
            "entry_unbalanced",
        ),
        (
            "only one line",
            vec![("6100", Some(0.0), None)],
            "entry_needs_two_lines",
        ),
        (
            "a line has both",
            vec![
                ("6100", Some(100.0), Some(100.0)),
                ("1110", None, Some(0.0)),
            ],
            "line_amount_invalid",
        ),
        (
            "a line has no amount",
            vec![
                ("6100", Some(100.0), None),
                ("1110", None, Some(100.0)),
                ("1120", None, None),
            ],
            "line_amount_invalid",
        ),
        (
            "a fraction of a piastre",
            vec![("6100", Some(100.5), None), ("1110", None, Some(100.5))],
            "line_amount_invalid",
        ),
        (
            "a negative amount",
            vec![("6100", Some(-100.0), None), ("1110", None, Some(-100.0))],
            "line_amount_invalid",
        ),
    ];
    for (why, lines, expected) in cases {
        let business = new_shop();
        let lines = lines
            .into_iter()
            .map(|(c, d, cr)| line(&business, c, d, cr))
            .collect();
        assert_eq!(
            code(business.post_journal_entry(&entry("2026-11-01", lines))),
            expected,
            "{why}"
        );
        assert!(
            business
                .trial_balance("2026-12-31")
                .unwrap()
                .rows
                .is_empty(),
            "{why}"
        );
    }
}

#[test]
fn refused_when_an_account_doesnt_exist() {
    let business = new_shop();
    let lines = vec![
        JournalLine::debit(9999, 100),
        JournalLine::credit(account(&business, "1110"), 100),
    ];
    assert_eq!(
        code(business.post_journal_entry(&entry("2026-11-01", lines))),
        "account_not_found"
    );
}

#[test]
fn refused_when_the_date_is_not_a_real_date() {
    for date in ["2026-13-01", "2026-02-30", "01/11/2026", ""] {
        let business = new_shop();
        assert_eq!(
            code(business.post_journal_entry(&rent_paid(&business, date, 1))),
            "date_invalid",
            "{date}"
        );
    }
}

#[test]
fn entries_after_the_trial_balance_date_are_left_out() {
    let business = new_shop();
    business
        .post_journal_entry(&rent_paid(&business, "2026-11-01", 100))
        .unwrap();
    business
        .post_journal_entry(&rent_paid(&business, "2026-12-01", 200))
        .unwrap();
    assert_eq!(
        business.trial_balance("2026-11-30").unwrap().total_debit,
        100
    );
    assert_eq!(
        business.trial_balance("2026-12-31").unwrap().total_debit,
        300
    );
}

#[test]
fn an_account_whose_movements_cancel_out_is_not_listed() {
    let business = new_shop();
    let (bank, cash) = (account(&business, "1120"), account(&business, "1110"));
    business
        .post_journal_entry(&entry(
            "2026-11-01",
            vec![
                JournalLine::debit(bank, 100),
                JournalLine::credit(cash, 100),
            ],
        ))
        .unwrap();
    business
        .post_journal_entry(&entry(
            "2026-11-02",
            vec![
                JournalLine::debit(cash, 100),
                JournalLine::credit(bank, 100),
            ],
        ))
        .unwrap();
    assert_eq!(
        business.trial_balance("2026-11-30").unwrap(),
        TrialBalance {
            rows: vec![],
            total_debit: 0,
            total_credit: 0
        }
    );
}

fn new_account(code: &str, name: &str) -> NewAccount {
    NewAccount {
        code: code.into(),
        name: name.into(),
        kind: "expense".into(),
    }
}

#[test]
fn the_accountant_can_add_an_account() {
    let business = new_shop();
    let id = business
        .add_account(&new_account("6800", "دعاية وإعلان"))
        .unwrap();
    let added = business
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.id == id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(added).unwrap(),
        serde_json::json!({ "id": id, "code": "6800", "name": "دعاية وإعلان", "type": "expense", "role": null, "active": true })
    );
}

#[test]
fn two_accounts_cannot_share_a_code() {
    assert_eq!(
        code(new_shop().add_account(&new_account("6100", "إيجار مخزن"))),
        "account_code_taken"
    );
}

#[test]
fn an_account_needs_a_code_and_a_name() {
    let business = new_shop();
    assert_eq!(
        code(business.add_account(&new_account(" ", "x"))),
        "account_code_required"
    );
    assert_eq!(
        code(business.add_account(&new_account("6900", ""))),
        "account_name_required"
    );
}

#[test]
fn an_account_can_be_renamed_and_renumbered_and_keeps_its_history() {
    let business = new_shop();
    let rent = account(&business, "6100");
    business
        .post_journal_entry(&rent_paid(&business, "2026-11-01", 100))
        .unwrap();
    business
        .update_account(
            rent,
            &AccountChanges {
                code: Some("6110".into()),
                name: Some("إيجار المحل".into()),
            },
        )
        .unwrap();
    let rows = business.trial_balance("2026-11-30").unwrap().rows;
    assert!(rows.iter().any(|r| r.account_id == rent
        && r.code == "6110"
        && r.name == "إيجار المحل"
        && r.debit == 100));
}

#[test]
fn nothing_can_be_posted_to_an_inactive_account() {
    let business = new_shop();
    let entry = rent_paid(&business, "2026-11-01", 100);
    business
        .deactivate_account(account(&business, "6100"))
        .unwrap();
    assert_eq!(
        code(business.post_journal_entry(&entry)),
        "account_inactive"
    );
    assert!(
        !business
            .accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.code == "6100")
            .unwrap()
            .active
    );
}

#[test]
fn an_unused_account_can_be_deleted() {
    let business = new_shop();
    let id = business
        .add_account(&new_account("6800", "دعاية وإعلان"))
        .unwrap();
    business.delete_account(id).unwrap();
    assert!(!business.accounts().unwrap().iter().any(|a| a.id == id));
}

#[test]
fn an_account_with_postings_cannot_be_deleted() {
    let business = new_shop();
    business
        .post_journal_entry(&rent_paid(&business, "2026-11-01", 100))
        .unwrap();
    assert_eq!(
        code(business.delete_account(account(&business, "6100"))),
        "account_has_postings"
    );
}

#[test]
fn an_account_the_app_posts_to_automatically_cannot_be_deleted_or_deactivated() {
    let business = new_shop();
    let sales = account(&business, "4100");
    assert_eq!(code(business.delete_account(sales)), "account_is_system");
    assert_eq!(
        code(business.deactivate_account(sales)),
        "account_is_system"
    );
}

#[test]
fn opening_balances_post_against_the_opening_balances_account_so_the_books_balance() {
    let business = new_shop();
    let opening = account(&business, "3900");
    business
        .post_opening_balances(
            "2026-01-01",
            &[
                JournalLine::debit(account(&business, "1110"), 1_000_000),
                JournalLine::debit(account(&business, "1300"), 5_000_000),
                JournalLine::credit(account(&business, "2100"), 1_500_000),
            ],
        )
        .unwrap();
    let tb = business.trial_balance("2026-01-01").unwrap();
    assert!(tb
        .rows
        .iter()
        .any(|r| r.account_id == opening && r.debit == 0 && r.credit == 4_500_000));
    assert_eq!((tb.total_debit, tb.total_credit), (6_000_000, 6_000_000));
}

#[test]
fn posted_entries_are_still_there_after_the_file_is_reopened() {
    let (_dir, path) = temp_file("shop.mplus");
    let business = Business::create(&path, &shop(), &manager()).unwrap();
    business
        .post_journal_entry(&rent_paid(&business, "2026-11-01", 100))
        .unwrap();
    business.close();
    let file = Business::open(&path).unwrap();
    let reopened = file.sign_in(&manager().name, &manager().password).unwrap();
    assert_eq!(
        reopened.trial_balance("2026-11-30").unwrap().total_debit,
        100
    );
}

#[test]
fn renumbering_an_account_to_a_code_in_use_is_refused() {
    let business = new_shop();
    let changes = AccountChanges {
        code: Some("1110".into()),
        name: None,
    };
    assert_eq!(
        code(business.update_account(account(&business, "6100"), &changes)),
        "account_code_taken"
    );
}

#[test]
fn a_deactivated_account_can_be_reactivated_and_posted_to_again() {
    let business = new_shop();
    let rent = account(&business, "6100");
    business.deactivate_account(rent).unwrap();
    business.reactivate_account(rent).unwrap();
    business
        .post_journal_entry(&rent_paid(&business, "2026-11-01", 100))
        .unwrap();
    assert_eq!(
        business.trial_balance("2026-11-30").unwrap().total_debit,
        100
    );
}

#[test]
fn opening_balances_that_already_balance_post_no_balancing_line() {
    let business = new_shop();
    business
        .post_opening_balances(
            "2026-01-01",
            &[
                JournalLine::debit(account(&business, "1110"), 1_000),
                JournalLine::credit(account(&business, "3100"), 1_000),
            ],
        )
        .unwrap();
    let codes: Vec<_> = business
        .trial_balance("2026-01-01")
        .unwrap()
        .rows
        .into_iter()
        .map(|r| r.code)
        .collect();
    assert_eq!(codes, ["1110", "3100"]);
}

#[test]
fn nothing_can_be_posted_on_or_before_the_lock_date() {
    let business = new_shop();
    business.set_lock_date(Some("2026-01-31")).unwrap();
    assert_eq!(business.lock_date().unwrap().as_deref(), Some("2026-01-31"));
    assert_eq!(
        code(business.post_journal_entry(&rent_paid(&business, "2026-01-31", 1))),
        "period_locked"
    );
    business
        .post_journal_entry(&rent_paid(&business, "2026-02-01", 1))
        .unwrap();
    business.set_lock_date(None).unwrap();
    business
        .post_journal_entry(&rent_paid(&business, "2026-01-15", 1))
        .unwrap();
}

#[test]
fn the_screens_call_the_facade_by_name_with_json() {
    let business = new_shop();
    let rent = account(&business, "6100");
    let cash = account(&business, "1110");
    let id = business
        .call(
            "postJournalEntry",
            &[serde_json::json!({ "date": "2026-11-01", "memo": "", "lines": [{ "accountId": rent, "debit": 100 }, { "accountId": cash, "credit": 100 }] })],
        )
        .unwrap();
    assert!(id.as_i64().unwrap() > 0);
    let tb = business
        .call("trialBalance", &[serde_json::json!("2026-11-30")])
        .unwrap();
    assert_eq!(tb["totalDebit"], 100);
    assert_eq!(code(business.call("customers", &[])), "not_ported");
}
