use serde::Serialize;

/**
 * Every rule the core refuses carries a stable `code`. Screens translate the code into Arabic or
 * English; the message is for logs and developers only. The codes are the ones `core/errors.ts`
 * lists, so the screens' strings keep working.
 */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BusinessError {
    pub code: &'static str,
    pub message: String,
    /** An amount the screen shows with the message, such as how far past a credit limit a sale goes. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    /** A name the screen shows with the message, such as the item that lacks a code. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl BusinessError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        BusinessError {
            code,
            message: message.into(),
            amount: None,
            detail: None,
        }
    }
}

impl std::fmt::Display for BusinessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BusinessError {}

/** A database failure is a bug or a broken file, never a business rule. */
impl From<rusqlite::Error> for BusinessError {
    fn from(error: rusqlite::Error) -> Self {
        BusinessError::new("internal", error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, BusinessError>;

/** Refuses with `code`; shorthand for the many checks in the core. */
pub fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T> {
    Err(BusinessError::new(code, message))
}
