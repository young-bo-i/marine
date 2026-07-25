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

/// Capability token handed to the in-browser extension, derived one-way from the
/// full API bearer.
///
/// The extension only ever needs `/v1/marine/*`, but it used to be stamped with
/// the full API token — which also authorizes `/v1/profiles/{id}/run|kill`,
/// `/v1/proxies` (upstream credentials), `/v1/vpns/{id}/export` and browser
/// downloads. Since the extension runs inside pages it does not control, that
/// made "extension compromised" equal to "whole automation API compromised".
///
/// Deriving instead of storing a second secret keeps this stable across restarts
/// (no new breakage for already-launched profiles) while making the capability
/// non-invertible: holding it does not reveal the full bearer. Rotating the API
/// token rotates this automatically.
pub fn extension_capability_token(api_token: &str) -> String {
  use base64::Engine as _;
  let derived = blake3::derive_key(
    "donutbrowser marine extension capability v1",
    api_token.as_bytes(),
  );
  base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(derived)
}

/// Build a structured `{ "code": ... }` local-API error string.
pub(crate) fn err(code: &str) -> String {
  serde_json::json!({ "code": code }).to_string()
}

/// Same, but carries a raw detail message.
pub(crate) fn err_with(code: &str, message: impl Into<String>) -> String {
  serde_json::json!({ "code": code, "params": { "message": message.into() } }).to_string()
}
