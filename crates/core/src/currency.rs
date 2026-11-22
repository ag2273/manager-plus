use serde::Serialize;

use crate::error::{refuse, Result};
use crate::ledger::Piastres;
use crate::num::safe_int;

/** A currency a supplier can bill in, with its ISO code and digits after the point. */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyInfo {
    pub code: &'static str,
    pub minor_units: u32,
    pub name_ar: &'static str,
}

pub const CURRENCIES: [CurrencyInfo; 4] = [
    CurrencyInfo {
        code: "EGP",
        minor_units: 2,
        name_ar: "جنيه مصري",
    },
    CurrencyInfo {
        code: "USD",
        minor_units: 2,
        name_ar: "دولار أمريكي",
    },
    CurrencyInfo {
        code: "EUR",
        minor_units: 2,
        name_ar: "يورو",
    },
    CurrencyInfo {
        code: "CNY",
        minor_units: 2,
        name_ar: "يوان صيني",
    },
];

/** EGP per one unit of a currency, in integer millionths: 48.50 is 48_500_000. */
pub type Rate = i64;
pub const ONE: Rate = 1_000_000;

pub fn is_currency(code: &str) -> bool {
    CURRENCIES.iter().any(|c| c.code == code)
}

/** A rate that can be posted: a positive whole number of millionths, and exactly one for EGP. */
pub fn assert_rate(currency: &str, rate: f64) -> Result<Rate> {
    let Some(rate) = safe_int(rate).filter(|r| *r > 0) else {
        return refuse(
            "rate_invalid",
            format!("Rate {rate} is not a positive number of millionths"),
        );
    };
    if currency == "EGP" && rate != ONE {
        return refuse("rate_invalid", "An EGP document has no exchange rate");
    }
    Ok(rate)
}

/** An amount in a currency's minor units turned into piastres, half away from zero, exactly. */
pub fn to_egp(amount: i64, rate: Rate) -> Piastres {
    let product = amount as i128 * rate as i128;
    let half = (ONE / 2) as i128;
    let one = ONE as i128;
    (if product >= 0 {
        (product + half) / one
    } else {
        -((-product + half) / one)
    }) as i64
}
