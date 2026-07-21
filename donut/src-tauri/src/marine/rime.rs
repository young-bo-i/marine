//! Rime Buffer action-plugin bridge.
//!
//! The browser extension publishes the editor/comment target that currently
//! owns focus. Rime Buffer can then discover that target through the local
//! Marine API and request a target-bound prompt for its selected AI connector.
//! Context is intentionally memory-only: when Marine is not running there is
//! no plugin runtime, and restarting Marine never revives a stale page target.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use utoipa::ToSchema;

pub const DIRECT_ACTION_ID: &str = "marine.generate-direct";
pub const REPLY_ACTION_ID: &str = "marine.generate-reply";
pub const RIME_PLUGIN_ID: &str = "marine";
pub const CONTEXT_TTL_SECS: u64 = 5 * 60;
const MAX_FUTURE_SKEW_SECS: u64 = 60;
const MILLIS_PER_SEC: u64 = 1000;
// Contemporary Unix seconds are 10 digits and milliseconds are 13 digits.
// Keeping the cutoff between them lets older extension builds continue to
// publish seconds while newer builds gain sub-second lease ordering.
const MILLIS_TIMESTAMP_CUTOFF: u64 = 100_000_000_000;
const REVOKED_CONTEXT_TTL_SECS: u64 = CONTEXT_TTL_SECS + MAX_FUTURE_SKEW_SECS;
const MAX_ACTIVE_CONTEXTS: usize = 32;
const MAX_REVOKED_CONTEXTS: usize = 4096;
const RIME_CONTEXT_ENVELOPE_VERSION: u8 = 1;
const RIME_SOURCE_SUBTITLE: &str = "subtitle";
const RIME_SOURCE_COMMENTS: &str = "comments";
const RIME_SOURCE_ARTICLE: &str = "article";
const RIME_SOURCE_NONE: &str = "none";
const MAX_RIME_TARGET_SUMMARY_BYTES: usize = 1_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RimeContextMode {
  Direct,
  Reply,
}

impl RimeContextMode {
  pub fn action_id(self) -> &'static str {
    match self {
      Self::Direct => DIRECT_ACTION_ID,
      Self::Reply => REPLY_ACTION_ID,
    }
  }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeTarget {
  #[serde(default)]
  pub id: String,
  #[serde(default)]
  pub author_name: String,
  #[serde(default)]
  pub text: String,
  #[serde(default)]
  pub parent_id: String,
  #[serde(default)]
  pub root_id: String,
}

