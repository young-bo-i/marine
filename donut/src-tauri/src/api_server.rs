use crate::browser::ProxySettings;
use crate::camoufox_manager::CamoufoxConfig;
use crate::events;
use crate::group_manager::GROUP_MANAGER;
use crate::profile::manager::ProfileManager;
use crate::proxy_manager::PROXY_MANAGER;
use crate::tag_manager::TAG_MANAGER;
use axum::{
  body::Body,
  extract::{Extension, Path, Query, State},
  http::{header, HeaderMap, HeaderValue, StatusCode},
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

use crate::marine::generate::cli::{detect_agents, AgentStatus};
use crate::marine::generate::{generate_blocks, generate_blocks_stream, BlocksV1, GeneratedBlock};
use crate::marine::history::{HistoryError, PostingRecord, HISTORY_MANAGER};
use crate::marine::rime::{
  now_secs as rime_now_secs, RimeContext, RimeContextError, RimeContextMode, RimeContextStore,
  RimeInvokeRequest, RimePrepareRequest, RimePrepareResponse, RimeStatus, RimeTarget,
  RIME_PLUGIN_ID,
};
use crate::settings_manager::SettingsManager;
use tokio_util::sync::CancellationToken;

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
    marine_generate_stream,
    marine_get_provider_config,
    marine_set_provider_config,
    marine_get_identities,
    marine_get_history,
    marine_append_history,
    marine_search_slot,
    marine_login_status,
    marine_prospect_ready,
    marine_ingest_prospects,
    marine_claim_prospect,
    marine_prepare_prospect_send,
    marine_settle_prospect,
    marine_list_prospects,
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
    AgentStatus,
    BlocksV1,
    GeneratedBlock,
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
  /// Who generated the comment: `extension` / `rime` / `manual`. Optional.
  #[serde(default)]
  generation_source: Option<String>,
}

fn default_marine_brand_id() -> String {
  "scholay".to_string()
}

/// Bound a generation-source tag to the known set so the ledger never stores an
/// arbitrary string. Unknown/absent → `None`.
fn normalized_generation_source(value: Option<String>) -> Option<String> {
  value.and_then(|raw| match raw.trim() {
    "extension" => Some("extension".to_string()),
    "rime" => Some("rime".to_string()),
    "manual" => Some("manual".to_string()),
    _ => None,
  })
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
  /// Who generated the comment: `extension` / `rime` / `manual` (bounded to that
  /// set server-side). The in-browser extension sets `extension` when the post's
  /// text matches a draft it filled via the in-page 生成 button.
  #[serde(default)]
  generation_source: Option<String>,
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

/// Platforms whose published receipts we can verify.
///
/// Gate, not a formality: a receipt only means "the comment is live" because a
/// platform-specific builder checked that platform's success criteria
/// (`publish-receipt.js`). Accepting a platform with no builder would let a
/// "posted" row into the history with nothing behind it.
const RECEIPT_PLATFORMS: [&str; 4] = ["bilibili", "zhihu", "xiaohongshu", "douyin"];

fn receipt_platform_host_ok(host: &str, platform: &str) -> bool {
  let host = host.to_ascii_lowercase();
  let root = match platform {
    "bilibili" => "bilibili.com",
    "zhihu" => "zhihu.com",
    "xiaohongshu" => "xiaohongshu.com",
    "douyin" => "douyin.com",
    _ => return false,
  };
  host == root || host.ends_with(&format!(".{root}"))
}

/// `platform` = `Some(p)` pins the URL to that platform's own domain; `None`
/// only checks that it is a usable http(s) URL.
///
/// Pinning matters on the receipt path: the receipt asserts "this comment is
/// live at this URL", so a receipt claiming `platform: zhihu` with a Bilibili
/// URL is incoherent and must not become a history row.
fn validated_http_url(value: &str, platform: Option<&str>) -> Result<String, String> {
  let value = bounded_required(value, "target_url", HISTORY_MAX_URL_CHARS)?;
  let parsed = url::Url::parse(&value).map_err(|_| "target_url is not a valid URL".to_string())?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return Err("target_url must use http or https".to_string());
  }
  if parsed.host_str().is_none() {
    return Err("target_url must include a host".to_string());
  }
  if let Some(platform) = platform {
    let host = parsed.host_str().unwrap_or_default();
    if !receipt_platform_host_ok(host, platform) {
      return Err(format!("target_url must be a {platform} page"));
    }
  }
  Ok(value)
}

/// A platform's own comment id.
///
/// Bilibili and Zhihu hand out positive integers (`rpid` / `id`); **Xiaohongshu
/// hands out 24-char hex strings** (measured: `6a5b0f18000000001c00fb2c`).
/// Parsing as `u64` therefore rejected every Xiaohongshu receipt — and did so at
/// the very last hop, where the symptom is indistinguishable from "no receipt
/// arrived at all".
///
/// Both shapes are accepted, neither loosely: this id is the only evidence that
/// the comment actually went live, so anything ambiguous is refused.
fn normalized_platform_id(value: Option<String>, field: &str) -> Result<Option<String>, String> {
  let Some(value) = bounded_optional(value, field, HISTORY_MAX_ID_CHARS)? else {
    return Ok(None);
  };
  if let Ok(number) = value.parse::<u64>() {
    if number == 0 {
      return Ok(None);
    }
    return Ok(Some(number.to_string()));
  }
  let hex = value.trim();
  if hex.len() >= 16 && hex.len() <= 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
    return Ok(Some(hex.to_string()));
  }
  Err(format!(
    "{field} must be a positive integer or a hex platform id"
  ))
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
  // Parse up front so a malformed id is still a 400 rather than a 404.
  uuid::Uuid::parse_str(profile_id).map_err(|_| history_invalid("profile_id must be a UUID"))?;
  // Read one profile, not all of them: this runs on every /v1/marine/history*
  // request and each metadata.json is tens of KB.
  ProfileManager::instance()
    .get_profile_by_id(profile_id)
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
    target_url: validated_http_url(&request.target_url, None)?,
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
    generation_source: normalized_generation_source(request.generation_source),
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
  // Was hardcoded to bilibili. Every hop of this chain had the same hardcode and
  // each one silently dropped Zhihu receipts — the comment was live, the ledger
  // said `posted`, and only the history was missing, with nothing to say which
  // hop ate it.
  let platform = request.platform.trim().to_ascii_lowercase();
  if !RECEIPT_PLATFORMS.contains(&platform.as_str()) {
    return Err(format!(
      "platform must be one of {}",
      RECEIPT_PLATFORMS.join(", ")
    ));
  }
  let platform_comment_id =
    normalized_platform_id(Some(request.platform_comment_id), "platform_comment_id")?
      .ok_or_else(|| "platform_comment_id must be a positive integer".to_string())?;
  let canonical_event_id = format!("{platform}:{platform_comment_id}");
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
    target_url: validated_http_url(&request.target_url, Some(platform.as_str()))?,
    page_title: bounded_optional(
      Some(request.page_title),
      "page_title",
      HISTORY_MAX_TITLE_CHARS,
    )?
    .unwrap_or_default(),
    platform: platform.clone(),
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
    generation_source: normalized_generation_source(request.generation_source),
    // `<platform>-api` — the receipt came from that platform's own publish
    // response, not from a human confirming in the UI.
    confirmation_source: format!("{platform}-api"),
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

