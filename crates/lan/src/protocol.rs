//! The wire format: one JSON object per line each way, a reply answering the request with the same id.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;

/** The port a server listens on unless told otherwise. */
pub const DEFAULT_PORT: u16 = 47_100;
/** The mDNS service servers announce and clients look for. */
pub const SERVICE: &str = "_managerplus._tcp.local.";
/** Longest request or reply line accepted; anything longer is a broken or hostile peer. */
pub const MAX_LINE: usize = 4 * 1024 * 1024;

/** What `hello` answers, before anyone signs in. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub app: String,
    pub protocol: u32,
    pub settings: manager_core::BusinessSettings,
}

/** One line from server to client. A failure carries the facade's error code, message and amount. */
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Reply {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/** A remote error code as the `&'static str` the facade's errors carry; each distinct code is kept once. */
fn intern(code: &str) -> &'static str {
    static CODES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut codes = CODES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(known) = codes.iter().find(|c| **c == code) {
        return known;
    }
    let kept: &'static str = Box::leak(code.to_string().into_boxed_str());
    codes.push(kept);
    kept
}

impl Reply {
    pub fn success(id: u64, value: Value) -> Reply {
        Reply {
            id,
            ok: true,
            value: Some(value),
            code: None,
            message: None,
            amount: None,
            detail: None,
        }
    }

    pub fn failure(id: u64, error: manager_core::BusinessError) -> Reply {
        Reply {
            id,
            ok: false,
            value: None,
            code: Some(error.code.to_string()),
            message: Some(error.message),
            amount: error.amount,
            detail: error.detail,
        }
    }

    /** The reply as the facade's own result, so a remote call looks like a local one. */
    pub fn into_result(self) -> manager_core::Result<Value> {
        if self.ok {
            return Ok(self.value.unwrap_or(Value::Null));
        }
        let mut error = manager_core::BusinessError::new(
            intern(self.code.as_deref().unwrap_or("unexpected")),
            self.message.unwrap_or_default(),
        );
        error.amount = self.amount;
        error.detail = self.detail;
        Err(error)
    }
}