impl RimeTarget {
  fn is_complete_reply_target(&self) -> bool {
    !self.id.is_empty()
      && self.id == self.id.trim()
      && !self.author_name.trim().is_empty()
      && !self.text.trim().is_empty()
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeContext {
  pub context_id: String,
  /// Browser profile stamped into the extension runtime by Marine. Empty is
  /// accepted only for the lightweight development bridge and older clients.
  #[serde(default)]
  pub profile_id: String,
  /// Canonical brand snapshot resolved by Marine when the context is accepted.
  #[serde(default)]
  pub brand_id: String,
  #[serde(default)]
  pub brand_revision: u64,
  pub mode: RimeContextMode,
  pub action_id: String,
  pub label: String,
  pub target_summary: String,
  pub platform: String,
  pub url: String,
  pub title: String,
  #[serde(default)]
  pub target: Option<RimeTarget>,
  #[serde(default)]
  pub skill: String,
  /// Normalized Marine prompt payload:
  /// `article.markdown`, `comments.agentMd`, and `subtitle.text`.
  #[serde(default)]
  #[schema(value_type = Object)]
  pub payload: Value,
  pub updated_at: u64,
}

impl RimeContext {
  pub fn validate(&self, now_secs: u64) -> Result<(), RimeContextError> {
    if self.context_id.trim().is_empty() {
      return Err(RimeContextError::Invalid("contextId is required"));
    }
    if self.action_id != self.mode.action_id() {
      return Err(RimeContextError::Invalid(
        "actionId does not match the context mode",
      ));
    }
    if !self.payload.is_object() {
      return Err(RimeContextError::Invalid("payload must be an object"));
    }
    if self.target_summary.len() > MAX_RIME_TARGET_SUMMARY_BYTES
      || self.target_summary.contains('\0')
    {
      return Err(RimeContextError::Invalid(
        "targetSummary must be at most 1000 UTF-8 bytes without NUL",
      ));
    }
    if self.mode == RimeContextMode::Reply
      && !self
        .target
        .as_ref()
        .is_some_and(RimeTarget::is_complete_reply_target)
    {
      return Err(RimeContextError::Invalid(
        "reply context must include target id, authorName, and text",
      ));
    }
    if !is_fresh_timestamp(self.updated_at, now_secs) {
      return Err(RimeContextError::Stale);
    }
    Ok(())
  }

  /// Add Marine's trusted action and target binding before prompt assembly.
  pub fn prompt_payload(&self) -> Value {
    let mut payload = self.payload.clone();
    let selected_source = rime_payload_source(&payload);
    let Some(object) = payload.as_object_mut() else {
      return payload;
    };
    object.insert(
      "__marineContext".to_string(),
      serde_json::json!({
        "version": RIME_CONTEXT_ENVELOPE_VERSION,
        "contextId": self.context_id,
        "profileId": self.profile_id,
        "brandId": self.brand_id,
        "brandRevision": self.brand_revision,
        "updatedAt": self.updated_at,
        "platform": self.platform,
        "url": self.url,
        "title": self.title,
        "mode": self.mode,
        "actionId": self.action_id,
        "label": self.label,
        "targetSummary": self.target_summary,
        "source": selected_source,
        "sourceSelection": {
          "selected": selected_source,
          "policy": [RIME_SOURCE_SUBTITLE, RIME_SOURCE_COMMENTS, RIME_SOURCE_ARTICLE],
        },
        "target": self.target,
      }),
    );
    object.insert(
      "__marineIntent".to_string(),
      serde_json::json!({
        "mode": self.mode,
        "target": self.target,
        "targetSummary": self.target_summary,
      }),
    );
    payload
  }
}

fn rime_payload_source(payload: &Value) -> &'static str {
  if rime_payload_has_text(payload, "subtitle", "text") {
    RIME_SOURCE_SUBTITLE
  } else if rime_payload_has_text(payload, "comments", "agentMd") {
    RIME_SOURCE_COMMENTS
  } else if rime_payload_has_text(payload, "article", "markdown") {
    RIME_SOURCE_ARTICLE
  } else {
    RIME_SOURCE_NONE
  }
}

fn rime_payload_has_text(payload: &Value, section: &str, field: &str) -> bool {
  payload
    .get(section)
    .and_then(|value| value.get(field))
    .and_then(Value::as_str)
    .is_some_and(|value| !value.trim().is_empty())
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeStatus {
  pub available: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub context_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mode: Option<RimeContextMode>,
  pub action_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub target_summary: Option<String>,
  pub updated_at: u64,
}

impl RimeStatus {
  fn unavailable(updated_at: u64) -> Self {
    Self {
      available: false,
      context_id: None,
      mode: None,
      action_id: String::new(),
      label: None,
      target_summary: None,
      updated_at,
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeInvokeRequest {
  pub request_id: String,
  pub action_id: String,
  pub context_id: String,
}

pub const RIME_PREPARE_PROTOCOL_VERSION: u8 = 1;
pub const RIME_PREPARE_RESULT_FORMAT: &str = "blocks-v1";
const MAX_RIME_REQUEST_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimePrepareRequest {
  pub plugin_id: String,
  pub runtime_instance_id: String,
  #[serde(flatten)]
  pub invoke: RimeInvokeRequest,
}

impl RimePrepareRequest {
  pub fn validate_binding(
    &self,
    expected_plugin_id: &str,
    expected_runtime_instance_id: &str,
  ) -> Result<(), RimeContextError> {
    for value in [
      self.plugin_id.as_str(),
      self.runtime_instance_id.as_str(),
      self.invoke.request_id.as_str(),
      self.invoke.action_id.as_str(),
      self.invoke.context_id.as_str(),
    ] {
      if value.is_empty()
        || value.len() > MAX_RIME_REQUEST_ID_BYTES
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
      {
        return Err(RimeContextError::Invalid(
          "request identity fields must be 1-128 bytes of printable ASCII",
        ));
      }
    }
    if self.plugin_id != expected_plugin_id {
      return Err(RimeContextError::Invalid(
        "pluginId does not match this runtime",
      ));
    }
    if self.runtime_instance_id != expected_runtime_instance_id {
      return Err(RimeContextError::Invalid(
        "runtimeInstanceId does not match this runtime",
      ));
    }
    Ok(())
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimePrepareResponse {
  pub protocol_version: u8,
  pub result_format: String,
  pub plugin_id: String,
  pub runtime_instance_id: String,
  pub request_id: String,
  pub action_id: String,
  pub context_id: String,
  pub prompt: String,
  pub target_summary: String,
}

impl RimePrepareResponse {
  pub fn new(request: &RimePrepareRequest, prompt: String, target_summary: String) -> Self {
    Self {
      protocol_version: RIME_PREPARE_PROTOCOL_VERSION,
      result_format: RIME_PREPARE_RESULT_FORMAT.to_string(),
      plugin_id: request.plugin_id.clone(),
      runtime_instance_id: request.runtime_instance_id.clone(),
      request_id: request.invoke.request_id.clone(),
      action_id: request.invoke.action_id.clone(),
      context_id: request.invoke.context_id.clone(),
      prompt,
      target_summary,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RimeContextError {
  Missing,
  Stale,
  ContextMismatch,
  ActionMismatch,
  Invalid(&'static str),
}

#[derive(Debug, Clone)]
struct StoredRimeContext {
  context: RimeContext,
  updated_at_millis: u64,
  received_order: u64,
}

#[derive(Debug, Default)]
struct RimeContextState {
  contexts: HashMap<String, StoredRimeContext>,
  revoked_contexts: HashMap<String, u64>,
  active_context_id: Option<String>,
  high_watermark_millis: u64,
  high_watermark_wire: u64,
  next_received_order: u64,
}

impl RimeContextState {
  fn latest_fresh(&self, now_secs: u64) -> Option<&StoredRimeContext> {
    let active_context_id = self.active_context_id.as_deref()?;
    self
      .contexts
      .get(active_context_id)
      .filter(|stored| is_fresh_timestamp_millis(stored.updated_at_millis, now_secs))
  }

  fn prune(&mut self, now_secs: u64) {
    self
      .contexts
      .retain(|_, stored| is_fresh_timestamp_millis(stored.updated_at_millis, now_secs));
    self.revoked_contexts.retain(|_, revoked_at| {
      *revoked_at <= now_secs.saturating_add(MAX_FUTURE_SKEW_SECS)
        && now_secs.saturating_sub(*revoked_at) <= REVOKED_CONTEXT_TTL_SECS
    });
    while self.revoked_contexts.len() > MAX_REVOKED_CONTEXTS {
      let Some(oldest) = self
        .revoked_contexts
        .iter()
        .min_by_key(|(_, revoked_at)| **revoked_at)
        .map(|(context_id, _)| context_id.clone())
      else {
        break;
      };
      self.revoked_contexts.remove(&oldest);
    }
  }

  fn revoke(&mut self, context_id: &str, now_secs: u64) -> bool {
    let removed = self.contexts.remove(context_id).is_some();
    if self.active_context_id.as_deref() == Some(context_id) {
      self.active_context_id = None;
    }
    self
      .revoked_contexts
      .insert(context_id.to_string(), now_secs);
    removed
  }
}

#[derive(Clone, Default)]
pub struct RimeContextStore {
  inner: Arc<RwLock<RimeContextState>>,
}

impl RimeContextStore {
  pub fn set(&self, context: RimeContext, now_secs: u64) -> Result<RimeStatus, RimeContextError> {
    context.validate(now_secs)?;
    let updated_at_millis = normalize_timestamp_millis(context.updated_at);
    let mut state = self.inner.write().unwrap_or_else(|e| e.into_inner());
    state.prune(now_secs);
    if state.revoked_contexts.contains_key(&context.context_id) {
      return Err(RimeContextError::ContextMismatch);
    }

    let context_id = context.context_id.clone();
    if state.active_context_id.as_deref() == Some(context_id.as_str()) {
      if state
        .contexts
        .get(&context_id)
        .is_some_and(|stored| stored.updated_at_millis >= updated_at_millis)
        || updated_at_millis <= state.high_watermark_millis
      {
        let status = status_from_state(&state, now_secs);
        return Ok(status);
      }

      // A strictly newer publication for the currently active context is a
      // lease renewal, not a new semantic target. Keep the brand snapshot
      // frozen and reject any attempt to mutate page/target semantics under an
      // existing context id.
      let stored_context = state
        .contexts
        .get(&context_id)
        .map(|stored| stored.context.clone())
        .ok_or(RimeContextError::ContextMismatch)?;
      let mut renewed = context;
      if !stored_context.profile_id.is_empty() && renewed.profile_id == stored_context.profile_id {
        renewed.brand_id = stored_context.brand_id.clone();
        renewed.brand_revision = stored_context.brand_revision;
        renewed.skill = stored_context.skill.clone();
      }
      let mut comparable = renewed.clone();
      comparable.updated_at = stored_context.updated_at;
      if comparable != stored_context {
        return Err(RimeContextError::ContextMismatch);
      }
      state.next_received_order = state.next_received_order.saturating_add(1);
      let received_order = state.next_received_order;
      state.high_watermark_millis = updated_at_millis;
      state.high_watermark_wire = renewed.updated_at;
      state.contexts.insert(
        context_id,
        StoredRimeContext {
          context: renewed,
          updated_at_millis,
          received_order,
        },
      );
      state.prune(now_secs);
      let status = status_from_state(&state, now_secs);
      return Ok(status);
    } else if updated_at_millis <= state.high_watermark_millis {
      // A superseded profile must not regain ownership merely because its PUT
      // completed late. Equal timestamps are deliberately fail-closed too.
      state.revoke(&context_id, now_secs);
      state.prune(now_secs);
      let status = status_from_state(&state, now_secs);
      return Ok(status);
    }

    if let Some(previous) = state.active_context_id.take() {
      state.revoke(&previous, now_secs);
    }
    let inactive_contexts: Vec<String> = state.contexts.keys().cloned().collect();
    for inactive in inactive_contexts {
      state.revoke(&inactive, now_secs);
    }
    state.next_received_order = state.next_received_order.saturating_add(1);
    let received_order = state.next_received_order;
    state.active_context_id = Some(context_id.clone());
    state.high_watermark_millis = updated_at_millis;
    state.high_watermark_wire = context.updated_at;
    state.contexts.insert(
      context_id,
      StoredRimeContext {
        context,
        updated_at_millis,
        received_order,
      },
    );
    while state.contexts.len() > MAX_ACTIVE_CONTEXTS {
      let Some(oldest) = state
        .contexts
        .iter()
        .min_by_key(|(_, stored)| {
          (
            stored.updated_at_millis,
            std::cmp::Reverse(stored.received_order),
          )
        })
        .map(|(context_id, _)| context_id.clone())
      else {
        break;
      };
      state.contexts.remove(&oldest);
      state.revoked_contexts.insert(oldest, now_secs);
    }
    state.prune(now_secs);
    let status = status_from_state(&state, now_secs);
    Ok(status)
  }

  pub fn clear(&self, expected_context_id: Option<&str>) -> bool {
    self.clear_at(expected_context_id, now_secs())
  }

  fn clear_at(&self, expected_context_id: Option<&str>, now_secs: u64) -> bool {
    let Some(expected) = expected_context_id
      .map(str::trim)
      .filter(|value| !value.is_empty())
    else {
      return false;
    };
    let mut state = self.inner.write().unwrap_or_else(|e| e.into_inner());
    state.prune(now_secs);
    // Focus leases are unique. Keep a short tombstone so a PUT that was
    // already in flight when DELETE arrived cannot revive that target.
    let removed = state.revoke(expected, now_secs);
    state.prune(now_secs);
    removed
  }

  pub fn status(&self, now_secs: u64) -> RimeStatus {
    let state = self.inner.read().unwrap_or_else(|e| e.into_inner());
    status_from_state(&state, now_secs)
  }

  pub fn context_for_invoke(
    &self,
    request: &RimeInvokeRequest,
    now_secs: u64,
  ) -> Result<RimeContext, RimeContextError> {
    if request.request_id.trim().is_empty()
      || request.context_id.trim().is_empty()
      || request.action_id.trim().is_empty()
    {
      return Err(RimeContextError::Invalid(
        "requestId, contextId, and actionId are required",
      ));
    }
    let state = self.inner.read().unwrap_or_else(|e| e.into_inner());
    let context = state
      .latest_fresh(now_secs)
      .map(|stored| &stored.context)
      .ok_or_else(|| {
        if state.contexts.is_empty() {
          RimeContextError::Missing
        } else {
          RimeContextError::Stale
        }
      })?;
    if context.context_id != request.context_id {
      return Err(RimeContextError::ContextMismatch);
    }
    if context.action_id != request.action_id {
      return Err(RimeContextError::ActionMismatch);
    }
    Ok(context.clone())
  }
}

fn status_from_state(state: &RimeContextState, now_secs: u64) -> RimeStatus {
  let Some(context) = state.latest_fresh(now_secs).map(|stored| &stored.context) else {
    let updated_at = if state.high_watermark_wire > 0 {
      state.high_watermark_wire
    } else {
      now_secs
    };
    return RimeStatus::unavailable(updated_at);
  };
  RimeStatus {
    available: true,
    context_id: Some(context.context_id.clone()),
    mode: Some(context.mode),
    action_id: context.action_id.clone(),
    label: Some(context.label.clone()),
    target_summary: Some(context.target_summary.clone()),
    updated_at: context.updated_at,
  }
}

pub fn now_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

fn is_fresh_timestamp(updated_at: u64, now_secs: u64) -> bool {
  is_fresh_timestamp_millis(normalize_timestamp_millis(updated_at), now_secs)
}

fn normalize_timestamp_millis(updated_at: u64) -> u64 {
  if updated_at < MILLIS_TIMESTAMP_CUTOFF {
    updated_at.saturating_mul(MILLIS_PER_SEC)
  } else {
    updated_at
  }
}

fn is_fresh_timestamp_millis(updated_at_millis: u64, now_secs: u64) -> bool {
  let now_millis = now_secs.saturating_mul(MILLIS_PER_SEC);
  updated_at_millis > 0
    && updated_at_millis
      <= now_millis.saturating_add(MAX_FUTURE_SKEW_SECS.saturating_mul(MILLIS_PER_SEC))
    && now_millis.saturating_sub(updated_at_millis)
      <= CONTEXT_TTL_SECS.saturating_mul(MILLIS_PER_SEC)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RimeRuntimeConfig<'a> {
  plugin_id: &'static str,
  api_base: String,
  token: &'a str,
  updated_at: u64,
  instance_id: &'a str,
  process_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RimeRuntimeOwnership {
  instance_id: String,
  process_id: u32,
}

pub fn runtime_config_path() -> PathBuf {
  crate::app_dirs::data_dir().join("etinput-runtime.json")
}

pub fn generate_runtime_token() -> String {
  let token_bytes: [u8; 32] = {
    use rand::Rng;
    let mut rng = rand::rng();
    let mut bytes = [0u8; 32];
    rng.fill_bytes(&mut bytes);
    bytes
  };
  use base64::{engine::general_purpose, Engine as _};
  general_purpose::URL_SAFE_NO_PAD.encode(token_bytes)
}

pub fn write_runtime_config(port: u16, token: &str, instance_id: &str) -> Result<PathBuf, String> {
  write_runtime_config_at(&runtime_config_path(), port, token, instance_id, now_secs())
}

fn write_runtime_config_at(
  path: &Path,
  port: u16,
  token: &str,
  instance_id: &str,
  updated_at: u64,
) -> Result<PathBuf, String> {
  let parent = path
    .parent()
    .ok_or_else(|| "runtime config path has no parent".to_string())?;
  fs::create_dir_all(parent).map_err(|e| format!("create runtime config directory: {e}"))?;
  let config = RimeRuntimeConfig {
    plugin_id: RIME_PLUGIN_ID,
    api_base: format!("http://127.0.0.1:{port}/v1/marine"),
    token,
    updated_at,
    instance_id,
    process_id: std::process::id(),
  };
  let json =
    serde_json::to_vec_pretty(&config).map_err(|e| format!("serialize runtime config: {e}"))?;

  write_runtime_config_atomically(path, parent, &json)?;

  Ok(path.to_path_buf())
}

fn write_runtime_config_atomically(path: &Path, parent: &Path, json: &[u8]) -> Result<(), String> {
  use std::io::Write;

  let mut temporary = tempfile::Builder::new()
    .prefix(".etinput-runtime-")
    .tempfile_in(parent)
    .map_err(|error| format!("create temporary runtime config: {error}"))?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    temporary
      .as_file()
      .set_permissions(fs::Permissions::from_mode(0o600))
      .map_err(|error| format!("set temporary runtime config permissions: {error}"))?;
  }

  temporary
    .write_all(json)
    .map_err(|error| format!("write temporary runtime config: {error}"))?;
  temporary
    .as_file()
    .sync_all()
    .map_err(|error| format!("sync temporary runtime config: {error}"))?;
  temporary
    .persist(path)
    .map_err(|error| format!("replace runtime config: {}", error.error))?;

  // The file contents are durable above; syncing the containing directory
  // makes the atomic rename durable as well on Unix filesystems.
  #[cfg(unix)]
  fs::File::open(parent)
    .and_then(|directory| directory.sync_all())
    .map_err(|error| format!("sync runtime config directory: {error}"))?;

  Ok(())
}

/// Remove only the runtime file written by this exact API-server instance.
/// A second Marine process may already have replaced it with a newer lease;
/// an older process must never delete that newer process's credentials.
pub fn remove_runtime_config_if_owned(instance_id: &str) -> Result<bool, String> {
  remove_runtime_config_if_owned_at(&runtime_config_path(), instance_id)
}

/// Synchronous final-exit cleanup for Tauri's `RunEvent::Exit`. Tokio may no
/// longer be available there, so ownership is also recorded by process ID.
pub fn remove_runtime_config_for_current_process() -> Result<bool, String> {
  remove_runtime_config_if_process_at(&runtime_config_path(), std::process::id())
}

fn remove_runtime_config_if_owned_at(path: &Path, instance_id: &str) -> Result<bool, String> {
  remove_runtime_config_matching(path, |ownership| ownership.instance_id == instance_id)
}

fn remove_runtime_config_if_process_at(path: &Path, process_id: u32) -> Result<bool, String> {
  remove_runtime_config_matching(path, |ownership| ownership.process_id == process_id)
}

fn remove_runtime_config_matching(
  path: &Path,
  owns: impl FnOnce(&RimeRuntimeOwnership) -> bool,
) -> Result<bool, String> {
  remove_runtime_config_matching_after_claim(path, owns, || Ok(()))
}

fn remove_runtime_config_matching_after_claim(
  path: &Path,
  owns: impl FnOnce(&RimeRuntimeOwnership) -> bool,
  after_claim: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
  let parent = path
    .parent()
    .ok_or_else(|| "runtime config path has no parent".to_string())?;
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("etinput-runtime.json");
  let claimed_path = parent.join(format!(
    ".{file_name}.cleanup-{}-{}",
    std::process::id(),
    uuid::Uuid::new_v4()
  ));

  // Claim the exact directory entry before checking ownership. A newer
  // process may publish a replacement at `path` immediately afterwards, but
  // cleanup can then only remove this claimed inode, never that replacement.
  match fs::rename(path, &claimed_path) {
    Ok(()) => {}
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
    Err(error) => return Err(format!("claim runtime config before removal: {error}")),
  }

  let bytes = match fs::read(&claimed_path) {
    Ok(bytes) => bytes,
    Err(error) => {
      let restore_result = restore_claimed_runtime_config(&claimed_path, path);
      return match restore_result {
        Ok(()) => Err(format!("read claimed runtime config: {error}")),
        Err(restore_error) => Err(format!(
          "read claimed runtime config: {error}; {restore_error}"
        )),
      };
    }
  };
  let ownership: RimeRuntimeOwnership = match serde_json::from_slice(&bytes) {
    Ok(ownership) => ownership,
    Err(error) => {
      let restore_result = restore_claimed_runtime_config(&claimed_path, path);
      return match restore_result {
        Ok(()) => Err(format!("parse claimed runtime config: {error}")),
        Err(restore_error) => Err(format!(
          "parse claimed runtime config: {error}; {restore_error}"
        )),
      };
    }
  };
  if !owns(&ownership) {
    restore_claimed_runtime_config(&claimed_path, path)?;
    return Ok(false);
  }
  if let Err(error) = after_claim() {
    let restore_result = restore_claimed_runtime_config(&claimed_path, path);
    return match restore_result {
      Ok(()) => Err(error),
      Err(restore_error) => Err(format!("{error}; {restore_error}")),
    };
  }
  match fs::remove_file(&claimed_path) {
    Ok(()) => Ok(true),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
    Err(error) => Err(format!("remove claimed runtime config: {error}")),
  }
}

fn restore_claimed_runtime_config(claimed_path: &Path, path: &Path) -> Result<(), String> {
  match fs::hard_link(claimed_path, path) {
    Ok(()) => {}
    // A new runtime config won the race. It must remain authoritative; the
    // mismatched claimed file is now only an obsolete duplicate.
    Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
    Err(error) => {
      return Err(format!(
        "restore claimed runtime config (preserved at {}): {error}",
        claimed_path.display()
      ));
    }
  }
  match fs::remove_file(claimed_path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("remove claimed runtime config duplicate: {error}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn direct_context(updated_at: u64) -> RimeContext {
    RimeContext {
      context_id: "ctx-direct".into(),
      profile_id: String::new(),
      brand_id: String::new(),
      brand_revision: 0,
      mode: RimeContextMode::Direct,
      action_id: DIRECT_ACTION_ID.into(),
      label: "Marine · 直评".into(),
      target_summary: "视频直评".into(),
      platform: "bilibili".into(),
      url: "https://www.bilibili.com/video/BV1".into(),
      title: "Example".into(),
      target: None,
      skill: "be useful".into(),
      payload: serde_json::json!({"article": {"markdown": "video"}}),
      updated_at,
    }
  }

  fn reply_context(updated_at: u64) -> RimeContext {
    RimeContext {
      context_id: "ctx-reply".into(),
      mode: RimeContextMode::Reply,
      action_id: REPLY_ACTION_ID.into(),
      label: "Marine · 回复 @Alice".into(),
      target_summary: "回复 @Alice".into(),
      target: Some(RimeTarget {
        id: "42".into(),
        author_name: "Alice".into(),
        text: "这条评论".into(),
        ..Default::default()
      }),
      ..direct_context(updated_at)
    }
  }

  #[test]
  fn target_summary_matches_the_rime_prepare_byte_contract() {
    let now = 1_000_000;
    let mut context = direct_context(now);
    context.target_summary = "界".repeat(333);
    assert_eq!(context.target_summary.len(), 999);
    assert!(context.validate(now).is_ok());

    context.target_summary.push('界');
    assert_eq!(context.target_summary.len(), 1_002);
    assert_eq!(
      context.validate(now),
      Err(RimeContextError::Invalid(
        "targetSummary must be at most 1000 UTF-8 bytes without NUL"
      ))
    );

    context.target_summary = "bad\0summary".into();
    assert_eq!(
      context.validate(now),
      Err(RimeContextError::Invalid(
        "targetSummary must be at most 1000 UTF-8 bytes without NUL"
      ))
    );
  }

  #[test]
  fn store_rejects_stale_and_mismatched_invocations() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    store.set(direct_context(now), now).unwrap();

    let mismatch = RimeInvokeRequest {
      request_id: "req-1".into(),
      action_id: DIRECT_ACTION_ID.into(),
      context_id: "another-context".into(),
    };
    assert_eq!(
      store.context_for_invoke(&mismatch, now),
      Err(RimeContextError::ContextMismatch)
    );

    let current = RimeInvokeRequest {
      request_id: "req-2".into(),
      action_id: DIRECT_ACTION_ID.into(),
      context_id: "ctx-direct".into(),
    };
    assert_eq!(
      store.context_for_invoke(&current, now + CONTEXT_TTL_SECS + 1),
      Err(RimeContextError::Stale)
    );
  }

  #[test]
  fn action_binding_uses_the_captured_mode_and_rejects_cross_mode_invocation() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    store.set(reply_context(now), now).unwrap();

    let status = store.status(now);
    assert_eq!(status.mode, Some(RimeContextMode::Reply));
    assert_eq!(status.action_id, REPLY_ACTION_ID);
    assert_eq!(
      store.context_for_invoke(
        &RimeInvokeRequest {
          request_id: "req-cross-mode".into(),
          action_id: DIRECT_ACTION_ID.into(),
          context_id: "ctx-reply".into(),
        },
        now,
      ),
      Err(RimeContextError::ActionMismatch)
    );

    let mut mismatched_context = reply_context(now);
    mismatched_context.action_id = DIRECT_ACTION_ID.into();
    assert_eq!(
      mismatched_context.validate(now),
      Err(RimeContextError::Invalid(
        "actionId does not match the context mode"
      ))
    );
  }

  #[test]
  fn conditional_clear_cannot_remove_a_new_context() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    store.set(direct_context(now), now).unwrap();
    assert!(!store.clear_at(Some("old-context"), now));
    assert!(store.status(now).available);
    assert!(store.clear_at(Some("ctx-direct"), now));
    assert!(!store.status(now).available);
  }

  #[test]
  fn interleaved_profiles_keep_the_newest_lease_active() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    let mut older = direct_context(now - 2);
    older.context_id = "ctx-profile-a".into();
    let mut newer = reply_context(now);
    newer.context_id = "ctx-profile-b".into();

    store.set(older.clone(), now).unwrap();
    store.set(newer.clone(), now).unwrap();
    // Profile A's slow request completes after profile B has already
    // published its newer focus lease.
    assert!(matches!(
      store.set(older, now),
      Err(RimeContextError::ContextMismatch)
    ));

    let status = store.status(now);
    assert_eq!(status.context_id.as_deref(), Some("ctx-profile-b"));
    assert_eq!(status.action_id, REPLY_ACTION_ID);
    assert_eq!(
      store.context_for_invoke(
        &RimeInvokeRequest {
          request_id: "req-old".into(),
          action_id: DIRECT_ACTION_ID.into(),
          context_id: "ctx-profile-a".into(),
        },
        now,
      ),
      Err(RimeContextError::ContextMismatch)
    );

    assert!(!store.clear_at(Some("ctx-profile-a"), now));
    assert_eq!(
      store.status(now).context_id.as_deref(),
      Some("ctx-profile-b")
    );
    assert!(store.clear_at(Some("ctx-profile-b"), now));
    assert!(!store.status(now).available);
  }

  #[test]
  fn deleting_active_high_watermark_never_falls_back() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    let mut older = direct_context(now - 2);
    older.context_id = "ctx-profile-a".into();
    let mut newer = reply_context(now);
    newer.context_id = "ctx-profile-b".into();

    store.set(older.clone(), now).unwrap();
    store.set(newer, now).unwrap();
    assert!(store.clear_at(Some("ctx-profile-b"), now));
    assert!(!store.status(now).available);
    assert!(matches!(
      store.set(older, now),
      Err(RimeContextError::ContextMismatch)
    ));
    assert!(!store.status(now).available);
  }

  #[test]
  fn millisecond_leases_sort_within_the_same_second() {
    let now = 1_800_000_000;
    let now_millis = now * MILLIS_PER_SEC;
    let store = RimeContextStore::default();
    let mut newer = reply_context(now_millis - 100);
    newer.context_id = "ctx-profile-b".into();
    let mut delayed_older = direct_context(now_millis - 900);
    delayed_older.context_id = "ctx-profile-a".into();

    store.set(newer, now).unwrap();
    store.set(delayed_older, now).unwrap();

    let status = store.status(now);
    assert_eq!(status.context_id.as_deref(), Some("ctx-profile-b"));
    assert_eq!(status.updated_at, now_millis - 100);
  }

  #[test]
  fn identical_millisecond_lease_keeps_the_first_arrival() {
    let now = 1_800_000_000;
    let timestamp = now * MILLIS_PER_SEC - 100;
    let store = RimeContextStore::default();
    let mut first = reply_context(timestamp);
    first.context_id = "ctx-profile-b".into();
    let mut delayed = direct_context(timestamp);
    delayed.context_id = "ctx-profile-a".into();

    store.set(first, now).unwrap();
    store.set(delayed, now).unwrap();

    let status = store.status(now);
    assert_eq!(status.context_id.as_deref(), Some("ctx-profile-b"));
    assert_eq!(status.action_id, REPLY_ACTION_ID);
  }

  #[test]
  fn legacy_seconds_and_milliseconds_share_one_timeline() {
    let now = 1_800_000_000;
    let store = RimeContextStore::default();
    let mut legacy = direct_context(now - 1);
    legacy.context_id = "ctx-legacy-seconds".into();
    let mut milliseconds = reply_context(now * MILLIS_PER_SEC - 500);
    milliseconds.context_id = "ctx-milliseconds".into();

    store.set(milliseconds, now).unwrap();
    store.set(legacy, now).unwrap();

    assert_eq!(
      store.status(now).context_id.as_deref(),
      Some("ctx-milliseconds")
    );
  }

  #[test]
  fn delete_tombstone_rejects_a_late_put_for_the_same_lease() {
    let now = 1_000_000;
    let store = RimeContextStore::default();

    assert!(!store.clear_at(Some("ctx-in-flight"), now));
    let mut delayed = direct_context(now);
    delayed.context_id = "ctx-in-flight".into();
    assert!(matches!(
      store.set(delayed, now),
      Err(RimeContextError::ContextMismatch)
    ));
    assert!(!store.status(now).available);
  }

  #[test]
  fn older_renewal_cannot_regress_an_existing_lease() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    let mut newest = direct_context(now);
    newest.title = "new title".into();
    store.set(newest, now).unwrap();

    let mut delayed = direct_context(now - 1);
    delayed.title = "old title".into();
    store.set(delayed, now).unwrap();

    let context = store
      .context_for_invoke(
        &RimeInvokeRequest {
          request_id: "req-current".into(),
          action_id: DIRECT_ACTION_ID.into(),
          context_id: "ctx-direct".into(),
        },
        now,
      )
      .unwrap();
    assert_eq!(context.title, "new title");
    assert_eq!(context.updated_at, now);
  }

  #[test]
  fn consecutive_same_id_renewals_refresh_in_place() {
    let now = 1_800_000_000;
    let now_millis = now * MILLIS_PER_SEC;
    let store = RimeContextStore::default();
    let mut context = direct_context(now_millis - 400);
    let original_title = context.title.clone();
    store.set(context.clone(), now).unwrap();

    for age_millis in [300, 200, 100] {
      context.updated_at = now_millis - age_millis;
      let status = store.set(context.clone(), now).unwrap();
      assert!(status.available);
      assert_eq!(status.context_id.as_deref(), Some("ctx-direct"));
      assert_eq!(status.updated_at, context.updated_at);
    }

    // Equal and older deliveries are accepted as idempotent no-ops, but must
    // not overwrite the newest stored context with delayed semantic data.
    let mut equal = context.clone();
    equal.title = "equal timestamp must not replace".into();
    store.set(equal, now).unwrap();
    let mut older = context.clone();
    older.updated_at -= 1;
    older.title = "older timestamp must not replace".into();
    store.set(older, now).unwrap();

    let current = store
      .context_for_invoke(
        &RimeInvokeRequest {
          request_id: "req-after-renewals".into(),
          action_id: DIRECT_ACTION_ID.into(),
          context_id: "ctx-direct".into(),
        },
        now,
      )
      .unwrap();
    assert_eq!(current.updated_at, now_millis - 100);
    assert_eq!(current.title, original_title);
  }

  #[test]
  fn same_id_renewal_cannot_replace_target_semantics() {
    let now = 1_800_000_000;
    let store = RimeContextStore::default();
    let mut context = direct_context(now * MILLIS_PER_SEC - 200);
    store.set(context.clone(), now).unwrap();

    context.updated_at += 100;
    context.title = "different page".into();
    assert!(matches!(
      store.set(context, now),
      Err(RimeContextError::ContextMismatch)
    ));
  }

  #[test]
  fn same_id_profile_renewal_keeps_the_frozen_brand_revision() {
    let now = 1_800_000_000;
    let store = RimeContextStore::default();
    let mut context = direct_context(now * MILLIS_PER_SEC - 200);
    context.profile_id = uuid::Uuid::new_v4().to_string();
    context.brand_id = "brand-a".into();
    context.brand_revision = 3;
    context.skill = "frozen skill".into();
    store.set(context.clone(), now).unwrap();

    context.updated_at += 100;
    context.brand_id = "brand-b".into();
    context.brand_revision = 4;
    context.skill = "newer brand must wait for a new target lease".into();
    store.set(context.clone(), now).unwrap();

    let current = store
      .context_for_invoke(
        &RimeInvokeRequest {
          request_id: "req-frozen-brand".into(),
          action_id: DIRECT_ACTION_ID.into(),
          context_id: context.context_id,
        },
        now,
      )
      .unwrap();
    assert_eq!(current.brand_id, "brand-a");
    assert_eq!(current.brand_revision, 3);
    assert_eq!(current.skill, "frozen skill");
  }

  #[test]
  fn clear_after_renewal_tombstones_late_same_id_put() {
    let now = 1_800_000_000;
    let now_millis = now * MILLIS_PER_SEC;
    let store = RimeContextStore::default();
    let mut context = direct_context(now_millis - 300);
    store.set(context.clone(), now).unwrap();

    context.updated_at = now_millis - 200;
    store.set(context.clone(), now).unwrap();
    context.updated_at = now_millis - 100;
    store.set(context.clone(), now).unwrap();
    assert!(store.clear_at(Some("ctx-direct"), now));
    assert!(!store.status(now).available);

    context.updated_at = now_millis;
    assert!(matches!(
      store.set(context, now),
      Err(RimeContextError::ContextMismatch)
    ));
    assert!(!store.status(now).available);
  }

  #[test]
  fn reply_context_requires_exact_id_author_and_text() {
    let now = 1_000_000;
    for target in [
      RimeTarget {
        author_name: "Alice".into(),
        text: "comment".into(),
        ..Default::default()
      },
      RimeTarget {
        id: "42".into(),
        text: "comment".into(),
        ..Default::default()
      },
      RimeTarget {
        id: "42".into(),
        author_name: "Alice".into(),
        ..Default::default()
      },
      RimeTarget {
        id: " 42 ".into(),
        author_name: "Alice".into(),
        text: "comment".into(),
        ..Default::default()
      },
    ] {
      let mut context = reply_context(now);
      context.target = Some(target);
      assert_eq!(
        context.validate(now),
        Err(RimeContextError::Invalid(
          "reply context must include target id, authorName, and text"
        ))
      );
    }

    assert!(reply_context(now).validate(now).is_ok());
  }

  #[test]
  fn prompt_payload_overrides_forged_intent_with_captured_reply_target() {
    let mut context = reply_context(1);
    context.target.as_mut().unwrap().parent_id = "parent-9".into();
    context.target.as_mut().unwrap().root_id = "root-7".into();
    context.payload = serde_json::json!({
      "article": {"markdown": "article"},
      "comments": {"agentMd": "comments"},
      "subtitle": {"text": "subtitle"},
      "context": {
        "platform": "forged-platform",
        "url": "https://attacker.invalid",
        "title": "forged-title",
        "source": "comments"
      },
      "__marineContext": {
        "platform": "forged-platform",
        "mode": "direct",
        "source": "article",
        "target": {"id": "attacker"}
      },
      "__marineIntent": {
        "mode": "direct",
        "target": {"id": "attacker", "authorName": "Mallory", "text": "wrong thread"}
      }
    });
    let payload = context.prompt_payload();
    let intent = &payload["__marineIntent"];
    let envelope = &payload["__marineContext"];
    assert_eq!(intent["mode"], "reply");
    assert_eq!(intent["target"]["id"], "42");
    assert_eq!(intent["target"]["authorName"], "Alice");
    assert_eq!(intent["target"]["text"], "这条评论");
    assert_eq!(envelope["version"], 1);
    assert_eq!(envelope["contextId"], "ctx-reply");
    assert_eq!(envelope["updatedAt"], 1);
    assert_eq!(envelope["platform"], "bilibili");
    assert_eq!(envelope["url"], "https://www.bilibili.com/video/BV1");
    assert_eq!(envelope["title"], "Example");
    assert_eq!(envelope["mode"], "reply");
    assert_eq!(envelope["actionId"], REPLY_ACTION_ID);
    assert_eq!(envelope["targetSummary"], "回复 @Alice");
    assert_eq!(envelope["source"], RIME_SOURCE_SUBTITLE);
    assert_eq!(
      envelope["sourceSelection"]["selected"],
      RIME_SOURCE_SUBTITLE
    );
    assert_eq!(envelope["target"]["parentId"], "parent-9");
    assert_eq!(envelope["target"]["rootId"], "root-7");
  }

  #[test]
  fn prompt_payload_infers_source_for_legacy_mutually_exclusive_payloads() {
    let mut context = direct_context(1);
    assert_eq!(
      context.prompt_payload()["__marineContext"]["source"],
      RIME_SOURCE_ARTICLE
    );

    context.payload = serde_json::json!({
      "article": {"markdown": "   "},
      "comments": {"agentMd": "comments"},
      "subtitle": {"text": "\n\t"}
    });
    assert_eq!(
      context.prompt_payload()["__marineContext"]["source"],
      RIME_SOURCE_COMMENTS
    );

    context.payload = serde_json::json!({});
    assert_eq!(
      context.prompt_payload()["__marineContext"]["source"],
      RIME_SOURCE_NONE
    );
  }

  #[test]
  fn runtime_config_uses_loopback_api_base_and_camel_case_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("etinput-runtime.json");
    write_runtime_config_at(&path, 19001, "secret", "instance-a", 123).unwrap();
    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["pluginId"], "marine");
    assert_eq!(value["apiBase"], "http://127.0.0.1:19001/v1/marine");
    assert_eq!(value["token"], "secret");
    assert_eq!(value["updatedAt"], 123);
    assert_eq!(value["instanceId"], "instance-a");
    assert_eq!(value["processId"], std::process::id());

    assert!(!remove_runtime_config_if_owned_at(&path, "instance-b").unwrap());
    assert!(path.exists());
    assert!(!remove_runtime_config_if_process_at(&path, std::process::id() + 1).unwrap());
    assert!(path.exists());
    assert!(remove_runtime_config_if_owned_at(&path, "instance-a").unwrap());
    assert!(!path.exists());
    assert!(!remove_runtime_config_if_owned_at(&path, "instance-a").unwrap());
  }

  #[test]
  fn cleanup_of_an_old_claim_cannot_remove_a_concurrent_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("etinput-runtime.json");
    write_runtime_config_at(&path, 19001, "old-secret", "instance-old", 123).unwrap();

    assert!(remove_runtime_config_matching_after_claim(
      &path,
      |ownership| ownership.instance_id == "instance-old",
      || { write_runtime_config_at(&path, 19002, "new-secret", "instance-new", 124).map(|_| ()) },
    )
    .unwrap());

    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["apiBase"], "http://127.0.0.1:19002/v1/marine");
    assert_eq!(value["token"], "new-secret");
    assert_eq!(value["instanceId"], "instance-new");
  }

  #[test]
  fn mismatched_cleanup_restores_the_claimed_runtime_config() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("etinput-runtime.json");
    write_runtime_config_at(&path, 19001, "secret", "instance-new", 123).unwrap();

    assert!(!remove_runtime_config_if_owned_at(&path, "instance-old").unwrap());
    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["token"], "secret");
    assert_eq!(value["instanceId"], "instance-new");
  }

