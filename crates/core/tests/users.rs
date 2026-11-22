//! Ported from `src/core/users.test.ts`. Its items test is in `items.rs`.
mod common;

use common::*;
use manager_core::ledger::{JournalEntryInput, JournalLine, NewAccount};
use manager_core::users::{Credentials, NewUser, UserChanges};
use manager_core::{Business, LicenceLimits};
use rusqlite::Connection;

fn user(name: &str, role: &str, password: &str) -> NewUser {
    NewUser {
        name: name.into(),
        role: role.into(),
        password: password.into(),
    }
}

fn rent_entry(business: &Business) -> JournalEntryInput {
    JournalEntryInput {
        date: "2026-11-01".into(),
        memo: "إيجار".into(),
        lines: vec![
            JournalLine::debit(account(business, "6100"), 100),
            JournalLine::credit(account(business, "1110"), 100),
        ],
    }
}

fn saved_shop() -> (tempfile::TempDir, String) {
    let (dir, path) = temp_file("shop.mplus");
    Business::create(&path, &shop(), &manager())
        .unwrap()
        .close();
    (dir, path)
}

#[test]
fn creating_a_business_makes_its_first_user_a_manager_signed_in() {
    let business = new_shop();
    let me = business.current_user().unwrap();
    assert_eq!(
        (me.name.as_str(), me.role.as_str(), me.active),
        ("أيمن", "manager", true)
    );
    assert_eq!(business.users().unwrap().len(), 1);
}

#[test]
fn a_business_needs_a_manager_name_and_a_password_of_at_least_6_characters() {
    let blank = Credentials {
        name: " ".into(),
        password: "123456".into(),
    };
    assert_eq!(
        code(Business::create(":memory:", &shop(), &blank)),
        "user_name_required"
    );
    let short = Credentials {
        name: "أيمن".into(),
        password: "12345".into(),
    };
    assert_eq!(
        code(Business::create(":memory:", &shop(), &short)),
        "password_too_short"
    );
}

#[test]
fn passwords_are_never_stored_as_typed() {
    let (_dir, path) = saved_shop();
    let conn = Connection::open(&path).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT group_concat(name || password_hash) FROM users",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!stored.contains(&manager().password));
}

#[test]
fn an_opened_file_must_be_signed_into_before_anything_else_but_its_settings() {
    let (_dir, path) = saved_shop();
    let file = Business::open(&path).unwrap();
    assert_eq!(file.settings().unwrap().name, shop().name);
    assert!(file.current_user().is_none());
    assert_eq!(code(file.accounts()), "sign_in_required");
}

#[test]
fn signing_in_with_the_right_password_works_a_wrong_one_is_refused() {
    let (_dir, path) = saved_shop();
    let file = Business::open(&path).unwrap();
    assert_eq!(code(file.sign_in("أيمن", "غلط غلط")), "sign_in_failed");
    assert_eq!(
        code(file.sign_in("مش موجود", &manager().password)),
        "sign_in_failed"
    );
    let session = file.sign_in(" أيمن ", &manager().password).unwrap();
    assert_eq!(session.current_user().unwrap().name, "أيمن");
    assert!(!session.accounts().unwrap().is_empty());
}

#[test]
fn a_deactivated_user_cannot_sign_in() {
    let business = new_shop();
    let id = business
        .add_user(&user("سارة", "cashier", "123456"))
        .unwrap();
    business.deactivate_user(id).unwrap();
    assert_eq!(code(business.sign_in("سارة", "123456")), "sign_in_failed");
}

#[test]
fn a_manager_adds_users_with_a_role() {
    let business = new_shop();
    business
        .add_user(&user("سارة", "cashier", "123456"))
        .unwrap();
    business
        .add_user(&user("محمود", "accountant", "123456"))
        .unwrap();
    let users: Vec<_> = business
        .users()
        .unwrap()
        .into_iter()
        .map(|u| (u.name, u.role))
        .collect();
    let expected: Vec<(String, String)> = [
        ("أيمن", "manager"),
        ("سارة", "cashier"),
        ("محمود", "accountant"),
    ]
    .iter()
    .map(|(n, r)| (n.to_string(), r.to_string()))
    .collect();
    assert_eq!(users, expected);
}

