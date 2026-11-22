use rusqlite::Connection;

use crate::error::Result;
use crate::items::Quantity;
use crate::ledger::Piastres;
use crate::num::mul_div_round;

/** How much of a posted line's values earlier documents already took back. */
#[derive(Debug, Clone, Default)]
pub struct Taken {
    pub quantity: Quantity,
    pub values: Vec<Piastres>,
}

/**
 * The share of a line's values for `quantity` out of the line's `whole` quantity. The
 * part that takes the last of the line gets exactly what is left, so taking a line
 * back in pieces never loses or invents a piastre.
 */
pub fn share_of(
    values: &[Piastres],
    whole: Quantity,
    before: &Taken,
    quantity: Quantity,
) -> Vec<Piastres> {
    let last = before.quantity + quantity == whole;
    values
        .iter()
        .enumerate()
        .map(|(i, &value)| {
            if last {
                value - before.values.get(i).copied().unwrap_or(0)
            } else {
                mul_div_round(value, quantity, whole)
            }
        })
        .collect()
}

/** Adds a share to what was taken. */
pub fn take(before: &Taken, quantity: Quantity, share: &[Piastres]) -> Taken {
    Taken {
        quantity: before.quantity + quantity,
        values: share
            .iter()
            .enumerate()
            .map(|(i, v)| v + before.values.get(i).copied().unwrap_or(0))
            .collect(),
    }
}

/** Next number in a gap-free sequence; call inside the posting transaction. */
pub fn next_number(conn: &Connection, table: &str) -> Result<i64> {
    Ok(conn.query_row(
        &format!("SELECT COALESCE(MAX(number), 0) + 1 FROM {table}"),
        [],
        |r| r.get(0),
    )?)
}
