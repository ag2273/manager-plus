//! Ported from `src/core/credit-limit.test.ts`: the till cases. The invoice cases come with
//! customers' invoices (#77); here the same approval rules are checked through the till.
mod common;

use common::*;
use manager_core::customers::CustomerInput;
use manager_core::sales::{PaymentInput, SaleInput, SaleLineInput};
use manager_core::users::Credentials;
use manager_core::{Business, BusinessSettings};

struct Setup {
    business: Business,
    main: i64,
    router: i64,
    amal: i64,
}

fn setup() -> Setup {
    let settings = BusinessSettings {
        name: "شركة النور للكمبيوتر".into(),
        ..shop()
    };
    let business = Business::create(":memory:", &settings, &manager()).unwrap();
    let main = main_warehouse(&business);
    // 1,140.00 each with VAT.
    let router = business
        .add_item(&piece(&business, "راوتر", 114_000))
        .unwrap();
    let supplier = supplier(&business);
    buy(
        &business,
        supplier,
        main,
        "2026-01-01",
        &[(router, 50_000, 60_000)],
    );
    // A limit of 3,000.00.
    let amal = business
        .add_customer(&CustomerInput {
            name: "شركة الأمل".into(),
            credit_limit: Some(300_000.0),
            ..Default::default()
        })
        .unwrap();
    Setup {
        business,
        main,
        router,
        amal,
    }
}

impl Setup {
    fn sale(&self, routers: i64, paid: i64) -> SaleInput {
        SaleInput {
            date: "2026-02-01".into(),
            warehouse_id: self.main,
            customer_id: Some(self.amal),
            lines: vec![SaleLineInput::base(self.router, routers * 1_000)],
            payments: if paid > 0 {
                vec![PaymentInput::new("cash", paid)]
            } else {
                vec![]
            },
            ..Default::default()
        }
    }
}

#[test]
fn at_the_till_only_the_part_left_on_credit_counts() {
    let s = setup();
    let till = signed_in(&s.business, "سارة", "cashier");
    till.open_shift(0.0).unwrap();
    // Three routers, 1,000.00 paid: 2,420.00 on credit fits.
    till.post_sale(&s.sale(3, 100_000)).unwrap();
    let refused = till.post_sale(&s.sale(1, 0)).unwrap_err();
    assert_eq!(
        (refused.code, refused.amount),
        ("credit_limit_exceeded", Some(56_000))
    );
    till.post_sale(&SaleInput {
        credit_approval: Some(manager()),
        ..s.sale(1, 0)
    })
    .unwrap();
    assert_eq!(s.business.customer_balance(s.amal).unwrap(), 356_000);
}

#[test]
fn a_managers_approval_is_in_the_audit_log_without_the_password() {
    let s = setup();
    let till = signed_in(&s.business, "سارة", "cashier");
    till.open_shift(0.0).unwrap();
    till.post_sale(&SaleInput {
        credit_approval: Some(manager()),
        ..s.sale(3, 0)
    })
    .unwrap();

    assert_eq!(s.business.customer_balance(s.amal).unwrap(), 342_000);
    let log = s.business.audit_log().unwrap();
    let approval = log
        .iter()
        .find(|e| e.action == "approveCreditLimit")
        .unwrap();
    assert_eq!(
        (approval.user_name.as_str(), approval.entity_id),
        ("أيمن", Some(s.amal))
    );
    let detail: serde_json::Value = serde_json::from_str(&approval.detail).unwrap();
    assert_eq!(detail["over"], 42_000);
    assert_eq!(detail["document"], "postSale");
    assert_eq!(detail["requestedBy"], "سارة");
    let sale = log.iter().find(|e| e.action == "postSale").unwrap();
    let detail: serde_json::Value = serde_json::from_str(&sale.detail).unwrap();
    assert_eq!(detail["creditApprovedBy"], "أيمن");
    assert!(log.iter().all(|e| !e.detail.contains(&manager().password)));
}

#[test]
fn only_a_manager_can_approve_with_the_right_password() {
    let s = setup();
    signed_in(&s.business, "محاسب", "accountant");
    s.business.open_shift(0.0).unwrap();
    let approved_by = |name: &str, password: &str| SaleInput {
        credit_approval: Some(Credentials {
            name: name.into(),
            password: password.into(),
        }),
        ..s.sale(3, 0)
    };
    assert_eq!(
        code(s.business.post_sale(&approved_by("محاسب", "123456"))),
        "approval_not_manager"
    );
    assert_eq!(
        code(s.business.post_sale(&approved_by(&manager().name, "خطأ"))),
        "sign_in_failed"
    );
    assert_eq!(s.business.customer_balance(s.amal).unwrap(), 0);
}
