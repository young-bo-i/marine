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
  async fn generate(&self, prompt: &str, schema: &Value) -> Result<String, String>;
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
pub async fn generate_output(
  skill: &str,
  payload: &Value,
) -> Result<GenerationOutput, String> {
  let settings = SettingsManager::instance()
    .load_settings()
    .map_err(|e| err_with("MARINE_GENERATE_FAILED", format!("settings: {e}")))?;
  let provider = select_provider(&settings)?;
  let (prompt_text, schema) = prompt::build(payload, skill);
  let raw = provider
    .generate(&prompt_text, &schema)
    .await
    .map_err(|e| {
      if e == "MARINE_GENERATE_TIMEOUT" {
        err("MARINE_GENERATE_TIMEOUT")
      } else if e.starts_with('{') {
        e
      } else {
        err_with("MARINE_GENERATE_FAILED", e)
      }
    })?;
  parse_output(&raw)
}
