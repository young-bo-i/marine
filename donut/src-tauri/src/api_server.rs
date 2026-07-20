use crate::browser::ProxySettings;
use crate::camoufox_manager::CamoufoxConfig;
use crate::events;
use crate::group_manager::GROUP_MANAGER;
use crate::profile::manager::ProfileManager;
use crate::proxy_manager::PROXY_MANAGER;
use crate::tag_manager::TAG_MANAGER;
use axum::{
  extract::{Extension, Path, Query, State},
  http::{HeaderMap, StatusCode},
  middleware::{self, Next},
  response::{Json, Response},
  routing::get,
  Router,
};
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tower_http::cors::CorsLayer;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::marine::history::{HistoryError, PostingRecord, HISTORY_MANAGER};
use crate::marine::rime::{
  now_secs as rime_now_secs, RimeContext, RimeContextError, RimeContextMode, RimeContextStore,
  RimeInvokeRequest, RimePrepareRequest, RimePrepareResponse, RimeStatus, RimeTarget,
  RIME_PLUGIN_ID,
};

// API Types
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct ApiProfile {
  pub id: String,
  pub name: String,
  pub browser: String,
  pub version: String,
  pub proxy_id: Option<String>,
  pub launch_hook: Option<String>,
  pub process_id: Option<u32>,
  pub last_launch: Option<u64>,
  pub release_type: String,
  #[schema(value_type = Object)]
  pub camoufox_config: Option<serde_json::Value>,
  pub group_id: Option<String>,
  pub tags: Vec<String>,
  pub is_running: bool,
  pub proxy_bypass_rules: Vec<String>,
  pub vpn_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiProfilesResponse {
  pub profiles: Vec<ApiProfile>,
  pub total: usize,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiProfileResponse {
  pub profile: ApiProfile,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CreateProfileRequest {
  pub name: String,
  /// Browser engine. Must be `"wayfern"` (anti-detect Chromium) or `"camoufox"`
  /// (anti-detect Firefox). Any other value (e.g. `"chromium"`) is rejected with
  /// 400.
  pub browser: String,
  /// Optional. Omit (or pass `"latest"`) to use the newest already-downloaded
  /// version of the chosen browser. A concrete version must already be
  /// downloaded; the create path does not fetch new versions.
  #[serde(default)]
  pub version: Option<String>,
  pub proxy_id: Option<String>,
  pub vpn_id: Option<String>,
  pub launch_hook: Option<String>,
  pub release_type: Option<String>,
  /// Camoufox fingerprint/config. Send only when `browser` is `"camoufox"`.
  /// Omit it, or pass an empty object `{}`, to have a fresh fingerprint
  /// generated automatically at creation. Provide a `fingerprint` field to
  /// pin a specific one.
  #[schema(value_type = Object)]
  pub camoufox_config: Option<serde_json::Value>,
  /// Wayfern fingerprint/config. Send only when `browser` is `"wayfern"`.
  /// Omit it, or pass an empty object `{}`, to have a fresh fingerprint
  /// generated automatically at creation. Provide a `fingerprint` field to
  /// pin a specific one.
  #[schema(value_type = Object)]
  pub wayfern_config: Option<serde_json::Value>,
  pub group_id: Option<String>,
  pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct UpdateProfileRequest {
  pub name: Option<String>,
  // No `browser` field: a profile's engine is fixed at creation (changing it
  // would invalidate the generated fingerprint and on-disk profile dir).
  // Accepting it here only to silently ignore it misled API clients.
  pub version: Option<String>,
  pub proxy_id: Option<String>,
  pub vpn_id: Option<String>,
  pub launch_hook: Option<String>,
  pub release_type: Option<String>,
  #[schema(value_type = Object)]
  pub camoufox_config: Option<serde_json::Value>,
  pub group_id: Option<String>,
  pub tags: Option<Vec<String>>,
  pub extension_group_id: Option<String>,
  pub proxy_bypass_rules: Option<Vec<String>>,
  /// One of "Disabled", "Regular", "Encrypted".
  pub sync_mode: Option<String>,
}

#[derive(Clone)]
struct ApiServerState {
  app_handle: tauri::AppHandle,
  /// Per-process capability accepted only by the Rime consumer endpoints.
  /// The browser extension continues to use the user's full API token for
  /// publishing/clearing context.
  rime_consumer_token: Arc<str>,
  rime_runtime_instance_id: Arc<str>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
struct ApiGroupResponse {
  id: String,
  name: String,
  profile_count: usize,
}

#[derive(Debug, Deserialize, ToSchema)]
struct CreateGroupRequest {
  name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
struct UpdateGroupRequest {
  name: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
struct ApiProxyResponse {
  id: String,
  name: String,
  #[schema(value_type = Object)]
  proxy_settings: ProxySettings,
}

#[derive(Debug, Deserialize, ToSchema)]
struct CreateProxyRequest {
  name: String,
  #[schema(value_type = Object)]
  proxy_settings: ProxySettings,
}

#[derive(Debug, Deserialize, ToSchema)]
struct UpdateProxyRequest {
  name: Option<String>,
  #[schema(value_type = Object)]
  proxy_settings: Option<ProxySettings>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
struct ApiVpnResponse {
  id: String,
  name: String,
  /// Always "WireGuard"
  vpn_type: String,
  created_at: i64,
  last_used: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
struct ApiVpnExportResponse {
  id: String,
  name: String,
  /// Always "WireGuard"
  vpn_type: String,
  /// Raw `.conf` file content (decrypted)
  config_data: String,
}

#[derive(Debug, Deserialize, ToSchema)]
struct ImportVpnRequest {
  /// Raw WireGuard `.conf` file content
  content: String,
  /// Original filename
  filename: String,
  /// Optional display name; defaults to filename-based name
  name: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct CreateVpnRequest {
  name: String,
  /// Must be "WireGuard"
  vpn_type: String,
  config_data: String,
}

#[derive(Debug, Deserialize, ToSchema)]
struct UpdateVpnRequest {
  name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
struct DownloadBrowserRequest {
  browser: String,
  version: String,
}

#[derive(Debug, Serialize, ToSchema)]
struct DownloadBrowserResponse {
  browser: String,
  version: String,
  status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ToastPayload {
  pub message: String,
  pub variant: String,
  pub title: String,
  pub description: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct RunProfileResponse {
  profile_id: String,
  remote_debugging_port: u16,
  headless: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
struct RunProfileRequest {
  url: Option<String>,
  headless: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct OpenUrlRequest {
  url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
struct ImportCookiesRequest {
  /// Raw cookie file content. Format is auto-detected: a JSON array
  /// (Puppeteer / EditThisCookie style) or a Netscape `cookies.txt`.
  content: String,
}

#[derive(Debug, Serialize, ToSchema)]
struct ImportCookiesResponse {
  cookies_imported: usize,
  cookies_replaced: usize,
  errors: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct BatchRunRequest {
  /// Profile IDs to launch.
  profile_ids: Vec<String>,
  /// Optional URL to open in every launched profile.
  url: Option<String>,
  /// Launch headless. Defaults to false.
  headless: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
struct BatchRunResult {
  profile_id: String,
  /// Whether this profile launched successfully.
  ok: bool,
  /// Remote debugging port if launched, otherwise null.
  remote_debugging_port: Option<u16>,
  /// Failure reason if not launched, otherwise null.
  error: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct BatchRunResponse {
  results: Vec<BatchRunResult>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct BatchStopRequest {
  /// Profile IDs to stop.
  profile_ids: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct BatchStopResult {
  profile_id: String,
  /// Whether this profile was stopped successfully.
  ok: bool,
  /// Failure reason if not stopped, otherwise null.
  error: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct BatchStopResponse {
  results: Vec<BatchStopResult>,
}

#[derive(OpenApi)]
#[openapi(
  paths(
    get_profiles,
    get_profile,
    create_profile,
    update_profile,
    delete_profile,
    run_profile,
    open_url_in_profile,
    kill_profile,
    batch_run_profiles,
    batch_stop_profiles,
    import_profile_cookies,
    get_groups,
    get_group,
    create_group,
    update_group,
    delete_group,
    get_tags,
    get_proxies,
    get_proxy,
    create_proxy,
    update_proxy,
    delete_proxy,
    get_vpns,
    get_vpn,
    import_vpn,
    create_vpn,
    update_vpn,
    delete_vpn,
    download_browser_api,
    get_browser_versions,
    check_browser_downloaded,
    marine_generate_api,
    marine_get_provider_config,
    marine_set_provider_config,
    marine_get_identities,
    marine_get_history,
    marine_append_history,
    marine_append_published_history,
    marine_get_agents,
    marine_get_rime_status,
    marine_put_rime_context,
    marine_delete_rime_context,
    marine_prepare_rime_action,
    marine_invoke_rime_action,
    marine_invoke_rime_action_stream,
  ),
  components(schemas(
    ApiProfile,
    ApiProfilesResponse,
    ApiProfileResponse,
    CreateProfileRequest,
    UpdateProfileRequest,
    ApiGroupResponse,
    CreateGroupRequest,
    UpdateGroupRequest,
    ApiProxyResponse,
    CreateProxyRequest,
    UpdateProxyRequest,
    ApiVpnResponse,
    ImportVpnRequest,
    CreateVpnRequest,
    UpdateVpnRequest,
    DownloadBrowserRequest,
    DownloadBrowserResponse,
    RunProfileResponse,
    RunProfileRequest,
    BatchRunRequest,
    BatchRunResult,
    BatchRunResponse,
    BatchStopRequest,
    BatchStopResult,
    BatchStopResponse,
    OpenUrlRequest,
    ImportCookiesRequest,
    ImportCookiesResponse,
    ProxySettings,
    MarineGenerateRequest,
    MarineProviderConfig,
    MarineIdentity,
    MarineHistoryAppendRequest,
    MarinePublishedHistoryRequest,
    PostingRecord,
    RimeContext,
    RimeContextMode,
    RimeInvokeRequest,
    RimePrepareRequest,
    RimePrepareResponse,
    RimeStatus,
    RimeTarget,
  )),
  tags(
    (name = "profiles", description = "Profile management endpoints"),
    (name = "groups", description = "Group management endpoints"),
    (name = "tags", description = "Tag management endpoints"),
    (name = "proxies", description = "Proxy management endpoints"),
    (name = "vpns", description = "VPN management endpoints"),
    (name = "browsers", description = "Browser management endpoints"),
    (name = "cookies", description = "Cookie management endpoints"),
    (name = "marine", description = "Marine 截流 endpoints (extension-facing)"),
  ),
  modifiers(&SecurityAddon),
)]
struct ApiDoc;

// ===================== Marine (截流) endpoints =====================
// The in-browser Marine extension publishes the frozen page target, 话术, and
// posting history. Rime-side connectors own model authorization and execution;
// Marine only prepares the prompt bound to an authenticated context lease.

#[derive(Debug, Deserialize, ToSchema)]
struct MarineGenerateRequest {
  /// The pre-built persona/话术 ("skill") text the extension ships and merges
  /// (`skills/<brand>/`); the server splices it with the payload + task contract.
  skill: String,
  /// The grab payload the extension produced (article/subtitle/comments).
  #[schema(value_type = Object)]
  payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
struct MarineProviderConfig {
  provider: Option<String>,
  cli_model: Option<String>,
  openai_base_url: Option<String>,
  openai_model: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarineHistoryAppendRequest {
  profile_id: String,
  brand_id: String,
  target_url: String,
  #[serde(default)]
  page_title: String,
  platform: String,
  kind: String,
  angle: String,
  text: String,
  #[serde(default)]
  site_account_id: Option<String>,
  #[serde(default)]
  site_account_name: Option<String>,
  #[serde(default)]
  target_comment_id: Option<String>,
  #[serde(default)]
  target_author: Option<String>,
  #[serde(default)]
  parent_id: Option<String>,
  #[serde(default)]
  root_id: Option<String>,
  #[serde(default)]
  context_id: Option<String>,
}

fn default_marine_brand_id() -> String {
  "scholay".to_string()
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarinePublishedHistoryRequest {
  schema_version: u8,
  #[serde(default)]
  event_id: Option<String>,
  profile_id: String,
  #[serde(default = "default_marine_brand_id")]
  brand_id: String,
  target_url: String,
  #[serde(default)]
  page_title: String,
  platform: String,
  kind: String,
  text_snapshot: String,
  #[serde(default)]
  site_account_id: Option<String>,
  #[serde(default)]
  site_account_name: Option<String>,
  platform_comment_id: String,
  #[serde(default)]
  target_comment_id: Option<String>,
  #[serde(default)]
  target_author: Option<String>,
  #[serde(default)]
  parent_id: Option<String>,
  #[serde(default)]
  root_id: Option<String>,
  #[serde(default)]
  context_id: Option<String>,
  /// Bilibili's `ctime` in Unix seconds. Observation time is used if absent.
  #[serde(default, alias = "published_at")]
  posted_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
struct MarineIdentity {
  id: String,
  name: String,
}

const HISTORY_MAX_URL_CHARS: usize = 4096;
const HISTORY_MAX_TITLE_CHARS: usize = 512;
const HISTORY_MAX_TEXT_CHARS: usize = 20_000;
const HISTORY_MAX_SHORT_CHARS: usize = 256;
const HISTORY_MAX_ID_CHARS: usize = 128;

fn history_api_error(
  status: StatusCode,
  code: &str,
  message: impl Into<String>,
) -> (StatusCode, String) {
  (status, crate::marine::err_with(code, message))
}

fn history_invalid(message: impl Into<String>) -> (StatusCode, String) {
  history_api_error(StatusCode::BAD_REQUEST, "MARINE_HISTORY_INVALID", message)
}

fn history_storage_error(error: impl std::fmt::Display) -> (StatusCode, String) {
  log::error!("Marine posting history storage failed: {error}");
  history_api_error(
    StatusCode::INTERNAL_SERVER_ERROR,
    "MARINE_HISTORY_STORAGE_FAILED",
    "posting history storage failed",
  )
}

fn history_manager_error(error: HistoryError) -> (StatusCode, String) {
  match error {
    HistoryError::InvalidProfileId(_) => history_invalid("invalid profile_id"),
    other => history_storage_error(other),
  }
}

fn bounded_required(value: &str, field: &str, max_chars: usize) -> Result<String, String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return Err(format!("{field} is required"));
  }
  if trimmed.chars().count() > max_chars {
    return Err(format!("{field} exceeds {max_chars} characters"));
  }
  Ok(trimmed.to_string())
}

fn bounded_required_preserved(
  value: &str,
  field: &str,
  max_chars: usize,
) -> Result<String, String> {
  if value.trim().is_empty() {
    return Err(format!("{field} is required"));
  }
  if value.chars().count() > max_chars {
    return Err(format!("{field} exceeds {max_chars} characters"));
  }
  Ok(value.to_string())
}

fn bounded_optional(
  value: Option<String>,
  field: &str,
  max_chars: usize,
) -> Result<Option<String>, String> {
  let Some(value) = value else {
    return Ok(None);
  };
  if value.trim().is_empty() {
    return Ok(None);
  }
  bounded_required(&value, field, max_chars).map(Some)
}

fn validated_http_url(value: &str, require_bilibili: bool) -> Result<String, String> {
  let value = bounded_required(value, "target_url", HISTORY_MAX_URL_CHARS)?;
  let parsed = url::Url::parse(&value).map_err(|_| "target_url is not a valid URL".to_string())?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return Err("target_url must use http or https".to_string());
  }
  if parsed.host_str().is_none() {
    return Err("target_url must include a host".to_string());
  }
  if require_bilibili {
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "bilibili.com" && !host.ends_with(".bilibili.com") {
      return Err("target_url must be a Bilibili page".to_string());
    }
  }
  Ok(value)
}

fn normalized_platform_id(value: Option<String>, field: &str) -> Result<Option<String>, String> {
  let Some(value) = bounded_optional(value, field, HISTORY_MAX_ID_CHARS)? else {
    return Ok(None);
  };
  let number = value
    .parse::<u64>()
    .map_err(|_| format!("{field} must be a positive integer"))?;
  if number == 0 {
    return Ok(None);
  }
  Ok(Some(number.to_string()))
}

fn normalized_published_at(value: Option<u64>, observed_at: u64) -> Result<u64, String> {
  let Some(value) = value else {
    return Ok(observed_at);
  };
  let seconds = if value >= 100_000_000_000 {
    value / 1_000
  } else {
    value
  };
  if seconds == 0 || seconds > observed_at.saturating_add(86_400) {
    return Err("posted_at is not a plausible Unix timestamp".to_string());
  }
  Ok(seconds)
}

fn resolve_marine_identity(profile_id: &str) -> Result<MarineIdentity, (StatusCode, String)> {
  let parsed_id =
    uuid::Uuid::parse_str(profile_id).map_err(|_| history_invalid("profile_id must be a UUID"))?;
  let profiles = ProfileManager::instance()
    .list_profiles()
    .map_err(history_storage_error)?;
  profiles
    .into_iter()
    .find(|profile| profile.id == parsed_id)
    .map(|profile| MarineIdentity {
      id: profile.id.to_string(),
      name: profile.name,
    })
    .ok_or_else(|| {
      history_api_error(
        StatusCode::NOT_FOUND,
        "MARINE_HISTORY_PROFILE_NOT_FOUND",
        "Marine identity not found",
      )
    })
}

fn manual_history_record(
  request: MarineHistoryAppendRequest,
  identity: &MarineIdentity,
  observed_at: u64,
) -> Result<PostingRecord, String> {
  let platform = bounded_required(&request.platform, "platform", 64)?.to_ascii_lowercase();
  let kind = bounded_required(&request.kind, "kind", 16)?.to_ascii_lowercase();
  if !matches!(kind.as_str(), "direct" | "reply") {
    return Err("kind must be direct or reply".to_string());
  }
  Ok(PostingRecord {
    id: uuid::Uuid::new_v4().to_string(),
    event_id: None,
    profile_id: identity.id.clone(),
    profile_name_snapshot: identity.name.clone(),
    brand_id: bounded_required(&request.brand_id, "brand_id", 64)?,
    target_url: validated_http_url(&request.target_url, false)?,
    page_title: bounded_optional(
      Some(request.page_title),
      "page_title",
      HISTORY_MAX_TITLE_CHARS,
    )?
    .unwrap_or_default(),
    platform,
    kind,
    angle: bounded_optional(Some(request.angle), "angle", HISTORY_MAX_SHORT_CHARS)?
      .unwrap_or_default(),
    text_snapshot: bounded_required_preserved(&request.text, "text", HISTORY_MAX_TEXT_CHARS)?,
    site_account_id: bounded_optional(
      request.site_account_id,
      "site_account_id",
      HISTORY_MAX_ID_CHARS,
    )?,
    site_account_name: bounded_optional(
      request.site_account_name,
      "site_account_name",
      HISTORY_MAX_SHORT_CHARS,
    )?,
    platform_comment_id: None,
    target_comment_id: bounded_optional(
      request.target_comment_id,
      "target_comment_id",
      HISTORY_MAX_ID_CHARS,
    )?,
    target_author: bounded_optional(
      request.target_author,
      "target_author",
      HISTORY_MAX_SHORT_CHARS,
    )?,
    parent_id: bounded_optional(request.parent_id, "parent_id", HISTORY_MAX_ID_CHARS)?,
    root_id: bounded_optional(request.root_id, "root_id", HISTORY_MAX_ID_CHARS)?,
    context_id: bounded_optional(request.context_id, "context_id", HISTORY_MAX_ID_CHARS)?,
    confirmation_source: "manual".into(),
    status: "manual_confirmed".into(),
    posted_at: observed_at,
  })
}

fn published_history_record(
  request: MarinePublishedHistoryRequest,
  identity: &MarineIdentity,
  observed_at: u64,
) -> Result<PostingRecord, String> {
  if request.schema_version != 1 {
    return Err("schema_version must be 1".to_string());
  }
  if !request.platform.trim().eq_ignore_ascii_case("bilibili") {
    return Err("platform must be bilibili".to_string());
  }
  let platform_comment_id =
    normalized_platform_id(Some(request.platform_comment_id), "platform_comment_id")?
      .ok_or_else(|| "platform_comment_id must be a positive integer".to_string())?;
  let canonical_event_id = format!("bilibili:{platform_comment_id}");
  if let Some(event_id) = request.event_id.as_deref() {
    if event_id != canonical_event_id {
      return Err("event_id does not match platform_comment_id".to_string());
    }
  }
  let target_comment_id = normalized_platform_id(request.target_comment_id, "target_comment_id")?;
  let parent_id = normalized_platform_id(request.parent_id, "parent_id")?;
  let root_id = normalized_platform_id(request.root_id, "root_id")?;
  let hierarchy_target_id = parent_id.clone().or_else(|| root_id.clone());
  if target_comment_id != hierarchy_target_id {
    return Err("target_comment_id does not match parent_id/root_id".to_string());
  }
  let inferred_kind = if hierarchy_target_id.is_some() {
    "reply"
  } else {
    "direct"
  };
  if request.kind.trim().to_ascii_lowercase() != inferred_kind {
    return Err("kind does not match the Bilibili reply hierarchy".to_string());
  }
  Ok(PostingRecord {
    id: uuid::Uuid::new_v4().to_string(),
    event_id: Some(canonical_event_id),
    profile_id: identity.id.clone(),
    profile_name_snapshot: identity.name.clone(),
    brand_id: bounded_required(&request.brand_id, "brand_id", 64)?,
    target_url: validated_http_url(&request.target_url, true)?,
    page_title: bounded_optional(
      Some(request.page_title),
      "page_title",
      HISTORY_MAX_TITLE_CHARS,
    )?
    .unwrap_or_default(),
    platform: "bilibili".into(),
    kind: inferred_kind.into(),
    angle: String::new(),
    text_snapshot: bounded_required_preserved(
      &request.text_snapshot,
      "text_snapshot",
      HISTORY_MAX_TEXT_CHARS,
    )?,
    site_account_id: bounded_optional(
      request.site_account_id,
      "site_account_id",
      HISTORY_MAX_ID_CHARS,
    )?,
    site_account_name: bounded_optional(
      request.site_account_name,
      "site_account_name",
      HISTORY_MAX_SHORT_CHARS,
    )?,
    platform_comment_id: Some(platform_comment_id),
    target_comment_id,
    target_author: bounded_optional(
      request.target_author,
      "target_author",
      HISTORY_MAX_SHORT_CHARS,
    )?,
    parent_id,
    root_id,
    context_id: bounded_optional(request.context_id, "context_id", HISTORY_MAX_ID_CHARS)?,
    confirmation_source: "bilibili-api".into(),
    status: "published".into(),
    posted_at: normalized_published_at(request.posted_at, observed_at)?,
  })
}

fn marine_ai_execution_moved() -> (StatusCode, String) {
  (
    StatusCode::GONE,
    crate::marine::err_with(
      "MARINE_AI_MOVED_TO_RIME",
      "AI execution moved to the Rime connector selected by the user",
    ),
  )
}

#[utoipa::path(
  post, path = "/v1/marine/generate", request_body = MarineGenerateRequest,
  responses((status = 410, description = "AI execution moved to Rime connectors")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_generate_api(
  Json(request): Json<MarineGenerateRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  let _retired_payload = (request.skill, request.payload);
  Err(marine_ai_execution_moved())
}

#[utoipa::path(
  get, path = "/v1/marine/provider-config",
  responses((status = 410, description = "AI authorization moved to Rime connectors")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_provider_config() -> Result<StatusCode, (StatusCode, String)> {
  Err(marine_ai_execution_moved())
}

#[utoipa::path(
  put, path = "/v1/marine/provider-config", request_body = MarineProviderConfig,
  responses((status = 410, description = "AI authorization moved to Rime connectors")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_set_provider_config(
  Json(config): Json<MarineProviderConfig>,
) -> Result<StatusCode, (StatusCode, String)> {
  let _retired_config = (
    config.provider,
    config.cli_model,
    config.openai_base_url,
    config.openai_model,
  );
  Err(marine_ai_execution_moved())
}

#[utoipa::path(
  get, path = "/v1/marine/agents",
  responses((status = 410, description = "AI authorization moved to Rime connectors")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_agents() -> Result<StatusCode, (StatusCode, String)> {
  Err(marine_ai_execution_moved())
}

#[utoipa::path(
  get, path = "/v1/marine/identities",
  responses((status = 200, body = [MarineIdentity])),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_identities(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<MarineIdentity>>, (StatusCode, String)> {
  let mut identities: Vec<MarineIdentity> = ProfileManager::instance()
    .list_profiles()
    .map_err(history_storage_error)?
    .into_iter()
    .map(|profile| MarineIdentity {
      id: profile.id.to_string(),
      name: profile.name,
    })
    .collect();
  identities.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
  Ok(Json(identities))
}

#[utoipa::path(
  get, path = "/v1/marine/history/{profile_id}",
  params(("profile_id" = String, Path, description = "Profile (persona) id")),
  responses((status = 200, body = [PostingRecord])),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_history(
  Path(profile_id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<PostingRecord>>, (StatusCode, String)> {
  let identity = resolve_marine_identity(&profile_id)?;
  let records = HISTORY_MANAGER
    .lock()
    .map_err(|_| history_storage_error("history manager lock poisoned"))?
    .list_for_profile(&identity.id)
    .map_err(history_manager_error)?;
  Ok(Json(records))
}

#[utoipa::path(
  post, path = "/v1/marine/history", request_body = MarineHistoryAppendRequest,
  responses((status = 200, description = "Recorded")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_append_history(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineHistoryAppendRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  let identity = resolve_marine_identity(&req.profile_id)?;
  let record = manual_history_record(req, &identity, crate::proxy_manager::now_secs())
    .map_err(history_invalid)?;
  HISTORY_MANAGER
    .lock()
    .map_err(|_| history_storage_error("history manager lock poisoned"))?
    .append(record)
    .map_err(history_manager_error)?;
  Ok(StatusCode::OK)
}

#[utoipa::path(
  post, path = "/v1/marine/history/published", request_body = MarinePublishedHistoryRequest,
  responses((status = 200, description = "Recorded or already recorded", body = PostingRecord)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_append_published_history(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarinePublishedHistoryRequest>,
) -> Result<Json<PostingRecord>, (StatusCode, String)> {
  let identity = resolve_marine_identity(&req.profile_id)?;
  let record = published_history_record(req, &identity, crate::proxy_manager::now_secs())
    .map_err(history_invalid)?;
  let outcome = HISTORY_MANAGER
    .lock()
    .map_err(|_| history_storage_error("history manager lock poisoned"))?
    .append(record)
    .map_err(history_manager_error)?;
  Ok(Json(outcome.record().clone()))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RimeClearQuery {
  context_id: Option<String>,
}

fn rime_context_error(error: RimeContextError) -> (StatusCode, String) {
  let (status, message) = match error {
    RimeContextError::Missing => (StatusCode::NOT_FOUND, "no active browser comment target"),
    RimeContextError::Stale => (StatusCode::CONFLICT, "browser comment target is stale"),
    RimeContextError::ContextMismatch => (StatusCode::CONFLICT, "browser comment target changed"),
    RimeContextError::ActionMismatch => (
      StatusCode::CONFLICT,
      "action does not match the browser comment target",
    ),
    RimeContextError::Invalid(message) => (StatusCode::BAD_REQUEST, message),
  };
  (
    status,
    crate::marine::err_with("MARINE_RIME_CONTEXT_INVALID", message),
  )
}

#[utoipa::path(
  get, path = "/v1/marine/rime/status",
  responses((status = 200, body = RimeStatus)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_rime_status(Extension(store): Extension<RimeContextStore>) -> Json<RimeStatus> {
  Json(store.status(rime_now_secs()))
}

#[utoipa::path(
  put, path = "/v1/marine/rime/context", request_body = RimeContext,
  responses((status = 200, body = RimeStatus), (status = 400, description = "Invalid or stale context")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_put_rime_context(
  Extension(store): Extension<RimeContextStore>,
  Json(context): Json<RimeContext>,
) -> Result<Json<RimeStatus>, (StatusCode, String)> {
  store
    .set(context, rime_now_secs())
    .map(Json)
    .map_err(rime_context_error)
}

#[utoipa::path(
  delete, path = "/v1/marine/rime/context",
  responses((status = 204, description = "Context cleared or already superseded")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_delete_rime_context(
  Extension(store): Extension<RimeContextStore>,
  Query(query): Query<RimeClearQuery>,
) -> StatusCode {
  // A stale tab's blur event is intentionally idempotent: a mismatched
  // contextId leaves the newer target untouched but still returns 204.
  store.clear(query.context_id.as_deref());
  StatusCode::NO_CONTENT
}

fn rime_context_same_lease(current: &RimeContext, captured: &RimeContext) -> bool {
  // Periodic focus renewal advances only updatedAt. Every semantic field stays
  // frozen so prepare can never return a prompt for a superseded target.
  let mut normalized_current = current.clone();
  normalized_current.updated_at = captured.updated_at;
  normalized_current == *captured
}

fn prepare_rime_response(
  store: &RimeContextStore,
  expected_runtime_instance_id: &str,
  request: RimePrepareRequest,
) -> Result<RimePrepareResponse, (StatusCode, String)> {
  request
    .validate_binding(RIME_PLUGIN_ID, expected_runtime_instance_id)
    .map_err(rime_context_error)?;
  let context = store
    .context_for_invoke(&request.invoke, rime_now_secs())
    .map_err(rime_context_error)?;
  let payload = context.prompt_payload();
  let prompt = crate::marine::generate::prompt::build_blocks_v1(&payload, &context.skill).map_err(
    |message| {
      (
        StatusCode::PAYLOAD_TOO_LARGE,
        crate::marine::err_with("MARINE_RIME_PROMPT_TOO_LARGE", message),
      )
    },
  )?;

  let current = store
    .context_for_invoke(&request.invoke, rime_now_secs())
    .map_err(rime_context_error)?;
  if !rime_context_same_lease(&current, &context) {
    return Err(rime_context_error(RimeContextError::ContextMismatch));
  }

  Ok(RimePrepareResponse::new(
    &request,
    prompt,
    context.target_summary,
  ))
}

#[utoipa::path(
  post, path = "/v1/marine/rime/prepare", request_body = RimePrepareRequest,
  responses(
    (status = 200, body = RimePrepareResponse),
    (status = 400, description = "Invalid runtime or request identity"),
    (status = 413, description = "Fixed prompt content exceeds the connector limit"),
    (status = 404, description = "No active context"),
    (status = 409, description = "Context changed or expired")
  ),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_prepare_rime_action(
  State(state): State<ApiServerState>,
  Extension(store): Extension<RimeContextStore>,
  Json(request): Json<RimePrepareRequest>,
) -> Result<Json<RimePrepareResponse>, (StatusCode, String)> {
  prepare_rime_response(&store, state.rime_runtime_instance_id.as_ref(), request).map(Json)
}

#[utoipa::path(
  post, path = "/v1/marine/rime/invoke", request_body = RimeInvokeRequest,
  responses((status = 410, description = "AI execution moved to Rime connectors")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_invoke_rime_action(
  Json(_request): Json<RimeInvokeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  Err(marine_ai_execution_moved())
}

#[utoipa::path(
  post, path = "/v1/marine/rime/invoke-stream", request_body = RimePrepareRequest,
  responses((status = 410, description = "AI execution moved to Rime connectors")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_invoke_rime_action_stream(
  Json(_request): Json<RimePrepareRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  Err(marine_ai_execution_moved())
}

// =================== end Marine endpoints ===================

struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
  fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
    if let Some(components) = openapi.components.as_mut() {
      components.add_security_scheme(
        "bearer_auth",
        utoipa::openapi::security::SecurityScheme::Http(
          utoipa::openapi::security::HttpBuilder::new()
            .scheme(utoipa::openapi::security::HttpAuthScheme::Bearer)
            .bearer_format("JWT")
            .build(),
        ),
      );
    }
  }
}

pub struct ApiServer {
  port: Option<u16>,
  shutdown_tx: Option<mpsc::Sender<()>>,
  task_handle: Option<tokio::task::JoinHandle<()>>,
  rime_runtime_instance_id: Option<String>,
}

impl ApiServer {
  fn new() -> Self {
    Self {
      port: None,
      shutdown_tx: None,
      task_handle: None,
      rime_runtime_instance_id: None,
    }
  }

  fn get_port(&self) -> Option<u16> {
    self.port
  }

  async fn start(
    &mut self,
    app_handle: tauri::AppHandle,
    preferred_port: u16,
  ) -> Result<u16, String> {
    // Stop existing server if running
    self.stop().await.ok();

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);
    let rime_consumer_token = crate::marine::rime::generate_runtime_token();
    let rime_runtime_instance_id = uuid::Uuid::new_v4().to_string();
    let state = ApiServerState {
      app_handle: app_handle.clone(),
      rime_consumer_token: Arc::from(rime_consumer_token.clone()),
      rime_runtime_instance_id: Arc::from(rime_runtime_instance_id.clone()),
    };

    // Try preferred port first, then random port
    let listener = match TcpListener::bind(format!("127.0.0.1:{preferred_port}")).await {
      Ok(listener) => listener,
      Err(_) => {
        // Port conflict, try random port
        let random_port = rand::random::<u16>().saturating_add(10000);
        match TcpListener::bind(format!("127.0.0.1:{random_port}")).await {
          Ok(listener) => {
            let _ = events::emit(
              "api-port-conflict",
              format!("API server using fallback port {random_port}"),
            );
            listener
          }
          Err(e) => return Err(format!("Failed to bind to any port: {e}")),
        }
      }
    };

    let actual_port = listener
      .local_addr()
      .map_err(|e| format!("Failed to get local address: {e}"))?
      .port();

    // Create router with OpenAPI documentation
    let (v1_routes, _) = OpenApiRouter::new()
      .routes(routes!(get_profiles, create_profile))
      .routes(routes!(get_profile, update_profile, delete_profile))
      .routes(routes!(run_profile))
      .routes(routes!(open_url_in_profile))
      .routes(routes!(kill_profile))
      .routes(routes!(batch_run_profiles))
      .routes(routes!(batch_stop_profiles))
      .routes(routes!(import_profile_cookies))
      .routes(routes!(get_groups, create_group))
      .routes(routes!(get_group, update_group, delete_group))
      .routes(routes!(get_tags))
      .routes(routes!(get_proxies, create_proxy))
      .routes(routes!(get_proxy, update_proxy, delete_proxy))
      .routes(routes!(get_vpns, create_vpn))
      .routes(routes!(import_vpn))
      .routes(routes!(export_vpn))
      .routes(routes!(get_vpn, update_vpn, delete_vpn))
      .routes(routes!(get_extensions))
      .routes(routes!(delete_extension_api))
      .routes(routes!(get_extension_groups))
      .routes(routes!(delete_extension_group_api))
      .routes(routes!(download_browser_api))
      .routes(routes!(get_browser_versions))
      .routes(routes!(check_browser_downloaded))
      .routes(routes!(get_wayfern_token, refresh_wayfern_token))
      .routes(routes!(marine_generate_api))
      .routes(routes!(
        marine_get_provider_config,
        marine_set_provider_config
      ))
      .routes(routes!(marine_get_identities))
      .routes(routes!(marine_get_history))
      .routes(routes!(marine_append_history))
      .routes(routes!(marine_append_published_history))
      .routes(routes!(marine_get_agents))
      .routes(routes!(marine_get_rime_status))
      .routes(routes!(marine_put_rime_context))
      .routes(routes!(marine_delete_rime_context))
      .routes(routes!(marine_prepare_rime_action))
      .routes(routes!(marine_invoke_rime_action))
      .routes(routes!(marine_invoke_rime_action_stream))
      .split_for_parts();

    let api = ApiDoc::openapi();

    let v1_routes = v1_routes
      .layer(Extension(RimeContextStore::default()))
      // Inert chokepoint (innermost → runs after auth) for the future per-hour
      // automation request limit. See rate_limit_middleware.
      .layer(middleware::from_fn(rate_limit_middleware))
      .layer(middleware::from_fn_with_state(
        state.clone(),
        auth_middleware,
      ))
      .layer(middleware::from_fn(terms_check_middleware));

    let api_for_v1 = api.clone();
    let app = Router::new()
      .merge(v1_routes)
      .route("/openapi.json", get(move || async move { Json(api) }))
      .route(
        "/v1/openapi.json",
        get(move || async move { Json(api_for_v1) }),
      )
      // Outermost layer: logs every request so customer reports show what
      // their automation is actually calling, what the response status was,
      // and how long it took. Never logs request bodies or auth headers.
      .layer(middleware::from_fn(request_logging_middleware))
      .layer(CorsLayer::permissive())
      .with_state(state);

    // Start server task
    let task_handle = tokio::spawn(async move {
      let server = axum::serve(listener, app);
      tokio::select! {
        _ = server => {},
        _ = shutdown_rx.recv() => {},
      }
    });

    self.port = Some(actual_port);
    self.shutdown_tx = Some(shutdown_tx);
    self.task_handle = Some(task_handle);

    match crate::marine::rime::write_runtime_config(
      actual_port,
      &rime_consumer_token,
      &rime_runtime_instance_id,
    ) {
      Ok(path) => {
        self.rime_runtime_instance_id = Some(rime_runtime_instance_id);
        log::info!(
          "Marine: wrote scoped Rime plugin runtime config to {}",
          path.display()
        );
      }
      Err(error) => {
        log::error!("Marine: failed to write Rime runtime config: {error}");
      }
    }

    Ok(actual_port)
  }

  async fn stop(&mut self) -> Result<(), String> {
    if let Some(shutdown_tx) = self.shutdown_tx.take() {
      let _ = shutdown_tx.send(()).await;
    }

    if let Some(handle) = self.task_handle.take() {
      handle.abort();
    }

    if let Some(instance_id) = self.rime_runtime_instance_id.take() {
      match crate::marine::rime::remove_runtime_config_if_owned(&instance_id) {
        Ok(true) => log::info!("Marine: removed stopped Rime runtime lease"),
        Ok(false) => {}
        Err(error) => log::warn!("Marine: failed to remove Rime runtime lease: {error}"),
      }
    }

    self.port = None;
    Ok(())
  }
}

// Terms and Conditions check middleware
async fn terms_check_middleware(
  request: axum::extract::Request,
  next: Next,
) -> Result<Response, StatusCode> {
  let terms_accepted = crate::wayfern_terms::WayfernTermsManager::instance().is_terms_accepted();
  terms_check_middleware_with_acceptance(request, next, terms_accepted).await
}

async fn terms_check_middleware_with_acceptance(
  request: axum::extract::Request,
  next: Next,
  terms_accepted: bool,
) -> Result<Response, StatusCode> {
  // Rime's Chrome-first bridge does not launch or download Wayfern. Keep its
  // local, authenticated endpoints independent from the browser license gate.
  if !terms_accepted && !is_rime_api_path(request.uri().path()) {
    return Err(StatusCode::FORBIDDEN);
  }

  Ok(next.run(request).await)
}

// Authentication middleware
async fn auth_middleware(
  State(state): State<ApiServerState>,
  headers: HeaderMap,
  request: axum::extract::Request,
  next: Next,
) -> Result<Response, StatusCode> {
  let path = request.uri().path().to_string();

  // Get the Authorization header
  let auth_header = headers
    .get("Authorization")
    .and_then(|h| h.to_str().ok())
    .and_then(|h| h.strip_prefix("Bearer "));

  let token = match auth_header {
    Some(token) => token,
    None => {
      log::warn!("[api] Rejected {path}: missing Authorization header");
      return Err(StatusCode::UNAUTHORIZED);
    }
  };

  // The runtime file consumed by Rime Buffer carries an ephemeral capability,
  // not the long-lived full API bearer. It can read status and explicitly
  // invoke an already-published action, but cannot publish context or access
  // any account/profile API. A fresh capability is generated on every start.
  if is_rime_consumer_path(&path)
    && constant_time_token_matches(token, state.rime_consumer_token.as_ref())
  {
    return Ok(next.run(request).await);
  }

  // Get the stored token
  let settings_manager = crate::settings_manager::SettingsManager::instance();
  let stored_token = match settings_manager.get_api_token(&state.app_handle).await {
    Ok(Some(stored_token)) => stored_token,
    Ok(None) => {
      log::warn!(
        "[api] Rejected {path}: API server has no stored token (was the API toggled off?)"
      );
      return Err(StatusCode::UNAUTHORIZED);
    }
    Err(e) => {
      log::error!("[api] Failed to read stored API token: {e}");
      return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
  };

  // Constant-time comparison so the auth check doesn't leak the shared-prefix
  // length via timing. `ConstantTimeEq` on equal-length byte slices; differing
  // lengths simply compare unequal.
  if !constant_time_token_matches(token, &stored_token) {
    log::warn!("[api] Rejected {path}: token mismatch");
    return Err(StatusCode::UNAUTHORIZED);
  }

  // Token is valid, continue with the request
  Ok(next.run(request).await)
}

fn is_rime_consumer_path(path: &str) -> bool {
  matches!(
    path,
    "/v1/marine/rime/status"
      | "/v1/marine/rime/prepare"
      | "/v1/marine/rime/invoke"
      | "/v1/marine/rime/invoke-stream"
  )
}

fn is_rime_api_path(path: &str) -> bool {
  matches!(
    path,
    "/v1/marine/rime/status"
      | "/v1/marine/rime/context"
      | "/v1/marine/rime/prepare"
      | "/v1/marine/rime/invoke"
      | "/v1/marine/rime/invoke-stream"
  )
}

fn constant_time_token_matches(presented: &str, expected: &str) -> bool {
  use subtle::ConstantTimeEq;
  let presented = presented.as_bytes();
  let expected = expected.as_bytes();
  presented.len() == expected.len() && presented.ct_eq(expected).into()
}

/// Logs every request: method, path, query, response status, duration.
/// Skips Authorization header and request bodies entirely.
async fn request_logging_middleware(request: axum::extract::Request, next: Next) -> Response {
  let method = request.method().clone();
  let path = request.uri().path().to_string();
  let query = request.uri().query().map(|q| q.to_string());
  let started = std::time::Instant::now();

  let response = next.run(request).await;

  let status = response.status();
  let elapsed_ms = started.elapsed().as_millis();

  let level = if status.is_server_error() {
    log::Level::Error
  } else if status.is_client_error() {
    log::Level::Warn
  } else {
    log::Level::Info
  };

  match query {
    Some(q) => log::log!(
      level,
      "[api] {method} {path}?{q} -> {status} ({elapsed_ms} ms)"
    ),
    None => log::log!(level, "[api] {method} {path} -> {status} ({elapsed_ms} ms)"),
  }

  response
}

/// Chokepoint for the future per-hour automation request limit. The limit
/// (`requests_per_hour`, default 100) is already plumbed through entitlements;
/// this middleware is intentionally inert today — it resolves the limit but
/// never blocks. To enforce, count authenticated requests per rolling hour and
/// return `StatusCode::TOO_MANY_REQUESTS` once the limit (when > 0) is exceeded.
async fn rate_limit_middleware(
  request: axum::extract::Request,
  next: Next,
) -> Result<Response, StatusCode> {
  let _requests_per_hour = crate::cloud_auth::CLOUD_AUTH.requests_per_hour().await;
  // TODO(rate-limit): enforce `_requests_per_hour` for automation routes.
  Ok(next.run(request).await)
}

// Global API server instance
lazy_static! {
  pub static ref API_SERVER: Arc<Mutex<ApiServer>> = Arc::new(Mutex::new(ApiServer::new()));
}

// Tauri commands
#[tauri::command]
pub async fn start_api_server_internal(
  port: u16,
  app_handle: &tauri::AppHandle,
) -> Result<u16, String> {
  let mut server_guard = API_SERVER.lock().await;
  server_guard.start(app_handle.clone(), port).await
}

#[tauri::command]
pub async fn stop_api_server() -> Result<(), String> {
  let mut server_guard = API_SERVER.lock().await;
  server_guard.stop().await
}

#[tauri::command]
pub async fn start_api_server(
  port: Option<u16>,
  app_handle: tauri::AppHandle,
) -> Result<u16, String> {
  let actual_port = port.unwrap_or(10108);
  start_api_server_internal(actual_port, &app_handle).await
}

#[tauri::command]
pub async fn get_api_server_status() -> Result<Option<u16>, String> {
  let server_guard = API_SERVER.lock().await;
  Ok(server_guard.get_port())
}

/// Serialize a browser config (camoufox/wayfern) to JSON for an API response.
/// Viewing a profile's fingerprint is available to every API caller; only
/// editing it (via `update_profile`) and launching/killing profiles
/// programmatically require an active paid plan.
fn config_to_api_value<T: serde::Serialize>(config: Option<&T>) -> Option<serde_json::Value> {
  serde_json::to_value(config?).ok()
}

// API Handlers - Profiles
#[utoipa::path(
  get,
  path = "/v1/profiles",
  responses(
    (status = 200, description = "List of all profiles", body = ApiProfilesResponse),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn get_profiles() -> Result<Json<ApiProfilesResponse>, StatusCode> {
  let profile_manager = ProfileManager::instance();
  match profile_manager.list_profiles() {
    Ok(profiles) => {
      let api_profiles: Vec<ApiProfile> = profiles
        .iter()
        .map(|profile| ApiProfile {
          id: profile.id.to_string(),
          name: profile.name.clone(),
          browser: profile.browser.clone(),
          version: profile.version.clone(),
          proxy_id: profile.proxy_id.clone(),
          launch_hook: profile.launch_hook.clone(),
          process_id: profile.process_id,
          last_launch: profile.last_launch,
          release_type: profile.release_type.clone(),
          camoufox_config: config_to_api_value(profile.camoufox_config.as_ref()),
          group_id: profile.group_id.clone(),
          tags: profile.tags.clone(),
          is_running: profile.process_id.is_some(), // Simple check based on process_id
          proxy_bypass_rules: profile.proxy_bypass_rules.clone(),
          vpn_id: profile.vpn_id.clone(),
        })
        .collect();

      Ok(Json(ApiProfilesResponse {
        profiles: api_profiles,
        total: profiles.len(),
      }))
    }
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

#[utoipa::path(
  get,
  path = "/v1/profiles/{id}",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  responses(
    (status = 200, description = "Profile details", body = ApiProfileResponse),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Profile not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn get_profile(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<ApiProfileResponse>, StatusCode> {
  let profile_manager = ProfileManager::instance();
  match profile_manager.list_profiles() {
    Ok(profiles) => {
      if let Some(profile) = profiles.iter().find(|p| p.id.to_string() == id) {
        Ok(Json(ApiProfileResponse {
          profile: ApiProfile {
            id: profile.id.to_string(),
            name: profile.name.clone(),
            browser: profile.browser.clone(),
            version: profile.version.clone(),
            proxy_id: profile.proxy_id.clone(),
            launch_hook: profile.launch_hook.clone(),
            process_id: profile.process_id,
            last_launch: profile.last_launch,
            release_type: profile.release_type.clone(),
            camoufox_config: config_to_api_value(profile.camoufox_config.as_ref()),
            group_id: profile.group_id.clone(),
            tags: profile.tags.clone(),
            is_running: profile.process_id.is_some(), // Simple check based on process_id
            proxy_bypass_rules: profile.proxy_bypass_rules.clone(),
            vpn_id: profile.vpn_id.clone(),
          },
        }))
      } else {
        Err(StatusCode::NOT_FOUND)
      }
    }
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

/// Create a profile.
///
/// - `browser` must be `"wayfern"` or `"camoufox"`; any other value is rejected
///   with 400.
/// - `version` is optional: omit it or pass `"latest"` to use the newest
///   already-downloaded version of that browser. The version must be present
///   locally (this endpoint does not download new versions); 400 if none is.
/// - Omitting the matching `wayfern_config`/`camoufox_config`, or passing an
///   empty object `{}`, generates a fresh fingerprint automatically.
#[utoipa::path(
  post,
  path = "/v1/profiles",
  request_body = CreateProfileRequest,
  responses(
    (status = 200, description = "Profile created successfully", body = ApiProfileResponse),
    (status = 400, description = "Invalid browser, or no downloaded version available"),
    (status = 401, description = "Unauthorized"),
    (status = 402, description = "Selected proxy requires payment"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn create_profile(
  State(state): State<ApiServerState>,
  Json(request): Json<CreateProfileRequest>,
) -> Result<Json<ApiProfileResponse>, (StatusCode, String)> {
  let profile_manager = ProfileManager::instance();

  // Only Wayfern and Camoufox profiles are launchable; the rest of the system
  // (fingerprint generation, launch, run) supports nothing else. Reject anything
  // else up front — otherwise the profile is created with no fingerprint and an
  // unrecognized browser, then crashes with a 500 on /run. Mirrors the MCP
  // create_profile validation.
  if request.browser != "wayfern" && request.browser != "camoufox" {
    return Err((
      StatusCode::BAD_REQUEST,
      format!(
        "Invalid browser \"{}\". Must be \"wayfern\" (anti-detect Chromium) or \"camoufox\" (anti-detect Firefox).",
        request.browser
      ),
    ));
  }

  // Resolve the version. Omitted, empty, or "latest" means "newest version
  // already downloaded for this browser". The create path generates the
  // fingerprint by launching that binary, so the version must be present
  // locally — we don't fetch new versions here. 400 if none is downloaded.
  let version = match request.version.as_deref() {
    Some(v) if !v.is_empty() && v != "latest" => v.to_string(),
    _ => {
      let registry = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance();
      let mut versions = registry.get_downloaded_versions(&request.browser);
      // browsers is a HashMap, so keys are unordered — sort newest-first by
      // semver before taking the latest.
      versions.sort_by(|a, b| crate::api_client::compare_versions(b, a));
      match versions.into_iter().next() {
        Some(v) => v,
        None => {
          return Err((
            StatusCode::BAD_REQUEST,
            format!(
              "No downloaded version of \"{}\" is available. Download the browser in Marine first — this endpoint does not download browsers.",
              request.browser
            ),
          ));
        }
      }
    }
  };

  // Parse camoufox config if provided
  let camoufox_config = if let Some(config) = &request.camoufox_config {
    serde_json::from_value(config.clone()).ok()
  } else {
    None
  };

  // Parse wayfern config if provided
  let wayfern_config = if let Some(config) = &request.wayfern_config {
    serde_json::from_value(config.clone()).ok()
  } else {
    None
  };

  // Reject a dead/unreachable proxy or VPN before creating the profile. A 402
  // (expired proxy subscription) maps to 402; anything else is a 400.
  if let Err(err) =
    crate::validate_profile_network(request.proxy_id.as_deref(), request.vpn_id.as_deref()).await
  {
    return Err(if err.contains("PROXY_PAYMENT_REQUIRED") {
      (
        StatusCode::PAYMENT_REQUIRED,
        "The selected proxy requires an active subscription.".to_string(),
      )
    } else {
      (
        StatusCode::BAD_REQUEST,
        format!("Profile network validation failed: {err}"),
      )
    });
  }

  // Create profile using the async create_profile_with_group method
  match profile_manager
    .create_profile_with_group(
      &state.app_handle,
      &request.name,
      &request.browser,
      &version,
      request.release_type.as_deref().unwrap_or("stable"),
      request.proxy_id.clone(),
      request.vpn_id.clone(),
      camoufox_config,
      wayfern_config,
      request.group_id.clone(),
      false,
      None,
      request.launch_hook.clone(),
      None,
    )
    .await
  {
    Ok(mut profile) => {
      // Apply tags if provided
      if let Some(tags) = &request.tags {
        if profile_manager
          .update_profile_tags(&state.app_handle, &profile.name, tags.clone())
          .is_err()
        {
          return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Profile created but failed to apply tags.".to_string(),
          ));
        }
        profile.tags = tags.clone();
      }

      // Update tag manager with new tags
      if let Ok(profiles) = profile_manager.list_profiles() {
        let _ = crate::tag_manager::TAG_MANAGER
          .lock()
          .map(|manager| manager.rebuild_from_profiles(&profiles));
      }

      Ok(Json(ApiProfileResponse {
        profile: ApiProfile {
          id: profile.id.to_string(),
          name: profile.name,
          browser: profile.browser,
          version: profile.version,
          proxy_id: profile.proxy_id,
          launch_hook: profile.launch_hook,
          process_id: profile.process_id,
          last_launch: profile.last_launch,
          release_type: profile.release_type,
          camoufox_config: config_to_api_value(profile.camoufox_config.as_ref()),
          group_id: profile.group_id,
          tags: profile.tags,
          is_running: false,
          proxy_bypass_rules: profile.proxy_bypass_rules,
          vpn_id: profile.vpn_id,
        },
      }))
    }
    Err(e) => Err((
      StatusCode::BAD_REQUEST,
      format!("Failed to create profile: {e}"),
    )),
  }
}

#[utoipa::path(
  put,
  path = "/v1/profiles/{id}",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  request_body = UpdateProfileRequest,
  responses(
    (status = 200, description = "Profile updated successfully", body = ApiProfileResponse),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Profile not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn update_profile(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
  Json(request): Json<UpdateProfileRequest>,
) -> Result<Json<ApiProfileResponse>, StatusCode> {
  let profile_manager = ProfileManager::instance();

  if request.proxy_id.as_deref().is_some_and(|s| !s.is_empty())
    && request.vpn_id.as_deref().is_some_and(|s| !s.is_empty())
  {
    return Err(StatusCode::BAD_REQUEST);
  }

  // Update profile fields
  if let Some(new_name) = request.name {
    if profile_manager
      .rename_profile(&state.app_handle, &id, &new_name)
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(version) = request.version {
    if profile_manager
      .update_profile_version(&state.app_handle, &id, &version)
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(proxy_id) = request.proxy_id {
    if profile_manager
      .update_profile_proxy(state.app_handle.clone(), &id, Some(proxy_id))
      .await
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(vpn_id) = request.vpn_id {
    let normalized = if vpn_id.is_empty() {
      None
    } else {
      Some(vpn_id)
    };
    if profile_manager
      .update_profile_vpn(state.app_handle.clone(), &id, normalized)
      .await
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(launch_hook) = request.launch_hook {
    let normalized = if launch_hook.trim().is_empty() {
      None
    } else {
      Some(launch_hook)
    };

    if profile_manager
      .update_profile_launch_hook(&state.app_handle, &id, normalized)
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(camoufox_config) = request.camoufox_config {
    // Editing a profile's fingerprint config is part of the cross-OS fingerprint
    // capability (GUI, API, MCP). Viewing it is free; mutating it is not.
    if !crate::cloud_auth::CLOUD_AUTH
      .can_use_cross_os_fingerprints()
      .await
    {
      return Err(StatusCode::PAYMENT_REQUIRED);
    }
    let config: Result<CamoufoxConfig, _> = serde_json::from_value(camoufox_config);
    match config {
      Ok(config) => {
        if profile_manager
          .update_camoufox_config(state.app_handle.clone(), &id, config)
          .await
          .is_err()
        {
          return Err(StatusCode::BAD_REQUEST);
        }
      }
      Err(_) => return Err(StatusCode::BAD_REQUEST),
    }
  }

  if let Some(group_id) = request.group_id {
    if profile_manager
      .assign_profiles_to_group(&state.app_handle, vec![id.clone()], Some(group_id))
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(tags) = request.tags {
    if profile_manager
      .update_profile_tags(&state.app_handle, &id, tags)
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }

    // Update tag manager with new tags from all profiles
    if let Ok(profiles) = profile_manager.list_profiles() {
      let _ = crate::tag_manager::TAG_MANAGER
        .lock()
        .map(|manager| manager.rebuild_from_profiles(&profiles));
    }
  }

  if let Some(extension_group_id) = request.extension_group_id {
    let ext_group = if extension_group_id.is_empty() {
      None
    } else {
      Some(extension_group_id)
    };
    if profile_manager
      .update_profile_extension_group(&id, ext_group)
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(proxy_bypass_rules) = request.proxy_bypass_rules {
    if profile_manager
      .update_profile_proxy_bypass_rules(&state.app_handle, &id, proxy_bypass_rules)
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  if let Some(sync_mode) = request.sync_mode {
    if crate::sync::set_profile_sync_mode(state.app_handle.clone(), id.clone(), sync_mode)
      .await
      .is_err()
    {
      return Err(StatusCode::BAD_REQUEST);
    }
  }

  // Return updated profile
  get_profile(Path(id), State(state)).await
}

#[utoipa::path(
  delete,
  path = "/v1/profiles/{id}",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  responses(
    (status = 204, description = "Profile deleted successfully"),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn delete_profile(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  let profile_manager = ProfileManager::instance();
  match profile_manager.delete_profile(&state.app_handle, &id) {
    Ok(_) => Ok(StatusCode::NO_CONTENT),
    Err(_) => Err(StatusCode::BAD_REQUEST),
  }
}

// API Handlers - Groups
#[utoipa::path(
  get,
  path = "/v1/groups",
  responses(
    (status = 200, description = "List of all groups", body = Vec<ApiGroupResponse>),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "groups"
)]
async fn get_groups(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<ApiGroupResponse>>, StatusCode> {
  match GROUP_MANAGER.lock() {
    Ok(manager) => {
      match manager.get_all_groups() {
        Ok(groups) => {
          let api_groups = groups
            .into_iter()
            .map(|group| ApiGroupResponse {
              id: group.id,
              name: group.name,
              profile_count: 0, // Would need profile list to calculate this
            })
            .collect();
          Ok(Json(api_groups))
        }
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
      }
    }
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

#[utoipa::path(
  get,
  path = "/v1/groups/{id}",
  params(
    ("id" = String, Path, description = "Group ID")
  ),
  responses(
    (status = 200, description = "Group details", body = ApiGroupResponse),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Group not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "groups"
)]
async fn get_group(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<ApiGroupResponse>, StatusCode> {
  match GROUP_MANAGER.lock() {
    Ok(manager) => match manager.get_all_groups() {
      Ok(groups) => {
        if let Some(group) = groups.into_iter().find(|g| g.id == id) {
          Ok(Json(ApiGroupResponse {
            id: group.id,
            name: group.name,
            profile_count: 0,
          }))
        } else {
          Err(StatusCode::NOT_FOUND)
        }
      }
      Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    },
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

#[utoipa::path(
  post,
  path = "/v1/groups",
  request_body = CreateGroupRequest,
  responses(
    (status = 200, description = "Group created successfully", body = ApiGroupResponse),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "groups"
)]
async fn create_group(
  State(state): State<ApiServerState>,
  Json(request): Json<CreateGroupRequest>,
) -> Result<Json<ApiGroupResponse>, StatusCode> {
  match GROUP_MANAGER.lock() {
    Ok(manager) => match manager.create_group(&state.app_handle, request.name) {
      Ok(group) => Ok(Json(ApiGroupResponse {
        id: group.id,
        name: group.name,
        profile_count: 0,
      })),
      Err(_) => Err(StatusCode::BAD_REQUEST),
    },
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

#[utoipa::path(
  put,
  path = "/v1/groups/{id}",
  params(
    ("id" = String, Path, description = "Group ID")
  ),
  request_body = UpdateGroupRequest,
  responses(
    (status = 200, description = "Group updated successfully", body = ApiGroupResponse),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Group not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "groups"
)]
async fn update_group(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
  Json(request): Json<UpdateGroupRequest>,
) -> Result<Json<ApiGroupResponse>, StatusCode> {
  match GROUP_MANAGER.lock() {
    Ok(manager) => match manager.update_group(&state.app_handle, id.clone(), request.name) {
      Ok(group) => Ok(Json(ApiGroupResponse {
        id: group.id,
        name: group.name,
        profile_count: 0,
      })),
      Err(_) => Err(StatusCode::BAD_REQUEST),
    },
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

#[utoipa::path(
  delete,
  path = "/v1/groups/{id}",
  params(
    ("id" = String, Path, description = "Group ID")
  ),
  responses(
    (status = 204, description = "Group deleted successfully"),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "groups"
)]
async fn delete_group(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  match GROUP_MANAGER.lock() {
    Ok(manager) => match manager.delete_group(&state.app_handle, id.clone()) {
      Ok(_) => Ok(StatusCode::NO_CONTENT),
      Err(_) => Err(StatusCode::BAD_REQUEST),
    },
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

// API Handlers - Tags
#[utoipa::path(
  get,
  path = "/v1/tags",
  responses(
    (status = 200, description = "List of all tags", body = Vec<String>),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "tags"
)]
async fn get_tags(State(_state): State<ApiServerState>) -> Result<Json<Vec<String>>, StatusCode> {
  match TAG_MANAGER.lock() {
    Ok(manager) => match manager.get_all_tags() {
      Ok(tags) => Ok(Json(tags)),
      Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    },
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

// API Handlers - Proxies
#[utoipa::path(
  get,
  path = "/v1/proxies",
  responses(
    (status = 200, description = "List of all proxies", body = Vec<ApiProxyResponse>),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "proxies"
)]
async fn get_proxies(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<ApiProxyResponse>>, StatusCode> {
  let proxies = PROXY_MANAGER.get_stored_proxies();
  Ok(Json(
    proxies
      .into_iter()
      .map(|p| ApiProxyResponse {
        id: p.id,
        name: p.name,
        proxy_settings: p.proxy_settings,
      })
      .collect(),
  ))
}

#[utoipa::path(
  get,
  path = "/v1/proxies/{id}",
  params(
    ("id" = String, Path, description = "Proxy ID")
  ),
  responses(
    (status = 200, description = "Proxy details", body = ApiProxyResponse),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Proxy not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "proxies"
)]
async fn get_proxy(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<ApiProxyResponse>, StatusCode> {
  let proxies = PROXY_MANAGER.get_stored_proxies();
  if let Some(proxy) = proxies.into_iter().find(|p| p.id == id) {
    Ok(Json(ApiProxyResponse {
      id: proxy.id,
      name: proxy.name,
      proxy_settings: proxy.proxy_settings,
    }))
  } else {
    Err(StatusCode::NOT_FOUND)
  }
}

#[utoipa::path(
  post,
  path = "/v1/proxies",
  request_body = CreateProxyRequest,
  responses(
    (status = 200, description = "Proxy created successfully", body = ApiProxyResponse),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "proxies"
)]
async fn create_proxy(
  State(state): State<ApiServerState>,
  Json(request): Json<CreateProxyRequest>,
) -> Result<Json<ApiProxyResponse>, StatusCode> {
  let result = PROXY_MANAGER.create_stored_proxy(
    &state.app_handle,
    request.name.clone(),
    request.proxy_settings,
  );

  match result {
    Ok(proxy) => Ok(Json(ApiProxyResponse {
      id: proxy.id,
      name: proxy.name,
      proxy_settings: proxy.proxy_settings,
    })),
    Err(_) => Err(StatusCode::BAD_REQUEST),
  }
}

#[utoipa::path(
  put,
  path = "/v1/proxies/{id}",
  params(
    ("id" = String, Path, description = "Proxy ID")
  ),
  request_body = UpdateProxyRequest,
  responses(
    (status = 200, description = "Proxy updated successfully", body = ApiProxyResponse),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Proxy not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "proxies"
)]
async fn update_proxy(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
  Json(request): Json<UpdateProxyRequest>,
) -> Result<Json<ApiProxyResponse>, StatusCode> {
  let result =
    PROXY_MANAGER.update_stored_proxy(&state.app_handle, &id, request.name, request.proxy_settings);

  match result {
    Ok(proxy) => Ok(Json(ApiProxyResponse {
      id: proxy.id,
      name: proxy.name,
      proxy_settings: proxy.proxy_settings,
    })),
    Err(_) => Err(StatusCode::NOT_FOUND),
  }
}

#[utoipa::path(
  delete,
  path = "/v1/proxies/{id}",
  params(
    ("id" = String, Path, description = "Proxy ID")
  ),
  responses(
    (status = 204, description = "Proxy deleted successfully"),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "proxies"
)]
async fn delete_proxy(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  match PROXY_MANAGER.delete_stored_proxy(&state.app_handle, &id) {
    Ok(_) => Ok(StatusCode::NO_CONTENT),
    Err(_) => Err(StatusCode::BAD_REQUEST),
  }
}

// API Handlers - VPNs

fn vpn_to_api_response(c: &crate::vpn::VpnConfig) -> ApiVpnResponse {
  ApiVpnResponse {
    id: c.id.clone(),
    name: c.name.clone(),
    vpn_type: c.vpn_type.to_string(),
    created_at: c.created_at,
    last_used: c.last_used,
  }
}

fn parse_vpn_type(s: &str) -> Option<crate::vpn::VpnType> {
  match s.to_ascii_lowercase().as_str() {
    "wireguard" | "wg" => Some(crate::vpn::VpnType::WireGuard),
    _ => None,
  }
}

#[utoipa::path(
  get,
  path = "/v1/vpns",
  responses(
    (status = 200, description = "List of all VPN configurations", body = Vec<ApiVpnResponse>),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn get_vpns(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<ApiVpnResponse>>, StatusCode> {
  let storage = crate::vpn::VPN_STORAGE
    .lock()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let configs = storage
    .list_configs()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  Ok(Json(configs.iter().map(vpn_to_api_response).collect()))
}

#[utoipa::path(
  get,
  path = "/v1/vpns/{id}",
  params(("id" = String, Path, description = "VPN configuration ID")),
  responses(
    (status = 200, description = "VPN configuration details", body = ApiVpnResponse),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "VPN configuration not found"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn get_vpn(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<ApiVpnResponse>, StatusCode> {
  let storage = crate::vpn::VPN_STORAGE
    .lock()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let configs = storage
    .list_configs()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  configs
    .iter()
    .find(|c| c.id == id)
    .map(|c| Json(vpn_to_api_response(c)))
    .ok_or(StatusCode::NOT_FOUND)
}

#[utoipa::path(
  get,
  path = "/v1/vpns/{id}/export",
  params(("id" = String, Path, description = "VPN configuration ID")),
  responses(
    (status = 200, description = "Decrypted VPN configuration", body = ApiVpnExportResponse),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "VPN configuration not found"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn export_vpn(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<ApiVpnExportResponse>, StatusCode> {
  let storage = crate::vpn::VPN_STORAGE
    .lock()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  match storage.load_config(&id) {
    Ok(config) => Ok(Json(ApiVpnExportResponse {
      id: config.id,
      name: config.name,
      vpn_type: config.vpn_type.to_string(),
      config_data: config.config_data,
    })),
    Err(_) => Err(StatusCode::NOT_FOUND),
  }
}

#[utoipa::path(
  post,
  path = "/v1/vpns/import",
  request_body = ImportVpnRequest,
  responses(
    (status = 200, description = "VPN configuration imported successfully", body = ApiVpnResponse),
    (status = 400, description = "Invalid or unrecognized VPN config"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn import_vpn(
  State(_state): State<ApiServerState>,
  Json(request): Json<ImportVpnRequest>,
) -> Result<Json<ApiVpnResponse>, StatusCode> {
  let result = {
    let storage = crate::vpn::VPN_STORAGE
      .lock()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    storage.import_config(&request.content, &request.filename, request.name)
  };
  match result {
    Ok(config) => {
      let _ = events::emit("vpn-configs-changed", ());
      Ok(Json(vpn_to_api_response(&config)))
    }
    Err(_) => Err(StatusCode::BAD_REQUEST),
  }
}

#[utoipa::path(
  post,
  path = "/v1/vpns",
  request_body = CreateVpnRequest,
  responses(
    (status = 200, description = "VPN configuration created successfully", body = ApiVpnResponse),
    (status = 400, description = "Invalid VPN config or unknown vpn_type"),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn create_vpn(
  State(_state): State<ApiServerState>,
  Json(request): Json<CreateVpnRequest>,
) -> Result<Json<ApiVpnResponse>, StatusCode> {
  let vpn_type = parse_vpn_type(&request.vpn_type).ok_or(StatusCode::BAD_REQUEST)?;
  let result = {
    let storage = crate::vpn::VPN_STORAGE
      .lock()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    storage.create_config_manual(&request.name, vpn_type, &request.config_data)
  };
  match result {
    Ok(config) => {
      let _ = events::emit("vpn-configs-changed", ());
      Ok(Json(vpn_to_api_response(&config)))
    }
    Err(_) => Err(StatusCode::BAD_REQUEST),
  }
}

#[utoipa::path(
  put,
  path = "/v1/vpns/{id}",
  params(("id" = String, Path, description = "VPN configuration ID")),
  request_body = UpdateVpnRequest,
  responses(
    (status = 200, description = "VPN configuration updated successfully", body = ApiVpnResponse),
    (status = 400, description = "Bad request"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "VPN configuration not found"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn update_vpn(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
  Json(request): Json<UpdateVpnRequest>,
) -> Result<Json<ApiVpnResponse>, StatusCode> {
  let result = {
    let storage = crate::vpn::VPN_STORAGE
      .lock()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    storage.update_config_name(&id, &request.name)
  };
  match result {
    Ok(config) => {
      let _ = events::emit("vpn-configs-changed", ());
      Ok(Json(vpn_to_api_response(&config)))
    }
    Err(_) => Err(StatusCode::NOT_FOUND),
  }
}

#[utoipa::path(
  delete,
  path = "/v1/vpns/{id}",
  params(("id" = String, Path, description = "VPN configuration ID")),
  responses(
    (status = 204, description = "VPN configuration deleted successfully"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "VPN configuration not found"),
    (status = 500, description = "Internal server error")
  ),
  security(("bearer_auth" = [])),
  tag = "vpns"
)]
async fn delete_vpn(
  Path(id): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  let _ = crate::vpn_worker_runner::stop_vpn_worker_by_vpn_id(&id).await;

  let result = {
    let storage = crate::vpn::VPN_STORAGE
      .lock()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    storage.delete_config(&id)
  };
  match result {
    Ok(_) => {
      let _ = events::emit("vpn-configs-changed", ());
      Ok(StatusCode::NO_CONTENT)
    }
    Err(_) => Err(StatusCode::NOT_FOUND),
  }
}

// Extension API endpoints

#[utoipa::path(
  get,
  path = "/v1/extensions",
  responses(
    (status = 200, description = "List of extensions"),
    (status = 401, description = "Unauthorized"),
  ),
  security(("bearer_auth" = [])),
  tag = "extensions"
)]
async fn get_extensions(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<crate::extension_manager::Extension>>, StatusCode> {
  let mgr = crate::extension_manager::EXTENSION_MANAGER.lock().unwrap();
  mgr
    .list_extensions()
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[utoipa::path(
  get,
  path = "/v1/extension-groups",
  responses(
    (status = 200, description = "List of extension groups"),
    (status = 401, description = "Unauthorized"),
  ),
  security(("bearer_auth" = [])),
  tag = "extensions"
)]
async fn get_extension_groups(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<crate::extension_manager::ExtensionGroup>>, StatusCode> {
  let mgr = crate::extension_manager::EXTENSION_MANAGER.lock().unwrap();
  mgr
    .list_groups()
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[utoipa::path(
  delete,
  path = "/v1/extensions/{id}",
  params(("id" = String, Path, description = "Extension ID")),
  responses(
    (status = 204, description = "Extension deleted"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Extension not found"),
  ),
  security(("bearer_auth" = [])),
  tag = "extensions"
)]
async fn delete_extension_api(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  let mgr = crate::extension_manager::EXTENSION_MANAGER.lock().unwrap();
  mgr
    .delete_extension(&state.app_handle, &id)
    .map(|_| StatusCode::NO_CONTENT)
    .map_err(|_| StatusCode::NOT_FOUND)
}

#[utoipa::path(
  delete,
  path = "/v1/extension-groups/{id}",
  params(("id" = String, Path, description = "Extension Group ID")),
  responses(
    (status = 204, description = "Extension group deleted"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Extension group not found"),
  ),
  security(("bearer_auth" = [])),
  tag = "extensions"
)]
async fn delete_extension_group_api(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  let mgr = crate::extension_manager::EXTENSION_MANAGER.lock().unwrap();
  mgr
    .delete_group(&state.app_handle, &id)
    .map(|_| StatusCode::NO_CONTENT)
    .map_err(|_| StatusCode::NOT_FOUND)
}

// API Handler - Run Profile with Remote Debugging
#[utoipa::path(
  post,
  path = "/v1/profiles/{id}/run",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  request_body = RunProfileRequest,
  responses(
    (status = 200, description = "Profile launched successfully", body = RunProfileResponse),
    (status = 400, description = "Cannot launch cross-OS profile"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Profile not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn run_profile(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
  Json(request): Json<RunProfileRequest>,
) -> Result<Json<RunProfileResponse>, StatusCode> {
  if !crate::cloud_auth::CLOUD_AUTH
    .can_use_browser_automation()
    .await
  {
    return Err(StatusCode::PAYMENT_REQUIRED);
  }

  let headless = request.headless.unwrap_or(false);
  let url = request.url;

  let profile_manager = ProfileManager::instance();
  let profiles = profile_manager
    .list_profiles()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  let profile = profiles
    .iter()
    .find(|p| p.id.to_string() == id)
    .ok_or(StatusCode::NOT_FOUND)?;

  if profile.is_cross_os() {
    return Err(StatusCode::BAD_REQUEST);
  }

  // Team lock check
  crate::team_lock::acquire_team_lock_if_needed(profile)
    .await
    .map_err(|_| StatusCode::CONFLICT)?;

  let remote_debugging_port = {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
      .await
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let port = listener
      .local_addr()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
      .port();
    drop(listener);
    port
  };

  // Use the same launch path as the main app, but force a fresh instance with
  // remote debugging enabled so the returned port is the one the browser binds.
  match crate::browser_runner::launch_browser_profile_impl(
    state.app_handle.clone(),
    profile.clone(),
    url,
    Some(remote_debugging_port),
    headless,
    true,
  )
  .await
  {
    Ok(updated_profile) => Ok(Json(RunProfileResponse {
      profile_id: updated_profile.id.to_string(),
      remote_debugging_port,
      headless,
    })),
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

// API Handler - Open URL in existing browser
#[utoipa::path(
  post,
  path = "/v1/profiles/{id}/open-url",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  request_body = OpenUrlRequest,
  responses(
    (status = 200, description = "URL opened successfully"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Profile not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn open_url_in_profile(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
  Json(request): Json<OpenUrlRequest>,
) -> Result<StatusCode, StatusCode> {
  if !crate::cloud_auth::CLOUD_AUTH
    .can_use_browser_automation()
    .await
  {
    return Err(StatusCode::PAYMENT_REQUIRED);
  }

  let browser_runner = crate::browser_runner::BrowserRunner::instance();

  browser_runner
    .open_url_with_profile(state.app_handle.clone(), id, request.url)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  Ok(StatusCode::OK)
}

// API Handler - Kill browser process
#[utoipa::path(
  post,
  path = "/v1/profiles/{id}/kill",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  responses(
    (status = 204, description = "Browser process killed successfully"),
    (status = 401, description = "Unauthorized"),
    (status = 402, description = "Active paid plan required"),
    (status = 404, description = "Profile not found"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn kill_profile(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
) -> Result<StatusCode, StatusCode> {
  // Programmatically launching and stopping profiles is a paid feature; the
  // run/open-url handlers gate the same way.
  if !crate::cloud_auth::CLOUD_AUTH
    .can_use_browser_automation()
    .await
  {
    return Err(StatusCode::PAYMENT_REQUIRED);
  }

  let profile_manager = ProfileManager::instance();
  let profiles = profile_manager
    .list_profiles()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  let profile = profiles
    .iter()
    .find(|p| p.id.to_string() == id)
    .ok_or(StatusCode::NOT_FOUND)?;

  let browser_runner = crate::browser_runner::BrowserRunner::instance();
  browser_runner
    .kill_browser_process(state.app_handle.clone(), profile)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  crate::team_lock::release_team_lock_if_needed(profile).await;

  Ok(StatusCode::NO_CONTENT)
}

// API Handler - Batch run profiles (paid: browser automation). Mirrors the
// single `/run` gate; never breaks the batch on a single profile's failure —
// each profile gets its own result entry.
#[utoipa::path(
  post,
  path = "/v1/profiles/batch/run",
  request_body = BatchRunRequest,
  responses(
    (status = 200, description = "Batch launch completed; inspect per-profile results", body = BatchRunResponse),
    (status = 401, description = "Unauthorized"),
    (status = 402, description = "Active paid plan with browser automation required"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn batch_run_profiles(
  State(state): State<ApiServerState>,
  Json(request): Json<BatchRunRequest>,
) -> Result<Json<BatchRunResponse>, StatusCode> {
  if !crate::cloud_auth::CLOUD_AUTH
    .can_use_browser_automation()
    .await
  {
    return Err(StatusCode::PAYMENT_REQUIRED);
  }

  let headless = request.headless.unwrap_or(false);
  let profile_manager = ProfileManager::instance();
  let profiles = profile_manager
    .list_profiles()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  let mut results = Vec::with_capacity(request.profile_ids.len());
  for profile_id in &request.profile_ids {
    let fail = |error: &str| BatchRunResult {
      profile_id: profile_id.clone(),
      ok: false,
      remote_debugging_port: None,
      error: Some(error.to_string()),
    };

    let Some(profile) = profiles.iter().find(|p| p.id.to_string() == *profile_id) else {
      results.push(fail("profile not found"));
      continue;
    };
    if profile.is_cross_os() {
      results.push(fail("cross-OS profiles cannot be launched"));
      continue;
    }
    if crate::team_lock::acquire_team_lock_if_needed(profile)
      .await
      .is_err()
    {
      results.push(fail("profile is locked by another team member"));
      continue;
    }

    let port = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
      Ok(listener) => match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => {
          results.push(fail("failed to allocate debugging port"));
          continue;
        }
      },
      Err(_) => {
        results.push(fail("failed to allocate debugging port"));
        continue;
      }
    };

    match crate::browser_runner::launch_browser_profile_impl(
      state.app_handle.clone(),
      profile.clone(),
      request.url.clone(),
      Some(port),
      headless,
      true,
    )
    .await
    {
      Ok(_) => results.push(BatchRunResult {
        profile_id: profile_id.clone(),
        ok: true,
        remote_debugging_port: Some(port),
        error: None,
      }),
      Err(e) => results.push(fail(&format!("launch failed: {e}"))),
    }
  }

  Ok(Json(BatchRunResponse { results }))
}

// API Handler - Batch stop profiles (paid: browser automation).
#[utoipa::path(
  post,
  path = "/v1/profiles/batch/stop",
  request_body = BatchStopRequest,
  responses(
    (status = 200, description = "Batch stop completed; inspect per-profile results", body = BatchStopResponse),
    (status = 401, description = "Unauthorized"),
    (status = 402, description = "Active paid plan with browser automation required"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "profiles"
)]
async fn batch_stop_profiles(
  State(state): State<ApiServerState>,
  Json(request): Json<BatchStopRequest>,
) -> Result<Json<BatchStopResponse>, StatusCode> {
  if !crate::cloud_auth::CLOUD_AUTH
    .can_use_browser_automation()
    .await
  {
    return Err(StatusCode::PAYMENT_REQUIRED);
  }

  let profile_manager = ProfileManager::instance();
  let profiles = profile_manager
    .list_profiles()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let browser_runner = crate::browser_runner::BrowserRunner::instance();

  let mut results = Vec::with_capacity(request.profile_ids.len());
  for profile_id in &request.profile_ids {
    let Some(profile) = profiles.iter().find(|p| p.id.to_string() == *profile_id) else {
      results.push(BatchStopResult {
        profile_id: profile_id.clone(),
        ok: false,
        error: Some("profile not found".to_string()),
      });
      continue;
    };

    match browser_runner
      .kill_browser_process(state.app_handle.clone(), profile)
      .await
    {
      Ok(_) => {
        crate::team_lock::release_team_lock_if_needed(profile).await;
        results.push(BatchStopResult {
          profile_id: profile_id.clone(),
          ok: true,
          error: None,
        });
      }
      Err(e) => results.push(BatchStopResult {
        profile_id: profile_id.clone(),
        ok: false,
        error: Some(format!("stop failed: {e}")),
      }),
    }
  }

  Ok(Json(BatchStopResponse { results }))
}

#[utoipa::path(
  post,
  path = "/v1/profiles/{id}/cookies/import",
  params(
    ("id" = String, Path, description = "Profile ID")
  ),
  request_body = ImportCookiesRequest,
  responses(
    (status = 200, description = "Cookies imported successfully", body = ImportCookiesResponse),
    (status = 400, description = "Invalid cookie file or unsupported browser"),
    (status = 401, description = "Unauthorized"),
    (status = 404, description = "Profile not found"),
    (status = 409, description = "Browser is currently running"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "cookies"
)]
async fn import_profile_cookies(
  Path(id): Path<String>,
  State(state): State<ApiServerState>,
  Json(request): Json<ImportCookiesRequest>,
) -> Result<Json<ImportCookiesResponse>, StatusCode> {
  let profile_manager = ProfileManager::instance();
  let profiles = profile_manager
    .list_profiles()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  if !profiles.iter().any(|p| p.id.to_string() == id) {
    return Err(StatusCode::NOT_FOUND);
  }

  match crate::cookie_manager::CookieManager::import_cookies(
    &state.app_handle,
    &id,
    &request.content,
  )
  .await
  {
    Ok(result) => {
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        if let Some(profile) = profiles.iter().find(|p| p.id.to_string() == id) {
          if profile.is_sync_enabled() {
            let pid = id.clone();
            tauri::async_runtime::spawn(async move {
              scheduler.queue_profile_sync(pid).await;
            });
          }
        }
      }
      Ok(Json(ImportCookiesResponse {
        cookies_imported: result.cookies_imported,
        cookies_replaced: result.cookies_replaced,
        errors: result.errors,
      }))
    }
    Err(e) => {
      let msg = e.to_lowercase();
      if msg.contains("running") {
        Err(StatusCode::CONFLICT)
      } else if msg.contains("no valid cookies") || msg.contains("unsupported browser") {
        Err(StatusCode::BAD_REQUEST)
      } else {
        Err(StatusCode::INTERNAL_SERVER_ERROR)
      }
    }
  }
}

// API Handler - Download Browser
#[utoipa::path(
  post,
  path = "/v1/browsers/download",
  request_body = DownloadBrowserRequest,
  responses(
    (status = 200, description = "Browser download initiated", body = DownloadBrowserResponse),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "browsers"
)]
async fn download_browser_api(
  State(state): State<ApiServerState>,
  Json(request): Json<DownloadBrowserRequest>,
) -> Result<Json<DownloadBrowserResponse>, StatusCode> {
  match crate::downloader::download_browser(
    state.app_handle.clone(),
    request.browser.clone(),
    request.version.clone(),
  )
  .await
  {
    Ok(_) => Ok(Json(DownloadBrowserResponse {
      browser: request.browser,
      version: request.version,
      status: "downloaded".to_string(),
    })),
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

// API Handler - Get Browser Versions
#[utoipa::path(
  get,
  path = "/v1/browsers/{browser}/versions",
  params(
    ("browser" = String, Path, description = "Browser name")
  ),
  responses(
    (status = 200, description = "List of available browser versions", body = Vec<String>),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "browsers"
)]
async fn get_browser_versions(
  Path(browser): Path<String>,
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<String>>, StatusCode> {
  let version_manager = crate::browser_version_manager::BrowserVersionManager::instance();

  match version_manager
    .fetch_browser_versions_with_count(&browser, false)
    .await
  {
    Ok(result) => Ok(Json(result.versions)),
    Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
  }
}

// API Handler - Check if Browser is Downloaded
#[utoipa::path(
  get,
  path = "/v1/browsers/{browser}/versions/{version}/downloaded",
  params(
    ("browser" = String, Path, description = "Browser name"),
    ("version" = String, Path, description = "Browser version")
  ),
  responses(
    (status = 200, description = "Browser download status", body = bool),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Internal server error")
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "browsers"
)]
async fn check_browser_downloaded(
  Path((browser, version)): Path<(String, String)>,
  State(_state): State<ApiServerState>,
) -> Result<Json<bool>, StatusCode> {
  let is_downloaded = crate::downloaded_browsers_registry::is_browser_downloaded(browser, version);
  Ok(Json(is_downloaded))
}

// API Handlers - Wayfern Token

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct WayfernTokenResponse {
  pub token: Option<String>,
}

#[utoipa::path(
  get,
  path = "/v1/wayfern-token",
  responses(
    (status = 200, description = "Current wayfern token", body = WayfernTokenResponse),
    (status = 401, description = "Unauthorized"),
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "wayfern"
)]
async fn get_wayfern_token(
  State(_state): State<ApiServerState>,
) -> Result<Json<WayfernTokenResponse>, StatusCode> {
  let token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
  Ok(Json(WayfernTokenResponse { token }))
}

#[utoipa::path(
  post,
  path = "/v1/wayfern-token/refresh",
  responses(
    (status = 200, description = "Refreshed wayfern token", body = WayfernTokenResponse),
    (status = 401, description = "Unauthorized"),
    (status = 500, description = "Failed to refresh token"),
  ),
  security(
    ("bearer_auth" = [])
  ),
  tag = "wayfern"
)]
async fn refresh_wayfern_token(
  State(_state): State<ApiServerState>,
) -> Result<Json<WayfernTokenResponse>, (StatusCode, String)> {
  crate::cloud_auth::CLOUD_AUTH
    .request_wayfern_token()
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

  let token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
  Ok(Json(WayfernTokenResponse { token }))
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::body::Body;
  use axum::http::{header, Request};
  use http_body_util::BodyExt;
  use tower::ServiceExt;

  fn test_marine_identity() -> MarineIdentity {
    MarineIdentity {
      id: uuid::Uuid::new_v4().to_string(),
      name: "Research identity".into(),
    }
  }

  fn test_published_history_request() -> MarinePublishedHistoryRequest {
    MarinePublishedHistoryRequest {
      schema_version: 1,
      event_id: Some("bilibili:9001".into()),
      profile_id: uuid::Uuid::new_v4().to_string(),
      brand_id: "scholay".into(),
      target_url: "https://www.bilibili.com/video/BV1test".into(),
      page_title: "A video".into(),
      platform: "bilibili".into(),
      kind: "direct".into(),
      text_snapshot: " The final text returned by Bilibili\n".into(),
      site_account_id: Some("42".into()),
      site_account_name: Some("viewer".into()),
      platform_comment_id: "9001".into(),
      target_comment_id: None,
      target_author: None,
      parent_id: Some("0".into()),
      root_id: Some("0".into()),
      context_id: None,
      posted_at: Some(1_700_000_000),
    }
  }

  #[test]
  fn marine_identity_response_exposes_only_id_and_name() {
    let value = serde_json::to_value(test_marine_identity()).unwrap();
    let object = value.as_object().unwrap();
    assert_eq!(object.len(), 2);
    assert!(object.contains_key("id"));
    assert!(object.contains_key("name"));
  }

  #[test]
  fn manual_history_request_remains_backward_compatible() {
    let request: MarineHistoryAppendRequest = serde_json::from_value(serde_json::json!({
      "profile_id": uuid::Uuid::new_v4().to_string(),
      "brand_id": "scholay",
      "target_url": "https://example.com/post",
      "platform": "web",
      "kind": "direct",
      "angle": "",
      "text": "manual comment"
    }))
    .unwrap();
    let record = manual_history_record(request, &test_marine_identity(), 123).unwrap();
    assert_eq!(record.status, "manual_confirmed");
    assert_eq!(record.confirmation_source, "manual");
    assert!(record.page_title.is_empty());
    assert_eq!(record.posted_at, 123);
  }

  #[test]
  fn published_history_uses_platform_receipt_fields() {
    let record = published_history_record(
      test_published_history_request(),
      &test_marine_identity(),
      1_800_000_000,
    )
    .unwrap();
    assert_eq!(record.event_id.as_deref(), Some("bilibili:9001"));
    assert_eq!(record.platform_comment_id.as_deref(), Some("9001"));
    assert_eq!(
      record.text_snapshot,
      " The final text returned by Bilibili\n"
    );
    assert_eq!(record.kind, "direct");
    assert_eq!(record.status, "published");
    assert_eq!(record.confirmation_source, "bilibili-api");
    assert_eq!(record.posted_at, 1_700_000_000);
  }

  #[test]
  fn published_reply_uses_the_bilibili_parent_as_its_target() {
    let mut request = test_published_history_request();
    request.kind = "reply".into();
    request.root_id = Some("12".into());
    request.parent_id = Some("34".into());
    request.target_comment_id = Some("34".into());
    let record = published_history_record(request, &test_marine_identity(), 1_800_000_000).unwrap();
    assert_eq!(record.kind, "reply");
    assert_eq!(record.target_comment_id.as_deref(), Some("34"));
  }

  #[test]
  fn published_history_rejects_non_bilibili_pages_and_mismatched_hierarchy() {
    let identity = test_marine_identity();
    let mut wrong_page = test_published_history_request();
    wrong_page.target_url = "https://example.com/video/BV1test".into();
    assert!(published_history_record(wrong_page, &identity, 1_800_000_000).is_err());

    let mut wrong_kind = test_published_history_request();
    wrong_kind.target_comment_id = Some("12".into());
    assert!(published_history_record(wrong_kind, &identity, 1_800_000_000).is_err());
  }

  fn rime_test_context(context_id: &str) -> RimeContext {
    RimeContext {
      context_id: context_id.into(),
      mode: RimeContextMode::Direct,
      action_id: crate::marine::rime::DIRECT_ACTION_ID.into(),
      label: "Marine · 直评".into(),
      target_summary: "视频直评".into(),
      platform: "bilibili".into(),
      url: "https://www.bilibili.com/video/BV1".into(),
      title: "Example".into(),
      target: None,
      skill: "be useful".into(),
      payload: serde_json::json!({"article": {"markdown": "video"}}),
      updated_at: rime_now_secs(),
    }
  }

  fn rime_test_router(store: RimeContextStore) -> Router {
    Router::new()
      .route("/status", get(marine_get_rime_status))
      .route(
        "/context",
        axum::routing::put(marine_put_rime_context).delete(marine_delete_rime_context),
      )
      .route("/invoke", axum::routing::post(marine_invoke_rime_action))
      .layer(Extension(store))
  }

  async fn unaccepted_terms_test_middleware(
    request: axum::extract::Request,
    next: Next,
  ) -> Result<Response, StatusCode> {
    terms_check_middleware_with_acceptance(request, next, false).await
  }

  // Removing `browser` from UpdateProfileRequest, and rejecting invalid
  // `browser` values on create, must NOT make the API reject requests that
  // carry extra/unknown fields — old clients still send them. serde ignores
  // unknown fields by default; these tests lock that in so a future
  // `#[serde(deny_unknown_fields)]` can't silently break compatibility.
  #[test]
  fn update_profile_request_ignores_unknown_fields() {
    // `browser` is no longer a field, plus a wholly unknown field. Both must
    // be accepted and ignored, not rejected.
    let json = r#"{"name": "p", "browser": "wayfern", "totally_unknown": 123}"#;
    let parsed: UpdateProfileRequest =
      serde_json::from_str(json).expect("unknown fields must be ignored, not rejected");
    assert_eq!(parsed.name.as_deref(), Some("p"));
  }

  #[test]
  fn create_profile_request_ignores_unknown_fields() {
    let json = r#"{"name": "p", "browser": "wayfern", "version": "latest", "future_field": true}"#;
    let parsed: CreateProfileRequest =
      serde_json::from_str(json).expect("unknown fields must be ignored, not rejected");
    assert_eq!(parsed.browser, "wayfern");
  }

  #[test]
  fn create_profile_request_allows_omitting_version_and_configs() {
    // Minimal body: no version, no wayfern_config/camoufox_config. Must
    // deserialize (version resolves to latest-downloaded at the handler; an
    // absent config triggers fresh-fingerprint generation).
    let json = r#"{"name": "p", "browser": "wayfern"}"#;
    let parsed: CreateProfileRequest =
      serde_json::from_str(json).expect("version and configs are optional");
    assert_eq!(parsed.browser, "wayfern");
    assert!(parsed.version.is_none());
    assert!(parsed.wayfern_config.is_none());
    assert!(parsed.camoufox_config.is_none());
  }

  #[test]
  fn create_profile_browser_validation_matches_supported_engines() {
    // The handler rejects anything that isn't a launchable engine; this is the
    // same predicate it uses, kept in lockstep with MCP's create_profile.
    let is_valid = |b: &str| b == "wayfern" || b == "camoufox";
    assert!(is_valid("wayfern"));
    assert!(is_valid("camoufox"));
    assert!(!is_valid("chromium"));
    assert!(!is_valid("firefox"));
    assert!(!is_valid(""));
  }

  #[test]
  fn rime_runtime_capability_is_scoped_to_consumer_routes() {
    assert!(is_rime_consumer_path("/v1/marine/rime/status"));
    assert!(is_rime_consumer_path("/v1/marine/rime/prepare"));
    assert!(is_rime_consumer_path("/v1/marine/rime/invoke"));
    assert!(is_rime_consumer_path("/v1/marine/rime/invoke-stream"));
    assert!(!is_rime_consumer_path("/v1/marine/rime/context"));
    assert!(!is_rime_consumer_path("/v1/profiles"));
    assert!(constant_time_token_matches("capability", "capability"));
    assert!(!constant_time_token_matches("capability", "capabilitx"));
    assert!(!constant_time_token_matches("short", "longer"));
  }

  #[test]
  fn rime_prepare_route_and_response_are_documented() {
    let api = ApiDoc::openapi();
    assert!(api.paths.paths.contains_key("/v1/marine/rime/prepare"));
    assert!(api
      .components
      .as_ref()
      .unwrap()
      .schemas
      .contains_key("RimePrepareResponse"));
  }

  #[test]
  fn rime_prepare_echoes_identity_and_builds_only_a_blocks_v1_prompt() {
    let store = RimeContextStore::default();
    let context = rime_test_context("ctx-prepare");
    let now = rime_now_secs();
    store
      .set(context.clone(), now)
      .expect("test context should be accepted");
    let request = RimePrepareRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-test".into(),
      invoke: RimeInvokeRequest {
        request_id: "request-test".into(),
        action_id: context.action_id.clone(),
        context_id: context.context_id.clone(),
      },
    };

    let response = prepare_rime_response(&store, "runtime-test", request).unwrap();
    assert_eq!(response.protocol_version, 1);
    assert_eq!(response.result_format, "blocks-v1");
    assert_eq!(response.plugin_id, RIME_PLUGIN_ID);
    assert_eq!(response.runtime_instance_id, "runtime-test");
    assert_eq!(response.request_id, "request-test");
    assert_eq!(response.action_id, context.action_id);
    assert_eq!(response.context_id, context.context_id);
    assert_eq!(response.target_summary, context.target_summary);
    assert!(response.prompt.contains("blocks 必须恰好包含 1 项"));
    assert!(response.prompt.contains("video"));
    assert!(!response.prompt.contains("replies 必须"));

    let json = serde_json::to_value(response).unwrap();
    assert_eq!(json["protocolVersion"], 1);
    assert_eq!(json["resultFormat"], "blocks-v1");
    assert_eq!(json["pluginId"], RIME_PLUGIN_ID);
    assert_eq!(json["runtimeInstanceId"], "runtime-test");
  }

  #[test]
  fn rime_prepare_rejects_a_mismatched_runtime_before_building() {
    let store = RimeContextStore::default();
    let context = rime_test_context("ctx-wrong-runtime");
    let now = rime_now_secs();
    store.set(context.clone(), now).unwrap();
    let request = RimePrepareRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-other".into(),
      invoke: RimeInvokeRequest {
        request_id: "request-wrong-runtime".into(),
        action_id: context.action_id,
        context_id: context.context_id,
      },
    };

    let error = prepare_rime_response(&store, "runtime-test", request).unwrap_err();
    assert_eq!(error.0, StatusCode::BAD_REQUEST);
  }

  #[test]
  fn rime_prepare_rejects_fixed_prompt_content_above_the_connector_limit() {
    let store = RimeContextStore::default();
    let mut context = rime_test_context("ctx-oversized-prompt");
    context.skill = "S".repeat(crate::marine::generate::prompt::MAX_BLOCKS_V1_PROMPT_BYTES + 1);
    store.set(context.clone(), rime_now_secs()).unwrap();
    let request = RimePrepareRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-test".into(),
      invoke: RimeInvokeRequest {
        request_id: "request-oversized-prompt".into(),
        action_id: context.action_id,
        context_id: context.context_id,
      },
    };

    let error = prepare_rime_response(&store, "runtime-test", request).unwrap_err();
    assert_eq!(error.0, StatusCode::PAYLOAD_TOO_LARGE);
    let body: serde_json::Value = serde_json::from_str(&error.1).unwrap();
    assert_eq!(body["code"], "MARINE_RIME_PROMPT_TOO_LARGE");
  }

  #[tokio::test]
  async fn legacy_rime_generation_routes_are_gone() {
    let app = Router::new()
      .route("/invoke", axum::routing::post(marine_invoke_rime_action))
      .route(
        "/invoke-stream",
        axum::routing::post(marine_invoke_rime_action_stream),
      );
    let identity = serde_json::json!({
      "requestId": "request-gone",
      "actionId": crate::marine::rime::DIRECT_ACTION_ID,
      "contextId": "context-gone"
    });
    let stream_identity = serde_json::json!({
      "pluginId": RIME_PLUGIN_ID,
      "runtimeInstanceId": "runtime-gone",
      "requestId": "request-gone",
      "actionId": crate::marine::rime::DIRECT_ACTION_ID,
      "contextId": "context-gone"
    });

    for (path, body) in [("/invoke", identity), ("/invoke-stream", stream_identity)] {
      let response = app
        .clone()
        .oneshot(
          Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
        )
        .await
        .unwrap();
      assert_eq!(response.status(), StatusCode::GONE, "{path}");
      let bytes = response.into_body().collect().await.unwrap().to_bytes();
      let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
      assert_eq!(body["code"], "MARINE_AI_MOVED_TO_RIME");
    }
  }

  #[tokio::test]
  async fn legacy_marine_ai_routes_are_gone() {
    let app = Router::new()
      .route("/generate", axum::routing::post(marine_generate_api))
      .route(
        "/provider-config",
        get(marine_get_provider_config).put(marine_set_provider_config),
      )
      .route("/agents", get(marine_get_agents));

    for (method, path, body) in [
      (
        "POST",
        "/generate",
        serde_json::json!({"skill": "legacy", "payload": {}}),
      ),
      ("GET", "/provider-config", serde_json::Value::Null),
      ("PUT", "/provider-config", serde_json::json!({})),
      ("GET", "/agents", serde_json::Value::Null),
    ] {
      let mut request = Request::builder().method(method).uri(path);
      let body = if body.is_null() {
        Body::empty()
      } else {
        request = request.header(header::CONTENT_TYPE, "application/json");
        Body::from(serde_json::to_vec(&body).unwrap())
      };
      let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
      assert_eq!(response.status(), StatusCode::GONE, "{method} {path}");
      let bytes = response.into_body().collect().await.unwrap().to_bytes();
      let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
      assert_eq!(body["code"], "MARINE_AI_MOVED_TO_RIME");
    }
  }

  #[test]
  fn rime_prepare_lease_renewal_ignores_only_updated_at() {
    let captured = rime_test_context("ctx-renewal");
    let mut renewed = captured.clone();
    renewed.updated_at = renewed.updated_at.saturating_add(1);

    assert!(rime_context_same_lease(&renewed, &captured));
    assert!(rime_context_same_lease(&captured, &renewed));
  }

  #[test]
  fn rime_prepare_lease_rejects_every_semantic_context_change() {
    type ContextMutation = (&'static str, fn(&mut RimeContext));

    let captured = rime_test_context("ctx-captured");
    let changes: &[ContextMutation] = &[
      ("contextId", |context| context.context_id.push_str("-other")),
      ("mode", |context| context.mode = RimeContextMode::Reply),
      ("actionId", |context| context.action_id.push_str("-other")),
      ("label", |context| context.label.push_str(" other")),
      ("targetSummary", |context| {
        context.target_summary.push_str(" other")
      }),
      ("platform", |context| context.platform.push_str("-other")),
      ("url", |context| context.url.push_str("?other=1")),
      ("title", |context| context.title.push_str(" other")),
      ("target", |context| {
        context.target = Some(RimeTarget {
          id: "target-other".into(),
          author_name: "Other".into(),
          text: "Other comment".into(),
          parent_id: String::new(),
          root_id: String::new(),
        })
      }),
      ("skill", |context| context.skill.push_str(" other")),
      ("payload", |context| {
        context.payload = serde_json::json!({"article": {"markdown": "other"}})
      }),
    ];

    for (field, mutate) in changes {
      let mut changed = captured.clone();
      mutate(&mut changed);
      assert!(
        !rime_context_same_lease(&changed, &captured),
        "changing {field} must invalidate the prepare lease"
      );
    }
  }

  #[test]
  fn rime_prepare_context_match_survives_store_renewal() {
    let store = RimeContextStore::default();
    let captured = rime_test_context("ctx-renewed-in-store");
    let request = RimeInvokeRequest {
      request_id: "request-renewal".into(),
      action_id: captured.action_id.clone(),
      context_id: captured.context_id.clone(),
    };
    store
      .set(captured.clone(), rime_now_secs())
      .expect("initial context should be accepted");

    let mut renewed = captured.clone();
    renewed.updated_at = renewed.updated_at.saturating_add(1);
    store
      .set(renewed, rime_now_secs())
      .expect("fresh renewal should be accepted");

    let current = store
      .context_for_invoke(&request, rime_now_secs())
      .expect("renewed lease should still resolve");
    assert!(rime_context_same_lease(&current, &captured));
  }

  #[tokio::test]
  async fn rime_routes_bypass_only_the_wayfern_terms_gate() {
    async fn ok() -> StatusCode {
      StatusCode::OK
    }

    let app = Router::new()
      .route("/v1/marine/rime/status", get(ok))
      .route("/v1/marine/rime/context", axum::routing::put(ok).delete(ok))
      .route("/v1/marine/rime/prepare", axum::routing::post(ok))
      .route("/v1/marine/rime/invoke", axum::routing::post(ok))
      .route("/v1/marine/rime/invoke-stream", axum::routing::post(ok))
      .route("/v1/profiles", get(ok))
      .layer(middleware::from_fn(unaccepted_terms_test_middleware));

    for (method, path) in [
      ("GET", "/v1/marine/rime/status"),
      ("PUT", "/v1/marine/rime/context"),
      ("DELETE", "/v1/marine/rime/context"),
      ("POST", "/v1/marine/rime/prepare"),
      ("POST", "/v1/marine/rime/invoke"),
      ("POST", "/v1/marine/rime/invoke-stream"),
    ] {
      let request = Request::builder()
        .method(method)
        .uri(path)
        .body(Body::empty())
        .unwrap();
      assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK,
        "{method} {path} should not require Wayfern terms"
      );
    }

    let protected = Request::builder()
      .uri("/v1/profiles")
      .body(Body::empty())
      .unwrap();
    assert_eq!(
      app.oneshot(protected).await.unwrap().status(),
      StatusCode::FORBIDDEN
    );
  }

  #[tokio::test]
  async fn rime_context_routes_preserve_new_target_when_old_target_clears() {
    let store = RimeContextStore::default();
    let app = rime_test_router(store);
    let now = rime_now_secs();

    for (context_id, updated_at) in [("ctx-old", now - 2), ("ctx-new", now)] {
      let mut context = rime_test_context(context_id);
      context.updated_at = updated_at;
      let request = Request::builder()
        .method("PUT")
        .uri("/context")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&context).unwrap()))
        .unwrap();
      assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
      );
    }

    // The older profile's in-flight PUT may complete after the new target is
    // already active. Its client timestamp makes the leases comparable, so it
    // must not replace the newer target.
    let mut delayed_old = rime_test_context("ctx-old");
    delayed_old.updated_at = now - 2;
    let delayed_put = Request::builder()
      .method("PUT")
      .uri("/context")
      .header(header::CONTENT_TYPE, "application/json")
      .body(Body::from(serde_json::to_vec(&delayed_old).unwrap()))
      .unwrap();
    assert_eq!(
      app.clone().oneshot(delayed_put).await.unwrap().status(),
      StatusCode::CONFLICT
    );

    let clear_old = Request::builder()
      .method("DELETE")
      .uri("/context?contextId=ctx-old")
      .body(Body::empty())
      .unwrap();
    assert_eq!(
      app.clone().oneshot(clear_old).await.unwrap().status(),
      StatusCode::NO_CONTENT
    );

    let response = app
      .oneshot(
        Request::builder()
          .uri("/status")
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let status: RimeStatus = serde_json::from_slice(&bytes).unwrap();
    assert!(status.available);
    assert_eq!(status.context_id.as_deref(), Some("ctx-new"));
    assert_eq!(status.action_id, crate::marine::rime::DIRECT_ACTION_ID);
  }

  #[tokio::test]
  async fn rime_deleting_active_context_does_not_fall_back() {
    let store = RimeContextStore::default();
    let app = rime_test_router(store);
    let now = rime_now_secs();

    for (context_id, updated_at) in [("ctx-profile-a", now - 2), ("ctx-profile-b", now)] {
      let mut context = rime_test_context(context_id);
      context.updated_at = updated_at;
      let put = Request::builder()
        .method("PUT")
        .uri("/context")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&context).unwrap()))
        .unwrap();
      assert_eq!(
        app.clone().oneshot(put).await.unwrap().status(),
        StatusCode::OK
      );
    }

    let delete_active = Request::builder()
      .method("DELETE")
      .uri("/context?contextId=ctx-profile-b")
      .body(Body::empty())
      .unwrap();
    assert_eq!(
      app.clone().oneshot(delete_active).await.unwrap().status(),
      StatusCode::NO_CONTENT
    );

    let response = app
      .oneshot(
        Request::builder()
          .uri("/status")
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let status: RimeStatus = serde_json::from_slice(&bytes).unwrap();
    assert!(!status.available);
    assert!(status.context_id.is_none());
  }

  #[tokio::test]
  async fn rime_delete_arriving_before_put_revokes_only_that_lease() {
    let store = RimeContextStore::default();
    let app = rime_test_router(store);

    let clear = Request::builder()
      .method("DELETE")
      .uri("/context?contextId=ctx-in-flight")
      .body(Body::empty())
      .unwrap();
    assert_eq!(
      app.clone().oneshot(clear).await.unwrap().status(),
      StatusCode::NO_CONTENT
    );

    let delayed_put = Request::builder()
      .method("PUT")
      .uri("/context")
      .header(header::CONTENT_TYPE, "application/json")
      .body(Body::from(
        serde_json::to_vec(&rime_test_context("ctx-in-flight")).unwrap(),
      ))
      .unwrap();
    assert_eq!(
      app.clone().oneshot(delayed_put).await.unwrap().status(),
      StatusCode::CONFLICT
    );

    let current_put = Request::builder()
      .method("PUT")
      .uri("/context")
      .header(header::CONTENT_TYPE, "application/json")
      .body(Body::from(
        serde_json::to_vec(&rime_test_context("ctx-current")).unwrap(),
      ))
      .unwrap();
    assert_eq!(
      app.clone().oneshot(current_put).await.unwrap().status(),
      StatusCode::OK
    );

    let response = app
      .oneshot(
        Request::builder()
          .uri("/status")
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let status: RimeStatus = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status.context_id.as_deref(), Some("ctx-current"));
  }

  #[test]
  fn rime_prepare_rejects_a_context_mismatch() {
    let store = RimeContextStore::default();
    store
      .set(rime_test_context("ctx-current"), rime_now_secs())
      .unwrap();
    let request = RimePrepareRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-test".into(),
      invoke: RimeInvokeRequest {
        request_id: "req-1".into(),
        action_id: crate::marine::rime::DIRECT_ACTION_ID.into(),
        context_id: "ctx-stale".into(),
      },
    };
    let error = prepare_rime_response(&store, "runtime-test", request).unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
  }

  #[test]
  fn rime_prepare_rejects_action_for_a_different_captured_mode() {
    let store = RimeContextStore::default();
    store
      .set(rime_test_context("ctx-current"), rime_now_secs())
      .unwrap();
    let request = RimePrepareRequest {
      plugin_id: RIME_PLUGIN_ID.into(),
      runtime_instance_id: "runtime-test".into(),
      invoke: RimeInvokeRequest {
        request_id: "req-cross-mode".into(),
        action_id: crate::marine::rime::REPLY_ACTION_ID.into(),
        context_id: "ctx-current".into(),
      },
    };
    let error = prepare_rime_response(&store, "runtime-test", request).unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
  }
}
