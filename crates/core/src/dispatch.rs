use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::business::Business;
use crate::error::{refuse, BusinessError, Result};

/** The `index`th argument, decoded; a missing or malformed one is the screens' bug, never the user's. */
fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T> {
    let value = args.get(index).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|e| BusinessError::new("invalid_input", format!("Argument {index}: {e}")))
}

fn json<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| BusinessError::new("internal", e.to_string()))
}

impl Business {
    /**
     * Calls a facade method by the name the screens use, with its arguments as JSON, and returns
     * its result as JSON. The names are `BUSINESS_METHODS` in `shared/api.ts`; one not ported to
     * Rust yet is refused with `not_ported`.
     */
    pub fn call(&self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "settings" => json(self.settings()?),
            "currentUser" => json(self.current_user()),
            "licenceMode" => json(self.licence_mode()?),
            "users" => json(self.users()?),
            "addUser" => json(self.add_user(&arg(args, 0)?)?),
            "updateUser" => json(self.update_user(arg(args, 0)?, &arg(args, 1)?)?),
            "resetPassword" => json(self.reset_password(arg(args, 0)?, &arg::<String>(args, 1)?)?),
            "changeOwnPassword" => {
                json(self.change_own_password(&arg::<String>(args, 0)?, &arg::<String>(args, 1)?)?)
            }
            "deactivateUser" => json(self.deactivate_user(arg(args, 0)?)?),
            "reactivateUser" => json(self.reactivate_user(arg(args, 0)?)?),
            "auditLog" => json(self.audit_log()?),
            "accounts" => json(self.accounts()?),
            "addAccount" => json(self.add_account(&arg(args, 0)?)?),
            "updateAccount" => json(self.update_account(arg(args, 0)?, &arg(args, 1)?)?),
            "deactivateAccount" => json(self.deactivate_account(arg(args, 0)?)?),
            "reactivateAccount" => json(self.reactivate_account(arg(args, 0)?)?),
            "deleteAccount" => json(self.delete_account(arg(args, 0)?)?),
            "postJournalEntry" => json(self.post_journal_entry(&arg(args, 0)?)?),
            "postOpeningBalances" => json(
                self.post_opening_balances(&arg::<String>(args, 0)?, &arg::<Vec<_>>(args, 1)?)?,
            ),
            "trialBalance" => json(self.trial_balance(&arg::<String>(args, 0)?)?),
            "lockDate" => json(self.lock_date()?),
            "setLockDate" => json(self.set_lock_date(arg::<Option<String>>(args, 0)?.as_deref())?),
            _ => refuse(
                "not_ported",
                format!("{method} is not in the Rust core yet"),
            ),
        }
    }
}