/// Map a generation error's `{code}` JSON to an HTTP status. The JSON body still
/// carries the actionable code for the frontend to translate.
fn marine_generation_status(error: &str) -> StatusCode {
  let code = serde_json::from_str::<serde_json::Value>(error)
    .ok()
    .and_then(|value| {
      value
        .get("code")
        .and_then(|code| code.as_str())
        .map(str::to_string)
    })
    .unwrap_or_default();
  match code.as_str() {
    "MARINE_RIME_PROMPT_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
    "MARINE_OPENAI_NOT_CONFIGURED" | "MARINE_OPENAI_KEY_MISSING" | "MARINE_PROVIDER_INVALID" => {
      StatusCode::BAD_REQUEST
    }
    "MARINE_GENERATE_TIMEOUT" => StatusCode::GATEWAY_TIMEOUT,
    _ => StatusCode::BAD_GATEWAY,
  }
}

fn marine_settings_error(error: impl std::fmt::Display) -> (StatusCode, String) {
  (
    StatusCode::INTERNAL_SERVER_ERROR,
    crate::marine::err_with("MARINE_SETTINGS_FAILED", error.to_string()),
  )
}

/// One-shot generation. Runs the user-selected local connector (Codex / Claude
/// CLI, or OpenAI-compatible) on the pre-built skill + grab payload and returns a
/// single `blocks-v1` block. This endpoint never posts by itself; submission
/// policy belongs to its caller (the discovery extension may auto-submit only
/// after its target, draft, idempotency, and receipt guards pass).
#[utoipa::path(
  post, path = "/v1/marine/generate", request_body = MarineGenerateRequest,
  responses(
    (status = 200, body = BlocksV1),
    (status = 400, description = "Provider not configured / invalid request"),
    (status = 413, description = "Prompt exceeds the connector limit"),
    (status = 502, description = "Local agent failed to produce a valid result"),
    (status = 504, description = "Generation timed out")
  ),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_generate_api(
  Json(request): Json<MarineGenerateRequest>,
) -> Result<Json<BlocksV1>, (StatusCode, String)> {
  generate_blocks(&request.skill, &request.payload)
    .await
    .map(Json)
    .map_err(|error| (marine_generation_status(&error), error))
}

/// Streaming generation for the in-page button. The extension has already PUT the
/// focused comment target as a Rime context; this resolves that lease, assembles
/// the same server-authoritative `blocks-v1` prompt the `prepare` path builds,
/// runs the local connector, and streams NDJSON frames:
///   {"type":"delta","text": "<raw model chunk>"}   (incremental preview)
///   {"type":"done","blocks":[{ "text", "title" }]} (final, authoritative)
///   {"type":"error","code":"…"}                    (failure)
/// The response is only draft text; this endpoint never submits to a website.
#[utoipa::path(
  post, path = "/v1/marine/generate-stream", request_body = RimeInvokeRequest,
  responses(
    (status = 200, description = "NDJSON stream of delta/done/error frames", content_type = "application/x-ndjson"),
    (status = 400, description = "Invalid or stale context"),
    (status = 404, description = "No active comment target"),
    (status = 409, description = "Comment target changed or expired")
  ),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_generate_stream(
  Extension(store): Extension<RimeContextStore>,
  Json(request): Json<RimeInvokeRequest>,
) -> Result<Response, (StatusCode, String)> {
  let context = store
    .context_for_invoke(&request, rime_now_secs())
    .map_err(rime_context_error)?;
  let payload = context.prompt_payload();
  let skill = context.skill.clone();

  let (frames_tx, frames_rx) = mpsc::channel::<String>(32);
  let cancellation = CancellationToken::new();
  tokio::spawn(run_marine_generation_stream(
    payload,
    skill,
    frames_tx,
    cancellation.clone(),
  ));

  let body_stream = futures_util::stream::unfold(
    MarineStreamState {
      receiver: frames_rx,
      cancellation,
    },
    |mut state| async move {
      state
        .receiver
        .recv()
        .await
        .map(|line| (Ok::<String, std::convert::Infallible>(line), state))
    },
  );

  let mut response = Response::new(Body::from_stream(body_stream));
  response.headers_mut().insert(
    header::CONTENT_TYPE,
    HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
  );
  response
    .headers_mut()
    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
  response.headers_mut().insert(
    header::X_CONTENT_TYPE_OPTIONS,
    HeaderValue::from_static("nosniff"),
  );
  Ok(response)
}

struct MarineStreamState {
  receiver: mpsc::Receiver<String>,
  cancellation: CancellationToken,
}

impl Drop for MarineStreamState {
  fn drop(&mut self) {
    // Client hung up (or the stream body was dropped) → cancel the provider so we
    // never leave a codex/claude subprocess running past the request.
    self.cancellation.cancel();
  }
}

fn marine_stream_frame(value: serde_json::Value) -> String {
  let mut line = value.to_string();
  line.push('\n');
  line
}

/// Turn a provider error's `{code, params?}` JSON into an `{type:"error", …}`
/// frame, defaulting to a generic failure if the string isn't the expected shape.
fn marine_stream_error_frame(error: &str) -> serde_json::Value {
  match serde_json::from_str::<serde_json::Value>(error) {
    Ok(mut value) if value.is_object() => {
      if let Some(object) = value.as_object_mut() {
        object.insert("type".to_string(), serde_json::json!("error"));
      }
      value
    }
    _ => serde_json::json!({ "type": "error", "code": "MARINE_GENERATE_FAILED" }),
  }
}

