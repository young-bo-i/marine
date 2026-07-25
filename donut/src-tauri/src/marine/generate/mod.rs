//! 截流 generation — turns a grab payload + a pre-built skill (persona/话术 text
//! the Marine extension ships) into a single `blocks-v1` 话术 block, via a
//! pluggable local-agent provider.
//!
//! This is the browser-side, extension-self-serve execution path: Donut runs the
//! user-selected local connector so the extension can generate a reply without
//! the Rime input method installed.
//!
//! Providers (selected from AppSettings, auto-detected when unset):
//!   - local CLI: codex / claude (use the CLI's own subscription auth)
//!   - OpenAI-compatible HTTP endpoint (base URL + model in settings; key via
//!     the DONUT_MARINE_OPENAI_API_KEY env var)
//!
//! The output contract is `blocks-v1` — the exact same one `prompt::build_blocks_v1`
//! and the Rime `prepare` path produce — so both entry points stay unified.

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

/// One `blocks-v1` output block. `text` is the 话术; `title` is optional metadata.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct GeneratedBlock {
  pub text: String,
  #[serde(default)]
  pub title: Option<String>,
}

/// The `blocks-v1` connector output contract: `{ "blocks": [ { text, title? } ] }`.
/// A single-focus generation yields exactly one block.
#[derive(Debug, Clone, Default, Deserialize, Serialize, ToSchema)]
pub struct BlocksV1 {
  #[serde(default)]
  pub blocks: Vec<GeneratedBlock>,
}

/// A generation backend. Returns a JSON string matching [`blocks_v1_schema`].
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

/// JSON schema the connectors constrain output to. Mirrors the `blocks-v1`
/// contract that `prompt::build_blocks_v1` writes into the prompt.
///
/// OpenAI strict structured outputs (what Codex/OpenAI enforce when a
/// `response_format` schema is supplied) require that every object with
/// `additionalProperties:false` list ALL of its properties in `required` —
/// nullable-but-required is how an "optional" field is expressed. So `title`
/// must be in `required` (with a null-able type), otherwise the API rejects the
/// request with `invalid_json_schema`. Also avoid `minItems`/`maxItems`, which
/// strict mode does not support; the single-block contract is enforced by the
/// prompt and by `parse_blocks_v1` taking the first block.
fn blocks_v1_schema() -> Value {
  serde_json::json!({
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "blocks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "text": { "type": "string" },
            "title": { "type": ["string", "null"] }
          },
          "required": ["text", "title"]
        }
      }
    },
    "required": ["blocks"]
  })
}

/// First installed + authenticated local agent, by preference (codex, then
/// claude). `None` when neither subscription is ready.
pub fn detect_default_provider() -> Option<String> {
  let agents = cli::detect_agents();
  ["codex", "claude"].into_iter().find_map(|preferred| {
    agents
      .iter()
      .any(|agent| agent.id == preferred && agent.detected && agent.authed)
      .then(|| preferred.to_string())
  })
}

/// Resolve the effective provider name: an explicit user setting always wins;
/// otherwise auto-detect the first ready local agent, finally falling back to
/// "codex" so the error surfaced is the (actionable) "not connected" one.
fn resolve_provider_name(settings: &AppSettings) -> String {
  if let Some(explicit) = settings
    .marine_provider
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  {
    return explicit.to_string();
  }
  detect_default_provider().unwrap_or_else(|| "codex".to_string())
}

fn select_provider(settings: &AppSettings) -> Result<Box<dyn Provider>, String> {
  match resolve_provider_name(settings).as_str() {
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
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| err("MARINE_OPENAI_NOT_CONFIGURED"))?;
      let model = settings
        .marine_openai_model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "gpt-4o".to_string());
      let api_key = std::env::var("DONUT_MARINE_OPENAI_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
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

/// Parse a model's raw output into [`BlocksV1`], tolerating prose around the JSON
/// object (some models wrap it). Requires at least one block so a bare `{}` or a
/// truncated stream is treated as a failure, not an empty success.
fn parse_blocks_v1(raw: &str) -> Result<BlocksV1, String> {
  if let Ok(output) = serde_json::from_str::<BlocksV1>(raw) {
    if !output.blocks.is_empty() {
      return Ok(output);
    }
  }
  if let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}')) {
    if end > start {
      if let Ok(output) = serde_json::from_str::<BlocksV1>(&raw[start..=end]) {
        if !output.blocks.is_empty() {
          return Ok(output);
        }
      }
    }
  }
  Err(err_with(
    "MARINE_GENERATE_FAILED",
    format!(
      "could not parse output as blocks-v1 JSON: {}",
      raw.chars().take(200).collect::<String>()
    ),
  ))
}