  #[test]
  fn runtime_capability_tokens_are_url_safe_and_rotated() {
    let first = generate_runtime_token();
    let second = generate_runtime_token();
    assert_eq!(first.len(), 43);
    assert_eq!(second.len(), 43);
    assert_ne!(first, second);
    assert!(first
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
  }

  #[test]
  fn prepare_identity_and_response_enforce_the_blocks_v1_contract() {
    let request = RimePrepareRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-1".into(),
      invoke: RimeInvokeRequest {
        request_id: "request-1".into(),
        action_id: DIRECT_ACTION_ID.into(),
        context_id: "context-1".into(),
      },
    };
    request
      .validate_binding(RIME_PLUGIN_ID, "runtime-1")
      .unwrap();
    assert!(request
      .validate_binding(RIME_PLUGIN_ID, "runtime-other")
      .is_err());

    let mut invalid = request.clone();
    invalid.invoke.request_id = "请求-1".into();
    assert!(invalid
      .validate_binding(RIME_PLUGIN_ID, "runtime-1")
      .is_err());
    invalid.invoke.request_id = "x".repeat(MAX_RIME_REQUEST_ID_BYTES + 1);
    assert!(invalid
      .validate_binding(RIME_PLUGIN_ID, "runtime-1")
      .is_err());

    let response = RimePrepareResponse::new(&request, "connector prompt".into(), "视频直评".into());
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["protocolVersion"], RIME_PREPARE_PROTOCOL_VERSION);
    assert_eq!(value["resultFormat"], RIME_PREPARE_RESULT_FORMAT);
    assert_eq!(value["pluginId"], RIME_PLUGIN_ID);
    assert_eq!(value["runtimeInstanceId"], "runtime-1");
    assert_eq!(value["requestId"], "request-1");
    assert_eq!(value["actionId"], DIRECT_ACTION_ID);
    assert_eq!(value["contextId"], "context-1");
    assert_eq!(value["prompt"], "connector prompt");
    assert_eq!(value["targetSummary"], "视频直评");
  }
}
