//! Ported from `src/core/money.test.ts`.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::ledger::{JournalEntryInput, JournalLine, NewAccount};
use manager_core::money::{ExpenseInput, MoneyTransferInput, PaidFrom, Reconciliation};
use manager_core::purchases::SupplierInput;
use manager_core::settlements::PaymentInput;
use manager_core::Business;

struct Setup {
    business: Business,
    supplier: i64,
}

fn setup() -> Setup {
    let business = new_shop();
    let role = |r: &str| role_account(&business, r);
    // 10,000.00 into the main cash and 50,000.00 into the bank.
    business
        .post_journal_entry(&JournalEntryInput {
            date: "2026-01-01".into(),
            memo: "رأس المال".into(),
            lines: vec![
                JournalLine::debit(role("main_cash"), 1_000_000),
                JournalLine::debit(role("bank"), 5_000_000),
                JournalLine::credit(role("capital"), 6_000_000),
            ],
        })
        .unwrap();
    let supplier = business
        .add_supplier(&SupplierInput {
            name: "شركة الكهرباء".into(),
            ..Default::default()
        })
        .unwrap();
    Setup { business, supplier }
}

impl Setup {
    fn account(&self, role: &str) -> i64 {
        role_account(&self.business, role)
    }
    fn named(&self, name: &str) -> i64 {
        self.business
            .accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.name == name)
            .unwrap()
            .id
    }
    fn balance(&self, account_id: i64) -> i64 {
        self.business
            .trial_balance("2026-12-31")
            .unwrap()
            .rows
            .into_iter()
            .find(|r| r.account_id == account_id)
            .map_or(0, |r| r.debit - r.credit)
    }
    fn expense(
        &self,
        date: &str,
        account: i64,
        amount: i64,
        vat: i64,
        paid_from: PaidFrom,
    ) -> ExpenseInput {
        ExpenseInput {
            date: date.into(),
            expense_account_id: account,
            amount: amount as f64,
            vat: vat as f64,
            paid_from,
            memo: String::new(),
        }
    }
    fn cash(&self) -> PaidFrom {
        PaidFrom::Account {
            account_id: self.account("main_cash"),
        }
    }
    fn transfer(&self, date: &str, from: i64, to: i64, amount: i64) -> manager_core::Result<i64> {
        self.business
            .transfer_money(&MoneyTransferInput {
                date: date.into(),
                from_account_id: from,
                to_account_id: to,
                amount: amount as f64,
                memo: String::new(),
            })
            .map(|t| t.entry_id)
    }
}

#[test]
fn cash_bank_and_wallet_accounts_are_listed_with_balances_from_the_ledger() {
    let s = setup();
    let extra = s
        .business
        .add_account(&NewAccount {
            code: "1125".into(),
            name: "بنك مصر".into(),
            kind: "asset".into(),
        })
        .unwrap();
    let list = s.business.money_accounts("2026-12-31").unwrap();
    let balances: Vec<(&str, i64)> = list.iter().map(|a| (a.code.as_str(), a.balance)).collect();
    assert_eq!(
        balances,
        vec![
            ("1100", 0),
            ("1110", 1_000_000),
            ("1120", 5_000_000),
            ("1125", 0),
            ("1130", 0),
            ("1140", 0)
        ]
    );
    assert_eq!(list.iter().find(|a| a.id == extra).unwrap().name, "بنك مصر");
}

#[test]
fn an_expense_debits_the_expense_and_input_vat_and_credits_the_money_account_or_the_supplier() {
    let s = setup();
    let rent = s.named("الإيجار");
    let power = s.named("الكهرباء والمياه");
    let paid = s
        .business
        .record_expense(&ExpenseInput {
            memo: "إيجار فبراير".into(),
            ..s.expense("2026-02-01", rent, 500_000, 0, s.cash())
        })
        .unwrap();
    assert_eq!(paid.number, 1);
    s.business
        .record_expense(&s.expense(
            "2026-02-02",
            power,
            100_000,
            14_000,
            PaidFrom::Supplier {
                supplier_id: s.supplier,
            },
        ))
        .unwrap();

    assert_eq!(s.balance(rent), 500_000);
    assert_eq!(s.balance(s.account("main_cash")), 500_000);
    assert_eq!(s.balance(power), 100_000);
    assert_eq!(s.balance(s.account("input_vat")), 14_000);
    assert_eq!(s.business.supplier_balance(s.supplier).unwrap(), 114_000);
    let expenses: Vec<(i64, String, i64, i64, String)> = s
        .business
        .expenses()
        .unwrap()
        .into_iter()
        .map(|e| (e.number, e.account_name, e.amount, e.vat, e.paid_from))
        .collect();
    assert_eq!(
        expenses,
        vec![
            (
                2,
                "الكهرباء والمياه".into(),
                100_000,
                14_000,
                "شركة الكهرباء".into()
            ),
            (1, "الإيجار".into(), 500_000, 0, "الخزينة الرئيسية".into()),
        ]
    );
    assert_eq!(
        code(s.business.record_expense(&s.expense(
            "2026-02-01",
            s.account("bank"),
            1,
            0,
            s.cash()
        ))),
        "account_not_allowed"
    );
    assert_eq!(
        code(s.business.record_expense(&s.expense(
            "2026-02-01",
            rent,
            1,
            0,
            PaidFrom::Account { account_id: rent }
        ))),
        "account_not_allowed"
    );
}

