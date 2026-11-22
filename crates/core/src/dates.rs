use crate::error::{refuse, Result};

/** A calendar date as YYYY-MM-DD. Compared as text, which sorts like the dates. */
pub type IsoDate = String;

/** Refuses with `date_invalid` unless `date` is a real calendar date written YYYY-MM-DD. */
pub fn assert_iso_date(date: &str) -> Result<()> {
    if is_iso_date(date) {
        Ok(())
    } else {
        refuse("date_invalid", format!("Not a valid date: \"{date}\""))
    }
}

fn is_iso_date(date: &str) -> bool {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<u32> {
        let s = &date[r];
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())
            .flatten()
    };
    let (Some(y), Some(m), Some(d)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    chrono::NaiveDate::from_ymd_opt(y as i32, m, d).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_dates_only() {
        for good in ["2026-11-01", "2024-02-29", "0001-01-01"] {
            assert!(is_iso_date(good), "{good}");
        }
        for bad in [
            "2026-13-01",
            "2026-02-30",
            "01/11/2026",
            "",
            "2026-1-01",
            "2025-02-29",
            "２０２６-11-01",
        ] {
            assert!(!is_iso_date(bad), "{bad}");
        }
    }
}
