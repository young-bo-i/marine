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
pub mod quality;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use utoipa::ToSchema;

use super::{err, err_with};
use crate::settings_manager::{AppSettings, SettingsManager};
use quality::{
  build_comment_repair_prompt, validate_comment_quality, validate_comment_quality_spec,
  CommentQualitySpec,
};

const MAX_COMMENT_GENERATION_ATTEMPTS: usize = 3;
/// One wall-clock budget shared by the initial candidate and every repair.
/// The extension aborts its fetch after 245 seconds, so the server must finish
/// generation (or begin graceful provider cleanup) before that outer deadline.
pub const COMMENT_GENERATION_TOTAL_TIMEOUT_SECS: u64 = 230;

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
      // Substituted here rather than left to Codex: an unset model used to mean
      // "whatever `~/.codex/config.toml` says", which made the model behind
      // every comment depend on an unrelated terminal preference.
      model: Some(
        settings
          .marine_cli_model
          .clone()
          .map(|value| value.trim().to_string())
          .filter(|value| !value.is_empty())
          .unwrap_or_else(|| cli::DEFAULT_CODEX_MODEL.to_string()),
      ),
      reasoning_effort: Some(
        cli::normalize_codex_reasoning_effort(settings.marine_cli_reasoning_effort.as_deref())
          .map_err(|message| err_with("MARINE_PROVIDER_INVALID", message))?
          .unwrap_or_else(|| cli::DEFAULT_CODEX_REASONING_EFFORT.to_string()),
      ),
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
/// object (some models wrap it). The connector contract is exactly one nonempty
/// block; extra blocks are not silently ignored by the page.
fn parse_blocks_v1(raw: &str) -> Result<BlocksV1, String> {
  if let Ok(output) = serde_json::from_str::<BlocksV1>(raw) {
    if valid_blocks_shape(&output) {
      return Ok(output);
    }
  }
  if let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}')) {
    if end > start {
      if let Ok(output) = serde_json::from_str::<BlocksV1>(&raw[start..=end]) {
        if valid_blocks_shape(&output) {
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

fn valid_blocks_shape(output: &BlocksV1) -> bool {
  output.blocks.len() == 1 && !output.blocks[0].text.trim().is_empty()
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

pub(crate) fn validate_generation_quality_spec(spec: &CommentQualitySpec) -> Result<(), String> {
  let issues = validate_comment_quality_spec(spec);
  if issues.is_empty() {
    return Ok(());
  }
  let codes = issues
    .iter()
    .map(|issue| issue.code_str())
    .collect::<Vec<_>>()
    .join(",");
  Err(err_with(
    "MARINE_COMMENT_SPEC_INVALID",
    format!("comment quality specification is invalid: {codes}"),
  ))
}

async fn run_provider_before_deadline(
  skill: &str,
  payload: &Value,
  deltas: mpsc::Sender<String>,
  cancellation: &CancellationToken,
  deadline: tokio::time::Instant,
) -> Result<String, String> {
  if cancellation.is_cancelled() {
    return Err(err("MARINE_GENERATE_CANCELLED"));
  }
  if tokio::time::Instant::now() >= deadline {
    return Err(err("MARINE_GENERATE_TIMEOUT"));
  }

  // Do not drop a CLI provider future at the deadline: it owns the process-group
  // cleanup path. Cancel its child token, then await that bounded cleanup.
  let attempt_cancellation = cancellation.child_token();
  let provider = run_provider(skill, payload, deltas, attempt_cancellation.clone());
  tokio::pin!(provider);
  tokio::select! {
    result = &mut provider => result,
    _ = cancellation.cancelled() => {
      attempt_cancellation.cancel();
      let _ = provider.await;
      Err(err("MARINE_GENERATE_CANCELLED"))
    }
    _ = tokio::time::sleep_until(deadline) => {
      attempt_cancellation.cancel();
      let _ = provider.await;
      Err(err("MARINE_GENERATE_TIMEOUT"))
    }
  }
}

async fn run_validated_provider(
  skill: &str,
  payload: &Value,
  quality_spec: &CommentQualitySpec,
  deltas: mpsc::Sender<String>,
  cancellation: CancellationToken,
) -> Result<BlocksV1, String> {
  // Static policy errors are never repairable by a model. Reject them before
  // loading provider settings or consuming any connector quota.
  validate_generation_quality_spec(quality_spec)?;
  let deadline =
    tokio::time::Instant::now() + Duration::from_secs(COMMENT_GENERATION_TOTAL_TIMEOUT_SECS);
  let mut repair_instruction = None::<String>;
  let mut last_issue_codes = Vec::<String>::new();

  for attempt in 1..=MAX_COMMENT_GENERATION_ATTEMPTS {
    if cancellation.is_cancelled() {
      return Err(err("MARINE_GENERATE_CANCELLED"));
    }
    let attempt_skill = repair_instruction
      .as_ref()
      .map(|repair| format!("{skill}\n\n---\n\n# Marine 质量修复指令（最高优先级）\n\n{repair}"));
    let effective_skill = attempt_skill.as_deref().unwrap_or(skill);
    let raw = run_provider_before_deadline(
      effective_skill,
      payload,
      deltas.clone(),
      &cancellation,
      deadline,
    )
    .await?;

    let parsed = parse_blocks_v1(&raw);
    let candidate = parsed.unwrap_or_default();
    let issues = validate_comment_quality(&candidate, quality_spec);
    if issues.is_empty() {
      return Ok(candidate);
    }

    last_issue_codes = issues
      .iter()
      .map(|issue| issue.code_str().to_string())
      .collect();
    log::warn!(
      "Marine comment candidate rejected on attempt {attempt}/{MAX_COMMENT_GENERATION_ATTEMPTS}: {}",
      last_issue_codes.join(",")
    );
    if attempt < MAX_COMMENT_GENERATION_ATTEMPTS {
      let original_text = candidate
        .blocks
        .first()
        .map(|block| block.text.as_str())
        .unwrap_or(raw.as_str());
      repair_instruction = Some(build_comment_repair_prompt(
        original_text,
        quality_spec,
        &issues,
      ));
    }
  }

  Err(err_with(
    "MARINE_COMMENT_QUALITY_FAILED",
    format!(
      "candidate failed semantic validation after {MAX_COMMENT_GENERATION_ATTEMPTS} attempts: {}",
      last_issue_codes.join(",")
    ),
  ))
}

/// One-shot generation. Runs the same hardened provider path as the streaming
/// entry point, draining real deltas in the background. A validated structured
/// policy is mandatory for every caller.
pub async fn generate_blocks_with_quality(
  skill: &str,
  payload: &Value,
  quality_spec: &CommentQualitySpec,
) -> Result<BlocksV1, String> {
  let (deltas, mut delta_rx) = mpsc::channel(32);
  let drain = tokio::spawn(async move { while delta_rx.recv().await.is_some() {} });
  let result = run_validated_provider(
    skill,
    payload,
    quality_spec,
    deltas,
    CancellationToken::new(),
  )
  .await;
  drain.await.map_err(|error| {
    err_with(
      "MARINE_GENERATE_FAILED",
      format!("delta drain failed: {error}"),
    )
  })?;
  result
}

/// Streaming generation. Provider deltas go to a server-side sink; only the
/// validated final block is eligible for an editor-facing `done` frame.
pub async fn generate_blocks_stream_with_quality(
  skill: &str,
  payload: &Value,
  quality_spec: &CommentQualitySpec,
  deltas: mpsc::Sender<String>,
  cancellation: CancellationToken,
) -> Result<BlocksV1, String> {
  run_validated_provider(skill, payload, quality_spec, deltas, cancellation).await
}

/// Does this provider failure say the configured model is unusable?
///
/// `map_provider_error` deliberately keeps provider internals off the page, but
/// a rejected model is not an internal detail — it is a value the user typed
/// into the connector settings. Collapsed into the generic bucket it renders as
/// "生成失败，请重试", which sends them to retry forever instead of to the
/// field they got wrong; the model is pinned now, so this failure is permanent
/// rather than transient.
///
/// Matched on the message because the app-server reports it as a plain terminal
/// error: Codex 0.144.4 answers a bad model with
/// `"The 'x' model is not supported when using Codex with a ChatGPT account."`
/// inside a 400 `invalid_request_error`.
fn rejected_model_detail(error: &str) -> Option<String> {
  let lowered = error.to_ascii_lowercase();
  let names_a_model = lowered.contains("model is not supported")
    || lowered.contains("model_not_found")
    || lowered.contains("unknown model")
    || (lowered.contains("invalid_request_error") && lowered.contains("model"));
  if !names_a_model {
    return None;
  }
  // Prefer the innermost human sentence; the raw payload is nested JSON.
  let detail = error
    .rsplit_once("\"message\":")
    .map(|(_, tail)| tail)
    .unwrap_or(error)
    .trim()
    .trim_start_matches('"')
    .split("\",")
    .next()
    .unwrap_or(error)
    .trim()
    .trim_matches('"')
    .replace("\\\"", "\"")
    .trim()
    .to_string();
  Some(if detail.is_empty() {
    error.chars().take(200).collect()
  } else {
    detail.chars().take(200).collect()
  })
}

fn map_provider_error(error: String) -> String {
  if error == "MARINE_GENERATE_TIMEOUT" || error == "MARINE_GENERATE_CANCELLED" {
    err(&error)
  } else if let Some(detail) = rejected_model_detail(&error) {
    log::warn!("Marine generation rejected the configured model: {detail}");
    err_with("MARINE_MODEL_REJECTED", detail)
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

  /// The exact payload Codex 0.144.4 returns for a mistyped model, captured
  /// from a real run. Collapsing this into MARINE_GENERATE_FAILED is what makes
  /// a one-character typo look like a permanent unexplained outage.
  #[test]
  fn a_rejected_model_is_named_instead_of_becoming_a_generic_failure() {
    let real = "Codex reported an error: {\"type\":\"error\",\"status\":400,\"error\":\
                {\"type\":\"invalid_request_error\",\"message\":\"The 'gpt5.3-spark-typo' \
                model is not supported when using Codex with a ChatGPT account.\"}}";
    let detail = rejected_model_detail(real).expect("a rejected model must be recognised");
    assert!(detail.contains("gpt5.3-spark-typo"), "{detail}");
    assert!(
      !detail.contains("invalid_request_error"),
      "raw payload leaked: {detail}"
    );

    let mapped = map_provider_error(real.to_string());
    assert!(mapped.contains("MARINE_MODEL_REJECTED"), "{mapped}");
    assert!(mapped.contains("gpt5.3-spark-typo"), "{mapped}");
  }

  /// Ordinary failures must stay in the generic bucket — promoting them would
  /// leak provider internals onto the page.
  #[test]
  fn unrelated_provider_failures_stay_generic() {
    for ordinary in [
      "Codex produced no answer",
      "spawn Codex app-server failed: No such file or directory",
      "Codex closed without exactly one successful result event",
    ] {
      assert_eq!(rejected_model_detail(ordinary), None, "{ordinary}");
      assert!(map_provider_error(ordinary.to_string()).contains("MARINE_GENERATE_FAILED"));
    }
    // Cancellation and timeout keep their own codes.
    assert!(
      map_provider_error("MARINE_GENERATE_TIMEOUT".to_string()).contains("MARINE_GENERATE_TIMEOUT")
    );
  }

  fn valid_quality_spec() -> CommentQualitySpec {
    CommentQualitySpec {
      schema_version: quality::COMMENT_QUALITY_SCHEMA_VERSION,
      action: quality::CommentAction::Direct,
      persona_id: "P01".into(),
      brand_mode: quality::BrandMode::Required,
      brand_term: "Scholay".into(),
      brand_case_sensitive: true,
      required_capability_terms: vec!["文献矩阵分析".into()],
      min_chars: 20,
      max_chars: 240,
      forbidden_claims: None,
      forbidden_phrases: None,
      recent_texts: None,
    }
  }

  #[tokio::test]
  async fn invalid_quality_spec_is_rejected_before_provider_selection() {
    let mut spec = valid_quality_spec();
    spec.schema_version = 1;
    let error = generate_blocks_with_quality("skill", &serde_json::json!({}), &spec)
      .await
      .unwrap_err();
    let value: Value = serde_json::from_str(&error).unwrap();
    assert_eq!(value["code"], "MARINE_COMMENT_SPEC_INVALID");
  }

  #[test]
  fn comment_generation_budget_precedes_extension_deadline() {
    assert_eq!(COMMENT_GENERATION_TOTAL_TIMEOUT_SECS, 230);
  }

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
  fn multiple_or_blank_blocks_are_never_silently_accepted() {
    for raw in [
      r#"{"blocks":[{"text":"one","title":null},{"text":"two","title":null}]}"#,
      r#"{"blocks":[{"text":"   ","title":null}]}"#,
    ] {
      assert!(parse_blocks_v1(raw).is_err(), "unexpectedly accepted {raw}");
    }
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
