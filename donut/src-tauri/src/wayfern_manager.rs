use crate::browser_runner::BrowserRunner;
use crate::profile::BrowserProfile;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WayfernConfig {
  #[serde(default)]
  pub fingerprint: Option<String>,
  #[serde(default)]
  pub randomize_fingerprint_on_launch: Option<bool>,
  #[serde(default)]
  pub os: Option<String>,
  #[serde(default)]
  pub screen_max_width: Option<u32>,
  #[serde(default)]
  pub screen_max_height: Option<u32>,
  #[serde(default)]
  pub screen_min_width: Option<u32>,
  #[serde(default)]
  pub screen_min_height: Option<u32>,
  #[serde(default)]
  pub geoip: Option<serde_json::Value>, // For compatibility with shared config form
  #[serde(default)]
  pub block_images: Option<bool>, // For compatibility with shared config form
  #[serde(default)]
  pub block_webrtc: Option<bool>,
  #[serde(default)]
  pub block_webgl: Option<bool>,
  #[serde(default, skip_serializing)]
  pub proxy: Option<String>,
  /// Stable signature of the proxy/VPN/geoip the fingerprint's location data
  /// (timezone, latitude/longitude, language) was last computed for. Compared
  /// on launch to detect that the routing changed since creation, so the
  /// location can be refreshed instead of showing stale data.
  #[serde(default)]
  pub geo_proxy_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct WayfernLaunchResult {
  pub id: String,
  #[serde(alias = "process_id")]
  pub processId: Option<u32>,
  #[serde(alias = "profile_path")]
  pub profilePath: Option<String>,
  pub url: Option<String>,
  pub cdp_port: Option<u16>,
  /// The fingerprint Wayfern actually applied, echoed back by
  /// Wayfern.setFingerprint. It may be UPGRADED from the stored fingerprint
  /// (e.g. when the stored one targets an older browser version). Internal
  /// only — the caller persists it to the profile; never sent to the frontend.
  #[serde(default, skip_serializing)]
  pub used_fingerprint: Option<String>,
}

/// Monotonic per-LAUNCH generation. A teardown decided against generation N
/// aborts if the registered generation has moved, which is exactly "the profile
/// was relaunched while I was working". This matters because the force-kill
/// matches by PROFILE PATH, not PID, so a late teardown would otherwise kill
/// the freshly launched browser.
static LAUNCH_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct WayfernInstance {
  id: String,
  process_id: Option<u32>,
  profile_path: Option<String>,
  url: Option<String>,
  cdp_port: Option<u16>,
  /// Whether this instance was launched with an on-screen window.
  /// `Some(true)` = windowed (a Cmd+Q / last-window-close reaper may apply);
  /// `Some(false)` = headless (never reap on zero windows — a headless
  /// automation browser legitimately has zero page targets);
  /// `None` = unknown (e.g. a `recovered_<pid>` instance discovered by system
  /// scan after a GUI restart) — treated like headless for reaping (never reap).
  windowed: Option<bool>,
  /// `0` = a `recovered_*` entry adopted by system scan, which is explicitly
  /// NOT a launch we performed and must never invalidate a pending reap.
  launch_epoch: u64,
  /// Cancels the push-based CDP close watcher for THIS launch. Dropping the
  /// instance cancels it, so no watcher can outlive its launch or report on a
  /// stale instance. Only ever `Some` for `windowed: Some(true)`.
  ///
  /// Never read on purpose — it exists solely for its `Drop`. Storing it here
  /// rather than in a side registry is what makes every instance-removal site
  /// (the launch-time dedupe `retain`, `stop_wayfern`, the dead-pid sweep and
  /// the cleanup pass) cancel the watcher for free, with no extra bookkeeping
  /// to forget.
  #[allow(dead_code)]
  watcher: Option<crate::cdp_watcher::WatcherHandle>,
}

struct WayfernManagerInner {
  instances: HashMap<String, WayfernInstance>,
}

pub struct WayfernManager {
  inner: Arc<AsyncMutex<WayfernManagerInner>>,
  http_client: Client,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarineAutomationReadiness {
  Ready,
  Pending,
  Failed(String),
}

#[derive(Debug, Deserialize)]
struct CdpTarget {
  #[serde(rename = "type")]
  target_type: String,
  #[serde(rename = "webSocketDebuggerUrl")]
  websocket_debugger_url: Option<String>,
  // `/json` 一直带这两个键，但少一个字段整条反序列化就失败、页签列表直接变空 ——
  // 而空列表在调用方那里等于「浏览器没窗口了」。给默认值，不赌。
  #[serde(default)]
  id: String,
  #[serde(default)]
  url: String,
}

/// 一个标签页的最小身份。给编排用：它需要知道「驱动的是哪个页签」才能在换平台时
/// 导航同一个页签，而不是每换一次开一个新的。
#[derive(Debug, Clone)]
pub struct PageTarget {
  pub id: String,
  pub url: String,
  pub websocket_debugger_url: Option<String>,
}

impl WayfernManager {
  fn new() -> Self {
    Self {
      inner: Arc::new(AsyncMutex::new(WayfernManagerInner {
        instances: HashMap::new(),
      })),
      http_client: Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("Failed to build reqwest client for wayfern_manager"),
    }
  }

  pub fn instance() -> &'static WayfernManager {
    &WAYFERN_MANAGER
  }

  #[allow(dead_code)]
  pub fn get_profiles_dir(&self) -> PathBuf {
    crate::app_dirs::profiles_dir()
  }

  #[allow(dead_code)]
  fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  async fn find_free_port() -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
  }

  /// Normalize fingerprint data from Wayfern CDP format to our storage format.
  /// Wayfern returns fields like fonts, webglParameters as JSON strings which we keep as-is.
  fn normalize_fingerprint(fingerprint: serde_json::Value) -> serde_json::Value {
    // Our storage format matches what Wayfern returns:
    // - fonts, plugins, mimeTypes, voices are JSON strings
    // - webglParameters, webgl2Parameters, etc. are JSON strings
    // The form displays them as JSON text areas, so no conversion needed.
    fingerprint
  }

  /// Denormalize fingerprint data from our storage format to Wayfern CDP format.
  /// Wayfern expects certain fields as JSON strings.
  fn denormalize_fingerprint(fingerprint: serde_json::Value) -> serde_json::Value {
    // Our storage format matches what Wayfern expects:
    // - fonts, plugins, mimeTypes, voices are JSON strings
    // - webglParameters, webgl2Parameters, etc. are JSON strings
    // So no conversion is needed
    fingerprint
  }

  /// Derive the on-screen window size Chromium should open at, from the stored
  /// fingerprint. `Wayfern.setFingerprint` only spoofs what the page *reports*
  /// for `windowOuterWidth`/`screenWidth`/etc.; it does not move or resize the
  /// real top-level window. Without `--window-size` the OS window keeps
  /// Chromium's default, so the visible window contradicts the reported
  /// dimensions — a detectable mismatch. We pass `--window-size` so the actual
  /// window matches the fingerprint.
  ///
  /// Keys are the camelCase fields Wayfern uses in its fingerprint
  /// (`windowOuterWidth`, `screenAvailWidth`, …) — NOT the dotted
  /// Camoufox-style keys. Preference order, matching how the fingerprint
  /// describes the window:
  /// 1. `windowOuterWidth` / `windowOuterHeight` — the real window size.
  /// 2. `screenAvailWidth` / `screenAvailHeight` — usable screen area.
  /// 3. `screenWidth` / `screenHeight` — full screen.
  ///
  /// Returns `None` when the fingerprint carries no usable dimensions, leaving
  /// Chromium's default untouched. The fingerprint JSON may be the bare object
  /// or the legacy `{ "fingerprint": {...} }` wrapper.
  fn window_size_from_fingerprint(fingerprint_json: &str) -> Option<(u32, u32)> {
    let parsed: serde_json::Value = serde_json::from_str(fingerprint_json).ok()?;
    let fp = parsed.get("fingerprint").unwrap_or(&parsed);
    let obj = fp.as_object()?;

    // Accept both numeric and stringified numbers (Wayfern emits numbers, but a
    // CDP echo or older saved fingerprint may stringify them).
    let read = |key: &str| -> Option<u32> {
      let v = obj.get(key)?;
      v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|n| *n > 0)
        .map(|n| n as u32)
    };
    let pair = |w: &str, h: &str| -> Option<(u32, u32)> { Some((read(w)?, read(h)?)) };

    pair("windowOuterWidth", "windowOuterHeight")
      .or_else(|| pair("screenAvailWidth", "screenAvailHeight"))
      .or_else(|| pair("screenWidth", "screenHeight"))
  }

  fn parse_stored_fingerprint(fingerprint_json: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(fingerprint_json)
      .map_err(|e| format!("Failed to parse stored fingerprint JSON: {e}"))
  }

  async fn wait_for_cdp_ready(
    &self,
    port: u16,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    // On first launch, macOS Gatekeeper verifies the binary which can take 30+ seconds.
    // Use a real wall-clock deadline: a retry count does not bound the wait
    // when each HTTP attempt has its own timeout.
    let timeout = Duration::from_secs(60);
    let deadline = tokio::time::Instant::now() + timeout;
    let delay = Duration::from_millis(500);

    let mut last_error: Option<String> = None;
    let mut attempts = 0usize;
    loop {
      let now = tokio::time::Instant::now();
      if now >= deadline {
        break;
      }
      attempts += 1;
      let request_budget = deadline
        .saturating_duration_since(now)
        .min(Duration::from_secs(2));
      match tokio::time::timeout(request_budget, self.http_client.get(&url).send()).await {
        Ok(Ok(resp)) if resp.status().is_success() => {
          log::info!("CDP ready on port {port} after {attempts} attempts");
          return Ok(());
        }
        Ok(Ok(resp)) => {
          last_error = Some(format!("HTTP {} from {url}", resp.status()));
        }
        Ok(Err(e)) => {
          last_error = Some(format!("request failed: {e}"));
        }
        Err(_) => {
          last_error = Some(format!("request exceeded {request_budget:?}"));
        }
      }
      let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
      if remaining.is_zero() {
        break;
      }
      tokio::time::sleep(delay.min(remaining)).await;
    }

    let detail = last_error.unwrap_or_else(|| "no attempts completed".to_string());
    // Log at error level so we can diagnose Windows/AV/firewall-induced CDP hangs
    // in customer reports without needing them to reproduce in the moment.
    log::error!("CDP not ready after {timeout:?} ({attempts} attempts) on port {port}: {detail}");
    Err(format!("CDP not ready after {timeout:?} on port {port}: {detail}").into())
  }

  async fn get_cdp_targets(
    &self,
    port: u16,
  ) -> Result<Vec<CdpTarget>, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("http://127.0.0.1:{port}/json");
    let resp = self.http_client.get(&url).send().await?;
    let targets: Vec<CdpTarget> = resp.json().await?;
    Ok(targets)
  }

  /// 单条 CDP 命令的上限。
  ///
  /// **没有它就是永久挂死**：这个函数在 WebSocket 上等应答，一直等。编排的换平台
  /// 导航走的正是它，而 `Page.navigate` 实测会有不返回的时候（小红书那条腿）——
  /// 一旦不返回，腿的超时**永远不会触发**，因为超时判断在轮询循环里、在导航之后。
  /// 表现是整个调度器停在那里，日志一行都不再出，而浏览器停在 about:blank 转圈。
  const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

  async fn send_cdp_command(
    &self,
    ws_url: &str,
    method: &str,
    params: serde_json::Value,
  ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    match tokio::time::timeout(
      Self::CDP_COMMAND_TIMEOUT,
      self.send_cdp_command_inner(ws_url, method, params),
    )
    .await
    {
      Ok(r) => r,
      Err(_) => Err(format!("CDP command {method} timed out").into()),
    }
  }

  async fn send_cdp_command_inner(
    &self,
    ws_url: &str,
    method: &str,
    params: serde_json::Value,
  ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    let (mut ws_stream, _) = connect_async(ws_url).await?;

    let command = json!({
      "id": 1,
      "method": method,
      "params": params
    });

    use futures_util::sink::SinkExt;
    use futures_util::stream::StreamExt;

    ws_stream
      .send(Message::Text(command.to_string().into()))
      .await?;

    while let Some(msg) = ws_stream.next().await {
      match msg? {
        Message::Text(text) => {
          let response: serde_json::Value = serde_json::from_str(text.as_str())?;
          if response.get("id") == Some(&json!(1)) {
            if let Some(error) = response.get("error") {
              return Err(format!("CDP error: {}", error).into());
            }
            return Ok(response.get("result").cloned().unwrap_or(json!({})));
          }
        }
        Message::Close(_) => break,
        _ => {}
      }
    }

    Err("No response received from CDP".into())
  }

  /// Stable signature describing what determines this profile's geolocation
  /// (timezone, latitude/longitude, language): the geoip mode first, then the
  /// VPN, the proxy, or a direct connection. Compared across creation and
  /// launch to detect a change. The VPN case keys off `vpn_id` rather than the
  /// per-launch local port, and the proxy case off type/host/port/username so
  /// that editing the proxy is also caught.
  pub fn geo_signature(
    proxy: Option<&crate::browser::ProxySettings>,
    vpn_id: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> String {
    match geoip {
      Some(serde_json::Value::Bool(false)) => "off".to_string(),
      Some(serde_json::Value::String(ip)) if !ip.is_empty() => format!("ip:{ip}"),
      _ => {
        if let Some(id) = vpn_id {
          format!("vpn:{id}")
        } else if let Some(p) = proxy {
          format!(
            "proxy:{}://{}@{}:{}",
            p.proxy_type.to_lowercase(),
            p.username.as_deref().unwrap_or(""),
            p.host,
            p.port
          )
        } else {
          "direct".to_string()
        }
      }
    }
  }

  /// Apply timezone/geolocation fields to a fingerprint object from the proxy's
  /// exit IP (or a fixed geoip IP). Mutates `fingerprint` in place. Returns true
  /// if fresh geolocation was fetched and applied, false if geolocation is
  /// disabled or could not be resolved (in which case only safe defaults are
  /// filled in). Shared by fingerprint generation and the launch-time refresh
  /// so both produce identical location data.
  async fn apply_geolocation(
    fingerprint: &mut serde_json::Value,
    proxy: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> bool {
    // Default to auto-detect; only an explicit `false` disables geolocation.
    let should_geolocate = !matches!(geoip, Some(serde_json::Value::Bool(false)));
    if !should_geolocate {
      return false;
    }

    let geo_result = async {
      let ip = match geoip {
        Some(serde_json::Value::String(ip_str)) => ip_str.clone(),
        _ => crate::ip_utils::fetch_public_ip(proxy)
          .await
          .map_err(|e| format!("Failed to fetch public IP: {e}"))?,
      };
      crate::camoufox::geolocation::get_geolocation(&ip)
        .map_err(|e| format!("Failed to get geolocation for IP {ip}: {e}"))
    }
    .await;

    match geo_result {
      Ok(geo) => {
        if let Some(obj) = fingerprint.as_object_mut() {
          obj.insert("timezone".to_string(), json!(geo.timezone));
          // Calculate timezone offset from IANA timezone name
          if let Ok(tz) = geo.timezone.parse::<chrono_tz::Tz>() {
            use chrono::Offset;
            let now = chrono::Utc::now().with_timezone(&tz);
            let offset_seconds = now.offset().fix().local_minus_utc();
            let offset_minutes = -(offset_seconds / 60);
            obj.insert("timezoneOffset".to_string(), json!(offset_minutes));
          }
          obj.insert("latitude".to_string(), json!(geo.latitude));
          obj.insert("longitude".to_string(), json!(geo.longitude));
          let locale_str = geo.locale.as_string();
          obj.insert("language".to_string(), json!(&locale_str));
          obj.insert(
            "languages".to_string(),
            json!([&locale_str, &geo.locale.language]),
          );
        }
        log::info!(
          "Applied geolocation to Wayfern fingerprint: {} ({})",
          geo.locale.as_string(),
          geo.timezone
        );
        true
      }
      Err(e) => {
        log::warn!("Geolocation failed, using defaults: {e}");
        if let Some(obj) = fingerprint.as_object_mut() {
          if !obj.contains_key("timezone") {
            obj.insert("timezone".to_string(), json!("America/New_York"));
          }
          if !obj.contains_key("timezoneOffset") {
            obj.insert("timezoneOffset".to_string(), json!(300));
          }
        }
        false
      }
    }
  }

  /// Refresh ONLY the location fields (timezone, offset, latitude/longitude,
  /// language) of an already-generated fingerprint to match the current proxy,
  /// leaving every other fingerprint field untouched. `proxy` is the local
  /// proxy URL the browser will use. Returns the updated fingerprint JSON on
  /// success, or None if geolocation is disabled or could not be resolved, in
  /// which case the caller keeps the existing fingerprint and retries on the
  /// next launch.
  pub async fn refresh_fingerprint_geolocation(
    fingerprint_json: &str,
    proxy: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> Option<String> {
    let mut fp: serde_json::Value = serde_json::from_str(fingerprint_json).ok()?;
    if Self::apply_geolocation(&mut fp, proxy, geoip).await {
      serde_json::to_string(&fp).ok()
    } else {
      None
    }
  }

  pub async fn generate_fingerprint_config(
    &self,
    _app_handle: &AppHandle,
    profile: &BrowserProfile,
    config: &WayfernConfig,
  ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let executable_path = BrowserRunner::instance()
      .get_browser_executable_path(profile)
      .map_err(|e| format!("Failed to get Wayfern executable path: {e}"))?;

    let port = Self::find_free_port().await?;
    log::info!("Launching headless Wayfern on port {port} for fingerprint generation");

    let temp_profile_dir =
      std::env::temp_dir().join(format!("wayfern_fingerprint_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_profile_dir)?;

    let mut cmd = TokioCommand::new(&executable_path);
    cmd
      .arg("--headless=new")
      .arg(format!("--remote-debugging-port={port}"))
      .arg("--remote-debugging-address=127.0.0.1")
      .arg(format!("--user-data-dir={}", temp_profile_dir.display()))
      .arg("--disable-gpu")
      .arg("--no-first-run")
      .arg("--no-default-browser-check")
      .arg("--disable-background-mode")
      .arg("--use-mock-keychain")
      .arg("--password-store=basic")
      .arg("--disable-features=DialMediaRouteProvider");

    #[cfg(target_os = "linux")]
    cmd
      .arg("--no-sandbox")
      .arg("--disable-setuid-sandbox")
      .arg("--disable-dev-shm-usage");

    cmd.stdout(Stdio::null()).stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
      // OS error 14001 = SxS / missing Visual C++ Redistributable
      let hint = if e.raw_os_error() == Some(14001) {
        ". This usually means the Visual C++ Redistributable is not installed. \
         Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe"
      } else {
        ""
      };
      format!("Failed to spawn headless Wayfern: {e}{hint}")
    })?;
    let child_id = child.id();

    let cleanup = || async {
      if let Some(id) = child_id {
        #[cfg(unix)]
        {
          use nix::sys::signal::{kill, Signal};
          use nix::unistd::Pid;
          let _ = kill(Pid::from_raw(id as i32), Signal::SIGTERM);
        }
        #[cfg(windows)]
        {
          use std::os::windows::process::CommandExt;
          const CREATE_NO_WINDOW: u32 = 0x08000000;
          let _ = std::process::Command::new("taskkill")
            .args(["/PID", &id.to_string(), "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        }
      }
      let _ = std::fs::remove_dir_all(&temp_profile_dir);
    };

    if let Err(e) = self.wait_for_cdp_ready(port).await {
      // Try to capture stderr from the failed process for diagnostics
      let stderr_output = if let Some(id) = child_id {
        // Check if process is still running
        let is_running = sysinfo::System::new_with_specifics(
          sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
        )
        .process(sysinfo::Pid::from(id as usize))
        .is_some();

        if !is_running {
          // Process exited — try to read its stderr
          String::from("(process exited before CDP became ready)")
        } else {
          String::from("(process still running but not responding on CDP)")
        }
      } else {
        String::new()
      };

      log::error!(
        "Fingerprint-generation Wayfern (headless, pid={child_id:?}) never became CDP-ready: {e}. {stderr_output}"
      );
      cleanup().await;
      return Err(e);
    }

    let targets = match self.get_cdp_targets(port).await {
      Ok(t) => t,
      Err(e) => {
        cleanup().await;
        return Err(e);
      }
    };

    let page_target = targets
      .iter()
      .find(|t| t.target_type == "page" && t.websocket_debugger_url.is_some());

    let ws_url = match page_target {
      Some(target) => target.websocket_debugger_url.as_ref().unwrap().clone(),
      None => {
        cleanup().await;
        return Err("No page target found for CDP".into());
      }
    };

    let os = config
      .os
      .as_deref()
      .unwrap_or(if cfg!(target_os = "macos") {
        "macos"
      } else if cfg!(target_os = "linux") {
        "linux"
      } else {
        "windows"
      });

    // Include wayfern token if available (enables cross-OS fingerprinting for paid users)
    let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
    let mut refresh_params = json!({ "operatingSystem": os });
    if let Some(ref token) = wayfern_token {
      refresh_params
        .as_object_mut()
        .unwrap()
        .insert("wayfernToken".to_string(), json!(token));
    }

    let refresh_result = self
      .send_cdp_command(&ws_url, "Wayfern.refreshFingerprint", refresh_params)
      .await;

    if let Err(e) = refresh_result {
      cleanup().await;
      return Err(format!("Failed to refresh fingerprint: {e}").into());
    }

    let get_result = self
      .send_cdp_command(&ws_url, "Wayfern.getFingerprint", json!({}))
      .await;

    let fingerprint = match get_result {
      Ok(result) => {
        // Wayfern.getFingerprint returns { fingerprint: {...} }
        // We need to extract just the fingerprint object
        let fp = result.get("fingerprint").cloned().unwrap_or(result);
        // Normalize the fingerprint: convert JSON string fields to proper types
        let mut normalized = Self::normalize_fingerprint(fp);

        // Apply timezone/geolocation for the proxy this fingerprint is being
        // generated against. Shared with the launch-time location refresh.
        Self::apply_geolocation(
          &mut normalized,
          config.proxy.as_deref(),
          config.geoip.as_ref(),
        )
        .await;

        normalized
      }
      Err(e) => {
        cleanup().await;
        return Err(format!("Failed to get fingerprint: {e}").into());
      }
    };

    cleanup().await;

    let fingerprint_json = serde_json::to_string(&fingerprint)
      .map_err(|e| format!("Failed to serialize fingerprint: {e}"))?;

    log::info!(
      "Generated Wayfern fingerprint for OS: {}, fields: {:?}",
      os,
      fingerprint
        .as_object()
        .map(|o| o.keys().collect::<Vec<_>>())
    );

    // Keep sensitive location values out of customer log bundles. Presence is
    // enough to diagnose an incomplete fingerprint.
    if let Some(obj) = fingerprint.as_object() {
      log::debug!(
        "Generated fingerprint location metadata present: timezone={}, timezone_offset={}, coordinates={}, language={}",
        obj.contains_key("timezone"),
        obj.contains_key("timezoneOffset"),
        obj.contains_key("latitude") && obj.contains_key("longitude"),
        obj.contains_key("language"),
      );
    }

    Ok(fingerprint_json)
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn launch_wayfern(
    &self,
    _app_handle: &AppHandle,
    profile: &BrowserProfile,
    profile_path: &str,
    config: &WayfernConfig,
    url: Option<&str>,
    proxy_url: Option<&str>,
    ephemeral: bool,
    extension_paths: &[String],
    remote_debugging_port: Option<u16>,
    headless: bool,
    restore_last_session: bool,
  ) -> Result<WayfernLaunchResult, Box<dyn std::error::Error + Send + Sync>> {
    let executable_path = BrowserRunner::instance()
      .get_browser_executable_path(profile)
      .map_err(|e| format!("Failed to get Wayfern executable path: {e}"))?;

    let port = match remote_debugging_port {
      Some(p) => p,
      None => Self::find_free_port().await?,
    };
    log::info!("Launching Wayfern on CDP port {port} (detached)");

    // Diagnostic: verify critical profile files and test cookie decryption
    {
      let profile_path_buf = std::path::PathBuf::from(profile_path);
      let key_path = profile_path_buf.join("os_crypt_key");
      let cookies_path = {
        let network = profile_path_buf
          .join("Default")
          .join("Network")
          .join("Cookies");
        if network.exists() {
          network
        } else {
          profile_path_buf.join("Default").join("Cookies")
        }
      };

      if key_path.exists() {
        // Log the size only. This file's contents are the passphrase os_crypt
        // derives the profile's cookie-encryption key from, so writing it to
        // DonutBrowser.log would hand every cookie in the profile to anyone who
        // reads a log bundle (users routinely attach these to bug reports).
        let key_len = std::fs::metadata(&key_path).map(|m| m.len()).unwrap_or(0);
        log::info!("Pre-launch: os_crypt_key present ({key_len} bytes)");
      } else {
        log::warn!("Pre-launch: os_crypt_key NOT FOUND");
      }

      if cookies_path.exists() {
        // Try to open Cookies DB and check if encrypted cookies can be decrypted
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
          &cookies_path,
          rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
          let cookie_count: i64 = conn
            .query_row(
              "SELECT COUNT(*) FROM cookies WHERE length(encrypted_value) > 0",
              [],
              |r| r.get(0),
            )
            .unwrap_or(0);
          let total_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cookies", [], |r| r.get(0))
            .unwrap_or(0);
          log::info!(
            "Pre-launch: Cookies DB has {} total cookies, {} encrypted",
            total_count,
            cookie_count
          );

          // Try decrypting one cookie using the cookie_manager
          if let Some(encryption_key) = crate::cookie_manager::chrome_decrypt::get_encryption_key(
            &profile_path_buf,
            profile.resolved_os(),
          ) {
            if let Ok(mut stmt) = conn.prepare(
              "SELECT name, host_key, encrypted_value FROM cookies WHERE length(encrypted_value) > 0 LIMIT 1",
            ) {
              if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                  let name: String = row.get(0).unwrap_or_default();
                  let host: String = row.get(1).unwrap_or_default();
                  let encrypted: Vec<u8> = row.get(2).unwrap_or_default();
                  let decrypted = crate::cookie_manager::chrome_decrypt::decrypt(
                    &encrypted,
                    &host,
                    &encryption_key,
                  );
                  match decrypted {
                    Some(val) => log::info!(
                      "Pre-launch: Cookie decryption SUCCEEDED for '{}' (host: {}, decrypted {} bytes)",
                      name, host, val.len()
                    ),
                    None => log::error!(
                      "Pre-launch: Cookie decryption FAILED for '{}' (host: {}, encrypted {} bytes)",
                      name, host, encrypted.len()
                    ),
                  }
                }
              }
            }
          } else {
            log::error!("Pre-launch: Failed to derive encryption key from os_crypt_key");
          }
        }
      } else {
        log::warn!("Pre-launch: Cookies NOT FOUND");
      }
    }

    let mut args = vec![
      format!("--remote-debugging-port={port}"),
      "--remote-debugging-address=127.0.0.1".to_string(),
      format!("--user-data-dir={profile_path}"),
      "--no-first-run".to_string(),
      "--no-default-browser-check".to_string(),
      "--disable-background-mode".to_string(),
      "--disable-component-update".to_string(),
      // 这三个一起，才让编排能在窗口不在前台时跑完。评论自动化整条链路（流式
      // 生成、逐字打字、等待回执）都靠页内 setTimeout 推进，被节流就会撞上超时
      // 预算 —— 而超时会让台账记 failed，那条候选按「失败不重试」永久作废。
      "--disable-background-timer-throttling".to_string(),
      "--disable-backgrounding-occluded-windows".to_string(),
      "--disable-renderer-backgrounding".to_string(),
      "--crash-server-url=".to_string(),
      "--disable-updater".to_string(),
      "--disable-session-crashed-bubble".to_string(),
      "--hide-crash-restore-bubble".to_string(),
      "--disable-infobars".to_string(),
      // Prefetch* / NoStatePrefetch: cross-site Speculation-Rules prefetch uses
      // an isolated NetworkContext that defaults to DIRECT egress (real host IP
      // leaks past the per-profile proxy). Disabling via a LAUNCH FLAG cannot be
      // re-enabled by an imported/synced network_prediction_options pref (which a
      // compile-time pref default could be).
      "--disable-features=DialMediaRouteProvider,DnsOverHttps,AsyncDns,Prefetch,PrefetchProxy,SpeculationRulesPrefetchFuture,NoStatePrefetch".to_string(),
      "--use-mock-keychain".to_string(),
      "--password-store=basic".to_string(),
    ];

    if headless {
      args.push("--headless=new".to_string());
    } else {
      // Reopen the previous session's tabs on every windowed launch so the
      // user's open tabs persist across restarts on THIS device. Cross-device
      // tab sync is intentionally deferred (Chromium's `Sessions/` dir is
      // excluded from the file manifest), so this only restores locally.
      // Manual windowed launches restore; headless/MCP and discovery-owned
      // automation sessions start clean and never restore tabs.
      if restore_last_session {
        args.push("--restore-last-session".to_string());
      } else {
        // Supplying an explicit startup URL prevents a profile preference such
        // as "continue where you left off" from undoing the scheduler's clean
        // launch policy.  The real platform navigation happens over CDP only
        // after the target id is known.
        args.push("--new-window".to_string());
        args.push("about:blank".to_string());
      }

      if let Some((w, h)) = config
        .fingerprint
        .as_deref()
        .and_then(Self::window_size_from_fingerprint)
      {
        // Size the real OS window to match the fingerprint so the visible window
        // agrees with the reported windowOuterWidth/screen dimensions. Anchor at
        // 0,0 so the window also fits within the spoofed screen origin. Skipped in
        // headless mode, where there is no on-screen window.
        log::info!("Sizing Wayfern window to fingerprint dimensions: {w}x{h}");
        args.push(format!("--window-size={w},{h}"));
        args.push("--window-position=0,0".to_string());
      }
    }

    #[cfg(target_os = "linux")]
    {
      args.push("--no-sandbox".to_string());
      args.push("--disable-setuid-sandbox".to_string());
      args.push("--disable-dev-shm-usage".to_string());
    }

    if ephemeral {
      args.push("--disk-cache-size=1".to_string());
      args.push("--disable-breakpad".to_string());
      args.push("--disable-crash-reporter".to_string());
      args.push("--no-service-autorun".to_string());
      args.push("--disable-sync".to_string());
    }

    if !extension_paths.is_empty() {
      args.push(format!("--load-extension={}", extension_paths.join(",")));
    }

    let mut wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
    if wayfern_token.is_none() && crate::cloud_auth::CLOUD_AUTH.is_logged_in().await {
      // Brief wait for the background token fetch — when the API is healthy
      // the token usually lands in well under a second. If api.donutbrowser.com
      // is unreachable we don't want to gate the whole launch on it; the
      // browser still works without the token (cross-OS fingerprinting just
      // won't be enabled for this session, and the next launch will pick it
      // up once the token arrives).
      log::info!("Wayfern token not ready, waiting briefly...");
      for _ in 0..3 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
        if wayfern_token.is_some() {
          break;
        }
      }
      if wayfern_token.is_none() {
        log::warn!(
          "Wayfern token still unavailable after wait; launching without it (api.donutbrowser.com may be unreachable)"
        );
      }
    }
    if let Some(ref token) = wayfern_token {
      args.push(format!("--wayfern-token={token}"));
      log::info!("Wayfern token passed as CLI flag (length: {})", token.len());
    }

    if let Some(proxy) = proxy_url {
      // Map the local proxy scheme to the matching PAC directive. SOCKS5 lets
      // Chromium route UDP (QUIC/WebRTC) and resolve DNS through the proxy;
      // PROXY is HTTP CONNECT (TCP only). The host:port is the same either way.
      let (pac_directive, host_port) = if let Some(rest) = proxy.strip_prefix("socks5://") {
        ("SOCKS5", rest)
      } else {
        (
          "PROXY",
          proxy
            .trim_start_matches("http://")
            .trim_start_matches("https://"),
        )
      };
      let pac_data = format!(
        "data:application/x-ns-proxy-autoconfig,function FindProxyForURL(url,host){{return \"{pac_directive} {host_port}\";}}",
      );
      args.push(format!("--proxy-pac-url={pac_data}"));
      args.push("--dns-prefetch-disable".to_string());
    }

    // 直接 spawn，拿得到 PID。
    //
    // 曾经改走 `open -g`（macOS 上唯一能起在后台、不抢前台的办法），但它立刻返回、
    // 拿不到浏览器 PID，只能按 `--user-data-dir` 反查 —— 实测反查不上，于是按
    // 「启动失败」把刚起来的浏览器清理掉，整条腿白跑。而不抢前台这个目标本身已经
    // 放弃了：B 站的评论框在窗口没有系统焦点时根本不渲染输入框和发布按钮，编排
    // 必须把窗口带到前台（见 `bring_to_front`）。既然要前台，`open -g` 就只剩风险。
    let mut command = TokioCommand::new(&executable_path);
    command
      .args(&args)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());

    let child = command
      .spawn()
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        let hint = if e.raw_os_error() == Some(14001) {
          ". This usually means the Visual C++ Redistributable is not installed. \
           Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe"
        } else {
          ""
        };
        format!("Failed to spawn Wayfern: {e}{hint}").into()
      })?;
    let process_id = child.id();
    drop(child);

    // The browser is already running at this point but nothing has registered it
    // yet: `process_id` is not persisted and no instance entry exists. Bailing
    // out with `?` here used to leave a fully-provisioned Chromium running that
    // the UI reported as "failed to launch" — and because the fingerprint is
    // applied further down, that orphan browsed with its REAL fingerprint. A
    // later launch would then adopt it as a `recovered_*` instance. Kill it.
    let kill_orphan = |reason: &str| {
      if let Some(pid) = process_id {
        log::warn!("Wayfern launch failed after spawn ({reason}); terminating orphan PID {pid}");
        #[cfg(unix)]
        {
          use nix::sys::signal::{kill, Signal};
          use nix::unistd::Pid;
          let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
        #[cfg(windows)]
        {
          use std::os::windows::process::CommandExt;
          const CREATE_NO_WINDOW: u32 = 0x08000000;
          let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        }
      }
    };

    if let Err(e) = self.wait_for_cdp_ready(port).await {
      kill_orphan("CDP never became ready");
      return Err(e);
    }

    let targets = match self.get_cdp_targets(port).await {
      Ok(targets) => targets,
      Err(e) => {
        kill_orphan("could not read CDP targets");
        return Err(e);
      }
    };
    log::info!("Found {} CDP targets", targets.len());

    let page_targets: Vec<_> = targets.iter().filter(|t| t.target_type == "page").collect();
    log::info!("Found {} page targets", page_targets.len());
    // A discovery-owned launch will immediately collapse the browser to one
    // tab and navigate it itself.  Even if Chromium restores tabs because of a
    // profile preference, do not let an unresponsive historical tab multiply
    // launch-time CDP work before the scheduler gets a chance to sweep it.
    let targets_to_prepare = if restore_last_session {
      page_targets.as_slice()
    } else {
      &page_targets[..page_targets.len().min(1)]
    };
    if targets_to_prepare.len() < page_targets.len() {
      log::info!(
        "Automation launch is preparing 1 of {} page targets; the scheduler will sweep the rest",
        page_targets.len()
      );
    }

    // Apply fingerprint if configured
    let mut used_fingerprint: Option<String> = None;
    if let Some(fingerprint_json) = &config.fingerprint {
      if targets_to_prepare.is_empty() {
        kill_orphan("configured fingerprint has no page target");
        return Err("configured fingerprint could not be applied: no page target exists".into());
      }
      log::info!(
        "Applying fingerprint to Wayfern browser, fingerprint length: {} chars",
        fingerprint_json.len()
      );

      let stored_value = match Self::parse_stored_fingerprint(fingerprint_json) {
        Ok(value) => value,
        Err(e) => {
          kill_orphan("stored fingerprint JSON is invalid");
          return Err(e.into());
        }
      };

      // The stored fingerprint should be the fingerprint object directly (after our fix in generate_fingerprint_config)
      // But for backwards compatibility, also handle the wrapped format
      let mut fingerprint = if stored_value.get("fingerprint").is_some() {
        // Old format: {"fingerprint": {...}} - extract the inner fingerprint
        stored_value.get("fingerprint").cloned().unwrap()
      } else {
        // New format: fingerprint object directly {...}
        stored_value.clone()
      };

      // Add default timezone if not present (for profiles created before timezone was added)
      if let Some(obj) = fingerprint.as_object_mut() {
        if !obj.contains_key("timezone") {
          obj.insert("timezone".to_string(), json!("America/New_York"));
          log::info!("Added default timezone to fingerprint");
        }
        if !obj.contains_key("timezoneOffset") {
          obj.insert("timezoneOffset".to_string(), json!(300));
          log::info!("Added default timezoneOffset to fingerprint");
        }
      }

      // Denormalize fingerprint for Wayfern CDP (convert arrays/objects to JSON strings)
      let mut fingerprint_for_cdp = Self::denormalize_fingerprint(fingerprint);

      // Normalize languages: if it's a comma-separated string, convert to array
      if let Some(obj) = fingerprint_for_cdp.as_object_mut() {
        if let Some(serde_json::Value::String(s)) = obj.get("languages").cloned() {
          let arr: Vec<&str> = s.split(',').map(|l| l.trim()).collect();
          obj.insert("languages".to_string(), json!(arr));
        }
      }

      log::info!(
        "Fingerprint prepared for CDP command, fields: {:?}",
        fingerprint_for_cdp
          .as_object()
          .map(|o| o.keys().collect::<Vec<_>>())
      );

      // Keep sensitive location values out of customer log bundles. Presence
      // booleans still make malformed/partial profiles diagnosable.
      if let Some(obj) = fingerprint_for_cdp.as_object() {
        log::debug!(
          "Fingerprint CDP location metadata present: timezone={}, timezone_offset={}, coordinates={}, language={}, languages={}",
          obj.contains_key("timezone"),
          obj.contains_key("timezoneOffset"),
          obj.contains_key("latitude") && obj.contains_key("longitude"),
          obj.contains_key("language"),
          obj.contains_key("languages"),
        );
      }

      // Include wayfern token if available (enables cross-OS fingerprinting for paid users)
      let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
      let mut fingerprint_params = fingerprint_for_cdp.clone();
      if let Some(ref token) = wayfern_token {
        if let Some(obj) = fingerprint_params.as_object_mut() {
          obj.insert("wayfernToken".to_string(), json!(token));
        }
      }

      for (index, target) in targets_to_prepare.iter().enumerate() {
        let Some(ws_url) = &target.websocket_debugger_url else {
          if index == 0 {
            kill_orphan("primary page target has no debugger URL for fingerprinting");
            return Err(
              "configured fingerprint could not be applied: primary page target has no debugger URL"
                .into(),
            );
          }
          log::error!(
            "Could not apply fingerprint to secondary page target {}: debugger URL missing",
            target.id
          );
          continue;
        };
        log::info!("Applying fingerprint to page target {}", target.id);
        match self
          .send_cdp_command(ws_url, "Wayfern.setFingerprint", fingerprint_params.clone())
          .await
        {
          Ok(result) => {
            let returned_fields = result
              .get("fingerprint")
              .unwrap_or(&result)
              .as_object()
              .map(|fields| fields.len())
              .unwrap_or(0);
            // Never dump the full result: it is tens of KB and contains the
            // profile's device/geolocation fingerprint.  A count is enough
            // to distinguish a real echo from an empty response.
            log::info!(
              "Applied fingerprint to page target {} ({returned_fields} returned fields)",
              target.id
            );
            // Wayfern.setFingerprint echoes back the fingerprint it actually
            // used, which may be UPGRADED from what we sent (e.g. when the
            // stored fingerprint targets an older browser version). Capture
            // it once, from the first target that succeeds, so the caller can
            // persist the upgraded value to the profile.
            if used_fingerprint.is_none() {
              // getFingerprint/setFingerprint wrap the object as
              // { fingerprint: {...} }; tolerate a bare object too.
              let fp = result.get("fingerprint").cloned().unwrap_or(result);
              if fp.is_object() {
                match serde_json::to_string(&Self::normalize_fingerprint(fp)) {
                  Ok(s) => used_fingerprint = Some(s),
                  Err(e) => {
                    log::warn!("Failed to serialize used fingerprint: {e}")
                  }
                }
              }
            }
          }
          Err(e) if index == 0 => {
            kill_orphan("could not apply fingerprint to primary page target");
            return Err(
              format!("Failed to apply configured fingerprint to primary page target: {e}").into(),
            );
          }
          Err(e) => log::error!(
            "Failed to apply fingerprint to secondary target {}: {e}",
            target.id
          ),
        }
      }
    } else {
      log::warn!("No fingerprint found in config, browser will use default fingerprint");
    }

    // Geolocation is handled internally by the browser binary.

    if let Some(url) = url {
      log::info!("Navigating to URL via CDP: {}", url);
      let Some(target) = page_targets.first() else {
        kill_orphan("initial URL requested but no page target exists");
        return Err("initial URL requested but no page target exists".into());
      };
      let Some(ws_url) = &target.websocket_debugger_url else {
        kill_orphan("initial page target has no debugger URL");
        return Err("initial page target has no debugger URL".into());
      };
      if let Err(e) = self
        .send_cdp_command(ws_url, "Page.navigate", json!({ "url": url }))
        .await
      {
        kill_orphan("initial Page.navigate failed");
        return Err(format!("Failed to navigate to initial URL: {e}").into());
      }
    }

    for target in targets_to_prepare {
      if let Some(ws_url) = &target.websocket_debugger_url {
        // These are cleanup hints, not launch prerequisites.  Run them in
        // parallel under one short budget so a stale renderer cannot add three
        // full CDP timeouts to the visible "browser is open" stage.
        let cleanup = async {
          tokio::join!(
            self.send_cdp_command(ws_url, "Emulation.clearDeviceMetricsOverride", json!({})),
            self.send_cdp_command(
              ws_url,
              "Emulation.setFocusEmulationEnabled",
              json!({ "enabled": false }),
            ),
            self.send_cdp_command(
              ws_url,
              "Emulation.setEmulatedMedia",
              json!({ "media": "", "features": [] }),
            ),
          )
        };
        if tokio::time::timeout(Duration::from_secs(8), cleanup)
          .await
          .is_err()
        {
          log::warn!(
            "Timed out applying best-effort emulation cleanup to target {}",
            target.id
          );
        }
      }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let launch_epoch = LAUNCH_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // Event-driven close detection, gated identically to the zero-window
    // reaper: only positively-known WINDOWED launches. `!headless` is exactly
    // the condition that produces `windowed: Some(true)` below, and
    // `recovered_*` instances never come through this path.
    let watcher = if headless {
      None
    } else {
      Some(crate::cdp_watcher::spawn(profile.id.to_string(), port))
    };
    let instance = WayfernInstance {
      id: id.clone(),
      process_id,
      profile_path: Some(profile_path.to_string()),
      url: url.map(|s| s.to_string()),
      cdp_port: Some(port),
      // Positively known windowed-ness from the launch options, so the
      // zero-window reaper only fires for GUI launches, never headless ones.
      windowed: Some(!headless),
      launch_epoch,
      watcher,
    };

    let mut inner = self.inner.lock().await;
    // A profile can only run one browser at a time, so any pre-existing entry
    // for this same canonical profile_path is stale by definition (a crashed
    // or system-recovered instance with a dead PID and `windowed: None`). Drop
    // it BEFORE inserting the fresh one, using the same canonicalization the
    // by-path lookups use, so `is_instance_windowed` / `get_cdp_port` /
    // `count_page_targets` always resolve to exactly one entry and never pick a
    // stale value in nondeterministic HashMap order.
    let new_canonical = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());
    inner.instances.retain(|_, existing| {
      existing
        .profile_path
        .as_deref()
        .map(|p| {
          std::path::Path::new(p)
            .canonicalize()
            .unwrap_or_else(|_| std::path::Path::new(p).to_path_buf())
            != new_canonical
        })
        .unwrap_or(true)
    });
    inner.instances.insert(id.clone(), instance);

    Ok(WayfernLaunchResult {
      id,
      processId: process_id,
      profilePath: Some(profile_path.to_string()),
      url: url.map(|s| s.to_string()),
      cdp_port: Some(port),
      used_fingerprint,
    })
  }

  pub async fn stop_wayfern(
    &self,
    id: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut inner = self.inner.lock().await;

    if let Some(instance) = inner.instances.remove(id) {
      log::info!("Cleaning up Wayfern instance {}", instance.id);
      // 别在关浏览器这段时间里占着锁 —— 优雅关闭要等上几秒。
      drop(inner);

      // 先请 Chromium 自己退。它在正常关闭时会把 cookie SQLite 和 Preferences
      // flush 掉；被强杀则不会，未落盘的那个提交周期（约 30 秒）就没了。
      //
      // 在 macOS 上 SIGTERM 已经能触发这套收尾，Windows 却没有信号可发，原来
      // 直接 `taskkill /F` = TerminateProcess，**零 shutdown 回调**：每关一次
      // 浏览器就丢一批登录态，而这套编排每条腿都要关一次。
      let closed_itself = match instance.cdp_port {
        Some(port) => self.close_browser_via_cdp(port, instance.process_id).await,
        None => false,
      };

      if let Some(pid) = instance.process_id {
        if closed_itself {
          log::info!("Wayfern instance {id} (PID: {pid}) shut itself down cleanly");
        } else {
          log::warn!("Wayfern instance {id} (PID: {pid}) did not exit on request; forcing");
          #[cfg(unix)]
          {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
          }
          #[cfg(windows)]
          {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            // `/T` is not optional here. Windows never re-parents, and killing
            // only the browser process leaves its renderers, GPU process and
            // crashpad_handler alive — the last of which keeps a handle on the
            // profile directory and makes the later cleanup fail.
            let _ = std::process::Command::new("taskkill")
              .args(["/PID", &pid.to_string(), "/T", "/F"])
              .creation_flags(CREATE_NO_WINDOW)
              .output();
          }
          log::info!("Stopped Wayfern instance {id} (PID: {pid})");
        }
      }
    }

    Ok(())
  }

  /// Ask the browser to close itself, and wait for the process to actually go.
  ///
  /// Returns whether it exited on its own. `Browser.close` is sent on the
  /// browser-level WebSocket from `/json/version` — the per-page endpoints only
  /// close tabs.
  async fn close_browser_via_cdp(&self, port: u16, pid: Option<u32>) -> bool {
    /// Long enough for Chromium to flush its profile, short enough that the
    /// between-leg pause absorbs it. Measured shutdowns land near 2 s.
    const GRACEFUL_SHUTDOWN_WAIT: Duration = Duration::from_secs(8);
    /// 每次判活都是一次**全量进程表刷新**（Windows 上尤其贵），所以间隔要递增：
    /// 常见的 2 秒左右退出用不了几次扫描，慢的情况也不会扫上几十次。
    const FIRST_POLL: Duration = Duration::from_millis(100);
    const MAX_POLL: Duration = Duration::from_secs(1);

    let version_url = format!("http://127.0.0.1:{port}/json/version");
    let Ok(Ok(resp)) = tokio::time::timeout(
      Duration::from_secs(2),
      self.http_client.get(&version_url).send(),
    )
    .await
    else {
      return false;
    };
    let Ok(body) = resp.json::<serde_json::Value>().await else {
      return false;
    };
    let Some(ws) = body.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else {
      return false;
    };

    // The socket dies with the browser, so an error here is as likely to mean
    // "it worked" as "it failed" — the process check below is what decides.
    let _ = self.send_cdp_command(ws, "Browser.close", json!({})).await;

    let Some(pid) = pid else {
      // 没有 PID 就无从确认，只能按「没关成」处理，让调用方去强杀。
      return false;
    };
    let deadline = tokio::time::Instant::now() + GRACEFUL_SHUTDOWN_WAIT;
    let mut poll = FIRST_POLL;
    while tokio::time::Instant::now() < deadline {
      if !crate::proxy_storage::is_process_running(pid) {
        return true;
      }
      tokio::time::sleep(poll).await;
      poll = (poll * 2).min(MAX_POLL);
    }
    // 最后再看一眼：上面那次 sleep 可能刚好跨过了退出的瞬间。
    !crate::proxy_storage::is_process_running(pid)
  }

  /// Opens a URL in a new tab for an existing Wayfern instance.
  pub async fn open_url_in_tab(
    &self,
    profile_path: &str,
    url: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    let port = inner
      .instances
      .values()
      .find(|i| {
        i.profile_path
          .as_deref()
          .map(|p| {
            std::path::Path::new(p)
              .canonicalize()
              .unwrap_or_else(|_| std::path::Path::new(p).to_path_buf())
              == target_path
          })
          .unwrap_or(false)
      })
      .and_then(|i| i.cdp_port)
      .ok_or("Wayfern instance (with CDP port) not found for profile")?;
    drop(inner);

    // Open the URL in a new tab via the CDP HTTP convenience endpoint.
    let new_tab_url = format!(
      "http://127.0.0.1:{port}/json/new?{}",
      urlencoding::encode(url)
    );
    let resp = self
      .http_client
      .put(&new_tab_url)
      .send()
      .await
      .map_err(|e| format!("Failed to open new tab: {e}"))?;
    if !resp.status().is_success() {
      return Err(format!("CDP /json/new returned HTTP {}", resp.status()).into());
    }

    log::info!("Opened URL in new tab via CDP: {}", url);
    Ok(())
  }

  pub async fn get_cdp_port(&self, profile_path: &str) -> Option<u16> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    for instance in inner.instances.values() {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          return instance.cdp_port;
        }
      }
    }
    None
  }

  /// Count the DevTools targets of type `"page"` for this profile's instance —
  /// i.e. how many browser windows/tabs currently exist. On macOS, closing the
  /// last window leaves Chromium resident with zero page targets, so a `Some(0)`
  /// here means the user closed every window even though the process is alive.
  ///
  /// Resolves the CDP port via the SAME in-memory instance lookup as
  /// `get_cdp_port` (only the instance-tracked port; never a fresh system
  /// scan). Returns `None` when the port is unknown (no tracked instance) OR
  /// the CDP `/json` request fails (browser unreachable) — the caller treats
  /// `None` as "cannot tell, assume still open" so a genuinely open browser is
  /// never falsely reported stopped. Only `"page"` targets count; service
  /// workers / background pages / other target types are ignored.
  pub async fn count_page_targets(&self, profile_path: &str) -> Option<usize> {
    let port = self.get_cdp_port(profile_path).await?;
    let targets = self.get_cdp_targets(port).await.ok()?;
    Some(targets.iter().filter(|t| t.target_type == "page").count())
  }

  /// 这个 profile 现在有哪些标签页。
  ///
  /// `None` 的含义是**判断不了**（端口没跟踪 / `/json` 请求失败），不是「没有页签」。
  /// 调用方必须区分这两者：把「判断不了」当成「没窗口了」会误判会话失效。
  ///
  /// 纯只读。**不要**用 `BrowserRunner::check_browser_status` 代替它做会话探针 ——
  /// 那个函数在页签数为零时会**杀掉浏览器**（零窗口收割），会话中途调用等于自己
  /// 给自己埋雷。
  pub async fn list_page_targets(&self, profile_path: &str) -> Option<Vec<PageTarget>> {
    let port = self.get_cdp_port(profile_path).await?;
    let targets = self.get_cdp_targets(port).await.ok()?;
    Some(
      targets
        .into_iter()
        .filter(|t| t.target_type == "page")
        .map(|t| PageTarget {
          id: t.id,
          url: t.url,
          websocket_debugger_url: t.websocket_debugger_url,
        })
        .collect(),
    )
  }

  /// 把某个标签页导航到 `url`，返回实际驱动的 target id。
  ///
  /// `prefer` 是上一轮驱动的页签；它还在就继续用，不在了就退到第一个页签 ——
  /// 用户手动关掉那个页签时靠这条自愈，不该因为 id 找不到就判整个会话失效。
  ///
  /// **和 `open_url_in_tab` 的区别**：那个是 UI 的「在已开浏览器里打开 URL」，
  /// 语义就是要新开页签；这个是「原地换页」。编排换平台必须用这个 ——
  /// 走 `launch_or_open_url` 那条路一旦失败会**回落去起第二个浏览器实例**
  /// （见 browser_runner 的 fallback 分支），同一个 profile 目录两个浏览器
  /// 是唯一能造成同账号并发发送的路径。
  pub async fn navigate_in_tab(
    &self,
    profile_path: &str,
    prefer: Option<&str>,
    url: &str,
  ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let targets = self
      .list_page_targets(profile_path)
      .await
      .ok_or("CDP unreachable while navigating")?;
    let target = prefer
      .and_then(|id| targets.iter().find(|t| t.id == id))
      .or_else(|| targets.first())
      .ok_or("no page target to navigate")?;
    let ws = target
      .websocket_debugger_url
      .as_deref()
      .ok_or("page target has no debugger url")?;
    self
      .send_cdp_command(ws, "Page.navigate", json!({ "url": url }))
      .await?;
    Ok(target.id.clone())
  }

  /// 把标签页带到前台（操作系统层面）。
  ///
  /// **扩展自己做不到这件事**：`chrome.windows.update({focused:true})` 在 macOS 上
  /// 抢不到系统焦点 —— 系统不允许后台应用自行抢占前台。实测证据：一条知乎评论
  /// 在 `document.hasFocus() === false` 时发出成功，说明扩展那次聚焦调用没生效。
  ///
  /// 为什么非要前台：**B 站的评论框在窗口没有系统焦点时只渲染成一条紧凑条**，
  /// 里面既没有真正的输入框也没有发布按钮，链路会以「未能定位到直评输入框」告终。
  /// 知乎/小红书/抖音都不需要，只有 B 站。试过但无效的替代：合成 window focus
  /// 事件、在 MAIN world 覆盖 `document.hasFocus()`、用 CDP 真实鼠标点那条紧凑条。
  ///
  /// 代价是每条腿会打断用户一次。这是知情的取舍。
  pub async fn bring_to_front(&self, profile_path: &str, target_id: Option<&str>) -> bool {
    let Some(targets) = self.list_page_targets(profile_path).await else {
      return false;
    };
    let Some(target) = target_id
      .and_then(|id| targets.iter().find(|t| t.id == id))
      .or_else(|| targets.first())
    else {
      return false;
    };
    let Some(ws) = target.websocket_debugger_url.as_deref() else {
      return false;
    };
    matches!(
      tokio::time::timeout(
        Duration::from_secs(8),
        self.send_cdp_command(ws, "Page.bringToFront", json!({})),
      )
      .await,
      Ok(Ok(_))
    )
  }

  /// 渲染进程还应答吗（有界等待）。
  ///
  /// 为什么需要它：页面可以卡死到 `/json` 里 target 还在、`Page.navigate` 也照常
  /// 返回（那是浏览器进程处理的），但渲染进程一动不动。实测小红书搜索页会稳定
  /// 把渲染进程搞死。没有这个探针的话，一条腿要白等满 240 秒超时。
  ///
  /// 用 `DOM.getDocument` 而不是 `Runtime.evaluate`：后者被 Wayfern 二进制自带的
  /// 付费闸门直接拒掉，拿它当探针会**把每一条腿都判成卡死**。`DOM.*` 实测放行。
  ///
  /// 必须包超时：`send_cdp_command` 自己会一直等下去，渲染进程卡死时它永不返回，
  /// 整个调度器会跟着一起挂住。
  pub async fn renderer_responds(&self, profile_path: &str, target_id: Option<&str>) -> bool {
    let Some(targets) = self.list_page_targets(profile_path).await else {
      return false;
    };
    let Some(target) = target_id
      .and_then(|id| targets.iter().find(|t| t.id == id))
      .or_else(|| targets.first())
    else {
      return false;
    };
    let Some(ws) = target.websocket_debugger_url.as_deref() else {
      return false;
    };
    matches!(
      tokio::time::timeout(
        Duration::from_secs(8),
        self.send_cdp_command(ws, "DOM.getDocument", json!({ "depth": 0 })),
      )
      .await,
      Ok(Ok(_))
    )
  }

  /// Whether Marine's discovery bridge has completed its bootstrap in the
  /// selected tab.
  ///
  /// A responsive renderer is not enough: real runs have sat on a healthy old
  /// page for minutes after a lost navigation/content-script injection.  The
  /// Injection alone is insufficient: the MV3 worker may fail to wake or may
  /// be unable to authenticate to the local API while the isolated script is
  /// otherwise healthy.  Discovery therefore stamps
  /// `data-marine-prospect-ready=1` only after its worker/API handshake, or a
  /// `data-marine-prospect-failed` reason after bootstrap retries are spent.
  /// We read those markers through `DOM.getDocument` because
  /// `Runtime.evaluate` is blocked by Wayfern's capability gate.
  pub async fn marine_automation_readiness(
    &self,
    profile_path: &str,
    target_id: Option<&str>,
  ) -> MarineAutomationReadiness {
    let Some(targets) = self.list_page_targets(profile_path).await else {
      return MarineAutomationReadiness::Pending;
    };
    let Some(target) = target_id
      .and_then(|id| targets.iter().find(|t| t.id == id))
      .or_else(|| targets.first())
    else {
      return MarineAutomationReadiness::Pending;
    };
    let Some(ws) = target.websocket_debugger_url.as_deref() else {
      return MarineAutomationReadiness::Pending;
    };
    let result = match tokio::time::timeout(
      Duration::from_secs(5),
      self.send_cdp_command(
        ws,
        "DOM.getDocument",
        json!({ "depth": 1, "pierce": false }),
      ),
    )
    .await
    {
      Ok(Ok(value)) => value,
      _ => return MarineAutomationReadiness::Pending,
    };
    if Self::cdp_tree_has_attribute(&result, "data-marine-prospect-ready", "1") {
      return MarineAutomationReadiness::Ready;
    }
    if let Some(reason) = Self::cdp_tree_attribute_value(&result, "data-marine-prospect-failed") {
      return MarineAutomationReadiness::Failed(reason);
    }
    MarineAutomationReadiness::Pending
  }

  fn cdp_tree_attribute_value(value: &serde_json::Value, name: &str) -> Option<String> {
    if let Some(attributes) = value.get("attributes").and_then(|v| v.as_array()) {
      for pair in attributes.chunks_exact(2) {
        if pair[0].as_str() == Some(name) {
          return pair[1].as_str().map(str::to_string);
        }
      }
    }
    match value {
      serde_json::Value::Array(values) => values
        .iter()
        .find_map(|v| Self::cdp_tree_attribute_value(v, name)),
      serde_json::Value::Object(values) => values
        .values()
        .find_map(|v| Self::cdp_tree_attribute_value(v, name)),
      _ => None,
    }
  }

  fn cdp_tree_has_attribute(value: &serde_json::Value, name: &str, expected: &str) -> bool {
    if let Some(attributes) = value.get("attributes").and_then(|v| v.as_array()) {
      for pair in attributes.chunks_exact(2) {
        if pair[0].as_str() == Some(name) && pair[1].as_str() == Some(expected) {
          return true;
        }
      }
    }
    match value {
      serde_json::Value::Array(values) => values
        .iter()
        .any(|v| Self::cdp_tree_has_attribute(v, name, expected)),
      serde_json::Value::Object(values) => values
        .values()
        .any(|v| Self::cdp_tree_has_attribute(v, name, expected)),
      _ => false,
    }
  }

  /// 把标签页收敛到只剩 `keep_id` 一个，返回关掉了几个。
  ///
  /// 两条硬约束写在实现里，不靠调用方自觉：
  /// 1. **页签数 ≥ 2 才动手** —— Chromium 关掉最后一个标签页会退出整个浏览器，
  ///    而浏览器一没，这个会话剩下的平台就全废了。
  /// 2. **永不关 `keep_id`**。
  ///
  /// 失败是非致命的：主机制是「原地导航」，清页签只是收拾 `--restore-last-session`
  /// 恢复出来的残留。清不掉就记 warn 继续跑。
  pub async fn close_extra_page_targets(
    &self,
    profile_path: &str,
    keep_id: &str,
  ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let targets = self
      .list_page_targets(profile_path)
      .await
      .ok_or("CDP unreachable while sweeping tabs")?;
    if targets.len() < 2 {
      return Ok(0);
    }
    let port = self
      .get_cdp_port(profile_path)
      .await
      .ok_or("no CDP port while sweeping tabs")?;
    let mut closed = 0usize;
    for t in targets.iter().filter(|t| t.id != keep_id) {
      let url = format!("http://127.0.0.1:{port}/json/close/{}", t.id);
      match self.http_client.get(&url).send().await {
        Ok(r) if r.status().is_success() => closed += 1,
        Ok(r) => log::warn!("Could not close tab {}: HTTP {}", t.id, r.status()),
        Err(e) => log::warn!("Could not close tab {}: {e}", t.id),
      }
    }
    Ok(closed)
  }

  /// Whether the tracked instance for this profile was launched windowed.
  /// `Some(true)` = known windowed (eligible for the zero-window reaper),
  /// `Some(false)` = known headless, `None` = unknown (recovered instance) or
  /// no tracked instance. Only `Some(true)` should enable reaping.
  /// Launch generation of the tracked instance for this profile path, using the
  /// SAME canonicalized lookup as `get_cdp_port` / `is_instance_windowed`.
  /// `Some(0)` = a recovered instance; `None` = nothing tracked.
  pub async fn instance_epoch(&self, profile_path: &str) -> Option<u64> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    for instance in inner.instances.values() {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          return Some(instance.launch_epoch);
        }
      }
    }
    None
  }

  pub async fn is_instance_windowed(&self, profile_path: &str) -> Option<bool> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    for instance in inner.instances.values() {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          return instance.windowed;
        }
      }
    }
    None
  }

  pub async fn find_wayfern_by_profile(&self, profile_path: &str) -> Option<WayfernLaunchResult> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let mut inner = self.inner.lock().await;

    // Canonicalize the target path for comparison
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    // Find the instance with the matching profile path
    let mut found_id: Option<String> = None;
    for (id, instance) in &inner.instances {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          found_id = Some(id.clone());
          break;
        }
      }
    }

    // If we found an instance, verify the process is still running
    if let Some(id) = found_id {
      if let Some(instance) = inner.instances.get(&id) {
        if let Some(pid) = instance.process_id {
          let system = System::new_with_specifics(
            RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
          );
          let sysinfo_pid = sysinfo::Pid::from_u32(pid);

          if system.process(sysinfo_pid).is_some() {
            return Some(WayfernLaunchResult {
              id: id.clone(),
              processId: instance.process_id,
              profilePath: instance.profile_path.clone(),
              url: instance.url.clone(),
              cdp_port: instance.cdp_port,
              used_fingerprint: None,
            });
          } else {
            log::info!(
              "Wayfern process {} for profile {} is no longer running, cleaning up",
              pid,
              profile_path
            );
            inner.instances.remove(&id);
            return None;
          }
        }
      }
    }

    // If not found in in-memory instances, scan system processes.
    // This handles the case where the GUI was restarted but Wayfern is still running.
    if let Some((pid, found_profile_path, cdp_port)) =
      Self::find_wayfern_process_by_profile(&target_path)
    {
      log::info!(
        "Found running Wayfern process (PID: {}) for profile path via system scan",
        pid
      );

      let instance_id = format!("recovered_{}", pid);
      inner.instances.insert(
        instance_id.clone(),
        WayfernInstance {
          id: instance_id.clone(),
          process_id: Some(pid),
          profile_path: Some(found_profile_path.clone()),
          url: None,
          cdp_port,
          // Recovered by system scan after a GUI restart: we cannot know
          // whether it was launched windowed or headless, so leave it unknown
          // and never reap it on zero windows.
          windowed: None,
          launch_epoch: 0, // not a launch we performed
          watcher: None,   // recovered instances stay on the 5s poller
        },
      );

      return Some(WayfernLaunchResult {
        id: instance_id,
        processId: Some(pid),
        profilePath: Some(found_profile_path),
        url: None,
        cdp_port,
        used_fingerprint: None,
      });
    }

    None
  }

  /// Scan system processes to find a Wayfern/Chromium process using a specific profile path
  fn find_wayfern_process_by_profile(
    target_path: &std::path::Path,
  ) -> Option<(u32, String, Option<u16>)> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    let target_path_str = target_path.to_string_lossy();

    for (pid, process) in system.processes() {
      let cmd = process.cmd();
      if cmd.is_empty() {
        continue;
      }

      let exe_name = process.name().to_string_lossy().to_lowercase();
      let is_chromium_like = exe_name.contains("wayfern")
        || exe_name.contains("chromium")
        || exe_name.contains("chrome");

      if !is_chromium_like {
        continue;
      }

      // Skip child processes (renderer, GPU, utility, zygote, etc.)
      // Only the main browser process lacks a --type= argument
      let is_child = cmd
        .iter()
        .any(|a| a.to_str().is_some_and(|s| s.starts_with("--type=")));
      if is_child {
        continue;
      }

      let mut matched = false;
      let mut cdp_port: Option<u16> = None;

      for arg in cmd.iter() {
        if let Some(arg_str) = arg.to_str() {
          if let Some(dir_val) = arg_str.strip_prefix("--user-data-dir=") {
            let cmd_path = std::path::Path::new(dir_val)
              .canonicalize()
              .unwrap_or_else(|_| std::path::Path::new(dir_val).to_path_buf());
            if cmd_path == target_path {
              matched = true;
            }
          }

          if let Some(port_val) = arg_str.strip_prefix("--remote-debugging-port=") {
            cdp_port = port_val.parse().ok();
          }
        }
      }

      if matched {
        return Some((pid.as_u32(), target_path_str.to_string(), cdp_port));
      }
    }

    None
  }

  #[allow(dead_code)]
  pub async fn launch_wayfern_profile(
    &self,
    app_handle: &AppHandle,
    profile: &BrowserProfile,
    config: &WayfernConfig,
    url: Option<&str>,
    proxy_url: Option<&str>,
  ) -> Result<WayfernLaunchResult, Box<dyn std::error::Error + Send + Sync>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_path = profiles_dir.join(profile.id.to_string()).join("profile");
    let profile_path_str = profile_path.to_string_lossy().to_string();

    std::fs::create_dir_all(&profile_path)?;

    if let Some(existing) = self.find_wayfern_by_profile(&profile_path_str).await {
      log::info!("Stopping existing Wayfern instance for profile");
      self.stop_wayfern(&existing.id).await?;
    }

    self
      .launch_wayfern(
        app_handle,
        profile,
        &profile_path_str,
        config,
        url,
        proxy_url,
        profile.ephemeral,
        &[],
        None,
        false,
        true,
      )
      .await
  }

  #[allow(dead_code)]
  pub async fn cleanup_dead_instances(&self) {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let mut inner = self.inner.lock().await;
    let mut dead_ids = Vec::new();

    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    for (id, instance) in &inner.instances {
      if let Some(pid) = instance.process_id {
        let pid = sysinfo::Pid::from_u32(pid);
        if !system.processes().contains_key(&pid) {
          dead_ids.push(id.clone());
        }
      }
    }

    for id in dead_ids {
      log::info!("Cleaning up dead Wayfern instance: {id}");
      inner.instances.remove(&id);
    }
  }
}

