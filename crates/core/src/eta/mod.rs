//! E-invoicing with the Egyptian Tax Authority (ADR 0009): sales invoices and credit notes signed
//! with the business's USB token, and e-receipts for till sales chained by UUID. Optional per business.

pub mod cades;
pub mod der;
pub mod document;
pub mod receipt;
pub mod receipts_store;
pub mod sender;
pub mod store;
