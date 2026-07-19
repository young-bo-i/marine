//! Rime Buffer action-plugin bridge.
//!
//! The browser extension publishes the editor/comment target that currently
//! owns focus. Rime Buffer can then discover that target through the local
//! Marine API and explicitly request a direct-comment or reply candidate.
//! Context is intentionally memory-only: when Marine is not running there is
//! no plugin runtime, and restarting Marine never revives a stale page target.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use utoipa::ToSchema;

use super::generate::GenerationOutput;

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
  /// Normalized Marine generation payload:
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

  /// Add an internal, explicit generation intent while preserving the public
  /// `/v1/marine/generate` payload contract for existing extension callers.
  pub fn generation_payload(&self) -> Value {
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeBlock {
  pub text: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeInvokeResponse {
  pub request_id: String,
  pub action_id: String,
  pub context_id: String,
  pub blocks: Vec<RimeBlock>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub target_summary: Option<String>,
}

pub const RIME_STREAM_PROTOCOL_VERSION: u8 = 1;
pub const MAX_RIME_STREAM_BLOCKS: usize = 20;
// Protocol v1 wire limits are intentionally identical to the RimeBuffer
// parser. Keep these byte-based: Swift `Character` counts are not a portable
// wire-size contract for multi-byte UTF-8 text.
pub const MAX_RIME_STREAM_TEXT_BYTES: usize = 20_000;
pub const MAX_RIME_CANDIDATE_BYTES: usize = super::generate::MAX_STREAMED_PROVIDER_BYTES;
// Complete is one NDJSON frame, so reserve room for escaped metadata,
// identities, targetSummary, and frame keys below the 512 KiB wire ceiling.
const MAX_RIME_COMPLETE_BLOCKS_JSON_BYTES: usize = 480 * 1024;
pub const MAX_RIME_STREAM_FRAME_BYTES: usize = 512 * 1024;
pub const MAX_RIME_STREAM_TOTAL_BYTES: usize = 1024 * 1024;
pub const MAX_RIME_STREAM_EVENTS: usize = 2048;
const MAX_RIME_STREAM_ID_BYTES: usize = 128;
pub const MAX_RIME_STREAM_ERROR_MESSAGE_BYTES: usize = 500;
const MAX_RECENT_STREAM_REQUESTS: usize = 256;

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeStreamInvokeRequest {
  pub plugin_id: String,
  pub runtime_instance_id: String,
  #[serde(flatten)]
  pub invoke: RimeInvokeRequest,
}

impl RimeStreamInvokeRequest {
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
        || value.len() > MAX_RIME_STREAM_ID_BYTES
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
      {
        return Err(RimeContextError::Invalid(
          "stream identity fields must be 1-128 bytes of printable ASCII",
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
pub struct RimeStreamIdentity {
  pub plugin_id: String,
  pub runtime_instance_id: String,
  pub request_id: String,
  pub action_id: String,
  pub context_id: String,
}

impl RimeStreamIdentity {
  pub fn from_request(request: &RimeStreamInvokeRequest) -> Self {
    Self {
      plugin_id: request.plugin_id.clone(),
      runtime_instance_id: request.runtime_instance_id.clone(),
      request_id: request.invoke.request_id.clone(),
      action_id: request.invoke.action_id.clone(),
      context_id: request.invoke.context_id.clone(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(tag = "type")]
pub enum RimeStreamEvent {
  #[serde(rename = "heartbeat")]
  Heartbeat,
  #[serde(rename = "block")]
  Block {
    index: usize,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
  },
  #[serde(rename = "complete")]
  Complete {
    blocks: Vec<RimeBlock>,
    #[serde(rename = "targetSummary", skip_serializing_if = "Option::is_none")]
    target_summary: Option<String>,
  },
  #[serde(rename = "error")]
  Error {
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
  },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RimeStreamFrame {
  pub protocol_version: u8,
  pub seq: u64,
  #[serde(flatten)]
  pub identity: RimeStreamIdentity,
  #[serde(flatten)]
  pub event: RimeStreamEvent,
}

pub struct RimeStreamEncoder {
  identity: RimeStreamIdentity,
  next_seq: u64,
  event_count: usize,
  total_bytes: usize,
  terminal_emitted: bool,
}

impl RimeStreamEncoder {
  pub fn new(identity: RimeStreamIdentity) -> Self {
    Self {
      identity,
      next_seq: 1,
      event_count: 0,
      total_bytes: 0,
      terminal_emitted: false,
    }
  }

  pub fn encode(&mut self, event: RimeStreamEvent) -> Result<Vec<u8>, String> {
    if self.terminal_emitted {
      return Err("Rime stream already emitted a terminal event".to_string());
    }
    validate_stream_event(&event)?;
    let terminal = matches!(
      &event,
      RimeStreamEvent::Complete { .. } | RimeStreamEvent::Error { .. }
    );
    let event_limit = if terminal {
      MAX_RIME_STREAM_EVENTS
    } else {
      MAX_RIME_STREAM_EVENTS.saturating_sub(1)
    };
    if self.event_count >= event_limit {
      return Err("Rime stream exceeded the event limit".to_string());
    }
    let frame = RimeStreamFrame {
      protocol_version: RIME_STREAM_PROTOCOL_VERSION,
      seq: self.next_seq,
      identity: self.identity.clone(),
      event,
    };
    let mut bytes = serde_json::to_vec(&frame)
      .map_err(|error| format!("serialize Rime stream frame: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_RIME_STREAM_FRAME_BYTES {
      return Err("Rime stream frame exceeded the size limit".to_string());
    }
    let total_limit = if terminal {
      MAX_RIME_STREAM_TOTAL_BYTES
    } else {
      MAX_RIME_STREAM_TOTAL_BYTES.saturating_sub(MAX_RIME_STREAM_FRAME_BYTES)
    };
    if self.total_bytes.saturating_add(bytes.len()) > total_limit {
      return Err("Rime stream exceeded the total size limit".to_string());
    }
    self.next_seq = self.next_seq.saturating_add(1);
    self.event_count = self.event_count.saturating_add(1);
    self.total_bytes = self.total_bytes.saturating_add(bytes.len());
    self.terminal_emitted = terminal;
    Ok(bytes)
  }
}

fn validate_stream_event(event: &RimeStreamEvent) -> Result<(), String> {
  match event {
    RimeStreamEvent::Heartbeat => Ok(()),
    RimeStreamEvent::Block { index, text, title } => {
      if *index >= MAX_RIME_STREAM_BLOCKS {
        return Err("Rime stream block index exceeded the limit".to_string());
      }
      if text.is_empty() || text.len() > MAX_RIME_STREAM_TEXT_BYTES {
        return Err("Rime stream block text exceeded the limit".to_string());
      }
      if title.as_ref().is_some_and(|value| value.len() > 200) {
        return Err("Rime stream block title exceeded the limit".to_string());
      }
      Ok(())
    }
    RimeStreamEvent::Complete {
      blocks,
      target_summary,
    } => {
      if blocks.is_empty() || blocks.len() > MAX_RIME_STREAM_BLOCKS {
        return Err("Rime stream final block count is invalid".to_string());
      }
      for block in blocks {
        if block.text.is_empty() || block.text.len() > MAX_RIME_STREAM_TEXT_BYTES {
          return Err("Rime stream final block text exceeded the limit".to_string());
        }
        if block.title.as_ref().is_some_and(|value| value.len() > 200) {
          return Err("Rime stream final block title exceeded the limit".to_string());
        }
      }
      if target_summary
        .as_ref()
        .is_some_and(|value| value.len() > 1000)
      {
        return Err("Rime stream target summary exceeded the limit".to_string());
      }
      Ok(())
    }
    RimeStreamEvent::Error { code, message } => {
      if code.is_empty() || code.len() > 128 {
        return Err("Rime stream error code is invalid".to_string());
      }
      if message
        .as_ref()
        .is_some_and(|value| value.len() > MAX_RIME_STREAM_ERROR_MESSAGE_BYTES)
      {
        return Err("Rime stream error message exceeded the limit".to_string());
      }
      Ok(())
    }
  }
}

#[derive(Clone, Default)]
pub struct RimeStreamGate {
  inner: Arc<std::sync::Mutex<RimeStreamGateState>>,
}

#[derive(Default)]
struct RimeStreamGateState {
  active: Option<(uuid::Uuid, String)>,
  recent: VecDeque<String>,
  seen: HashSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RimeStreamGateError {
  Busy,
  Duplicate,
}

pub struct RimeStreamPermit {
  gate: RimeStreamGate,
  lease_id: uuid::Uuid,
}

impl RimeStreamGate {
  pub fn acquire(&self, request_id: &str) -> Result<RimeStreamPermit, RimeStreamGateError> {
    let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
    if state.seen.contains(request_id) {
      return Err(RimeStreamGateError::Duplicate);
    }
    if state.active.is_some() {
      return Err(RimeStreamGateError::Busy);
    }
    while state.recent.len() >= MAX_RECENT_STREAM_REQUESTS {
      if let Some(expired) = state.recent.pop_front() {
        state.seen.remove(&expired);
      }
    }
    let lease_id = uuid::Uuid::new_v4();
    state.active = Some((lease_id, request_id.to_string()));
    state.recent.push_back(request_id.to_string());
    state.seen.insert(request_id.to_string());
    Ok(RimeStreamPermit {
      gate: self.clone(),
      lease_id,
    })
  }
}

impl Drop for RimeStreamPermit {
  fn drop(&mut self) {
    let mut state = self
      .gate
      .inner
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    if state
      .active
      .as_ref()
      .is_some_and(|(lease_id, _)| *lease_id == self.lease_id)
    {
      state.active = None;
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

#[derive(Clone)]
pub struct RimeContextStore {
  inner: Arc<RwLock<RimeContextState>>,
  changes: watch::Sender<u64>,
}

impl Default for RimeContextStore {
  fn default() -> Self {
    let (changes, _) = watch::channel(0);
    Self {
      inner: Arc::new(RwLock::new(RimeContextState::default())),
      changes,
    }
  }
}

impl RimeContextStore {
  pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
    self.changes.subscribe()
  }

  fn notify_change(&self) {
    self
      .changes
      .send_modify(|version| *version = version.saturating_add(1));
  }

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
        drop(state);
        self.notify_change();
        return Ok(status);
      }

      // A strictly newer publication for the currently active context is a
      // lease renewal, not a supersession. Refresh it in place so the context
      // id is never tombstoned merely for staying focused. DELETE and an
      // actually different active context still use `revoke` below.
      state.next_received_order = state.next_received_order.saturating_add(1);
      let received_order = state.next_received_order;
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
      state.prune(now_secs);
      let status = status_from_state(&state, now_secs);
      drop(state);
      self.notify_change();
      return Ok(status);
    } else if updated_at_millis <= state.high_watermark_millis {
      // A superseded profile must not regain ownership merely because its PUT
      // completed late. Equal timestamps are deliberately fail-closed too.
      state.revoke(&context_id, now_secs);
      state.prune(now_secs);
      let status = status_from_state(&state, now_secs);
      drop(state);
      self.notify_change();
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
    drop(state);
    self.notify_change();
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
    drop(state);
    self.notify_change();
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

pub fn blocks_for_output(context: &RimeContext, output: GenerationOutput) -> Vec<RimeBlock> {
  match context.mode {
    RimeContextMode::Direct => output
      .direct
      .into_iter()
      .find_map(|candidate| {
        let text = candidate.text.trim();
        (!text.is_empty()).then(|| blocks_for_candidate(text, bounded_title(&candidate.angle)))
      })
      .unwrap_or_default(),
    RimeContextMode::Reply => {
      let target_id = context
        .target
        .as_ref()
        .map(|target| target.id.as_str())
        .unwrap_or_default();
      output
        .replies
        .into_iter()
        .filter(|candidate| !target_id.is_empty() && candidate.target_id == target_id)
        .find_map(|candidate| {
          let text = candidate.text.trim();
          (!text.is_empty())
            .then(|| blocks_for_candidate(text, bounded_title(&context.target_summary)))
        })
        .unwrap_or_default()
    }
  }
}

fn bounded_title(value: &str) -> Option<String> {
  let value = value.trim();
  if value.is_empty() {
    return None;
  }
  Some(truncate_utf8_bytes(value, 200))
}

fn blocks_for_candidate(text: &str, first_title: Option<String>) -> Vec<RimeBlock> {
  let blocks: Vec<RimeBlock> = split_rime_text(text)
    .into_iter()
    .enumerate()
    .map(|(index, text)| RimeBlock {
      text,
      title: (index == 0).then(|| first_title.clone()).flatten(),
    })
    .collect();
  if serde_json::to_vec(&blocks)
    .is_ok_and(|encoded| encoded.len() <= MAX_RIME_COMPLETE_BLOCKS_JSON_BYTES)
  {
    blocks
  } else {
    Vec::new()
  }
}

/// Split one sendable candidate into ordered, concatenable blocks. Natural
/// punctuation stays attached to the preceding block. This is deliberately an
/// online splitter: extending `text` can only grow the current last block or
/// append a new one, so an index already emitted by the stream never moves. If
/// a pathological tail exhausts all 20 slots and then exceeds the per-block
/// limit, fail closed instead of rewriting earlier boundaries.
fn split_rime_text(text: &str) -> Vec<String> {
  let text = text.trim();
  if text.is_empty() || text.len() > MAX_RIME_CANDIDATE_BYTES {
    return Vec::new();
  }

  let mut blocks = Vec::new();
  let mut start = 0usize;
  let mut characters = text.char_indices().peekable();
  while let Some((index, character)) = characters.next() {
    let end = index + character.len_utf8();
    if end.saturating_sub(start) > MAX_RIME_STREAM_TEXT_BYTES {
      if blocks.len() >= MAX_RIME_STREAM_BLOCKS - 1 || index == start {
        return Vec::new();
      }
      blocks.push(text[start..index].to_string());
      start = index;
    }
    let delimiter_run_ends = is_rime_block_delimiter(character)
      && !characters
        .peek()
        .is_some_and(|(_, next)| is_rime_block_delimiter(*next));
    let slots_after_boundary = MAX_RIME_STREAM_BLOCKS.saturating_sub(blocks.len() + 1);
    let maximum_future_bytes = MAX_RIME_CANDIDATE_BYTES.saturating_sub(end);
    if delimiter_run_ends
      && slots_after_boundary.saturating_mul(MAX_RIME_STREAM_TEXT_BYTES) >= maximum_future_bytes
    {
      blocks.push(text[start..end].to_string());
      start = end;
    }
  }
  if start < text.len() {
    if text.len().saturating_sub(start) > MAX_RIME_STREAM_TEXT_BYTES {
      return Vec::new();
    }
    blocks.push(text[start..].to_string());
  }
  blocks
}

fn is_rime_block_delimiter(character: char) -> bool {
  matches!(
    character,
    '，' | '。' | '！' | '？' | '；' | ',' | '.' | '!' | '?' | ';' | '\n'
  )
}

fn utf8_boundary_at_or_before(value: &str, maximum: usize) -> usize {
  let mut boundary = maximum.min(value.len());
  while boundary > 0 && !value.is_char_boundary(boundary) {
    boundary -= 1;
  }
  boundary
}

fn truncate_utf8_bytes(value: &str, maximum: usize) -> String {
  value[..utf8_boundary_at_or_before(value, maximum)].to_string()
}

/// Decode the first candidate that is valid for the captured action from a
/// partial schema-constrained GenerationOutput JSON document, then apply the
/// exact same block splitter used by the authoritative final result. Direct
/// streams never expose reply text; reply streams wait for an exact, complete
/// targetId match before exposing text. JSON strings may end mid-UTF-8 escape.
pub fn incremental_blocks_for_output(
  context: &RimeContext,
  input: &str,
) -> Result<Vec<RimeBlock>, String> {
  if input.len() > super::generate::MAX_STREAMED_PROVIDER_BYTES {
    return Err("partial generation JSON exceeded the configured limit".to_string());
  }
  let bytes = input.as_bytes();
  match context.mode {
    RimeContextMode::Direct => {
      let Some(objects) = incremental_array_objects(bytes, "direct")? else {
        return Ok(Vec::new());
      };
      for object in objects {
        let text = object_string_field(object.bytes, "text")?;
        if let Some(text) = text.filter(|value| !value.value.trim().is_empty()) {
          let angle = object_string_field(object.bytes, "angle")?
            .filter(|value| value.closed)
            .and_then(|value| bounded_title(&value.value));
          return Ok(blocks_for_candidate(text.value.trim(), angle));
        }
        if !object.complete {
          break;
        }
      }
    }
    RimeContextMode::Reply => {
      let target_id = context
        .target
        .as_ref()
        .map(|target| target.id.as_str())
        .unwrap_or_default();
      if target_id.is_empty() {
        return Ok(Vec::new());
      }
      let Some(objects) = incremental_array_objects(bytes, "replies")? else {
        return Ok(Vec::new());
      };
      for object in objects {
        let candidate_target = object_string_field(object.bytes, "targetId")?;
        let target_matches = candidate_target
          .as_ref()
          .is_some_and(|value| value.closed && value.value == target_id);
        if target_matches {
          let text = object_string_field(object.bytes, "text")?;
          if let Some(text) = text.filter(|value| !value.value.trim().is_empty()) {
            return Ok(blocks_for_candidate(
              text.value.trim(),
              bounded_title(&context.target_summary),
            ));
          }
        }
        if !object.complete && !candidate_target.as_ref().is_some_and(|value| value.closed) {
          break;
        }
      }
    }
  }
  Ok(Vec::new())
}

struct IncrementalObject<'a> {
  bytes: &'a [u8],
  complete: bool,
}

struct IncrementalString {
  value: String,
  closed: bool,
}

fn incremental_array_objects<'a>(
  bytes: &'a [u8],
  key: &str,
) -> Result<Option<Vec<IncrementalObject<'a>>>, String> {
  let Some(array_start) = find_top_level_array(bytes, key)? else {
    return Ok(None);
  };
  let mut objects = Vec::new();
  let mut cursor = array_start + 1;
  loop {
    cursor = skip_json_whitespace(bytes, cursor);
    while bytes.get(cursor) == Some(&b',') {
      cursor = skip_json_whitespace(bytes, cursor + 1);
    }
    match bytes.get(cursor) {
      None | Some(b']') => break,
      Some(b'{') => {
        let (end, complete) = scan_json_object(bytes, cursor);
        objects.push(IncrementalObject {
          bytes: &bytes[cursor..end],
          complete,
        });
        cursor = end;
        if !complete {
          break;
        }
      }
      _ => return Err("generation JSON array contained a non-object candidate".to_string()),
    }
  }
  Ok(Some(objects))
}

fn find_top_level_array(bytes: &[u8], wanted_key: &str) -> Result<Option<usize>, String> {
  let mut cursor = 0usize;
  let mut object_depth = 0usize;
  let mut array_depth = 0usize;
  while cursor < bytes.len() {
    match bytes[cursor] {
      b'"' => {
        let string = scan_json_string(bytes, cursor);
        if !string.closed {
          return Ok(None);
        }
        if object_depth == 1 && array_depth == 0 {
          let key = decode_json_string(&bytes[string.content_start..string.content_end], true)?;
          let mut value_start = skip_json_whitespace(bytes, string.next_index);
          if bytes.get(value_start) == Some(&b':') {
            value_start = skip_json_whitespace(bytes, value_start + 1);
            if key == wanted_key {
              return Ok((bytes.get(value_start) == Some(&b'[')).then_some(value_start));
            }
          }
        }
        cursor = string.next_index;
      }
      b'{' => {
        object_depth = object_depth.saturating_add(1);
        cursor += 1;
      }
      b'}' => {
        object_depth = object_depth.saturating_sub(1);
        cursor += 1;
      }
      b'[' => {
        array_depth = array_depth.saturating_add(1);
        cursor += 1;
      }
      b']' => {
        array_depth = array_depth.saturating_sub(1);
        cursor += 1;
      }
      _ => cursor += 1,
    }
  }
  Ok(None)
}

fn scan_json_object(bytes: &[u8], start: usize) -> (usize, bool) {
  let mut cursor = start;
  let mut object_depth = 0usize;
  let mut array_depth = 0usize;
  while cursor < bytes.len() {
    match bytes[cursor] {
      b'"' => {
        let string = scan_json_string(bytes, cursor);
        if !string.closed {
          return (bytes.len(), false);
        }
        cursor = string.next_index;
      }
      b'{' => {
        object_depth += 1;
        cursor += 1;
      }
      b'}' => {
        object_depth = object_depth.saturating_sub(1);
        cursor += 1;
        if object_depth == 0 && array_depth == 0 {
          return (cursor, true);
        }
      }
      b'[' => {
        array_depth += 1;
        cursor += 1;
      }
      b']' => {
        array_depth = array_depth.saturating_sub(1);
        cursor += 1;
      }
      _ => cursor += 1,
    }
  }
  (bytes.len(), false)
}

fn object_string_field(
  bytes: &[u8],
  wanted_key: &str,
) -> Result<Option<IncrementalString>, String> {
  let mut cursor = 1usize;
  let mut object_depth = 1usize;
  let mut array_depth = 0usize;
  while cursor < bytes.len() {
    match bytes[cursor] {
      b'"' => {
        let key = scan_json_string(bytes, cursor);
        if !key.closed {
          return Ok(None);
        }
        if object_depth == 1 && array_depth == 0 {
          let key_text = decode_json_string(&bytes[key.content_start..key.content_end], true)?;
          let mut value_start = skip_json_whitespace(bytes, key.next_index);
          if bytes.get(value_start) == Some(&b':') {
            value_start = skip_json_whitespace(bytes, value_start + 1);
            if key_text == wanted_key {
              if bytes.get(value_start) != Some(&b'"') {
                return Ok(None);
              }
              let value = scan_json_string(bytes, value_start);
              return Ok(Some(IncrementalString {
                value: decode_json_string(
                  &bytes[value.content_start..value.content_end],
                  value.closed,
                )?,
                closed: value.closed,
              }));
            }
          }
        }
        cursor = key.next_index;
      }
      b'{' => {
        object_depth += 1;
        cursor += 1;
      }
      b'}' => {
        object_depth = object_depth.saturating_sub(1);
        cursor += 1;
      }
      b'[' => {
        array_depth += 1;
        cursor += 1;
      }
      b']' => {
        array_depth = array_depth.saturating_sub(1);
        cursor += 1;
      }
      _ => cursor += 1,
    }
  }
  Ok(None)
}

struct ScannedJsonString {
  content_start: usize,
  content_end: usize,
  next_index: usize,
  closed: bool,
}

fn scan_json_string(bytes: &[u8], quote_index: usize) -> ScannedJsonString {
  let mut cursor = quote_index.saturating_add(1);
  let content_start = cursor;
  let mut escaped = false;
  while cursor < bytes.len() {
    let byte = bytes[cursor];
    if escaped {
      escaped = false;
    } else if byte == b'\\' {
      escaped = true;
    } else if byte == b'"' {
      return ScannedJsonString {
        content_start,
        content_end: cursor,
        next_index: cursor + 1,
        closed: true,
      };
    }
    cursor += 1;
  }
  ScannedJsonString {
    content_start,
    content_end: bytes.len(),
    next_index: bytes.len(),
    closed: false,
  }
}

fn skip_json_whitespace(bytes: &[u8], mut index: usize) -> usize {
  while bytes
    .get(index)
    .is_some_and(|byte| matches!(*byte, b' ' | b'\n' | b'\r' | b'\t'))
  {
    index += 1;
  }
  index
}

fn decode_json_string(content: &[u8], complete: bool) -> Result<String, String> {
  let content = std::str::from_utf8(content)
    .map_err(|_| "partial generation JSON contained invalid UTF-8".to_string())?;
  if complete {
    return decode_json_string_prefix(content)
      .ok_or_else(|| "generation JSON contained an invalid string escape".to_string());
  }
  let mut boundaries: Vec<usize> = content.char_indices().map(|(index, _)| index).collect();
  boundaries.push(content.len());
  for end in boundaries.into_iter().rev() {
    if let Some(decoded) = decode_json_string_prefix(&content[..end]) {
      return Ok(decoded);
    }
  }
  Ok(String::new())
}

fn decode_json_string_prefix(content: &str) -> Option<String> {
  let encoded = format!("\"{content}\"");
  serde_json::from_str(&encoded).ok()
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
  use crate::marine::generate::{GenDirect, GenReply};

  fn direct_context(updated_at: u64) -> RimeContext {
    RimeContext {
      context_id: "ctx-direct".into(),
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
  fn context_store_notifies_streams_on_set_and_clear() {
    let now = 1_000_000;
    let store = RimeContextStore::default();
    let mut changes = store.subscribe_changes();
    assert!(!changes.has_changed().unwrap());

    store.set(direct_context(now), now).unwrap();
    assert!(changes.has_changed().unwrap());
    let _ = changes.borrow_and_update();
    assert!(store.clear_at(Some("ctx-direct"), now));
    assert!(changes.has_changed().unwrap());
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
  fn mode_selects_only_the_matching_generation_candidates() {
    let output = GenerationOutput {
      direct: vec![GenDirect {
        text: " direct ".into(),
        angle: "angle".into(),
      }],
      replies: vec![GenReply {
        target_id: "42".into(),
        target: "@Alice".into(),
        text: " reply ".into(),
      }],
    };
    assert_eq!(
      blocks_for_output(&direct_context(1), output.clone()),
      vec![RimeBlock {
        text: "direct".into(),
        title: Some("angle".into())
      }]
    );
    assert_eq!(
      blocks_for_output(&reply_context(1), output),
      vec![RimeBlock {
        text: "reply".into(),
        title: Some("回复 @Alice".into())
      }]
    );
  }

  #[test]
  fn reply_with_an_id_discards_candidates_for_other_comments() {
    let context = reply_context(1);
    let output = GenerationOutput {
      direct: Vec::new(),
      replies: vec![
        GenReply {
          target_id: "another-comment".into(),
          target: "@Mallory".into(),
          text: "wrong target".into(),
        },
        GenReply {
          target_id: " 42 ".into(),
          target: "@Mallory".into(),
          text: "whitespace-normalized ids must not match".into(),
        },
        GenReply {
          target_id: "42".into(),
          target: "@Alice".into(),
          text: "right target".into(),
        },
        GenReply {
          target_id: "42".into(),
          target: "@Alice".into(),
          text: "alternative must not be appended".into(),
        },
      ],
    };
    assert_eq!(
      blocks_for_output(&context, output),
      vec![RimeBlock {
        text: "right target".into(),
        title: Some("回复 @Alice".into()),
      }]
    );
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

    let mut context = reply_context(now);
    context.target = None;
    assert!(blocks_for_output(
      &context,
      GenerationOutput {
        direct: Vec::new(),
        replies: vec![GenReply {
          target_id: "anything".into(),
          target: "@Alice".into(),
          text: "must not be accepted".into(),
        }],
      }
    )
    .is_empty());
  }

  #[test]
  fn action_invocation_uses_only_one_candidate() {
    let output = GenerationOutput {
      direct: vec![
        GenDirect {
          text: "best".into(),
          angle: "first".into(),
        },
        GenDirect {
          text: "second".into(),
          angle: "second".into(),
        },
      ],
      replies: Vec::new(),
    };
    assert_eq!(
      blocks_for_output(&direct_context(1), output),
      vec![RimeBlock {
        text: "best".into(),
        title: Some("first".into()),
      }]
    );
  }

  #[test]
  fn one_candidate_splits_into_ordered_sendable_blocks() {
    let text = " 先说重点，接着解释。Really? Yes!\n最后一句； ";
    let blocks = blocks_for_output(
      &direct_context(1),
      GenerationOutput {
        direct: vec![GenDirect {
          text: text.into(),
          angle: "层次".into(),
        }],
        replies: Vec::new(),
      },
    );
    assert_eq!(
      blocks,
      vec![
        RimeBlock {
          text: "先说重点，".into(),
          title: Some("层次".into()),
        },
        RimeBlock {
          text: "接着解释。".into(),
          title: None,
        },
        RimeBlock {
          text: "Really?".into(),
          title: None,
        },
        RimeBlock {
          text: " Yes!\n".into(),
          title: None,
        },
        RimeBlock {
          text: "最后一句；".into(),
          title: None,
        },
      ]
    );
    assert_eq!(
      blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<String>(),
      text.trim()
    );
  }

  #[test]
  fn splitter_hard_splits_utf8_without_losing_text() {
    let text = "界".repeat(8_000);
    let blocks = split_rime_text(&text);
    assert_eq!(blocks.len(), 2);
    assert!(blocks
      .iter()
      .all(|block| block.len() <= MAX_RIME_STREAM_TEXT_BYTES));
    assert!(blocks
      .iter()
      .all(|block| block.is_char_boundary(block.len())));
    assert_eq!(blocks.concat(), text);
  }

  #[test]
  fn splitter_caps_natural_boundaries_at_twenty_blocks() {
    let text = (0..25)
      .map(|index| format!("第{index}句，"))
      .collect::<String>();
    let blocks = split_rime_text(&text);
    assert!(blocks.len() <= MAX_RIME_STREAM_BLOCKS);
    assert_eq!(blocks.concat(), text);
    assert!(blocks
      .iter()
      .all(|block| block.len() <= MAX_RIME_STREAM_TEXT_BYTES));
    assert!(blocks.last().unwrap().contains("第24句，"));
  }

  #[test]
  fn splitter_reserves_tail_capacity_without_rewriting_streamed_indices() {
    let prefix = format!("{}{}", "a,".repeat(19), "x".repeat(20_000));
    let extended = format!("{prefix}y");
    let before = split_rime_text(&prefix);
    let after = split_rime_text(&extended);
    assert!(!before.is_empty());
    assert_eq!(before.len(), after.len());
    assert!(after.len() <= MAX_RIME_STREAM_BLOCKS);
    for (index, snapshot) in before.iter().enumerate() {
      assert!(after[index].starts_with(snapshot), "block {index} moved");
    }
    assert_eq!(before.concat(), prefix);
    assert_eq!(after.concat(), extended);
  }

  #[test]
  fn generation_payload_overrides_forged_intent_with_captured_reply_target() {
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
    let payload = context.generation_payload();
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
  fn generation_payload_infers_source_for_legacy_mutually_exclusive_payloads() {
    let mut context = direct_context(1);
    assert_eq!(
      context.generation_payload()["__marineContext"]["source"],
      RIME_SOURCE_ARTICLE
    );

    context.payload = serde_json::json!({
      "article": {"markdown": "   "},
      "comments": {"agentMd": "comments"},
      "subtitle": {"text": "\n\t"}
    });
    assert_eq!(
      context.generation_payload()["__marineContext"]["source"],
      RIME_SOURCE_COMMENTS
    );

    context.payload = serde_json::json!({});
    assert_eq!(
      context.generation_payload()["__marineContext"]["source"],
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
  fn incremental_json_scanner_emits_first_character_and_handles_split_escapes() {
    let context = direct_context(1);
    assert_eq!(
      incremental_blocks_for_output(&context, r#"{"direct":[{"text":"你"#).unwrap(),
      vec![RimeBlock {
        text: "你".into(),
        title: None,
      }]
    );
    assert_eq!(
      incremental_blocks_for_output(&context, r#"{"direct":[{"text":"a，\u4F"#).unwrap(),
      vec![RimeBlock {
        text: "a，".into(),
        title: None,
      }]
    );
    assert_eq!(
      incremental_blocks_for_output(
        &context,
        r#"{"direct":[{"text":"a\n\u4E2D\uD83D\uDE00\"尾","angle":"x"}],"replies":[]}"#
      )
      .unwrap(),
      vec![
        RimeBlock {
          text: "a\n".into(),
          title: Some("x".into()),
        },
        RimeBlock {
          text: "中😀\"尾".into(),
          title: None,
        },
      ]
    );
  }

  #[test]
  fn incremental_json_scanner_keeps_action_and_reply_target_isolated() {
    let raw = r#"{"direct":[{"text":"直评，继续","angle":"a"}],"replies":[{"targetId":"other","target":"@B","text":"错的"},{"targetId":" 42 ","target":"@B","text":"空白归一化也不能串楼"},{"targetId":"42","target":"@A","text":"正确，回复"}]}"#;
    assert_eq!(
      incremental_blocks_for_output(&direct_context(1), raw).unwrap(),
      vec![
        RimeBlock {
          text: "直评，".into(),
          title: Some("a".into()),
        },
        RimeBlock {
          text: "继续".into(),
          title: None,
        },
      ]
    );
    assert_eq!(
      incremental_blocks_for_output(&reply_context(1), raw).unwrap(),
      vec![
        RimeBlock {
          text: "正确，".into(),
          title: Some("回复 @Alice".into()),
        },
        RimeBlock {
          text: "回复".into(),
          title: None,
        },
      ]
    );
    assert!(
      incremental_blocks_for_output(&direct_context(1), r#"{"direct":[{"text":"bad\q"}] }"#)
        .is_err()
    );
  }

  #[test]
  fn incremental_and_final_blocks_keep_the_same_indices() {
    let context = direct_context(1);
    let partial =
      incremental_blocks_for_output(&context, r#"{"direct":[{"text":"第一句，第二"#).unwrap();
    let raw = r#"{"direct":[{"text":"第一句，第二句。第三句","angle":"角度"}],"replies":[]}"#;
    let streamed_final = incremental_blocks_for_output(&context, raw).unwrap();
    let authoritative = blocks_for_output(
      &context,
      serde_json::from_str::<GenerationOutput>(raw).unwrap(),
    );
    assert_eq!(partial[0].text, streamed_final[0].text);
    assert!(streamed_final[1].text.starts_with(&partial[1].text));
    assert_eq!(streamed_final, authoritative);
    assert_eq!(
      authoritative
        .iter()
        .map(|block| block.text.as_str())
        .collect::<String>(),
      "第一句，第二句。第三句"
    );
  }

  #[test]
  fn stream_frames_repeat_exact_identity_with_contiguous_sequence_numbers() {
    let request = RimeStreamInvokeRequest {
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
    let mut encoder = RimeStreamEncoder::new(RimeStreamIdentity::from_request(&request));
    let heartbeat: Value = serde_json::from_slice(
      encoder
        .encode(RimeStreamEvent::Heartbeat)
        .unwrap()
        .as_slice(),
    )
    .unwrap();
    let block: Value = serde_json::from_slice(
      encoder
        .encode(RimeStreamEvent::Block {
          index: 0,
          text: "首字".into(),
          title: None,
        })
        .unwrap()
        .as_slice(),
    )
    .unwrap();
    for (frame, seq, kind) in [(&heartbeat, 1, "heartbeat"), (&block, 2, "block")] {
      assert_eq!(frame["protocolVersion"], RIME_STREAM_PROTOCOL_VERSION);
      assert_eq!(frame["seq"], seq);
      assert_eq!(frame["type"], kind);
      assert_eq!(frame["pluginId"], RIME_PLUGIN_ID);
      assert_eq!(frame["runtimeInstanceId"], "runtime-1");
      assert_eq!(frame["requestId"], "request-1");
      assert_eq!(frame["actionId"], DIRECT_ACTION_ID);
      assert_eq!(frame["contextId"], "context-1");
    }
    encoder
      .encode(RimeStreamEvent::Complete {
        blocks: vec![RimeBlock {
          text: "完成".into(),
          title: None,
        }],
        target_summary: None,
      })
      .unwrap();
    assert!(encoder.encode(RimeStreamEvent::Heartbeat).is_err());
  }

  #[test]
  fn stream_encoder_and_binding_enforce_bounds_and_runtime_identity() {
    let request = RimeStreamInvokeRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-1".into(),
      invoke: RimeInvokeRequest {
        request_id: "request-1".into(),
        action_id: DIRECT_ACTION_ID.into(),
        context_id: "context-1".into(),
      },
    };
    assert!(request
      .validate_binding(RIME_PLUGIN_ID, "runtime-other")
      .is_err());
    let mut invalid_identity = request.clone();
    invalid_identity.invoke.request_id = "请求-1".into();
    assert!(invalid_identity
      .validate_binding(RIME_PLUGIN_ID, "runtime-1")
      .is_err());
    invalid_identity.invoke.request_id = "\u{7f}".into();
    assert!(invalid_identity
      .validate_binding(RIME_PLUGIN_ID, "runtime-1")
      .is_err());
    invalid_identity.invoke.request_id = "x".repeat(MAX_RIME_STREAM_ID_BYTES + 1);
    assert!(invalid_identity
      .validate_binding(RIME_PLUGIN_ID, "runtime-1")
      .is_err());
    let mut encoder = RimeStreamEncoder::new(RimeStreamIdentity::from_request(&request));
    let utf8_at_limit = "界".repeat(MAX_RIME_STREAM_TEXT_BYTES / "界".len());
    assert!(utf8_at_limit.len() <= MAX_RIME_STREAM_TEXT_BYTES);
    encoder
      .encode(RimeStreamEvent::Block {
        index: 0,
        text: utf8_at_limit.clone(),
        title: None,
      })
      .unwrap();
    assert!(encoder
      .encode(RimeStreamEvent::Block {
        index: 0,
        text: format!("{utf8_at_limit}界"),
        title: None,
      })
      .is_err());
    assert!(encoder
      .encode(RimeStreamEvent::Block {
        index: MAX_RIME_STREAM_BLOCKS,
        text: "x".into(),
        title: None,
      })
      .is_err());
    assert!(encoder
      .encode(RimeStreamEvent::Block {
        index: 0,
        text: "x".repeat(MAX_RIME_STREAM_TEXT_BYTES + 1),
        title: None,
      })
      .is_err());
  }

  #[test]
  fn stream_encoder_accepts_twenty_maximum_plaintext_blocks_in_complete() {
    let identity = RimeStreamIdentity {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-1".into(),
      request_id: "request-aggregate".into(),
      action_id: DIRECT_ACTION_ID.into(),
      context_id: "context-aggregate".into(),
    };
    let blocks = (0..MAX_RIME_STREAM_BLOCKS)
      .map(|_| RimeBlock {
        text: "x".repeat(MAX_RIME_STREAM_TEXT_BYTES),
        title: None,
      })
      .collect::<Vec<_>>();
    let mut encoder = RimeStreamEncoder::new(identity);
    let encoded = encoder
      .encode(RimeStreamEvent::Complete {
        blocks,
        target_summary: None,
      })
      .unwrap();
    assert!(encoded.len() <= MAX_RIME_STREAM_FRAME_BYTES);
    let frame: RimeStreamFrame = serde_json::from_slice(&encoded).unwrap();
    let RimeStreamEvent::Complete { blocks, .. } = frame.event else {
      panic!("expected complete event");
    };
    assert_eq!(blocks.len(), MAX_RIME_STREAM_BLOCKS);
  }

  #[test]
  fn stream_gate_is_single_concurrency_and_rejects_request_replay() {
    let gate = RimeStreamGate::default();
    let first = gate.acquire("request-1").unwrap();
    assert_eq!(
      gate.acquire("request-1").err(),
      Some(RimeStreamGateError::Duplicate)
    );
    assert_eq!(
      gate.acquire("request-2").err(),
      Some(RimeStreamGateError::Busy)
    );
    drop(first);
    let second = gate.acquire("request-2").unwrap();
    drop(second);
    assert_eq!(
      gate.acquire("request-1").err(),
      Some(RimeStreamGateError::Duplicate)
    );
  }
}