#[test]
fn two_users_cannot_share_a_name() {
    assert_eq!(
        code(new_shop().add_user(&user("أيمن", "cashier", "123456"))),
        "user_name_taken"
    );
}

#[test]
fn a_role_must_be_one_of_the_four() {
    assert_eq!(
        code(new_shop().add_user(&user("سارة", "boss", "123456"))),
        "role_invalid"
    );
}

#[test]
fn a_manager_can_rename_a_user_change_their_role_and_reset_their_password() {
    let business = new_shop();
    let id = business
        .add_user(&user("سارة", "cashier", "123456"))
        .unwrap();
    business
        .update_user(
            id,
            &UserChanges {
                name: Some("سارة أحمد".into()),
                role: Some("storekeeper".into()),
            },
        )
        .unwrap();
    business.reset_password(id, "654321").unwrap();
    let signed_in = business.sign_in("سارة أحمد", "654321").unwrap();
    let me = signed_in.current_user().unwrap();
    assert_eq!(
        (me.name.as_str(), me.role.as_str()),
        ("سارة أحمد", "storekeeper")
    );
}

#[test]
fn anyone_can_change_their_own_password_with_the_current_one() {
    let business = new_shop();
    business
        .add_user(&user("سارة", "cashier", "123456"))
        .unwrap();
    let sara = business.sign_in("سارة", "123456").unwrap();
    assert_eq!(
        code(sara.change_own_password("خطأ", "abcdef")),
        "sign_in_failed"
    );
    sara.change_own_password("123456", "abcdef").unwrap();
    assert_eq!(
        business
            .sign_in("سارة", "abcdef")
            .unwrap()
            .current_user()
            .unwrap()
            .name,
        "سارة"
    );
}

#[test]
fn the_last_active_manager_cannot_be_removed_or_demoted() {
    let business = new_shop();
    let me = business.current_user().unwrap().id;
    assert_eq!(code(business.deactivate_user(me)), "last_manager");
    assert_eq!(
        code(business.update_user(
            me,
            &UserChanges {
                name: None,
                role: Some("cashier".into())
            }
        )),
        "last_manager"
    );
    let second = business
        .add_user(&user("منى", "manager", "123456"))
        .unwrap();
    business.deactivate_user(me).unwrap();
    let users = business.users().unwrap();
    assert!(!users.iter().find(|u| u.id == me).unwrap().active);
    assert!(users.iter().find(|u| u.id == second).unwrap().active);
}

fn as_role(role: &str) -> (Business, Business) {
    let business = new_shop();
    business.add_user(&user("موظف", role, "123456")).unwrap();
    let signed_in = business.sign_in("موظف", "123456").unwrap();
    (business, signed_in)
}

#[test]
fn only_a_manager_manages_users() {
    for role in ["accountant", "cashier", "storekeeper"] {
        let (_manager, someone) = as_role(role);
        assert_eq!(
            code(someone.add_user(&user("جديد", "cashier", "123456"))),
            "not_allowed",
            "{role}"
        );
        assert_eq!(code(someone.users()), "not_allowed", "{role}");
    }
}

#[test]
fn an_accountant_keeps_the_books_a_cashier_and_a_storekeeper_cannot() {
    let (manager, accountant) = as_role("accountant");
    accountant
        .post_journal_entry(&rent_entry(&manager))
        .unwrap();
    assert_eq!(
        accountant.trial_balance("2026-11-30").unwrap().total_debit,
        100
    );
    for role in ["cashier", "storekeeper"] {
        let (m, someone) = as_role(role);
        assert_eq!(
            code(someone.post_journal_entry(&rent_entry(&m))),
            "not_allowed",
            "{role}"
        );
        assert_eq!(
            code(someone.trial_balance("2026-11-30")),
            "not_allowed",
            "{role}"
        );
    }
}

