//! Withholding tax categories. Rates and the report move here with #77.

use rusqlite::{Connection, OptionalExtension};

use crate::error::{refuse, Result};

pub fn assert_withholding_category(conn: &Connection, id: Option<i64>) -> Result<()> {
    let Some(id) = id else { return Ok(()) };
    let found = conn
        .query_row(
            "SELECT 1 FROM withholding_categories WHERE id = ?",
            [id],
            |_| Ok(()),
        )
        .optional()?;
    match found {
        Some(()) => Ok(()),
        None => refuse(
            "withholding_category_not_found",
            format!("No withholding category with id {id}"),
        ),
    }
}