lazy_static::lazy_static! {
  static ref WAYFERN_MANAGER: WayfernManager = WayfernManager::new();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn window_size_prefers_outer_window_dimensions() {
    // Field names + values mirror a real Wayfern fingerprint (camelCase).
    let fp = r#"{"windowOuterWidth": 1268, "windowOuterHeight": 764,
                 "windowInnerWidth": 1253, "windowInnerHeight": 630,
                 "screenAvailWidth": 1280, "screenAvailHeight": 775,
                 "screenWidth": 1280, "screenHeight": 800}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(fp),
      Some((1268, 764))
    );
  }

  #[test]
  fn window_size_falls_back_to_avail_then_full_screen() {
    let avail = r#"{"screenAvailWidth": 1280, "screenAvailHeight": 775,
                    "screenWidth": 1280, "screenHeight": 800}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(avail),
      Some((1280, 775))
    );

    let full = r#"{"screenWidth": 2560, "screenHeight": 1440}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(full),
      Some((2560, 1440))
    );
  }

  #[test]
  fn window_size_handles_wrapper_and_stringified_numbers() {
    let wrapped = r#"{"fingerprint": {"windowOuterWidth": "1366", "windowOuterHeight": "768"}}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(wrapped),
      Some((1366, 768))
    );
  }

  #[test]
  fn window_size_none_when_missing_or_invalid() {
    // No dimensions at all.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(r#"{"userAgent": "x"}"#),
      None
    );
    // A width with no matching height is not a usable pair.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(r#"{"windowOuterWidth": 1268}"#),
      None
    );
    // Zero is rejected as a degenerate size.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(
        r#"{"windowOuterWidth": 0, "windowOuterHeight": 0}"#
      ),
      None
    );
    // Not valid JSON.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint("not json"),
      None
    );
  }

  #[test]
  fn stored_fingerprint_parse_reports_invalid_json() {
    assert!(WayfernManager::parse_stored_fingerprint("not json").is_err());
    assert_eq!(
      WayfernManager::parse_stored_fingerprint(r#"{"fingerprint":{"timezone":"UTC"}}"#).unwrap()
        ["fingerprint"]["timezone"],
      "UTC"
    );
  }

  #[test]
  fn marine_readiness_markers_are_found_in_cdp_document_tree() {
    let ready = serde_json::json!({
      "root": {
        "nodeName": "#document",
        "children": [{
          "nodeName": "HTML",
          "attributes": ["lang", "zh-CN", "data-marine-prospect-ready", "1"]
        }]
      }
    });
    assert!(WayfernManager::cdp_tree_has_attribute(
      &ready,
      "data-marine-prospect-ready",
      "1"
    ));
    assert!(!WayfernManager::cdp_tree_has_attribute(
      &ready,
      "data-marine-prospect-ready",
      "0"
    ));

    let failed = serde_json::json!({
      "root": {
        "children": [{
          "attributes": ["data-marine-prospect-failed", "phase_a"]
        }]
      }
    });
    assert_eq!(
      WayfernManager::cdp_tree_attribute_value(&failed, "data-marine-prospect-failed").as_deref(),
      Some("phase_a")
    );
  }
}