async fn run_marine_generation_stream(
  payload: serde_json::Value,
  skill: String,
  frames: mpsc::Sender<String>,
  cancellation: CancellationToken,
) {
  let (provider_tx, mut provider_rx) = mpsc::channel::<String>(32);
  let provider_cancellation = cancellation.child_token();
  let generation = tokio::spawn(async move {
    generate_blocks_stream(&skill, &payload, provider_tx, provider_cancellation).await
  });

  loop {
    tokio::select! {
      _ = cancellation.cancelled() => {
        // The child token is already cancelled. DETACH (drop) the JoinHandle
        // instead of abort()ing it: an aborted task is dropped mid-await and
        // never runs terminate_and_reap (killpg over the whole process group),
        // orphaning the codex/claude grandchild. A detached task keeps running,
        // observes the cancelled token, and reaps the group gracefully.
        return;
      }
      delta = provider_rx.recv() => match delta {
        Some(text) => {
          let frame = marine_stream_frame(serde_json::json!({ "type": "delta", "text": text }));
          if frames.send(frame).await.is_err() {
            // Client hung up: cancel the child token and detach so the provider
            // reaps its process group instead of being abort()ed mid-await.
            cancellation.cancel();
            return;
          }
        }
        None => break,
      },
    }
  }

  let final_frame = match generation.await {
    Ok(Ok(output)) => serde_json::json!({ "type": "done", "blocks": output.blocks }),
    Ok(Err(error)) => marine_stream_error_frame(&error),
    Err(_) => serde_json::json!({ "type": "error", "code": "MARINE_GENERATE_FAILED" }),
  };
  let _ = frames.send(marine_stream_frame(final_frame)).await;
}