#[test]
fn the_screens_send_paid_from_as_an_account_or_a_supplier() {
    let account: PaidFrom = serde_json::from_value(serde_json::json!({ "accountId": 7 })).unwrap();
    let supplier: PaidFrom =
        serde_json::from_value(serde_json::json!({ "supplierId": 3 })).unwrap();
    assert!(matches!(account, PaidFrom::Account { account_id: 7 }));
    assert!(matches!(supplier, PaidFrom::Supplier { supplier_id: 3 }));
}

#[test]
fn a_transfer_moves_money_between_two_money_accounts() {
    let s = setup();
    let (bank, cash) = (s.account("bank"), s.account("main_cash"));
    s.transfer("2026-02-01", bank, cash, 200_000).unwrap();
    assert_eq!(s.balance(bank), 4_800_000);
    assert_eq!(s.balance(cash), 1_200_000);
    assert_eq!(
        code(s.transfer("2026-02-01", bank, bank, 1)),
        "account_not_allowed"
    );
}

#[test]
fn reconciling_ticks_lines_as_cleared_and_sets_the_cleared_balance_against_the_statement() {
    let s = setup();
    let bank = s.account("bank");
    s.transfer("2026-02-01", bank, s.account("main_cash"), 200_000)
        .unwrap();
    s.business
        .record_expense(&s.expense(
            "2026-02-03",
            s.named("عمولات البنوك والبطاقات"),
            1_500,
            0,
            PaidFrom::Account { account_id: bank },
        ))
        .unwrap();

    let lines = s
        .business
        .account_lines(bank, "2026-01-01", "2026-12-31")
        .unwrap();
    let shown: Vec<(i64, i64, bool)> = lines
        .iter()
        .map(|l| (l.debit, l.credit, l.cleared))
        .collect();
    assert_eq!(
        shown,
        vec![
            (5_000_000, 0, false),
            (0, 200_000, false),
            (0, 1_500, false)
        ]
    );
    s.business
        .set_cleared(bank, &[lines[0].line_id, lines[1].line_id], true)
        .unwrap();
    assert_eq!(
        s.business.reconciliation(bank, 4_800_000.0).unwrap(),
        Reconciliation {
            balance: 4_798_500,
            cleared: 4_800_000,
            statement: 4_800_000,
            difference: 0
        }
    );
    assert_eq!(
        s.business
            .reconciliation(bank, 4_798_500.0)
            .unwrap()
            .difference,
        -1_500
    );
    assert_eq!(
        code(
            s.business
                .set_cleared(s.account("main_cash"), &[lines[2].line_id], true)
        ),
        "line_not_found"
    );
}

#[test]
fn nothing_can_be_posted_on_or_before_the_lock_date() {
    let s = setup();
    let (bank, cash) = (s.account("bank"), s.account("main_cash"));
    s.business.set_lock_date(Some("2026-01-31")).unwrap();
    assert_eq!(
        s.business.lock_date().unwrap().as_deref(),
        Some("2026-01-31")
    );
    assert_eq!(
        code(s.transfer("2026-01-31", bank, cash, 1)),
        "period_locked"
    );
    s.transfer("2026-02-01", bank, cash, 1).unwrap();
    s.business.set_lock_date(None).unwrap();
    s.transfer("2026-01-15", bank, cash, 1).unwrap();

    let cashier = signed_in(&s.business, "سارة", "cashier");
    assert_eq!(
        code(cashier.set_lock_date(Some("2026-12-31"))),
        "not_allowed"
    );
}

#[test]
fn voiding_reverses_the_entry_on_the_void_date_keeps_both_in_the_ledger_and_is_audited() {
    let s = setup();
    let rent = s.named("الإيجار");
    let entry_id = s
        .business
        .record_expense(&s.expense("2026-02-01", rent, 500_000, 0, s.cash()))
        .unwrap()
        .entry_id;
    s.business.void_entry(entry_id, "2026-02-05").unwrap();
    assert_eq!(s.balance(rent), 0);
    assert_eq!(s.balance(s.account("main_cash")), 1_000_000);
    assert!(s.business.expenses().unwrap()[0].voided);
    assert_eq!(
        code(s.business.void_entry(entry_id, "2026-02-05")),
        "entry_voided"
    );
    let audit = &s.business.audit_log().unwrap()[0];
    assert_eq!(
        (audit.action.as_str(), audit.entity_id),
        ("voidEntry", Some(entry_id))
    );

    // Documents with their own undo (a receipt, an invoice) are not voided here.
    let amal = s
        .business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            ..Default::default()
        })
        .unwrap();
    s.business
        .receive_customer_payment(&PaymentInput::new(
            "2026-02-01",
            amal,
            s.account("bank"),
            100,
        ))
        .unwrap();
    let receipt = s
        .business
        .account_lines(s.account("bank"), "2026-02-01", "2026-02-01")
        .unwrap()[0]
        .entry_id;
    assert_eq!(
        code(s.business.void_entry(receipt, "2026-02-05")),
        "entry_not_voidable"
    );

    // An entry in a locked period is voided by a reversal dated after the lock.
    let early = s
        .transfer("2026-02-08", s.account("bank"), s.account("main_cash"), 1)
        .unwrap();
    s.business.set_lock_date(Some("2026-02-10")).unwrap();
    assert_eq!(
        code(s.business.void_entry(early, "2026-02-09")),
        "period_locked"
    );
    s.business.void_entry(early, "2026-02-11").unwrap();
    assert!(s.business.money_transfers().unwrap()[0].voided);
}
