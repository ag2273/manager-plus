//! The Manager+ books in Rust: every business rule behind one `Business` facade, on the same
//! SQLite file format as the TypeScript core it replaces (#72). Money is whole piastres, and
//! every command writes all its rows and its audit entry in one transaction, or nothing.

pub mod business;
pub mod chart;
pub mod currency;
pub mod customers;
pub mod dates;
mod dispatch;
pub mod error;
pub mod import;
pub mod inventory;
pub mod invoices;
pub mod items;
pub mod ledger;
pub mod migrations;
pub mod money;
pub mod num;
pub mod purchases;
pub mod quotations;
pub mod returns;
pub mod sales;
pub mod serials;
pub mod settlements;
pub mod shares;
pub mod shifts;
pub mod shipments;
pub mod stock;
pub mod users;
pub mod withholding;

pub use business::{Business, BusinessSettings, LicenceLimits, LicenceMode};
pub use error::{BusinessError, Result};