/// Read the current local-connector selection (provider + model + optional
/// OpenAI-compatible endpoint). The OpenAI API key is never returned.
#[utoipa::path(
  get, path = "/v1/marine/provider-config",
  responses((status = 200, body = MarineProviderConfig)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_provider_config() -> Result<Json<MarineProviderConfig>, (StatusCode, String)> {
  let settings = SettingsManager::instance()
    .load_settings()
    .map_err(marine_settings_error)?;
  Ok(Json(MarineProviderConfig {
    provider: settings.marine_provider,
    cli_model: settings.marine_cli_model,
    openai_base_url: settings.marine_openai_base_url,
    openai_model: settings.marine_openai_model,
  }))
}

/// Persist the local-connector selection. `provider: null` restores auto-detect.
#[utoipa::path(
  put, path = "/v1/marine/provider-config", request_body = MarineProviderConfig,
  responses((status = 200, body = MarineProviderConfig), (status = 400, description = "Unknown provider")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_set_provider_config(
  Json(config): Json<MarineProviderConfig>,
) -> Result<Json<MarineProviderConfig>, (StatusCode, String)> {
  if let Some(provider) = config.provider.as_deref() {
    if !matches!(provider, "codex" | "claude" | "openai") {
      return Err((
        StatusCode::BAD_REQUEST,
        crate::marine::err_with(
          "MARINE_PROVIDER_INVALID",
          "provider must be one of codex, claude, openai",
        ),
      ));
    }
  }
  let manager = SettingsManager::instance();
  let mut settings = manager.load_settings().map_err(marine_settings_error)?;
  settings.marine_provider = config.provider.clone();
  settings.marine_cli_model = config.cli_model.clone();
  settings.marine_openai_base_url = config.openai_base_url.clone();
  settings.marine_openai_model = config.openai_model.clone();
  manager
    .save_settings(&settings)
    .map_err(marine_settings_error)?;
  Ok(Json(config))
}

/// Auto-detect local agents (codex / claude) with connection status, so the
/// settings UI can show "connect your agent" cards.
#[utoipa::path(
  get, path = "/v1/marine/agents",
  responses((status = 200, description = "Local agent connection status", body = [AgentStatus])),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_agents() -> Json<Vec<AgentStatus>> {
  Json(detect_agents())
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
  // The ledger read is blocking file I/O behind a global mutex; running it
  // inline parks a tokio worker and serializes every other request behind it.
  let records = spawn_history_blocking(move || {
    HISTORY_MANAGER
      .lock()
      .map_err(|_| history_storage_error("history manager lock poisoned"))?
      .list_for_profile(&identity.id)
      .map_err(history_manager_error)
  })
  .await?;
  Ok(Json(records))
}

/// Run a blocking history operation off the async runtime's worker threads.
/// Every history path ends in an `fsync`, which must never block a tokio worker.
async fn spawn_history_blocking<T, F>(task: F) -> Result<T, (StatusCode, String)>
where
  F: FnOnce() -> Result<T, (StatusCode, String)> + Send + 'static,
  T: Send + 'static,
{
  match tokio::task::spawn_blocking(task).await {
    Ok(result) => result,
    Err(e) => Err(history_storage_error(format!("history task failed: {e}"))),
  }
}

// ---------------------------------------------------------------- prospects
//
// The prospect ledger is the ONLY thing that makes multi-account discovery
// safe: search filters spread candidates out but never guarantee disjointness,
// so dedup has to be authoritative and central. The extension runs per-profile
// and therefore cannot own it — these endpoints are how it reaches the shared
// ledger.

#[derive(Debug, Deserialize, ToSchema)]
struct MarineSearchSlotRequest {
  platform: String,
  keyword: String,
  /// This account's position among the accounts working this platform (0-based).
  /// Wraps when there are more accounts than sorts. Omit to get every slot,
  /// which is how the UI previews how N accounts would be spread out.
  #[serde(default)]
  account_index: Option<usize>,
}

#[utoipa::path(
  post, path = "/v1/marine/search-slot", request_body = MarineSearchSlotRequest,
  responses((status = 200, description = "Slot for this account, or every slot when account_index is omitted. Empty for an unsupported platform.",
             body = Vec<crate::marine::search_slot::SearchSlot>)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_search_slot(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineSearchSlotRequest>,
) -> Json<Vec<crate::marine::search_slot::SearchSlot>> {
  Json(match req.account_index {
    Some(i) => crate::marine::search_slot::slot_for(&req.platform, &req.keyword, i)
      .into_iter()
      .collect(),
    None => crate::marine::search_slot::all_slots(&req.platform, &req.keyword),
  })
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarineLoginCheckRequest {
  profile_id: String,
  platform: String,
  /// What the extension's in-page check concluded, if it has run. Optional so
  /// the endpoint is still useful before the page has been probed — the reply
  /// then carries `logged_in: null` with `awaiting_page_check`.
  ///
  /// This is not a convenience: the authoritative call CANNOT be made from
  /// here. Xiaohongshu and Douyin sign their "who am I" requests in page JS, so
  /// a Rust-side call is rejected in a way that looks exactly like a logout.
  #[serde(default)]
  page_result: Option<crate::marine::login::LoginStatus>,
}

#[utoipa::path(
  post, path = "/v1/marine/login-status", request_body = MarineLoginCheckRequest,
  responses((status = 200, description = "Login status", body = crate::marine::login::LoginStatus)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_login_status(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineLoginCheckRequest>,
) -> Result<Json<crate::marine::login::LoginStatus>, (StatusCode, String)> {
  let profile = crate::marine::cdp::resolve_running_profile(&req.profile_id)
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
  let port = crate::marine::cdp::get_cdp_port_for_profile(&profile)
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
  let ws = crate::marine::cdp::get_cdp_ws_url(port)
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
  let cookie_stage = crate::marine::login::cookie_probe(&req.platform, &ws)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
  let merged = crate::marine::login::merge(cookie_stage, req.page_result);

  // 顺手落盘，让「哪个账号在哪个平台掉登录了」能在 profile 列表上直接看到。
  //
  // 落盘失败只记日志：这是**观测数据**，为它让调用方失败会把编排的登录检查一起
  // 拖垮 —— 那条链路的正事是决定要不要往下跑，不是记账。
  if let Err(e) = crate::marine::login_status::LOGIN_STATUS.record(
    &req.profile_id,
    crate::marine::login_status::RecordedLogin {
      status: merged.clone(),
      checked_at: crate::proxy_manager::now_secs(),
    },
  ) {
    log::warn!("Could not record Marine login status: {e}");
  }

  Ok(Json(merged))
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarineProspectIngestRequest {
  candidates: Vec<crate::marine::prospect::Candidate>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarineProspectClaimRequest {
  profile_id: String,
  platform: String,
  /// How many distinct accounts may post under one item. Defaults to 1.
  #[serde(default)]
  per_item_account_cap: Option<usize>,
  /// Max age of a stored session-scoped `open_url` (Xiaohongshu). Defaults to 30 min.
  #[serde(default)]
  session_url_max_age_secs: Option<u64>,
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarineProspectSettleRequest {
  key: String,
  profile_id: String,
  /// `posted`, `unconfirmed`, `skipped`, `filled`, `failed`, or `blocked`.
  state: String,
}

#[derive(Debug, Deserialize, ToSchema)]
struct MarineProspectPrepareSendRequest {
  key: String,
  profile_id: String,
}

fn prospect_error(e: crate::marine::prospect::ProspectError) -> (StatusCode, String) {
  use crate::marine::prospect::ProspectError as E;
  match e {
    E::UnsupportedPlatform(_) | E::MissingItemId => (StatusCode::BAD_REQUEST, e.to_string()),
    E::NotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
    E::ClaimOwnerMismatch { .. } => (StatusCode::CONFLICT, e.to_string()),
    _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
  }
}

/// Authenticated, read-only readiness probe for the discovery extension.
///
/// A content script being injected does not prove that its MV3 service worker
/// can read the stamped runtime config or reach the local API.  The extension
/// calls this through a fixed service-worker message before advertising
/// automation readiness to the scheduler.  Keeping the route body-free makes
/// the probe incapable of claiming or mutating prospect records.
#[utoipa::path(
  get, path = "/v1/marine/prospects/ready",
  responses((status = 204, description = "Discovery bridge is authenticated and ready")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_prospect_ready(State(_state): State<ApiServerState>) -> StatusCode {
  StatusCode::NO_CONTENT
}

#[utoipa::path(
  post, path = "/v1/marine/prospects/ingest", request_body = MarineProspectIngestRequest,
  responses((status = 200, description = "Ingested", body = crate::marine::prospect::IngestReport)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_ingest_prospects(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineProspectIngestRequest>,
) -> Result<Json<crate::marine::prospect::IngestReport>, (StatusCode, String)> {
  let report =
    tokio::task::spawn_blocking(move || crate::marine::prospect::PROSPECTS.ingest(&req.candidates))
      .await
      .map_err(|e| {
        (
          StatusCode::INTERNAL_SERVER_ERROR,
          format!("ingest task failed: {e}"),
        )
      })?
      .map_err(prospect_error)?;
  Ok(Json(report))
}

#[utoipa::path(
  post, path = "/v1/marine/prospects/claim", request_body = MarineProspectClaimRequest,
  responses((status = 200, description = "Claimed record, or null when nothing is eligible",
             body = Option<crate::marine::prospect::ProspectRecord>)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_claim_prospect(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineProspectClaimRequest>,
) -> Result<Json<Option<crate::marine::prospect::ProspectRecord>>, (StatusCode, String)> {
  use crate::marine::prospect::{ClaimOptions, PROSPECTS};

  // Another device holds this profile's lease — do not hand it a target.
  //
  // The ledger's account-level gate can only see the touches that reached this
  // machine's disk. Sync is asynchronous, so while a second device is driving
  // this profile there is a window where its touches have not arrived and the
  // gate is blind: both machines would happily claim, and both would post. That
  // is the one failure the ledger exists to prevent, and no merge rule can undo
  // a comment that is already public.
  //
  // Refusing here turns that into a visible skipped leg. `is_locked_by_another`
  // is an in-memory read of the lease table, so this costs nothing per claim.
  if crate::team_lock::PROFILE_LOCK
    .is_locked_by_another(&req.profile_id)
    .await
  {
    return Err((
      StatusCode::CONFLICT,
      serde_json::json!({ "code": "MARINE_PROFILE_LEASED_ELSEWHERE" }).to_string(),
    ));
  }

  let mut opts = ClaimOptions::default();
  if let Some(v) = req.per_item_account_cap {
    opts.per_item_account_cap = v;
  }
  if let Some(v) = req.session_url_max_age_secs {
    opts.session_url_max_age_secs = v;
  }
  let claimed = tokio::task::spawn_blocking(move || {
    PROSPECTS.claim_next(&req.profile_id, &req.platform, &opts)
  })
  .await
  .map_err(|e| {
    (
      StatusCode::INTERNAL_SERVER_ERROR,
      format!("claim task failed: {e}"),
    )
  })?
  .map_err(prospect_error)?;

  // `null` rather than an error: "nothing left for you" is a normal outcome the
  // caller branches on, not a failure. (A 204 would be tidier HTTP, but this
  // module's `StatusCode` is reqwest's, so a JSON null keeps the handler honest
  // without dragging axum's response types through the whole file.)
  Ok(Json(claimed))
}

/// Persist the owner-checked, non-expiring send lease before any public click.
///
/// A browser may publish successfully and then lose its settlement response.
/// Once this transition commits, claim TTL must not hand the same item to a
/// second profile while the durable extension outbox is still reconciling it.
#[utoipa::path(
  post, path = "/v1/marine/prospects/prepare-send",
  request_body = MarineProspectPrepareSendRequest,
  responses((status = 204, description = "Irreversible send lease persisted")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_prepare_prospect_send(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineProspectPrepareSendRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  tokio::task::spawn_blocking(move || {
    crate::marine::prospect::PROSPECTS.prepare_send(&req.key, &req.profile_id)
  })
  .await
  .map_err(|e| {
    (
      StatusCode::INTERNAL_SERVER_ERROR,
      format!("prepare-send task failed: {e}"),
    )
  })?
  .map_err(prospect_error)?;
  Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
  post, path = "/v1/marine/prospects/settle", request_body = MarineProspectSettleRequest,
  responses((status = 200, description = "Settled")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_settle_prospect(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineProspectSettleRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  use crate::marine::prospect::{ProspectState, PROSPECTS};
  let state = match req.state.as_str() {
    "posted" => ProspectState::Posted,
    // The publish button was clicked but the platform never produced an
    // authoritative receipt.  It consumes the public-footprint cap because a
    // delayed/hidden success is safer than allowing a second account to post.
    "unconfirmed" => ProspectState::Unconfirmed,
    "skipped" => ProspectState::Skipped,
    // Terminal state of the current debug phase: draft written into the comment
    // box, send deliberately not clicked.
    "filled" => ProspectState::Filled,
    // Recorded, never retried — a failed attempt is data.
    "failed" => ProspectState::Failed,
    // Commenting is off on this item. Unlike every other state this withholds
    // it from ALL accounts, which is why it is a property of the content and
    // not of the caller.
    "blocked" => ProspectState::Blocked,
    // `seen` / `claimed` are rejected: letting a caller push an item back to
    // "not touched yet" would erase the dedup evidence the ledger exists for.
    other => {
      return Err((
        StatusCode::BAD_REQUEST,
        format!("state must be posted|unconfirmed|skipped|filled|failed|blocked, got {other}"),
      ))
    }
  };
  tokio::task::spawn_blocking(move || PROSPECTS.settle(&req.key, &req.profile_id, state))
    .await
    .map_err(|e| {
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("settle task failed: {e}"),
      )
    })?
    .map_err(prospect_error)?;
  Ok(StatusCode::OK)
}

#[utoipa::path(
  get, path = "/v1/marine/prospects",
  responses((status = 200, description = "All prospects", body = Vec<crate::marine::prospect::ProspectRecord>)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_list_prospects(
  State(_state): State<ApiServerState>,
) -> Result<Json<Vec<crate::marine::prospect::ProspectRecord>>, (StatusCode, String)> {
  let all = tokio::task::spawn_blocking(|| crate::marine::prospect::PROSPECTS.list_local())
    .await
    .map_err(|e| {
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("list task failed: {e}"),
      )
    })?
    .map_err(prospect_error)?;
  Ok(Json(all))
}

// ---------------------------------------------------------------- 键盘代打
//
// 抖音的评论编辑器对页内合成输入有反制：`execCommand('insertText')` 写进去
// 一两个字之后，它把整个评论组件拆掉（实测 `[data-e2e=comment-list]` 消失，
// 而且点评论图标 6 次都恢复不了），手动点「生成」也一样。
//
// 而 CDP `Input.dispatchKeyEvent` 产生的是**浏览器层面的可信事件**，页面无法
// 与真人区分 —— 实测同一个编辑器上连打 8 个字，组件毫发无损。所以抖音的写入
// 必须从扩展移到这里。
//
// 这条路由比 `prospects/*` 危险得多（它能让调用方操作浏览器），所以约束要更紧：
//   · 只打字，不点击、不导航 —— 发送仍由扩展点站点自己的按钮
//   · 文本长度封顶，且不接受控制字符
//   · 目标只能是**该 profile 自己正在运行的浏览器**，profile_id 由调用方给出
//     但必须能解析成一个在跑的 profile（`resolve_running_profile` 把关）

#[derive(Debug, Deserialize, ToSchema)]
struct MarineTypeTextRequest {
  profile_id: String,
  /// 要敲进当前焦点元素的文本。
  text: String,
  /// 每分钟字数，控制拟人节奏。省略用默认值。
  #[serde(default)]
  wpm: Option<f64>,
  /// **只在 debug 构建里有效**的调试端口。
  ///
  /// 正式路径上 profile 由 app 启动，`resolve_running_profile` 能从
  /// `process_id` 认出它并查到 CDP 端口。调试用的浏览器是手动起的，app 不知道
  /// 它的存在 —— 那道闸挡的正是「页面指挥 app 去操作任意浏览器」，不能为调试
  /// 放宽。
  ///
  /// 所以留一个**编译期就消失**的口子：release 构建里这个分支根本不编译，
  /// 攻击面不变；debug 构建里调试环境能跑完整链路。
  #[serde(default)]
  debug_cdp_port: Option<u16>,
}

/// 单次代打的字数上限。一条评论远用不了这么多，超过说明调用方状态不对。
const MARINE_TYPE_MAX_CHARS: usize = 2000;

#[utoipa::path(
  post, path = "/v1/marine/type-text", request_body = MarineTypeTextRequest,
  responses((status = 200, description = "Typed")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_type_text(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineTypeTextRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  let text = req.text;
  if text.trim().is_empty() {
    return Err((StatusCode::BAD_REQUEST, "text must not be empty".into()));
  }
  if text.chars().count() > MARINE_TYPE_MAX_CHARS {
    return Err((StatusCode::BAD_REQUEST, "text is too long".into()));
  }
  // 控制字符会被当成按键（Tab 切焦点、Enter 提交），一律拒绝 —— 发送必须由
  // 扩展点站点自己的按钮，不能靠打一个回车绕过去。
  if text.chars().any(|c| c.is_control() && c != '\n') {
    return Err((
      StatusCode::BAD_REQUEST,
      "text must not contain control characters".into(),
    ));
  }

  let debug_port = if cfg!(debug_assertions) {
    req.debug_cdp_port
  } else {
    None
  };
  let port = match debug_port {
    Some(p) => p,
    None => {
      let profile = crate::marine::cdp::resolve_running_profile(&req.profile_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
      crate::marine::cdp::get_cdp_port_for_profile(&profile)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?
    }
  };
  let ws = crate::marine::cdp::get_cdp_ws_url(port)
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

  crate::marine::automation::send_human_keystrokes(&ws, &text, req.wpm)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
  Ok(StatusCode::OK)
}

// ---------------------------------------------------------------- debug log
//
// The extension's own log, made durable. Its live consumer (the side panel's
// debug tab) disappears with the window, and the discovery scheduler closes the
// window at the end of every leg — so without this, the only surviving evidence
// of a run is the ledger, which records outcomes and not reasons.

#[derive(Debug, Deserialize, ToSchema)]
struct MarineDebugLogRequest {
  entries: Vec<crate::marine::debug_log::LogEntry>,
}

#[utoipa::path(
  post, path = "/v1/marine/debug/logs", request_body = MarineDebugLogRequest,
  responses((status = 200, description = "Appended")),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_append_debug_logs(
  State(_state): State<ApiServerState>,
  Json(req): Json<MarineDebugLogRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
  let now = crate::proxy_manager::now_secs();
  let mut entries = req.entries;
  for e in &mut entries {
    // The extension's `t` carries no date, so a line from yesterday would be
    // indistinguishable from one a minute ago. Stamp on arrival.
    if e.at == 0 {
      e.at = now;
    }
  }
  tokio::task::spawn_blocking(move || crate::marine::debug_log::DEBUG_LOG.append(&entries))
    .await
    .map_err(|e| {
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("debug log task failed: {e}"),
      )
    })?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
  Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize, ToSchema, Default)]
struct MarineDebugLogQuery {
  /// Newest N entries. Defaults to 200.
  #[serde(default)]
  limit: Option<usize>,
}

#[utoipa::path(
  get, path = "/v1/marine/debug/logs",
  params(("limit" = Option<usize>, Query, description = "Newest N entries (default 200)")),
  responses((status = 200, description = "Newest entries, oldest first",
             body = Vec<crate::marine::debug_log::LogEntry>)),
  security(("bearer_auth" = [])), tag = "marine"
)]
async fn marine_get_debug_logs(
  State(_state): State<ApiServerState>,
  axum::extract::Query(q): axum::extract::Query<MarineDebugLogQuery>,
) -> Result<Json<Vec<crate::marine::debug_log::LogEntry>>, (StatusCode, String)> {
  let limit = q.limit.unwrap_or(200).clamp(1, 5000);
  let entries =
    tokio::task::spawn_blocking(move || crate::marine::debug_log::DEBUG_LOG.tail(limit))
      .await
      .map_err(|e| {
        (
          StatusCode::INTERNAL_SERVER_ERROR,
          format!("debug log task failed: {e}"),
        )
      })?
      .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
  Ok(Json(entries))
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
  // Appending fsyncs before it returns — the 200 means "durable", and the
  // extension's outbox depends on that. Keep the fsync, just move it off the
  // async worker threads.
  spawn_history_blocking(move || {
    HISTORY_MANAGER
      .lock()
      .map_err(|_| history_storage_error("history manager lock poisoned"))?
      .append(record)
      .map_err(history_manager_error)
  })
  .await?;
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
  // Same durability contract as the manual append: this 200 is the extension's
  // acknowledgement that the receipt is on disk (sw.js pauses its outbox on 5xx).
  let outcome = spawn_history_blocking(move || {
    HISTORY_MANAGER
      .lock()
      .map_err(|_| history_storage_error("history manager lock poisoned"))?
      .append(record)
      .map_err(history_manager_error)
  })
  .await?;
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

  fn readiness_snapshot(&self) -> (Option<u16>, bool) {
    let task_running = self
      .task_handle
      .as_ref()
      .is_some_and(|task| !task.is_finished());
    (self.port, task_running)
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

    // Try the preferred port first, then let the OS choose a genuinely free
    // one.  Picking a single pseudo-random u16 still races every other process
    // between selection and bind, and could overflow into a privileged port.
    let (listener, used_fallback) =
      match TcpListener::bind(format!("127.0.0.1:{preferred_port}")).await {
        Ok(listener) => (listener, false),
        Err(_) => (
          TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind to any port: {e}"))?,
          true,
        ),
      };

    let actual_port = listener
      .local_addr()
      .map_err(|e| format!("Failed to get local address: {e}"))?
      .port();
    if used_fallback {
      let _ = events::emit(
        "api-port-conflict",
        format!("API server using fallback port {actual_port}"),
      );
    }

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
      .routes(routes!(marine_generate_stream))
      .routes(routes!(
        marine_get_provider_config,
        marine_set_provider_config
      ))
      .routes(routes!(marine_get_identities))
      .routes(routes!(marine_get_history))
      .routes(routes!(marine_append_history))
      .routes(routes!(marine_search_slot))
      .routes(routes!(marine_login_status))
      .routes(routes!(marine_prospect_ready))
      .routes(routes!(marine_ingest_prospects))
      .routes(routes!(marine_claim_prospect))
      .routes(routes!(marine_prepare_prospect_send))
      .routes(routes!(marine_settle_prospect))
      .routes(routes!(marine_list_prospects))
      .routes(routes!(marine_append_debug_logs, marine_get_debug_logs))
      .routes(routes!(marine_type_text))
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
      .layer(middleware::from_fn_with_state(
        state.clone(),
        auth_middleware,
      ));

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
    // The in-browser extension is stamped with a capability derived from the
    // bearer (see `marine::extension_capability_token`). It unlocks the Marine
    // namespace it owns and nothing else, so a page that manages to drive the
    // extension still cannot launch profiles or read proxy/VPN credentials.
    if is_marine_namespace_path(&path)
      && constant_time_token_matches(
        token,
        &crate::marine::extension_capability_token(&stored_token),
      )
    {
      return Ok(next.run(request).await);
    }
    log::warn!("[api] Rejected {path}: token mismatch");
    return Err(StatusCode::UNAUTHORIZED);
  }

  // Token is valid, continue with the request
  Ok(next.run(request).await)
}

// Marine local-API endpoints have three distinct audiences — do not confuse
// "unused by the extension" with "dead":
//
//   • Extension-facing (FULL api token): PUT/DELETE /rime/context (publish the
//     focused comment target as a lease-arbitrated context) and POST
//     /generate-stream (run the local connector on that context). This is the
//     self-serve path that works with NO input method installed.
//   • Input-method-facing (EPHEMERAL rime consumer token): GET /rime/status +
//     POST /rime/prepare. The extension no longer calls these, but the Rime
//     Buffer IME still does (it reads the same shared RimeContextStore the
//     extension PUT into). Live second consumer — NOT dead code.
//   • Deprecated tombstones: POST /rime/invoke + /rime/invoke-stream return 410
//     (AI execution moved into the connectors). Kept as a semantic migration
//     signal for any in-the-wild connector still pinned to the old invokePath.
//
// `is_rime_consumer_path` = paths the ephemeral consumer token may reach (the
// IME surface). `is_rime_api_path` = rime paths exempt from the Wayfern-terms
// gate. The FULL api token passes on every path regardless of these sets.
/// Everything the in-browser extension legitimately drives — and nothing else.
/// Deliberately excludes `/v1/profiles`, `/v1/proxies`, `/v1/vpns`, `/v1/browsers`.
fn is_marine_namespace_path(path: &str) -> bool {
  path.starts_with("/v1/marine/")
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

async fn loopback_port_accepts(port: u16, timeout: std::time::Duration) -> bool {
  matches!(
    tokio::time::timeout(
      timeout,
      tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
    )
    .await,
    Ok(Ok(_))
  )
}

/// Wait until the startup task has bound the local API and report its *actual*
/// port.
///
/// Profile launch and API startup are intentionally independent async tasks.
/// A one-shot status read can therefore observe `None` just before startup
/// falls back from an occupied preferred port.  Stamping the preferred port in
/// that window leaves the extension disconnected for the entire browser
/// session.  This bounded wait closes the race without making a failed API
/// startup capable of hanging browser launch forever.
pub async fn wait_for_api_server_ready(timeout: std::time::Duration) -> Result<u16, String> {
  let deadline = tokio::time::Instant::now() + timeout;
  let mut last_observation = "startup has not published a port".to_string();
  loop {
    let now = tokio::time::Instant::now();
    if now >= deadline {
      return Err(format!(
        "local API did not become ready within {}s ({last_observation})",
        timeout.as_secs(),
      ));
    }
    let remaining = deadline.saturating_duration_since(now);
    let (port, task_running) = match tokio::time::timeout(remaining, API_SERVER.lock()).await {
      Ok(server) => server.readiness_snapshot(),
      Err(_) => {
        return Err(format!(
          "local API did not become ready within {}s (timed out reading server state)",
          timeout.as_secs(),
        ));
      }
    };

    match (port, task_running) {
      (Some(port), true) => {
        let connect_budget = deadline
          .saturating_duration_since(tokio::time::Instant::now())
          .min(std::time::Duration::from_millis(250));
        if !connect_budget.is_zero() && loopback_port_accepts(port, connect_budget).await {
          // The task can exit or a concurrent restart can replace the port while
          // connect is in flight. Re-check the bookkeeping after the socket is
          // proven reachable. Neither lock acquisition spans network I/O.
          let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
          if remaining.is_zero() {
            last_observation = format!("loopback port {port} accepted too late");
          } else {
            let confirmed = match tokio::time::timeout(remaining, API_SERVER.lock()).await {
              Ok(server) => server.readiness_snapshot() == (Some(port), true),
              Err(_) => false,
            };
            if confirmed {
              return Ok(port);
            }
            last_observation = format!("server state changed while verifying loopback port {port}");
          }
        } else {
          last_observation = format!("loopback port {port} is not accepting connections");
        }
      }
      (Some(port), false) => {
        last_observation = format!("server task for port {port} has exited");
      }
      (None, _) => {
        last_observation = "startup has not published a port".to_string();
      }
    }

    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if !remaining.is_zero() {
      tokio::time::sleep(remaining.min(std::time::Duration::from_millis(100))).await;
    }
  }
}

/// Serialize a browser config (camoufox/wayfern) to JSON for an API response.
/// Viewing a profile's fingerprint is available to every API caller; only
/// editing it (via `update_profile`) and launching/killing profiles
/// programmatically are always available.
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

      // No tag rebuild here: `update_profile_tags` saves the profile, and
      // `save_profile` rebuilds whenever the tag set actually moved.

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

    // No tag rebuild here — `update_profile_tags` -> `save_profile` already did it.
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

  #[tokio::test]
  async fn readiness_requires_a_live_task_and_reachable_loopback_port() {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
      .await
      .unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(loopback_port_accepts(port, std::time::Duration::from_secs(1)).await);

    let mut server = ApiServer::new();
    server.port = Some(port);
    server.task_handle = Some(tokio::spawn(std::future::pending::<()>()));
    assert_eq!(server.readiness_snapshot(), (Some(port), true));

    server.task_handle.as_ref().unwrap().abort();
    tokio::task::yield_now().await;
    assert_eq!(server.readiness_snapshot(), (Some(port), false));
  }

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
      generation_source: None,
      posted_at: Some(1_700_000_000),
    }
  }

  fn zhihu_published_request() -> MarinePublishedHistoryRequest {
    MarinePublishedHistoryRequest {
      event_id: Some("zhihu:11541356856".into()),
      target_url: "https://www.zhihu.com/question/1/answer/2".into(),
      platform: "zhihu".into(),
      platform_comment_id: "11541356856".into(),
      ..test_published_history_request()
    }
  }

  /// 这条链上「哪些平台算数」在五个地方各写了一遍（bridge 的 signalReady 与
  /// sanitize、SW 的 sanitize、这里的 platform 校验与 URL 校验）。只改其中几处
  /// 的后果极其隐蔽：评论确实上线了、台账记了 posted、页内回执也有，唯独发布
  /// 历史里没有，而且没有任何线索指向是哪一跳丢的。实测被这个形态坑了两轮。
  /// 小红书的评论 id 是 24 位十六进制，不是正整数。只认整数会让它的回执在
  /// **最后一跳**被拒 —— 症状和「压根没收到回执」完全一样，极难分辨。
  #[test]
  fn platform_ids_accept_both_integer_and_hex_shapes() {
    let identity = test_marine_identity();
    let xhs = MarinePublishedHistoryRequest {
      event_id: Some("xiaohongshu:6a5b0f18000000001c00fb2c".into()),
      target_url: "https://www.xiaohongshu.com/explore/6a5b0f18000000001c00fb2c".into(),
      platform: "xiaohongshu".into(),
      platform_comment_id: "6a5b0f18000000001c00fb2c".into(),
      ..test_published_history_request()
    };
    let record =
      published_history_record(xhs, &identity, 1_700_000_100).expect("十六进制 id 必须被接受");
    assert_eq!(
      record.platform_comment_id.as_deref(),
      Some("6a5b0f18000000001c00fb2c")
    );
    assert_eq!(record.platform, "xiaohongshu");

    // 整数形态照常
    assert!(
      published_history_record(test_published_history_request(), &identity, 1_700_000_100).is_ok()
    );
  }

  #[test]
  fn platform_ids_still_reject_garbage() {
    // 放宽到十六进制不等于什么都收：id 是「真的上线了」的唯一凭据。
    let identity = test_marine_identity();
    for bad in [
      "",
      "not-an-id",
      "zzzz",
      "6a5b",
      "6a5b0f18000000001c00fb2c00000000000",
    ] {
      let req = MarinePublishedHistoryRequest {
        event_id: Some(format!("xiaohongshu:{bad}")),
        target_url: "https://www.xiaohongshu.com/explore/abc".into(),
        platform: "xiaohongshu".into(),
        platform_comment_id: bad.into(),
        ..test_published_history_request()
      };
      assert!(
        published_history_record(req, &identity, 1_700_000_100).is_err(),
        "{bad:?} 不该被当成合法的平台评论 id"
      );
    }
  }

  #[test]
  fn published_receipts_accept_every_platform_that_has_a_builder() {
    let identity = test_marine_identity();
    for (platform, request) in [
      ("bilibili", test_published_history_request()),
      ("zhihu", zhihu_published_request()),
    ] {
      let record = published_history_record(request, &identity, 1_700_000_100)
        .unwrap_or_else(|e| panic!("{platform} 的回执应当被接受，实际报错：{e}"));
      assert_eq!(record.platform, platform, "platform 字段要按声明的原样带出");
      assert!(
        record.event_id.as_deref().unwrap().starts_with(platform),
        "event_id 前缀要和 platform 一致，否则两个字段自相矛盾"
      );
      assert_eq!(record.confirmation_source, format!("{platform}-api"));
      assert_eq!(record.status, "published");
    }
  }

  #[test]
  fn published_receipts_reject_platforms_without_a_builder() {
    // 没有回执构造器就没有「真的上线了」的凭据 —— 放进来会让历史里出现
    // 一条什么都没验证过的 published 记录。
    let identity = test_marine_identity();
    for platform in ["douyin", "xiaohongshu", "weibo"] {
      let request = MarinePublishedHistoryRequest {
        platform: platform.into(),
        event_id: Some(format!("{platform}:9001")),
        ..test_published_history_request()
      };
      assert!(
        published_history_record(request, &identity, 1_700_000_100).is_err(),
        "{platform} 还没有回执检测，不能接受它的 published 记录"
      );
    }
  }

  #[test]
  fn a_receipt_url_must_belong_to_the_platform_it_claims() {
    // 回执断言的是「这条评论上线在这个 URL」。platform=zhihu 配一个 B 站 URL
    // 是自相矛盾的，不能落成记录。
    let identity = test_marine_identity();
    let mismatched = MarinePublishedHistoryRequest {
      target_url: "https://www.bilibili.com/video/BV1test".into(),
      ..zhihu_published_request()
    };
    assert!(published_history_record(mismatched, &identity, 1_700_000_100).is_err());

    let swapped = MarinePublishedHistoryRequest {
      target_url: "https://www.zhihu.com/question/1/answer/2".into(),
      ..test_published_history_request()
    };
    assert!(published_history_record(swapped, &identity, 1_700_000_100).is_err());
  }

  #[test]
  fn zhihu_subdomains_are_accepted() {
    // 专栏文章在 zhuanlan.zhihu.com —— 实测的第一条知乎回执就来自那里。
    let identity = test_marine_identity();
    let article = MarinePublishedHistoryRequest {
      target_url: "https://zhuanlan.zhihu.com/p/1995521640679904623".into(),
      ..zhihu_published_request()
    };
    assert!(published_history_record(article, &identity, 1_700_000_100).is_ok());
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
  fn published_history_records_and_bounds_the_generation_source() {
    // Known source flows through.
    let mut request = test_published_history_request();
    request.generation_source = Some("extension".into());
    let record = published_history_record(request, &test_marine_identity(), 1_800_000_000).unwrap();
    assert_eq!(record.generation_source.as_deref(), Some("extension"));

    // Absent stays absent.
    let record = published_history_record(
      test_published_history_request(),
      &test_marine_identity(),
      1_800_000_000,
    )
    .unwrap();
    assert_eq!(record.generation_source, None);

    // Unknown/arbitrary values are dropped, never stored verbatim.
    let mut request = test_published_history_request();
    request.generation_source = Some("<script>".into());
    let record = published_history_record(request, &test_marine_identity(), 1_800_000_000).unwrap();
    assert_eq!(record.generation_source, None);
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

  /// The extension capability must unlock the Marine namespace and nothing else,
  /// and must not be reversible into the bearer it was derived from.
  #[test]
  fn extension_capability_is_scoped_and_one_way() {
    let bearer = "full-api-bearer-token-value";
    let capability = crate::marine::extension_capability_token(bearer);

    assert_ne!(capability, bearer);
    assert!(!capability.contains(bearer));
    assert!(!bearer.contains(&capability));
    // Deterministic (survives restarts) and bound to this exact bearer.
    assert_eq!(
      capability,
      crate::marine::extension_capability_token(bearer)
    );
    assert_ne!(
      capability,
      crate::marine::extension_capability_token("another-bearer")
    );

    for allowed in [
      "/v1/marine/rime/context",
      "/v1/marine/generate-stream",
      "/v1/marine/history/published",
      "/v1/marine/identities",
      "/v1/marine/agents",
      "/v1/marine/provider-config",
    ] {
      assert!(is_marine_namespace_path(allowed), "{allowed}");
    }
    for denied in [
      "/v1/profiles",
      "/v1/profiles/abc/run",
      "/v1/profiles/abc/kill",
      "/v1/proxies",
      "/v1/vpns/abc/export",
      "/v1/browsers/download",
      "/v1/groups",
      "/v1/marine",
    ] {
      assert!(!is_marine_namespace_path(denied), "{denied}");
    }
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
  fn prospect_readiness_probe_is_documented() {
    let api = ApiDoc::openapi();
    assert!(
      api.paths.paths.contains_key("/v1/marine/prospects/ready"),
      "the extension bridge probe must remain part of the authenticated API"
    );
    assert!(
      api
        .paths
        .paths
        .contains_key("/v1/marine/prospects/prepare-send"),
      "the pre-click send lease must remain part of the authenticated API"
    );
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

  // Backend AI execution is restored (extension-self-serve): /agents now reports
  // local connector status instead of 410. /rime/invoke{,-stream} stay 410 — the
  // in-page button uses /v1/marine/generate-stream, not the old Rime push path.
  #[tokio::test]
  async fn marine_agents_route_is_live() {
    let app = Router::new().route("/agents", get(marine_get_agents));
    let response = app
      .oneshot(
        Request::builder()
          .method("GET")
          .uri("/agents")
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body.is_array(), "agents should return a JSON array");
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
