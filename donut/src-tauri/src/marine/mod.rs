//! Marine — 截流 backend for the in-browser Marine extension.
//!
//! Page-context work (grab / comment extraction / reply injection) lives in the
//! Marine browser extension itself. This module provides the services the
//! extension calls over Donut's local REST API (`api_server.rs` `/v1/marine/*`):
//! generation (`generate`) and posting history (`history`). The persona/话术 is
//! pre-built inside the extension and sent with each generate call. `cdp` +
//! `automation` remain the shared browser-automation stack used by the MCP server.

pub mod automation;
pub mod bookmarks;
pub mod cdp;
pub mod extension;
pub mod generate;
pub mod history;
pub mod rime;
pub mod rime_plugin;

/// Build a `{ "code": ... }` error string (used by the generation engine).
pub(crate) fn err(code: &str) -> String {
  serde_json::json!({ "code": code }).to_string()
}

/// Same, but carries a raw detail message.
pub(crate) fn err_with(code: &str, message: impl Into<String>) -> String {
  serde_json::json!({ "code": code, "params": { "message": message.into() } }).to_string()
}
