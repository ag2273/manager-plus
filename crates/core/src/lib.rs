//! The Manager+ books in Rust: every business rule behind one `Business` facade, on the same
//! SQLite file format as the TypeScript core it replaces (#72). Money is whole piastres, and
//! every command writes all its rows and its audit entry in one transaction, or nothing.

pub mod business;
pub mod chart;
pub mod dates;
mod dispatch;
pub mod error;
pub mod inventory;
pub mod items;
pub mod ledger;
pub mod migrations;
pub mod num;
pub mod serials;
pub mod stock;
pub mod users;

pub use business::{Business, BusinessSettings, LicenceLimits, LicenceMode};
pub use error::{BusinessError, Result};
