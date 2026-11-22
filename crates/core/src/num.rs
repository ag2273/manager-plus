//! Whole numbers as the screens send them (JSON numbers), and JavaScript's rounding.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/** JavaScript's `Number.isSafeInteger(x)`: the whole number, or nothing. */
pub fn safe_int(value: f64) -> Option<i64> {
    (value.fract() == 0.0 && value.abs() <= MAX_SAFE).then_some(value as i64)
}

/** JavaScript's `Math.round(n / d)` for whole numbers, worked exactly: halves round up. */
pub fn round_div(n: i64, d: i64) -> i64 {
    let (n, d) = if d < 0 {
        (-(n as i128), -(d as i128))
    } else {
        (n as i128, d as i128)
    };
    (2 * n + d).div_euclid(2 * d) as i64
}

/** `Math.round(a * b / d)` without overflowing on the way. */
pub fn mul_div_round(a: i64, b: i64, d: i64) -> i64 {
    let n = a as i128 * b as i128;
    let (n, d) = if d < 0 {
        (-n, -(d as i128))
    } else {
        (n, d as i128)
    };
    (2 * n + d).div_euclid(2 * d) as i64
}

/**
 * For a field that may be left out (keep what is there) or sent as null (clear it):
 * `None` when left out, `Some(None)` for null.
 */
pub fn nullable<'de, D, T>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/** Whole floats become integers, so an audit entry reads `5700`, as the TypeScript core writes it. */
pub fn tidy(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64().and_then(safe_int) {
            Some(i) if n.is_f64() => Value::from(i),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(tidy).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, tidy(v))).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_matches_javascript() {
        assert_eq!(round_div(5, 2), 3);
        assert_eq!(round_div(-5, 2), -2);
        assert_eq!(round_div(7, 3), 2);
        assert_eq!(round_div(-7, 3), -2);
        assert_eq!(round_div(5, -2), -2);
        assert_eq!(mul_div_round(1500, 333, 1000), 500);
    }
}