/// Shared core: pick the configured provider, build the `blocks-v1` prompt from
/// the pre-built skill + grab payload, run it, and return the raw model output.
async fn run_provider(
  skill: &str,
  payload: &Value,
  deltas: mpsc::Sender<String>,
  cancellation: CancellationToken,
) -> Result<String, String> {
  let settings = SettingsManager::instance()
    .load_settings()
    .map_err(|error| err_with("MARINE_GENERATE_FAILED", format!("settings: {error}")))?;
  let provider = select_provider(&settings)?;
  let prompt = prompt::build_blocks_v1(payload, skill)
    .map_err(|message| err_with("MARINE_RIME_PROMPT_TOO_LARGE", message))?;
  let schema = blocks_v1_schema();
  provider
    .generate_stream(&prompt, &schema, deltas, cancellation)
    .await
    .map_err(map_provider_error)
}

/// One-shot generation. Runs the same hardened provider path as the streaming
/// entry point, draining real deltas in the background.
pub async fn generate_blocks(skill: &str, payload: &Value) -> Result<BlocksV1, String> {
  let (deltas, mut delta_rx) = mpsc::channel(32);
  let drain = tokio::spawn(async move { while delta_rx.recv().await.is_some() {} });
  let raw_result = run_provider(skill, payload, deltas, CancellationToken::new()).await;
  drain.await.map_err(|error| {
    err_with(
      "MARINE_GENERATE_FAILED",
      format!("delta drain failed: {error}"),
    )
  })?;
  parse_blocks_v1(&raw_result?)
}

/// Streaming generation. Raw assistant deltas are forwarded to the caller for
/// incremental preview while the final result still goes through the exact same
/// strict `blocks-v1` parser used by the one-shot path.
pub async fn generate_blocks_stream(
  skill: &str,
  payload: &Value,
  deltas: mpsc::Sender<String>,
  cancellation: CancellationToken,
) -> Result<BlocksV1, String> {
  let raw = run_provider(skill, payload, deltas, cancellation).await?;
  parse_blocks_v1(&raw)
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

  #[test]
  fn parses_blocks_v1_with_surrounding_prose() {
    let raw = "Sure!\n{\"blocks\":[{\"text\":\"你好 Scholay\",\"title\":null}]}\ndone";
    let output = parse_blocks_v1(raw).unwrap();
    assert_eq!(output.blocks.len(), 1);
    assert_eq!(output.blocks[0].text, "你好 Scholay");
  }

  #[test]
  fn empty_blocks_are_a_failure_not_a_success() {
    let mapped = parse_blocks_v1("{\"blocks\":[]}").unwrap_err();
    let value: Value = serde_json::from_str(&mapped).unwrap();
    assert_eq!(value["code"], "MARINE_GENERATE_FAILED");
  }

  #[test]
  fn blocks_v1_schema_is_openai_strict_compliant() {
    // OpenAI strict structured outputs require every object with
    // additionalProperties:false to list ALL its properties in `required`
    // (nullable-but-required expresses "optional"). A missing key → the API
    // rejects the request with invalid_json_schema. Guard against regressing.
    fn check(node: &Value) {
      if node.get("type").and_then(Value::as_str) == Some("object") {
        let empty = serde_json::Map::new();
        let props = node
          .get("properties")
          .and_then(Value::as_object)
          .unwrap_or(&empty);
        let required: Vec<&str> = node
          .get("required")
          .and_then(Value::as_array)
          .map(|a| a.iter().filter_map(Value::as_str).collect())
          .unwrap_or_default();
        for key in props.keys() {
          assert!(
            required.contains(&key.as_str()),
            "property {key:?} missing from `required` (OpenAI strict mode)"
          );
        }
        for value in props.values() {
          check(value);
        }
      }
      if let Some(items) = node.get("items") {
        check(items);
      }
    }
    let schema = blocks_v1_schema();
    check(&schema);
    let serialized = schema.to_string();
    assert!(
      !serialized.contains("minItems") && !serialized.contains("maxItems"),
      "minItems/maxItems are unsupported by OpenAI strict mode"
    );
  }
}