#[test]
fn every_change_records_who_made_it_and_when_newest_first() {
    let business = new_shop();
    business
        .add_user(&user("محمود", "accountant", "123456"))
        .unwrap();
    let accountant = business.sign_in("محمود", "123456").unwrap();
    let entry_id = accountant
        .post_journal_entry(&rent_entry(&business))
        .unwrap();
    business
        .add_account(&NewAccount {
            code: "6800".into(),
            name: "دعاية".into(),
            kind: "expense".into(),
        })
        .unwrap();
    let log = business.audit_log().unwrap();
    let top: Vec<_> = log
        .iter()
        .take(3)
        .map(|e| (e.user_name.as_str(), e.action.as_str()))
        .collect();
    assert_eq!(
        top,
        [
            ("أيمن", "addAccount"),
            ("محمود", "postJournalEntry"),
            ("أيمن", "addUser")
        ]
    );
    assert_eq!(log[1].entity_id, Some(entry_id));
    let at = &log[0].at;
    assert!(
        at.len() == 24 && at.ends_with('Z') && &at[10..11] == "T",
        "{at}"
    );
}

#[test]
fn passwords_never_appear_in_the_audit_log() {
    let business = new_shop();
    let id = business
        .add_user(&user("سارة", "cashier", "سر-سارة-1"))
        .unwrap();
    business.reset_password(id, "سر-سارة-2").unwrap();
    assert!(!serde_json::to_string(&business.audit_log().unwrap())
        .unwrap()
        .contains("سر-سارة"));
}

#[test]
fn reading_does_not_write_to_the_audit_log_and_a_refused_command_leaves_no_trace() {
    let business = new_shop();
    let before = business.audit_log().unwrap().len();
    business.accounts().unwrap();
    business.trial_balance("2026-11-30").unwrap();
    assert!(business
        .add_account(&NewAccount {
            code: "6100".into(),
            name: "مكرر".into(),
            kind: "expense".into()
        })
        .is_err());
    assert_eq!(business.audit_log().unwrap().len(), before);
}

#[test]
fn a_cashier_cannot_read_the_audit_log() {
    let business = new_shop();
    business
        .add_user(&user("سارة", "cashier", "123456"))
        .unwrap();
    assert_eq!(
        code(business.sign_in("سارة", "123456").unwrap().audit_log()),
        "not_allowed"
    );
}

#[test]
fn the_licence_limits_people_signed_in_and_read_only_refuses_commands() {
    let business = new_shop();
    business
        .add_user(&user("سارة", "cashier", "123456"))
        .unwrap();
    business.set_licence_limits(LicenceLimits {
        read_only: None,
        users: Some(1),
    });
    // Signing in again as yourself is not another person.
    assert!(business.sign_in("أيمن", &manager().password).is_ok());
    assert_eq!(
        code(business.sign_in("سارة", "123456")),
        "licence_users_exceeded"
    );
    business.set_licence_limits(LicenceLimits {
        read_only: Some("trial_ended".into()),
        users: None,
    });
    assert_eq!(
        code(business.add_account(&NewAccount {
            code: "6800".into(),
            name: "x".into(),
            kind: "expense".into()
        })),
        "read_only"
    );
    assert!(business.accounts().is_ok());
    let me = business.current_user().unwrap().id;
    business.reset_password(me, "كلمة سر جديدة").unwrap();
}

#[test]
fn every_method_has_the_roles_the_typescript_core_gives_it() {
    let path = format!(
        "{}/tests/fixtures/permissions.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let expected: std::collections::BTreeMap<String, Vec<String>> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for (method, roles) in expected {
        let actual: Vec<String> = manager_core::users::roles_for(&method)
            .iter()
            .map(|r| r.to_string())
            .collect();
        let mut a = actual.clone();
        let mut e = roles.clone();
        a.sort();
        e.sort();
        assert_eq!(a, e, "{method}");
    }
}
