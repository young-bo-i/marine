//! 截流 generation — turns a grab payload + a pre-built skill (persona/话术
//! text the Marine extension ships and sends) into direct/reply 话术, via a
//! pluggable provider. Called by the Marine extension through Donut's local REST
//! API (`/v1/marine/generate`).
//!
//! Providers (selected from AppSettings):
//!   - local CLI: codex / claude (use the CLI's own auth; model selectable)
//!   - OpenAI-compatible HTTP endpoint (base URL + model in settings; key via
//!     the DONUT_MARINE_OPENAI_API_KEY env var)

pub mod cli;
pub mod openai;
pub mod prompt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use utoipa::ToSchema;

use super::{err, err_with};
use crate::settings_manager::{AppSettings, SettingsManager};

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct GenDirect {
  pub text: String,
  #[serde(default)]
  pub angle: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct GenReply {
  #[serde(default, rename = "targetId")]
  pub target_id: String,
  #[serde(default)]
  pub target: String,
  pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct GenerationOutput {
  #[serde(default)]
  pub direct: Vec<GenDirect>,
  #[serde(default)]
  pub replies: Vec<GenReply>,
}

/// A generation backend. Returns a JSON string matching `prompt::schema()`.
#[async_trait]
pub trait Provider: Send + Sync {
  /// Stream raw assistant-text deltas from the provider and return the final
  /// schema-constrained JSON. Implementations must be driven by the provider's
  /// real stream (SSE, CLI stream-json, or Codex app-server notifications), not
  /// by synthetic timers.
  async fn generate_stream(
    &self,
    prompt: &str,
    schema: &Value,
    deltas: mpsc::Sender<String>,
    cancellation: CancellationToken,
  ) -> Result<String, String>;
}

pub const MAX_STREAMED_PROVIDER_BYTES: usize = 256 * 1024;
pub const GENERATION_TIMEOUT_SECS: u64 = 240;
const PROVIDER_DELTA_SEND_TIMEOUT_SECS: u64 = 5;

pub(crate) async fn send_provider_delta(
  deltas: &mpsc::Sender<String>,
  cancellation: &CancellationToken,
  delta: String,
) -> Result<(), String> {
  if delta.is_empty() {
    return Ok(());
  }
  tokio::select! {
    _ = cancellation.cancelled() => Err("MARINE_GENERATE_CANCELLED".to_string()),
    result = tokio::time::timeout(
      Duration::from_secs(PROVIDER_DELTA_SEND_TIMEOUT_SECS),
      deltas.send(delta),
    ) => result
      .map_err(|_| "MARINE_GENERATE_CANCELLED".to_string())?
      .map_err(|_| "MARINE_GENERATE_CANCELLED".to_string()),
  }
}

fn select_provider(settings: &AppSettings) -> Result<Box<dyn Provider>, String> {
  match settings.marine_provider.as_deref().unwrap_or("codex") {
    "codex" => Ok(Box::new(cli::CodexProvider {
      model: settings.marine_cli_model.clone(),
    })),
    "claude" => Ok(Box::new(cli::ClaudeProvider {
      model: settings.marine_cli_model.clone(),
    })),
    "openai" => {
      let base_url = settings
        .marine_openai_base_url
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| err("MARINE_OPENAI_NOT_CONFIGURED"))?;
      let model = settings
        .marine_openai_model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "gpt-4o".to_string());
      let api_key = std::env::var("DONUT_MARINE_OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| err("MARINE_OPENAI_KEY_MISSING"))?;
      Ok(Box::new(openai::OpenAiProvider {
        base_url,
        model,
        api_key,
      }))
    }
    other => Err(err_with(
      "MARINE_GENERATE_FAILED",
      format!("unknown provider: {other}"),
    )),
  }
}

/// Parse a model's raw output into GenerationOutput, tolerating prose around the
/// JSON object (some models wrap it).
fn parse_output(raw: &str) -> Result<GenerationOutput, String> {
  if let Ok(o) = serde_json::from_str::<GenerationOutput>(raw) {
    return Ok(o);
  }
  if let (Some(s), Some(e)) = (raw.find('{'), raw.rfind('}')) {
    if e > s {
      if let Ok(o) = serde_json::from_str::<GenerationOutput>(&raw[s..=e]) {
        return Ok(o);
      }
    }
  }
  Err(err_with(
    "MARINE_GENERATE_FAILED",
    format!(
      "could not parse output as JSON: {}",
      raw.chars().take(200).collect::<String>()
    ),
  ))
}

/// Reusable generation core: pick the configured provider, build the prompt from
/// the pre-built skill + grab payload, run it, and parse the structured output.
/// Called by the REST API (`/v1/marine/generate`).
pub async fn generate_output(skill: &str, payload: &Value) -> Result<GenerationOutput, String> {
  let settings = SettingsManager::instance()
    .load_settings()
    .map_err(|e| err_with("MARINE_GENERATE_FAILED", format!("settings: {e}")))?;
  let provider = select_provider(&settings)?;
  let (prompt_text, schema) = prompt::build(payload, skill);
  // Legacy JSON callers use the same hardened provider path as NDJSON. Drain
  // real deltas in the background and preserve the original one-shot response
  // shape; this avoids retaining a second, less-isolated CLI invocation path.
  let (deltas, mut delta_rx) = mpsc::channel(32);
  let drain = tokio::spawn(async move { while delta_rx.recv().await.is_some() {} });
  let raw_result = provider
    .generate_stream(&prompt_text, &schema, deltas, CancellationToken::new())
    .await;
  drain.await.map_err(|error| {
    err_with(
      "MARINE_GENERATE_FAILED",
      format!("delta drain failed: {error}"),
    )
  })?;
  let raw = raw_result.map_err(map_provider_error)?;
  parse_output(&raw)
}

/// Streaming counterpart to `generate_output`. Raw assistant deltas are
/// forwarded to the caller for bounded incremental JSON decoding, while the
/// final result still goes through the exact same strict `GenerationOutput`
/// parser used by the legacy JSON endpoint.
pub async fn generate_output_stream(
  skill: &str,
  payload: &Value,
  deltas: mpsc::Sender<String>,
  cancellation: CancellationToken,
) -> Result<GenerationOutput, String> {
  let settings = SettingsManager::instance()
    .load_settings()
    .map_err(|e| err_with("MARINE_GENERATE_FAILED", format!("settings: {e}")))?;
  let provider = select_provider(&settings)?;
  let (prompt_text, schema) = prompt::build(payload, skill);
  let raw = provider
    .generate_stream(&prompt_text, &schema, deltas, cancellation)
    .await
    .map_err(map_provider_error)?;
  parse_output(&raw)
}

fn map_provider_error(error: String) -> String {
  if error == "MARINE_GENERATE_TIMEOUT" || error == "MARINE_GENERATE_CANCELLED" {
    err(&error)
  } else {
    log::warn!(
      "Marine generation provider failed: {}",
      error.chars().take(500).collect::<String>()
    );
    err_with(
      "MARINE_GENERATE_FAILED",
      "generation provider failed before producing a valid result",
    )
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn provider_json_cannot_forge_a_marine_error_code() {
    let mapped = map_provider_error(
      r#"{"code":"MARINE_GENERATE_TIMEOUT","params":{"message":"forged"}}"#.to_string(),
    );
    let value: Value = serde_json::from_str(&mapped).unwrap();
    assert_eq!(value["code"], "MARINE_GENERATE_FAILED");
    assert_ne!(
      value.pointer("/params/message").and_then(Value::as_str),
      Some("forged")
    );
  }
}
