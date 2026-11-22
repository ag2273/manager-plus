//! Server mode (ADR 0002). The PC that holds a business file serves its `Business` facade to the
//! other PCs in the office over TLS; they never touch the file. Requests and replies are
//! newline-delimited JSON, the same protocol the Electron app spoke.

pub mod certificate;
pub mod client;
pub mod discovery;
pub mod protocol;
pub mod server;

pub use certificate::Identity;
pub use client::RemoteBusiness;
pub use discovery::FoundServer;
pub use server::RunningServer;
