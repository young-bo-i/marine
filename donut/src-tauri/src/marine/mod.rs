//! Marine — context, 话术, records, and UI metadata for the in-browser Marine
//! extension.
//!
//! Page-context work (grab / comment extraction / reply injection) lives in the
//! Marine browser extension itself. This module provides the services the
//! extension calls over Donut's local REST API (`api_server.rs` `/v1/marine/*`):
//! frozen Rime context, connector-ready prompt preparation, and posting history.
//! Model authorization and execution belong to Rime-side Codex, Claude Code,
//! and OpenAI-compatible connectors.
//! `cdp` + `automation` remain the shared browser-automation stack used by the MCP
//! server.

pub mod automation;
pub mod bookmarks;
pub mod cdp;
pub mod extension;
pub mod generate;
pub mod history;
pub mod rime;
pub mod rime_plugin;

/// Build a structured `{ "code": ... }` local-API error string.
pub(crate) fn err(code: &str) -> String {
  serde_json::json!({ "code": code }).to_string()
}

/// Same, but carries a raw detail message.
pub(crate) fn err_with(code: &str, message: impl Into<String>) -> String {
  serde_json::json!({ "code": code, "params": { "message": message.into() } }).to_string()
}
