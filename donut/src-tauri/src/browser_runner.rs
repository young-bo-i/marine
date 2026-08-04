use crate::browser::ProxySettings;
use crate::camoufox_manager::{CamoufoxConfig, CamoufoxManager};
use crate::cloud_auth::CLOUD_AUTH;
use crate::downloaded_browsers_registry::DownloadedBrowsersRegistry;
use crate::events;
use crate::platform_browser;
use crate::profile::{BrowserProfile, ProfileManager};
use crate::proxy_manager::PROXY_MANAGER;
use crate::wayfern_manager::{WayfernConfig, WayfernManager};
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;

pub struct BrowserRunner {
  pub profile_manager: &'static ProfileManager,
  pub downloaded_browsers_registry: &'static DownloadedBrowsersRegistry,
  auto_updater: &'static crate::auto_updater::AutoUpdater,
  camoufox_manager: &'static CamoufoxManager,
  wayfern_manager: &'static WayfernManager,
  /// Per-profile consecutive "zero window" observations, keyed by profile id.
  /// Debounces the zero-window reaper in `check_browser_status`: a windowed
  /// Wayfern/Camoufox that reports zero CDP page targets must be seen empty
  /// `ZERO_WINDOW_REAP_THRESHOLD` times in a row before we tear it down, so a
  /// transient empty moment (e.g. between closing one window and opening the
  /// next) never triggers a false stop.
  zero_window_ticks: std::sync::Mutex<std::collections::HashMap<String, u8>>,
  /// One async mutex per profile id, held for the WHOLE of
  /// `kill_browser_process`. Teardown is NOT idempotent — its completion path
  /// is documented as corruption-prone on a double run (see
  /// `profile/password.rs`) — and two overlapping runs escalate a graceful
  /// SIGTERM into a force-kill-by-profile-path. Until now the only automatic
  /// caller was the single poller task, so single-caller-ness WAS the safety;
  /// the CDP watcher can now wake that poller sooner, so the invariant has to
  /// be made explicit. The map holds only Arcs; the std guard is dropped before
  /// awaiting the inner mutex.
  teardown_locks:
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
  /// Serialize launch entry points for the same profile.  In particular, the
  /// discovery scheduler must be able to re-check that a profile is still
  /// cold and, on failure, clean up only the resources it created without a
  /// manual/API launch racing into that ownership window.
  launch_locks:
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
  /// Profile ids whose launch has spawned a browser but not yet registered it.
  /// The launch path spawns the process long before it inserts the instance
  /// (a CDP-ready wait of up to 60s sits in between). No teardown may run in
  /// that window: the force-kill matches by PROFILE PATH and would kill the
  /// browser currently being launched.
  launching: std::sync::Mutex<std::collections::HashSet<String>>,
}

/// Consecutive zero-window observations required before the reaper tears down a
/// windowed Wayfern/Camoufox instance whose process is alive but has no windows.
const ZERO_WINDOW_REAP_THRESHOLD: u8 = 2;

/// What caused a `check_browser_status` call, which decides how much
/// corroboration the zero-window reaper demands.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StatusTrigger {
  /// 5s sweep / launch path / any ad-hoc caller: unchanged 2-sample debounce.
  Poll,
  /// The CDP watcher observed the page-target set drain and stay empty for the
  /// full grace window. One independent `/json` zero is then enough.
  PushConfirmedZero,
}

/// RAII marker for "a launch for this profile has spawned a process".
/// Drop-based so an early `?` return in the launch path cannot leak it.
pub struct LaunchInFlight {
  profile_id: String,
}

#[derive(Clone, Copy)]
struct BrowserLaunchOptions {
  remote_debugging_port: Option<u16>,
  headless: bool,
  restore_last_session: bool,
}

impl Drop for LaunchInFlight {
  fn drop(&mut self) {
    if let Ok(mut set) = BrowserRunner::instance().launching.lock() {
      set.remove(&self.profile_id);
    }
  }
}

impl BrowserRunner {
  fn new() -> Self {
    Self {
      profile_manager: ProfileManager::instance(),
      downloaded_browsers_registry: DownloadedBrowsersRegistry::instance(),
      auto_updater: crate::auto_updater::AutoUpdater::instance(),
      camoufox_manager: CamoufoxManager::instance(),
      wayfern_manager: WayfernManager::instance(),
      zero_window_ticks: std::sync::Mutex::new(std::collections::HashMap::new()),
      teardown_locks: std::sync::Mutex::new(std::collections::HashMap::new()),
      launch_locks: std::sync::Mutex::new(std::collections::HashMap::new()),
      launching: std::sync::Mutex::new(std::collections::HashSet::new()),
    }
  }

  /// Acquire the per-profile teardown lock. The registry guard (std) is dropped
  /// before the `.await`, so no std Mutex is ever held across an await.
  async fn teardown_guard(&self, profile_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = {
      let mut map = self.teardown_locks.lock().unwrap();
      map
        .entry(profile_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
    };
    lock.lock_owned().await
  }

  async fn launch_guard(&self, profile_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = {
      let mut map = self.launch_locks.lock().unwrap();
      map
        .entry(profile_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
    };
    lock.lock_owned().await
  }

  fn mark_launching(&self, profile_id: &str) -> LaunchInFlight {
    self
      .launching
      .lock()
      .unwrap()
      .insert(profile_id.to_string());
    LaunchInFlight {
      profile_id: profile_id.to_string(),
    }
  }

  fn launch_in_flight(&self, profile_id: &str) -> bool {
    self.launching.lock().unwrap().contains(profile_id)
  }

  pub fn instance() -> &'static BrowserRunner {
    &BROWSER_RUNNER
  }

  pub fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  /// Resolve the DNS blocklist level to a cached file path.
  /// If a level is set but the cache is missing, fetches on demand (blocks until done).
  async fn resolve_blocklist_file(
    profile: &crate::profile::BrowserProfile,
  ) -> Result<Option<String>, String> {
    let Some(ref level_str) = profile.dns_blocklist else {
      return Ok(None);
    };
    let Some(level) = crate::dns_blocklist::BlocklistLevel::parse_level(level_str) else {
      return Ok(None);
    };
    if level == crate::dns_blocklist::BlocklistLevel::None {
      return Ok(None);
    }
    let path = crate::dns_blocklist::BlocklistManager::ensure_cached(level)
      .await
      .map_err(|e| format!("Failed to fetch DNS blocklist: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
  }

  /// Refresh cloud proxy credentials if the profile uses a cloud or cloud-derived proxy,
  /// then resolve the proxy settings with profile-specific sid for sticky sessions.
  async fn resolve_proxy_with_refresh(
    &self,
    proxy_id: Option<&String>,
    profile_id: Option<&str>,
  ) -> Result<Option<ProxySettings>, String> {
    let proxy_id = match proxy_id {
      Some(id) => id,
      None => return Ok(None),
    };

    if PROXY_MANAGER.is_cloud_or_derived(proxy_id) {
      log::info!("Refreshing cloud proxy credentials before launch for proxy {proxy_id}");
      CLOUD_AUTH.sync_cloud_proxy().await;
    }
    // For cloud-derived proxies, inject profile-specific sid for sticky sessions
    if let Some(pid) = profile_id {
      if PROXY_MANAGER.is_cloud_or_derived(proxy_id) {
        return Ok(PROXY_MANAGER.resolve_proxy_for_profile(proxy_id, pid));
      }
    }
    Ok(PROXY_MANAGER.get_proxy_settings_by_id(proxy_id))
  }

  fn fire_launch_hook(profile: &BrowserProfile) {
    let Some(raw_url) = profile.launch_hook.as_deref() else {
      return;
    };
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
      return;
    }

    let parsed = match url::Url::parse(trimmed) {
      Ok(u) => u,
      Err(e) => {
        log::warn!(
          "Skipping launch hook for profile {} (ID: {}): invalid URL: {e}",
          profile.name,
          profile.id
        );
        return;
      }
    };

    if !matches!(parsed.scheme(), "http" | "https") {
      log::warn!(
        "Skipping launch hook for profile {} (ID: {}): URL must be http or https",
        profile.name,
        profile.id
      );
      return;
    }

    let url = parsed.to_string();
    let profile_name = profile.name.clone();
    let profile_id = profile.id.to_string();

    log::info!("Firing launch hook GET {url} for profile {profile_name} (ID: {profile_id})");

    tokio::spawn(async move {
      let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
      {
        Ok(c) => c,
        Err(e) => {
          log::warn!("Launch hook client build failed for {url}: {e}");
          return;
        }
      };

      match client.get(&url).send().await {
        Ok(resp) => {
          log::info!(
            "Launch hook {url} for profile {profile_name} returned status {}",
            resp.status()
          );
        }
        Err(e) => {
          log::warn!("Launch hook {url} for profile {profile_name} failed: {e}");
        }
      }
    });
  }

  async fn resolve_launch_proxy(
    &self,
    profile: &BrowserProfile,
  ) -> Result<Option<ProxySettings>, String> {
    Self::fire_launch_hook(profile);

    let resolved = self
      .resolve_proxy_with_refresh(profile.proxy_id.as_ref(), Some(&profile.id.to_string()))
      .await?;

    // 「配了代理但解析不到」绝不能和「没配代理」走同一条路。两者都返回 None，
    // 而 None 在下游只有一个意思：DIRECT。浏览器照常起来，指纹仍按代理的地理
    // 位置伪造，流量却带着操作员的真实 IP 发出去 —— 对做账号运营的人来说这是
    // 最贵的一种失败，而且不报错。云代理在启动前会刷新一次凭据，那一次网络抖动
    // 就足以让 stored_proxies 里的记录被移除，所以这条路径是常态而非边角。
    if profile.proxy_id.is_some() && resolved.is_none() {
      log::error!(
        "Refusing to launch profile {} (ID: {}): proxy {} could not be resolved; launching would connect directly",
        profile.name,
        profile.id,
        profile.proxy_id.as_deref().unwrap_or("<unknown>")
      );
      return Err(serde_json::json!({ "code": "PROXY_NOT_FOUND" }).to_string());
    }

    Ok(resolved)
  }

  /// 同一条铁律的 VPN 版本，见 [`Self::resolve_launch_proxy`]。
  fn vpn_upstream_required(
    profile: &BrowserProfile,
    port: Option<u16>,
  ) -> Result<ProxySettings, String> {
    let Some(port) = port else {
      log::error!(
        "Refusing to launch profile {} (ID: {}): VPN worker reported no local port; launching would connect directly",
        profile.name,
        profile.id
      );
      return Err(serde_json::json!({ "code": "VPN_NOT_WORKING" }).to_string());
    };
    Ok(ProxySettings {
      proxy_type: "socks5".to_string(),
      host: "127.0.0.1".to_string(),
      port,
      username: None,
      password: None,
    })
  }

  /// Get the executable path for a browser profile
  /// This is a common helper to eliminate code duplication across the codebase
  pub fn get_browser_executable_path(
    &self,
    profile: &BrowserProfile,
  ) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    // Create browser instance to get executable path
    let browser_type = crate::browser::BrowserType::from_str(&profile.browser)
      .map_err(|e| format!("Invalid browser type: {e}"))?;
    let browser = crate::browser::create_browser(browser_type);

    // Construct browser directory path: binaries/<browser>/<version>/
    let mut browser_dir = self.get_binaries_dir();
    browser_dir.push(&profile.browser);
    browser_dir.push(&profile.version);

    // Get platform-specific executable path
    browser
      .get_executable_path(&browser_dir)
      .map_err(|e| format!("Failed to get executable path for {}: {e}", profile.browser).into())
  }

  pub async fn launch_browser(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    local_proxy_settings: Option<&ProxySettings>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    self
      .launch_browser_internal(
        app_handle,
        profile,
        url,
        local_proxy_settings,
        BrowserLaunchOptions {
          remote_debugging_port: None,
          headless: false,
          restore_last_session: true,
        },
      )
      .await
  }

  async fn launch_browser_internal(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    _local_proxy_settings: Option<&ProxySettings>,
    options: BrowserLaunchOptions,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    let BrowserLaunchOptions {
      remote_debugging_port,
      headless,
      restore_last_session,
    } = options;
    // Handle Camoufox profiles using CamoufoxManager
    if profile.browser == "camoufox" {
      // Get or create camoufox config
      let mut camoufox_config = profile.camoufox_config.clone().unwrap_or_else(|| {
        log::info!(
          "No camoufox config found for profile {}, using default",
          profile.name
        );
        CamoufoxConfig::default()
      });

      // Always start a local proxy for Camoufox (for traffic monitoring and geoip support)
      let mut upstream_proxy = self
        .resolve_launch_proxy(profile)
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

      // If profile has a VPN instead of proxy, start VPN worker and use it as upstream
      if upstream_proxy.is_none() {
        if let Some(ref vpn_id) = profile.vpn_id {
          match crate::vpn_worker_runner::start_vpn_worker(vpn_id).await {
            Ok(vpn_worker) => {
              let settings = Self::vpn_upstream_required(profile, vpn_worker.local_port)?;
              log::info!(
                "VPN worker started for Camoufox profile on port {}",
                settings.port
              );
              upstream_proxy = Some(settings);
            }
            Err(e) => {
              return Err(format!("Failed to start VPN worker: {e}").into());
            }
          }
        }
      }

      log::info!(
        "Starting local proxy for Camoufox profile: {} (upstream: {})",
        profile.name,
        upstream_proxy
          .as_ref()
          .map(|p| format!("{}:{}", p.host, p.port))
          .unwrap_or_else(|| "DIRECT".to_string())
      );

      // Start the proxy and get local proxy settings
      // If proxy startup fails, DO NOT launch Camoufox - it requires local proxy
      let profile_id_str = profile.id.to_string();
      let blocklist_file = Self::resolve_blocklist_file(profile).await?;
      let local_proxy = PROXY_MANAGER
        .start_proxy(
          app_handle.clone(),
          upstream_proxy.as_ref(),
          0, // Use 0 as temporary PID, will be updated later
          Some(&profile_id_str),
          profile.proxy_bypass_rules.clone(),
          blocklist_file,
          // Camoufox (Firefox 150, and Firefox 135 on the not-yet-updated
          // Windows build) keeps the local HTTP proxy: Firefox's QUIC stack
          // bypasses a configured proxy, so QUIC is disabled and HTTP CONNECT
          // covers everything. SOCKS5 is reserved for Wayfern.
          "http",
        )
        .await
        .map_err(|e| {
          let error_msg = format!("Failed to start local proxy for Camoufox: {e}");
          log::error!("{}", error_msg);
          error_msg
        })?;

      // Format proxy URL for camoufox - always use HTTP for the local proxy
      let proxy_url = format!("http://{}:{}", local_proxy.host, local_proxy.port);

      // Set proxy in camoufox config
      camoufox_config.proxy = Some(proxy_url);

      // Ensure geoip is always enabled for proper geolocation spoofing
      if camoufox_config.geoip.is_none() {
        camoufox_config.geoip = Some(serde_json::Value::Bool(true));
      }

      log::info!(
        "Configured local proxy for Camoufox: {:?}, geoip: {:?}",
        camoufox_config.proxy,
        camoufox_config.geoip
      );

      // Check if we need to generate a new fingerprint on every launch
      let mut updated_profile = profile.clone();
      if camoufox_config.randomize_fingerprint_on_launch == Some(true) {
        log::info!(
          "Generating random fingerprint for Camoufox profile: {}",
          profile.name
        );

        // Create a config copy without the existing fingerprint to force generation of a new one
        let mut config_for_generation = camoufox_config.clone();
        config_for_generation.fingerprint = None;

        // Generate a new fingerprint
        let new_fingerprint = self
          .camoufox_manager
          .generate_fingerprint_config(&app_handle, profile, &config_for_generation)
          .await
          .map_err(|e| format!("Failed to generate random fingerprint: {e}"))?;

        log::info!(
          "New fingerprint generated, length: {} chars",
          new_fingerprint.len()
        );

        // Update the config with the new fingerprint for launching
        camoufox_config.fingerprint = Some(new_fingerprint.clone());

        // Save the updated fingerprint to the profile so it persists
        // We need to preserve all existing config fields and only update the fingerprint
        let mut updated_camoufox_config =
          updated_profile.camoufox_config.clone().unwrap_or_default();
        updated_camoufox_config.fingerprint = Some(new_fingerprint);
        // Preserve the randomize flag so it persists across launches
        updated_camoufox_config.randomize_fingerprint_on_launch = Some(true);
        // Preserve the OS setting so it's used for future fingerprint generation
        if camoufox_config.os.is_some() {
          updated_camoufox_config.os = camoufox_config.os.clone();
        }
        updated_profile.camoufox_config = Some(updated_camoufox_config.clone());

        log::info!(
          "Updated profile camoufox_config with new fingerprint for profile: {}, fingerprint length: {}",
          profile.name,
          updated_camoufox_config.fingerprint.as_ref().map(|f| f.len()).unwrap_or(0)
        );
      }

      // Create ephemeral dir for ephemeral or password-protected profiles
      let override_profile_path = if profile.password_protected {
        let dir = crate::profile::password::prepare_for_launch(profile)
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
        Some(dir)
      } else if profile.ephemeral {
        let dir = crate::ephemeral_dirs::create_ephemeral_dir(&profile.id.to_string())
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
        Some(dir)
      } else {
        None
      };

      // Install extensions if an extension group is assigned
      if updated_profile.extension_group_id.is_some() {
        let profiles_dir = self.profile_manager.get_profiles_dir();
        let ext_profile_path = if let Some(ref override_path) = override_profile_path {
          override_path.clone()
        } else {
          updated_profile.get_profile_data_path(&profiles_dir)
        };
        let mgr = crate::extension_manager::EXTENSION_MANAGER.lock().unwrap();
        match mgr.install_extensions_for_profile(&updated_profile, &ext_profile_path) {
          Ok(paths) => {
            if !paths.is_empty() {
              log::info!(
                "Installed {} Firefox extensions for profile: {}",
                paths.len(),
                updated_profile.name
              );
            }
          }
          Err(e) => {
            log::warn!("Failed to install extensions for Camoufox profile: {e}");
          }
        }
      }

      // Launch Camoufox browser
      log::info!("Launching Camoufox for profile: {}", profile.name);
      let camoufox_result = self
        .camoufox_manager
        .launch_camoufox_profile(
          app_handle.clone(),
          updated_profile.clone(),
          camoufox_config,
          url,
          override_profile_path,
          remote_debugging_port,
          headless,
        )
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to launch Camoufox: {e}").into()
        })?;

      // For server-based Camoufox, we use the process_id
      let process_id = camoufox_result.processId.unwrap_or(0);
      log::info!("Camoufox launched successfully with PID: {process_id}");

      // Update profile with the process info from camoufox result
      updated_profile.process_id = Some(process_id);
      updated_profile.last_launch = Some(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs());

      // Re-key the worker from its launch placeholder onto the real PID. Keyed
      // by profile, never by the placeholder value: concurrent launches each
      // hold a different one.
      if let Err(e) =
        PROXY_MANAGER.update_proxy_pid_for_profile(&profile.id.to_string(), process_id)
      {
        log::warn!("Warning: Failed to update proxy PID mapping: {e}");
      } else {
        log::info!("Updated proxy PID mapping to actual PID: {process_id}");
      }

      // Persist the real browser PID so the detached proxy worker self-reaps
      // when this browser dies, even after the GUI exits/restarts.
      PROXY_MANAGER.set_browser_pid_for_profile(&updated_profile.id.to_string(), process_id);

      // Save the updated profile (includes new fingerprint if randomize is enabled)
      log::info!(
        "Saving profile {} with camoufox_config fingerprint length: {}",
        updated_profile.name,
        updated_profile
          .camoufox_config
          .as_ref()
          .and_then(|c| c.fingerprint.as_ref())
          .map(|f| f.len())
          .unwrap_or(0)
      );
      self.save_process_info(&updated_profile)?;
      // No tag rebuild here: launching only stamps process info, and rescanning
      // every profile on disk made a full scan part of every browser launch.
      log::info!(
        "Successfully saved profile with process info: {}",
        updated_profile.name
      );

      // Emit profiles-changed to trigger frontend to reload profiles from disk
      // This ensures the UI displays the newly generated fingerprint
      if let Err(e) = events::emit_empty("profiles-changed") {
        log::warn!("Warning: Failed to emit profiles-changed event: {e}");
      }

      log::info!(
        "Emitting profile events for successful Camoufox launch: {}",
        updated_profile.name
      );

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &updated_profile) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }

      // Emit minimal running changed event to frontend with a small delay
      #[derive(Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }

      let payload = RunningChangedPayload {
        id: updated_profile.id.to_string(),
        is_running: updated_profile.process_id.is_some(),
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      } else {
        log::info!(
          "Successfully emitted profile-running-changed event for Camoufox {}: running={}",
          updated_profile.name,
          payload.is_running
        );
      }

      return Ok(updated_profile);
    }

    // Handle Wayfern profiles using WayfernManager
    if profile.browser == "wayfern" {
      // Get or create wayfern config
      let mut wayfern_config = profile.wayfern_config.clone().unwrap_or_else(|| {
        log::info!(
          "No wayfern config found for profile {}, using default",
          profile.name
        );
        WayfernConfig::default()
      });

      // Always start a local proxy for Wayfern (for traffic monitoring and geoip support)
      let mut upstream_proxy = self
        .resolve_launch_proxy(profile)
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

      // If profile has a VPN instead of proxy, start VPN worker and use it as upstream
      if upstream_proxy.is_none() {
        if let Some(ref vpn_id) = profile.vpn_id {
          match crate::vpn_worker_runner::start_vpn_worker(vpn_id).await {
            Ok(vpn_worker) => {
              let settings = Self::vpn_upstream_required(profile, vpn_worker.local_port)?;
              log::info!(
                "VPN worker started for Wayfern profile on port {}",
                settings.port
              );
              upstream_proxy = Some(settings);
            }
            Err(e) => {
              return Err(format!("Failed to start VPN worker: {e}").into());
            }
          }
        }
      }

      log::info!(
        "Starting local proxy for Wayfern profile: {} (upstream: {})",
        profile.name,
        upstream_proxy
          .as_ref()
          .map(|p| format!("{}:{}", p.host, p.port))
          .unwrap_or_else(|| "DIRECT".to_string())
      );

      // Start the proxy and get local proxy settings
      // If proxy startup fails, DO NOT launch Wayfern - it requires local proxy
      let profile_id_str = profile.id.to_string();
      let blocklist_file = Self::resolve_blocklist_file(profile).await?;
      let local_proxy = PROXY_MANAGER
        .start_proxy(
          app_handle.clone(),
          upstream_proxy.as_ref(),
          0, // Use 0 as temporary PID, will be updated later
          Some(&profile_id_str),
          profile.proxy_bypass_rules.clone(),
          blocklist_file,
          // Wayfern (Chromium) uses a local SOCKS5 proxy so QUIC and WebRTC
          // UDP can be routed through it (via SOCKS5 UDP ASSOCIATE) without
          // leaking the real IP, rather than being forced direct as they
          // would be over an HTTP CONNECT proxy.
          "socks5",
        )
        .await
        .map_err(|e| {
          let error_msg = format!("Failed to start local proxy for Wayfern: {e}");
          log::error!("{}", error_msg);
          error_msg
        })?;

      // Format proxy URL for wayfern - use SOCKS5 for the local proxy so
      // Chromium proxies UDP (QUIC/WebRTC), not just TCP.
      let proxy_url = format!("socks5://{}:{}", local_proxy.host, local_proxy.port);

      // Set proxy in wayfern config
      wayfern_config.proxy = Some(proxy_url);

      log::info!(
        "Configured local proxy for Wayfern: {:?}",
        wayfern_config.proxy
      );

      // Check if we need to generate a new fingerprint on every launch
      let mut updated_profile = profile.clone();
      if wayfern_config.randomize_fingerprint_on_launch == Some(true) {
        log::info!(
          "Generating random fingerprint for Wayfern profile: {}",
          profile.name
        );

        // Create a config copy without the existing fingerprint to force generation of a new one
        let mut config_for_generation = wayfern_config.clone();
        config_for_generation.fingerprint = None;

        // Generate a new fingerprint
        let new_fingerprint = self
          .wayfern_manager
          .generate_fingerprint_config(&app_handle, profile, &config_for_generation)
          .await
          .map_err(|e| format!("Failed to generate random fingerprint: {e}"))?;

        log::info!(
          "New fingerprint generated, length: {} chars",
          new_fingerprint.len()
        );

        // Update the config with the new fingerprint for launching
        wayfern_config.fingerprint = Some(new_fingerprint.clone());

        // Save the updated fingerprint to the profile so it persists.
        let mut updated_wayfern_config = updated_profile.wayfern_config.clone().unwrap_or_default();
        updated_wayfern_config.fingerprint = Some(new_fingerprint);
        // Preserve the randomize flag so it persists across launches
        updated_wayfern_config.randomize_fingerprint_on_launch = Some(true);
        // Preserve the OS setting so it's used for future fingerprint generation
        if wayfern_config.os.is_some() {
          updated_wayfern_config.os = wayfern_config.os.clone();
        }
        // The fresh fingerprint's location matches the current routing; record
        // its signature so launches keep it in sync with the non-randomize path.
        updated_wayfern_config.geo_proxy_signature =
          Some(crate::wayfern_manager::WayfernManager::geo_signature(
            upstream_proxy.as_ref(),
            profile.vpn_id.as_deref(),
            wayfern_config.geoip.as_ref(),
          ));
        updated_profile.wayfern_config = Some(updated_wayfern_config.clone());

        log::info!(
          "Updated profile wayfern_config with new fingerprint for profile: {}, fingerprint length: {}",
          profile.name,
          updated_wayfern_config.fingerprint.as_ref().map(|f| f.len()).unwrap_or(0)
        );
      } else {
        // Safety net: the stored fingerprint's timezone and geolocation were
        // computed for whatever proxy was set when the fingerprint was
        // generated. If the profile's proxy or VPN has changed since (the
        // common case being a user who forgot to set a proxy at creation and
        // added one afterwards), that location data is stale and the user would
        // see the wrong timezone on first launch. When the routing signature no
        // longer matches, refresh just the location fields of the stored
        // fingerprint through the current proxy. Wayfern only; the randomize
        // path above already regenerates the whole fingerprint each launch.
        let current_geo_sig = crate::wayfern_manager::WayfernManager::geo_signature(
          upstream_proxy.as_ref(),
          profile.vpn_id.as_deref(),
          wayfern_config.geoip.as_ref(),
        );
        let geo_enabled = !matches!(
          wayfern_config.geoip.as_ref(),
          Some(serde_json::Value::Bool(false))
        );
        if geo_enabled
          && wayfern_config.geo_proxy_signature.as_deref() != Some(current_geo_sig.as_str())
        {
          if let Some(stored_fp) = wayfern_config.fingerprint.clone() {
            log::info!(
              "Routing changed for Wayfern profile {} since its fingerprint was generated (was {:?}, now {}); refreshing timezone and geolocation",
              profile.name,
              wayfern_config.geo_proxy_signature,
              current_geo_sig
            );
            match crate::wayfern_manager::WayfernManager::refresh_fingerprint_geolocation(
              &stored_fp,
              wayfern_config.proxy.as_deref(),
              wayfern_config.geoip.as_ref(),
            )
            .await
            {
              Some(refreshed) => {
                // Use the refreshed fingerprint for this launch...
                wayfern_config.fingerprint = Some(refreshed.clone());
                wayfern_config.geo_proxy_signature = Some(current_geo_sig.clone());
                // ...and persist it so the corrected location sticks and we do
                // not refresh again on the next launch with the same proxy.
                let mut cfg = updated_profile.wayfern_config.clone().unwrap_or_default();
                cfg.fingerprint = Some(refreshed);
                cfg.geo_proxy_signature = Some(current_geo_sig);
                updated_profile.wayfern_config = Some(cfg);
              }
              None => {
                log::warn!(
                  "Could not refresh geolocation for Wayfern profile {} (proxy unreachable?); launching with existing location and will retry next launch",
                  profile.name
                );
              }
            }
          }
        }
      }

      // Create ephemeral dir for ephemeral or password-protected profiles
      if profile.password_protected {
        crate::profile::password::prepare_for_launch(profile)
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
      } else if profile.ephemeral {
        crate::ephemeral_dirs::create_ephemeral_dir(&profile.id.to_string())
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
      }

      // Launch Wayfern browser
      log::info!("Launching Wayfern for profile: {}", profile.name);

      // Get profile path for Wayfern
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(&updated_profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy().to_string();

      // Marine: seed the four default bookmarks (B站/小红书/知乎/抖音) into this
      // profile's bookmark bar exactly once — new profiles on first launch,
      // historical profiles on their next launch. We're already inside the
      // `profile.browser == "wayfern"` branch, and `profile_data_path` is the
      // same dir passed to Chromium as `--user-data-dir`, so Bookmarks lands in
      // `<user-data-dir>/Default/Bookmarks`. The flag is bookkeeping: it is
      // persisted here WITHOUT bumping updated_at (save_process_info ->
      // save_profile never touches updated_at), and we set it before spawning so
      // a later manual delete of one of the four is never re-added.
      if !updated_profile.default_bookmarks_seeded {
        match crate::marine::bookmarks::ensure_default_bookmarks(&profile_data_path) {
          Ok(()) => {
            updated_profile.default_bookmarks_seeded = true;
            if let Err(e) = self.save_process_info(&updated_profile) {
              log::warn!(
                "Marine: failed to persist default_bookmarks_seeded for profile {}: {e}",
                updated_profile.name
              );
            }
          }
          Err(e) => {
            // Leave the flag false so the next launch retries; ensure_default_bookmarks is idempotent.
            log::warn!(
              "Marine: failed to seed default bookmarks for profile {}: {e}",
              updated_profile.name
            );
          }
        }
      }

      // Install extensions if an extension group is assigned
      let mut extension_paths = Vec::new();
      if updated_profile.extension_group_id.is_some() {
        let mgr = crate::extension_manager::EXTENSION_MANAGER.lock().unwrap();
        match mgr.install_extensions_for_profile(&updated_profile, &profile_data_path) {
          Ok(paths) => {
            if !paths.is_empty() {
              log::info!(
                "Prepared {} Chromium extensions for profile: {}",
                paths.len(),
                updated_profile.name
              );
            }
            extension_paths = paths;
          }
          Err(e) => {
            log::warn!("Failed to install extensions for Wayfern profile: {e}");
          }
        }
      }

      // Marine: auto-load the in-browser 截流 extension into every Wayfern
      // profile, stamping its local-API runtime config (base + token + id).
      if let Some(marine_dir) = crate::marine::extension::ensure_for_profile(
        &app_handle,
        &profile_data_path,
        &updated_profile.id.to_string(),
      )
      .await
      {
        extension_paths.push(marine_dir.to_string_lossy().to_string());
        log::info!(
          "Marine: loaded 截流 extension for profile {}",
          updated_profile.name
        );
      } else if !restore_last_session {
        // A discovery launch without the bundled extension can only sit on the
        // search page until the leg timeout.  Manual launches remain usable in
        // degraded mode; automation must fail before spawning Chromium.
        return Err("Marine extension/runtime API is not ready for automation".into());
      }

      // Drop-guard covering the whole spawn -> register -> persist window that
      // the launch path leaves unregistered (a CDP-ready wait of up to 60s sits
      // in the middle). Deliberately NOT the teardown mutex: taking that here
      // would self-deadlock via launch_or_open_url -> check_browser_status ->
      // kill_browser_process.
      let _launching = self.mark_launching(&updated_profile.id.to_string());

      // Get proxy URL from config
      let proxy_url = wayfern_config.proxy.as_deref();

      let wayfern_result = self
        .wayfern_manager
        .launch_wayfern(
          &app_handle,
          &updated_profile,
          &profile_path_str,
          &wayfern_config,
          url.as_deref(),
          proxy_url,
          profile.ephemeral,
          &extension_paths,
          remote_debugging_port,
          headless,
          restore_last_session,
        )
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to launch Wayfern: {e}").into()
        })?;

      // Get the process ID from launch result
      let process_id = wayfern_result.processId.unwrap_or(0);
      log::info!("Wayfern launched successfully with PID: {process_id}");

      // Wayfern.setFingerprint echoes back the fingerprint the browser actually
      // applied, which may be UPGRADED from the stored one (e.g. when the
      // stored fingerprint targets an older browser version). Persist it so the
      // next launch starts from the upgraded value — saved below via
      // save_process_info(&updated_profile).
      if let Some(used_fp) = wayfern_result.used_fingerprint.clone() {
        let mut cfg = updated_profile.wayfern_config.clone().unwrap_or_default();
        if cfg.fingerprint.as_deref() != Some(used_fp.as_str()) {
          log::info!(
            "Persisting upgraded fingerprint from Wayfern.setFingerprint for profile: {} (len {})",
            profile.name,
            used_fp.len()
          );
          cfg.fingerprint = Some(used_fp);
          updated_profile.wayfern_config = Some(cfg);
        }
      }

      // Update profile with the process info
      updated_profile.process_id = Some(process_id);
      updated_profile.last_launch = Some(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs());

      // Re-key the worker from its launch placeholder onto the real PID. Keyed
      // by profile, never by the placeholder value: concurrent launches each
      // hold a different one.
      if let Err(e) =
        PROXY_MANAGER.update_proxy_pid_for_profile(&profile.id.to_string(), process_id)
      {
        log::warn!("Warning: Failed to update proxy PID mapping: {e}");
      } else {
        log::info!("Updated proxy PID mapping to actual PID: {process_id}");
      }

      // Persist the real browser PID so the detached proxy worker self-reaps
      // when this browser dies, even after the GUI exits/restarts.
      PROXY_MANAGER.set_browser_pid_for_profile(&updated_profile.id.to_string(), process_id);

      // Save the updated profile
      log::info!(
        "Saving profile {} with wayfern_config fingerprint length: {}",
        updated_profile.name,
        updated_profile
          .wayfern_config
          .as_ref()
          .and_then(|c| c.fingerprint.as_ref())
          .map(|f| f.len())
          .unwrap_or(0)
      );
      if let Err(e) = self.save_process_info(&updated_profile) {
        // The process is already registered by this point.  Returning through
        // `?` would report launch failure while leaving a fully usable browser
        // detached from profile state; the next launch may then adopt it and
        // create two automation sessions for one account.
        if let Err(stop_err) = self.wayfern_manager.stop_wayfern(&wayfern_result.id).await {
          log::warn!("Failed to stop Wayfern after process-info persistence failed: {stop_err}");
        }
        return Err(format!("Failed to save Wayfern process info: {e}").into());
      }
      // No tag rebuild here — see the matching note on the Camoufox launch path.
      log::info!(
        "Successfully saved profile with process info: {}",
        updated_profile.name
      );

      // Emit profiles-changed to trigger frontend to reload profiles from disk
      if let Err(e) = events::emit_empty("profiles-changed") {
        log::warn!("Warning: Failed to emit profiles-changed event: {e}");
      }

      log::info!(
        "Emitting profile events for successful Wayfern launch: {}",
        updated_profile.name
      );

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &updated_profile) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }

      // Emit minimal running changed event to frontend
      #[derive(Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }

      let payload = RunningChangedPayload {
        id: updated_profile.id.to_string(),
        is_running: updated_profile.process_id.is_some(),
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      } else {
        log::info!(
          "Successfully emitted profile-running-changed event for Wayfern {}: running={}",
          updated_profile.name,
          payload.is_running
        );
      }

      return Ok(updated_profile);
    }

    Err(format!("Unsupported browser type: {}", profile.browser).into())
  }

  pub async fn open_url_in_existing_browser(
    &self,
    _app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: &str,
    _internal_proxy_settings: Option<&ProxySettings>,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Handle Camoufox profiles using CamoufoxManager
    if profile.browser == "camoufox" {
      // Get the profile path based on the UUID
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy();

      // Check if the process is running
      match self
        .camoufox_manager
        .find_camoufox_by_profile(&profile_path_str)
        .await
      {
        Ok(Some(_camoufox_process)) => {
          log::info!(
            "Opening URL in existing Camoufox process for profile: {} (ID: {})",
            profile.name,
            profile.id
          );

          // Get Camoufox executable path and use Firefox-like remote mechanism
          let executable_path = self
            .get_browser_executable_path(profile)
            .map_err(|e| format!("Failed to get Camoufox executable path: {e}"))?;

          // Launch Camoufox with -profile and -new-tab to open URL in existing instance
          // This works because we no longer use -no-remote flag
          let output = std::process::Command::new(&executable_path)
            .arg("-profile")
            .arg(&*profile_path_str)
            .arg("-new-tab")
            .arg(url)
            .output()
            .map_err(|e| format!("Failed to execute Camoufox: {e}"))?;

          if output.status.success() {
            log::info!("Successfully opened URL in existing Camoufox instance");
            return Ok(());
          } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!("Camoufox -new-tab command failed: {stderr}");
            return Err(
              format!("Failed to open URL in existing Camoufox instance: {stderr}").into(),
            );
          }
        }
        Ok(None) => {
          return Err("Camoufox browser is not running".into());
        }
        Err(e) => {
          return Err(format!("Error checking Camoufox process: {e}").into());
        }
      }
    }

    // Handle Wayfern profiles using WayfernManager
    if profile.browser == "wayfern" {
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy();

      // Check if the process is running
      match self
        .wayfern_manager
        .find_wayfern_by_profile(&profile_path_str)
        .await
      {
        Some(_wayfern_process) => {
          log::info!(
            "Opening URL in existing Wayfern process for profile: {} (ID: {})",
            profile.name,
            profile.id
          );

          // Use CDP to open URL in a new tab
          self
            .wayfern_manager
            .open_url_in_tab(&profile_path_str, url)
            .await?;
          return Ok(());
        }
        None => {
          return Err("Wayfern browser is not running".into());
        }
      }
    }

    Err(format!("Unsupported browser type: {}", profile.browser).into())
  }

  pub async fn launch_browser_with_debugging(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    remote_debugging_port: Option<u16>,
    headless: bool,
    restore_last_session: bool,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    // Camoufox and Wayfern start (and PID-reconcile) their own local proxy
    // inside `launch_browser_internal`, so we hand it None here rather than
    // staging a second, orphaned proxy worker.
    self
      .launch_browser_internal(
        app_handle,
        profile,
        url,
        None,
        BrowserLaunchOptions {
          remote_debugging_port,
          headless,
          restore_last_session,
        },
      )
      .await
  }

  pub async fn launch_or_open_url(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    internal_proxy_settings: Option<&ProxySettings>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    self
      .launch_or_open_url_with_restore(app_handle, profile, url, internal_proxy_settings, true)
      .await
  }

  async fn launch_or_open_url_with_restore(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    internal_proxy_settings: Option<&ProxySettings>,
    restore_last_session: bool,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    log::info!(
      "launch_or_open_url called for profile: {} (ID: {})",
      profile.name,
      profile.id
    );

    // Get the most up-to-date profile data
    let profiles = self
      .profile_manager
      .list_profiles()
      .map_err(|e| format!("Failed to list profiles in launch_or_open_url: {e}"))?;
    let updated_profile = profiles
      .into_iter()
      .find(|p| p.id == profile.id)
      .unwrap_or_else(|| profile.clone());

    log::info!(
      "Checking browser status for profile: {} (ID: {})",
      updated_profile.name,
      updated_profile.id
    );

    // Check if browser is already running
    let is_running = self
      .check_browser_status(app_handle.clone(), &updated_profile)
      .await
      .map_err(|e| format!("Failed to check browser status: {e}"))?;

    // Get the updated profile again after status check (PID might have been updated)
    let profiles = self
      .profile_manager
      .list_profiles()
      .map_err(|e| format!("Failed to list profiles after status check: {e}"))?;
    let final_profile = profiles
      .into_iter()
      .find(|p| p.id == profile.id)
      .unwrap_or_else(|| updated_profile.clone());

    log::info!(
      "Browser status check - Profile: {} (ID: {}), Running: {}, URL: {:?}, PID: {:?}",
      final_profile.name,
      final_profile.id,
      is_running,
      url,
      final_profile.process_id
    );

    if is_running && url.is_some() {
      // Browser is running and we have a URL to open
      if let Some(url_ref) = url.as_ref() {
        log::info!("Opening URL in existing browser: {url_ref}");

        match self
          .open_url_in_existing_browser(
            app_handle.clone(),
            &final_profile,
            url_ref,
            internal_proxy_settings,
          )
          .await
        {
          Ok(()) => {
            log::info!("Successfully opened URL in existing browser");
            Ok(final_profile)
          }
          Err(e) => {
            log::info!("Failed to open URL in existing browser: {e}");

            // Fall back to launching a new instance
            log::info!(
              "Falling back to new instance for browser: {}",
              final_profile.browser
            );
            // Fallback to launching a new instance for other browsers
            self
              .launch_browser_internal(
                app_handle.clone(),
                &final_profile,
                url,
                internal_proxy_settings,
                BrowserLaunchOptions {
                  remote_debugging_port: None,
                  headless: false,
                  restore_last_session,
                },
              )
              .await
          }
        }
      } else {
        // This case shouldn't happen since we checked is_some() above, but handle it gracefully
        log::info!("URL was unexpectedly None, launching new browser instance");
        if restore_last_session {
          self
            .launch_browser(
              app_handle.clone(),
              &final_profile,
              url,
              internal_proxy_settings,
            )
            .await
        } else {
          self
            .launch_browser_internal(
              app_handle.clone(),
              &final_profile,
              url,
              internal_proxy_settings,
              BrowserLaunchOptions {
                remote_debugging_port: None,
                headless: false,
                restore_last_session: false,
              },
            )
            .await
        }
      }
    } else {
      // Browser is not running or no URL provided, launch new instance
      if !is_running {
        log::info!("Launching new browser instance - browser not running");
      } else {
        log::info!("Launching new browser instance - no URL provided");
      }
      self
        .launch_browser_internal(
          app_handle.clone(),
          &final_profile,
          url,
          internal_proxy_settings,
          BrowserLaunchOptions {
            remote_debugging_port: None,
            headless: false,
            restore_last_session,
          },
        )
        .await
    }
  }

  fn save_process_info(
    &self,
    profile: &BrowserProfile,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Use the regular save_profile method which handles the UUID structure
    self.profile_manager.save_profile(profile).map_err(|e| {
      let error_string = e.to_string();
      Box::new(std::io::Error::other(error_string)) as Box<dyn std::error::Error + Send + Sync>
    })
  }

  /// Liveness for the UI's "running" indicator.
  ///
  /// The base observation (`profile_manager.check_browser_status`) answers "is
  /// the tracked PID alive?". That is not enough on macOS: closing the last
  /// window of a Wayfern (Chromium) / Camoufox (Firefox) leaves the process
  /// RESIDENT with zero windows (only Cmd+Q quits it), so a pure PID check
  /// would report the profile "running" forever after the user closed it.
  ///
  /// For a positively-known WINDOWED Wayfern/Camoufox we therefore also ask
  /// "does the browser still have a window?" via the CDP `/json` page-target
  /// count. Zero page targets, observed `ZERO_WINDOW_REAP_THRESHOLD` times in a
  /// row (debounced against transient empties), means the user closed every
  /// window — we then run the EXISTING full teardown (`kill_browser_process`:
  /// stop proxy, tree-kill the process + descendants, clear the PID, emit
  /// events) and only then report stopped. Guarantees:
  ///   (A) no fake close — a `None` (CDP unreachable) or `>0` count keeps the
  ///       profile "running"; we only report stopped after a verified reap;
  ///   (B) no orphan — teardown goes through `kill_browser_process`, which
  ///       verifies the process is gone and stops the proxy worker;
  ///   (C) never kill headless/automation — only `Some(true)` windowed
  ///       instances are eligible; headless and unknown/recovered instances
  ///       fall back to pure PID liveness.
  pub async fn check_browser_status(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    self
      .check_browser_status_with(app_handle, profile, StatusTrigger::Poll)
      .await
  }

  pub async fn check_browser_status_with(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    trigger: StatusTrigger,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let profile_id = profile.id.to_string();

    // Base observation. Its `Ok(false)` path already cleared process_id and
    // emitted events for a genuine crash/quit.
    let proc_alive = self
      .profile_manager
      .check_browser_status(app_handle.clone(), profile)
      .await?;

    if !proc_alive {
      // Crash/quit path: forget any pending debounce and eagerly reap the
      // proxy worker so it can't linger (requirement B on the crash path).
      {
        let mut ticks = self.zero_window_ticks.lock().unwrap();
        ticks.remove(&profile_id);
      }
      let _ = crate::proxy_manager::PROXY_MANAGER
        .stop_proxy_by_profile_id(app_handle.clone(), &profile_id)
        .await;
      return Ok(false);
    }

    // Only positively-known WINDOWED Wayfern/Camoufox instances get the
    // zero-window reaper. Everything else (headless instances, unknown/
    // recovered instances, and any other browser type) keeps today's pure
    // PID-liveness behavior — return the base observation as-is.
    let profiles_dir = self.profile_manager.get_profiles_dir();
    let profile_path = crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
    let profile_path_str = profile_path.to_string_lossy().to_string();

    let page_targets = match profile.browser.as_str() {
      "wayfern" => {
        if self
          .wayfern_manager
          .is_instance_windowed(&profile_path_str)
          .await
          != Some(true)
        {
          return Ok(true);
        }
        self
          .wayfern_manager
          .count_page_targets(&profile_path_str)
          .await
      }
      "camoufox" => {
        if self
          .camoufox_manager
          .is_instance_windowed(&profile_path_str)
          .await
          != Some(true)
        {
          return Ok(true);
        }
        self
          .camoufox_manager
          .count_page_targets(&profile_path_str)
          .await
      }
      _ => return Ok(true),
    };

    match page_targets {
      // CDP unreachable: cannot tell. The process is alive, so err toward
      // "open". Reset the debounce counter so only an UNINTERRUPTED run of
      // `Some(0)` observations can reach the reap threshold — a `None` gap
      // breaks the "consecutive" chain and must not let a stale earlier
      // `Some(0)` combine with a later one to fake-close (requirement A).
      None => {
        let mut ticks = self.zero_window_ticks.lock().unwrap();
        ticks.insert(profile_id, 0);
        Ok(true)
      }
      // At least one window: definitely open. Reset the debounce counter.
      Some(n) if n > 0 => {
        let mut ticks = self.zero_window_ticks.lock().unwrap();
        ticks.insert(profile_id, 0);
        Ok(true)
      }
      // Zero windows: process alive but windowless (user closed the last
      // window). Debounce, then reap on the threshold.
      Some(_) => {
        // A push-confirmed zero means the CDP watcher already saw the
        // page-target set drain and stay empty for the full grace window.
        // Combined with the fresh `/json` count above that is TWO independent
        // observations over TWO transports ~1s apart — strictly more evidence
        // than the two samples of the same HTTP endpoint 5s apart that the poll
        // path uses, so the second sample would only add latency.
        let threshold = match trigger {
          StatusTrigger::Poll => ZERO_WINDOW_REAP_THRESHOLD,
          StatusTrigger::PushConfirmedZero => 1,
        };

        // Compute the decision under the lock, then DROP the guard before any
        // await so the std Mutex is never held across `kill_browser_process`
        // (which re-enters the manager locks).
        let should_reap = {
          let mut ticks = self.zero_window_ticks.lock().unwrap();
          let counter = ticks.entry(profile_id.clone()).or_insert(0);
          *counter = counter.saturating_add(1);
          if *counter >= threshold {
            *counter = 0;
            true
          } else {
            false
          }
        };

        if !should_reap {
          return Ok(true);
        }

        log::info!(
          "Zero-window reaper firing for profile {} (ID: {}) [trigger={trigger:?}]: process alive but no CDP page targets — tearing down",
          profile.name,
          profile.id
        );

        // Capture the launch generation we decided against. If this teardown
        // queues behind the per-profile lock and a relaunch lands meanwhile,
        // the guard in `kill_browser_process_with_epoch` aborts instead of
        // force-killing the NEW browser by profile path.
        let expect_epoch = if profile.browser == "wayfern" {
          self.wayfern_manager.instance_epoch(&profile_path_str).await
        } else {
          None
        };
        // Note: `kill_browser_process` stops the proxy worker BEFORE it verifies
        // the force-kill, so on the rare force-kill failure it returns Err with
        // the proxy already stopped while we keep reporting the profile
        // "running" (retried on the next tick). Left as-is intentionally: on the
        // reaper path the window is already closed (idle/windowless) so the
        // real-world impact is minimal, and reordering the shared teardown is
        // out of scope + higher risk.
        match self
          .kill_browser_process_with_epoch(app_handle.clone(), profile, expect_epoch)
          .await
        {
          Ok(()) => Ok(false),
          Err(e) => {
            // Teardown could not be verified — do NOT report stopped, so we
            // never claim a close we didn't complete (requirements A + B).
            // The counter was reset above, so it retries on the next zero
            // windows.
            log::warn!(
              "Zero-window reaper failed to tear down profile {} (ID: {}): {e}; keeping it running and will retry",
              profile.name,
              profile.id
            );
            Ok(true)
          }
        }
      }
    }
  }

  pub async fn kill_browser_process(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    self
      .kill_browser_process_with_epoch(app_handle, profile, None)
      .await
  }

  /// `expect_epoch`: `Some(e)` only from the zero-window reaper — abort if the
  /// instance registered for this profile is no longer launch `e`. User-driven
  /// stops pass `None`: they must kill whatever is running right now.
  async fn kill_browser_process_with_epoch(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    expect_epoch: Option<u64>,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let profile_id_str = profile.id.to_string();

    // Exactly one teardown per profile at a time. Acquired at exactly ONE depth
    // — never from the launch path — because tokio::sync::Mutex is not
    // reentrant and `launch_or_open_url` reaches `check_browser_status` -> here.
    let _teardown = self.teardown_guard(&profile_id_str).await;

    if self.launch_in_flight(&profile_id_str) {
      log::info!("Skipping teardown for profile {profile_id_str}: a launch is in flight");
      return Ok(());
    }

    if let Some(expected) = expect_epoch {
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let ppath = crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      match self
        .wayfern_manager
        .instance_epoch(&ppath.to_string_lossy())
        .await
      {
        // Already torn down while we waited for the lock (user Stop, or the
        // other reap). Running the whole teardown again risks the documented
        // double re-encryption on the completion path.
        None => {
          log::info!("Abandoning stale reap for profile {profile_id_str}: instance already gone");
          return Ok(());
        }
        // Epoch 0 = a `recovered_*` entry a concurrent `check_wayfern_status`
        // inserted mid-teardown. Not a relaunch.
        Some(current) if current != 0 && current != expected => {
          log::info!(
            "Abandoning stale reap for profile {profile_id_str}: launch epoch {expected} -> {current}"
          );
          return Ok(());
        }
        _ => {}
      }
    }

    // Handle Camoufox profiles using CamoufoxManager
    if profile.browser == "camoufox" {
      // Search by profile path to find the running Camoufox instance
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy();

      log::info!(
        "Attempting to kill Camoufox process for profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Stop the proxy associated with this profile first
      let profile_id_str = profile.id.to_string();
      if let Err(e) = PROXY_MANAGER
        .stop_proxy_by_profile_id(app_handle.clone(), &profile_id_str)
        .await
      {
        log::warn!(
          "Warning: Failed to stop proxy for profile {}: {e}",
          profile_id_str
        );
      }

      let mut process_actually_stopped = false;
      match self
        .camoufox_manager
        .find_camoufox_by_profile(&profile_path_str)
        .await
      {
        Ok(Some(camoufox_process)) => {
          log::info!(
            "Found Camoufox process: {} (PID: {:?})",
            camoufox_process.id,
            camoufox_process.processId
          );

          match self
            .camoufox_manager
            .stop_camoufox(&app_handle, &camoufox_process.id)
            .await
          {
            Ok(stopped) => {
              if let Some(pid) = camoufox_process.processId {
                if stopped {
                  // Verify the process actually died by checking after a short delay
                  use tokio::time::{sleep, Duration};
                  sleep(Duration::from_millis(500)).await;

                  use sysinfo::{Pid, System};
                  let system = System::new_all();
                  process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();

                  if process_actually_stopped {
                    log::info!(
                      "Successfully stopped Camoufox process: {} (PID: {:?}) - verified process is dead",
                      camoufox_process.id,
                      pid
                    );
                  } else {
                    log::warn!(
                      "Camoufox stop command returned success but process {} (PID: {:?}) is still running - forcing kill",
                      camoufox_process.id,
                      pid
                    );
                    // Force kill the process
                    #[cfg(target_os = "macos")]
                    {
                      use crate::platform_browser;
                      if let Err(e) = platform_browser::macos::kill_browser_process_impl(
                        pid,
                        Some(&profile_path_str),
                      )
                      .await
                      {
                        log::error!("Failed to force kill Camoufox process {}: {}", pid, e);
                      } else {
                        // Verify the process is actually dead after force kill
                        use tokio::time::{sleep, Duration};
                        sleep(Duration::from_millis(500)).await;
                        use sysinfo::{Pid, System};
                        let system = System::new_all();
                        process_actually_stopped =
                          system.process(Pid::from(pid as usize)).is_none();
                        if process_actually_stopped {
                          log::info!(
                            "Successfully force killed Camoufox process {} (PID: {:?})",
                            camoufox_process.id,
                            pid
                          );
                        }
                      }
                    }
                    #[cfg(target_os = "linux")]
                    {
                      use crate::platform_browser;
                      if let Err(e) = platform_browser::linux::kill_browser_process_impl(
                        pid,
                        Some(&profile_path_str),
                      )
                      .await
                      {
                        log::error!("Failed to force kill Camoufox process {}: {}", pid, e);
                      } else {
                        // Verify the process is actually dead after force kill
                        use tokio::time::{sleep, Duration};
                        sleep(Duration::from_millis(500)).await;
                        use sysinfo::{Pid, System};
                        let system = System::new_all();
                        process_actually_stopped =
                          system.process(Pid::from(pid as usize)).is_none();
                        if process_actually_stopped {
                          log::info!(
                            "Successfully force killed Camoufox process {} (PID: {:?})",
                            camoufox_process.id,
                            pid
                          );
                        }
                      }
                    }
                    #[cfg(target_os = "windows")]
                    {
                      use crate::platform_browser;
                      if let Err(e) =
                        platform_browser::windows::kill_browser_process_impl(pid).await
                      {
                        log::error!("Failed to force kill Camoufox process {}: {}", pid, e);
                      } else {
                        // Verify the process is actually dead after force kill
                        use tokio::time::{sleep, Duration};
                        sleep(Duration::from_millis(500)).await;
                        use sysinfo::{Pid, System};
                        let system = System::new_all();
                        process_actually_stopped =
                          system.process(Pid::from(pid as usize)).is_none();
                        if process_actually_stopped {
                          log::info!(
                            "Successfully force killed Camoufox process {} (PID: {:?})",
                            camoufox_process.id,
                            pid
                          );
                        }
                      }
                    }
                  }
                } else {
                  // stop_camoufox returned false, try to force kill the process
                  log::warn!(
                    "Camoufox stop command returned false for process {} (PID: {:?}) - attempting force kill",
                    camoufox_process.id,
                    pid
                  );
                  #[cfg(target_os = "macos")]
                  {
                    use crate::platform_browser;
                    if let Err(e) = platform_browser::macos::kill_browser_process_impl(
                      pid,
                      Some(&profile_path_str),
                    )
                    .await
                    {
                      log::error!("Failed to force kill Camoufox process {}: {}", pid, e);
                    } else {
                      // Verify the process is actually dead after force kill
                      use tokio::time::{sleep, Duration};
                      sleep(Duration::from_millis(500)).await;
                      use sysinfo::{Pid, System};
                      let system = System::new_all();
                      process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                      if process_actually_stopped {
                        log::info!(
                          "Successfully force killed Camoufox process {} (PID: {:?})",
                          camoufox_process.id,
                          pid
                        );
                      }
                    }
                  }
                  #[cfg(target_os = "linux")]
                  {
                    use crate::platform_browser;
                    if let Err(e) = platform_browser::linux::kill_browser_process_impl(
                      pid,
                      Some(&profile_path_str),
                    )
                    .await
                    {
                      log::error!("Failed to force kill Camoufox process {}: {}", pid, e);
                    } else {
                      // Verify the process is actually dead after force kill
                      use tokio::time::{sleep, Duration};
                      sleep(Duration::from_millis(500)).await;
                      use sysinfo::{Pid, System};
                      let system = System::new_all();
                      process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                      if process_actually_stopped {
                        log::info!(
                          "Successfully force killed Camoufox process {} (PID: {:?})",
                          camoufox_process.id,
                          pid
                        );
                      }
                    }
                  }
                  #[cfg(target_os = "windows")]
                  {
                    use crate::platform_browser;
                    if let Err(e) = platform_browser::windows::kill_browser_process_impl(pid).await
                    {
                      log::error!("Failed to force kill Camoufox process {}: {}", pid, e);
                    } else {
                      // Verify the process is actually dead after force kill
                      use tokio::time::{sleep, Duration};
                      sleep(Duration::from_millis(500)).await;
                      use sysinfo::{Pid, System};
                      let system = System::new_all();
                      process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                      if process_actually_stopped {
                        log::info!(
                          "Successfully force killed Camoufox process {} (PID: {:?})",
                          camoufox_process.id,
                          pid
                        );
                      }
                    }
                  }
                }
              } else {
                // No PID available, assume stopped if stop_camoufox returned true
                process_actually_stopped = stopped;
                if !stopped {
                  log::warn!(
                    "Failed to stop Camoufox process {} but no PID available for force kill",
                    camoufox_process.id
                  );
                }
              }
            }
            Err(e) => {
              log::error!(
                "Error stopping Camoufox process {}: {}",
                camoufox_process.id,
                e
              );
              // Try to force kill if we have a PID
              if let Some(pid) = camoufox_process.processId {
                log::info!(
                  "Attempting force kill after stop_camoufox error for PID: {}",
                  pid
                );
                #[cfg(target_os = "macos")]
                {
                  use crate::platform_browser;
                  if let Err(kill_err) =
                    platform_browser::macos::kill_browser_process_impl(pid, Some(&profile_path_str))
                      .await
                  {
                    log::error!(
                      "Failed to force kill Camoufox process {}: {}",
                      pid,
                      kill_err
                    );
                  } else {
                    use tokio::time::{sleep, Duration};
                    sleep(Duration::from_millis(500)).await;
                    use sysinfo::{Pid, System};
                    let system = System::new_all();
                    process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                  }
                }
                #[cfg(target_os = "linux")]
                {
                  use crate::platform_browser;
                  if let Err(kill_err) =
                    platform_browser::linux::kill_browser_process_impl(pid, Some(&profile_path_str))
                      .await
                  {
                    log::error!(
                      "Failed to force kill Camoufox process {}: {}",
                      pid,
                      kill_err
                    );
                  } else {
                    use tokio::time::{sleep, Duration};
                    sleep(Duration::from_millis(500)).await;
                    use sysinfo::{Pid, System};
                    let system = System::new_all();
                    process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                  }
                }
                #[cfg(target_os = "windows")]
                {
                  use crate::platform_browser;
                  if let Err(kill_err) =
                    platform_browser::windows::kill_browser_process_impl(pid).await
                  {
                    log::error!(
                      "Failed to force kill Camoufox process {}: {}",
                      pid,
                      kill_err
                    );
                  } else {
                    use tokio::time::{sleep, Duration};
                    sleep(Duration::from_millis(500)).await;
                    use sysinfo::{Pid, System};
                    let system = System::new_all();
                    process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                  }
                }
              }
            }
          }
        }
        Ok(None) => {
          log::info!(
            "No running Camoufox process found for profile: {} (ID: {})",
            profile.name,
            profile.id
          );
          process_actually_stopped = true; // No process found, consider it stopped
        }
        Err(e) => {
          log::error!(
            "Error finding Camoufox process for profile {}: {}",
            profile.name,
            e
          );
        }
      }

      // If process wasn't confirmed stopped, return an error
      if !process_actually_stopped {
        log::error!(
          "Failed to stop Camoufox process for profile: {} (ID: {}) - process may still be running",
          profile.name,
          profile.id
        );
        return Err(
          format!(
            "Failed to stop Camoufox process for profile {} - process may still be running",
            profile.name
          )
          .into(),
        );
      }

      // Clear the process ID from the profile and save immediately so that
      // subsequent calls to update_profile_version (which re-reads from disk)
      // see the cleared process_id.
      let mut updated_profile = profile.clone();
      updated_profile.process_id = None;
      self
        .save_process_info(&updated_profile)
        .map_err(|e| format!("Failed to update profile: {e}"))?;

      // Check for pending updates and apply them for Camoufox profiles too
      if let Ok(Some(pending_update)) = self
        .auto_updater
        .get_pending_update(&profile.browser, &profile.version)
      {
        log::info!(
          "Found pending update for Camoufox profile {}: {} -> {}",
          profile.name,
          profile.version,
          pending_update.new_version
        );

        match self.profile_manager.update_profile_version(
          &app_handle,
          &profile.id.to_string(),
          &pending_update.new_version,
        ) {
          Ok(updated_profile_after_update) => {
            log::info!(
              "Successfully updated Camoufox profile {} from version {} to {}",
              profile.name,
              profile.version,
              pending_update.new_version
            );
            updated_profile = updated_profile_after_update;

            if let Err(e) = self
              .auto_updater
              .dismiss_update_notification(&pending_update.id)
            {
              log::warn!("Warning: Failed to dismiss pending update notification: {e}");
            }
          }
          Err(e) => {
            log::error!(
              "Failed to apply pending update for Camoufox profile {}: {}",
              profile.name,
              e
            );
          }
        }
      }

      // If no pending update was applied, check if a newer installed version exists
      if updated_profile.version == profile.version {
        if let Some(p) = self
          .auto_updater
          .update_profile_to_latest_installed(&app_handle, &updated_profile)
        {
          updated_profile = p;
        }
      }

      log::info!(
        "Emitting profile events for successful Camoufox kill: {}",
        updated_profile.name
      );

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &updated_profile) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }

      // Emit minimal running changed event to frontend immediately
      #[derive(Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }
      let payload = RunningChangedPayload {
        id: updated_profile.id.to_string(),
        is_running: false, // Explicitly set to false since we just killed it
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      } else {
        log::info!(
          "Successfully emitted profile-running-changed event for Camoufox {}: running={}",
          updated_profile.name,
          payload.is_running
        );
      }

      if profile.password_protected {
        // Await the re-encryption so the queued sync (released later by
        // `mark_profile_stopped` in `kill_browser`) sees fresh ciphertext on
        // disk instead of the previous snapshot.
        crate::profile::password::complete_after_quit_and_wait(profile).await;
      } else if profile.ephemeral {
        crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
      }

      log::info!(
        "Camoufox process cleanup completed for profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Consolidate browser versions after stopping a browser
      if let Ok(consolidated) = self
        .downloaded_browsers_registry
        .consolidate_browser_versions(&app_handle)
      {
        if !consolidated.is_empty() {
          log::info!("Post-stop version consolidation results:");
          for action in &consolidated {
            log::info!("  {action}");
          }
        }
      }

      return Ok(());
    }

    // Handle Wayfern profiles using WayfernManager
    if profile.browser == "wayfern" {
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy();

      log::info!(
        "Attempting to kill Wayfern process for profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Stop the proxy associated with this profile first
      let profile_id_str = profile.id.to_string();
      if let Err(e) = PROXY_MANAGER
        .stop_proxy_by_profile_id(app_handle.clone(), &profile_id_str)
        .await
      {
        log::warn!(
          "Warning: Failed to stop proxy for profile {}: {e}",
          profile_id_str
        );
      }

      let mut process_actually_stopped = false;
      match self
        .wayfern_manager
        .find_wayfern_by_profile(&profile_path_str)
        .await
      {
        Some(wayfern_process) => {
          log::info!(
            "Found Wayfern process: {} (PID: {:?})",
            wayfern_process.id,
            wayfern_process.processId
          );

          match self.wayfern_manager.stop_wayfern(&wayfern_process.id).await {
            Ok(_) => {
              if let Some(pid) = wayfern_process.processId {
                // Verify the process actually died by checking after a short delay
                use tokio::time::{sleep, Duration};
                sleep(Duration::from_millis(500)).await;

                use sysinfo::{Pid, System};
                let system = System::new_all();
                process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();

                if process_actually_stopped {
                  log::info!(
                    "Successfully stopped Wayfern process: {} (PID: {:?}) - verified process is dead",
                    wayfern_process.id,
                    pid
                  );
                } else {
                  log::warn!(
                    "Wayfern stop command returned success but process {} (PID: {:?}) is still running - forcing kill",
                    wayfern_process.id,
                    pid
                  );
                  // Force kill the process
                  #[cfg(target_os = "macos")]
                  {
                    use crate::platform_browser;
                    if let Err(e) = platform_browser::macos::kill_browser_process_impl(
                      pid,
                      Some(&profile_path_str),
                    )
                    .await
                    {
                      log::error!("Failed to force kill Wayfern process {}: {}", pid, e);
                    } else {
                      sleep(Duration::from_millis(500)).await;
                      let system = System::new_all();
                      process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                      if process_actually_stopped {
                        log::info!(
                          "Successfully force killed Wayfern process {} (PID: {:?})",
                          wayfern_process.id,
                          pid
                        );
                      }
                    }
                  }
                  #[cfg(target_os = "linux")]
                  {
                    use crate::platform_browser;
                    if let Err(e) = platform_browser::linux::kill_browser_process_impl(
                      pid,
                      Some(&profile_path_str),
                    )
                    .await
                    {
                      log::error!("Failed to force kill Wayfern process {}: {}", pid, e);
                    } else {
                      sleep(Duration::from_millis(500)).await;
                      let system = System::new_all();
                      process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                      if process_actually_stopped {
                        log::info!(
                          "Successfully force killed Wayfern process {} (PID: {:?})",
                          wayfern_process.id,
                          pid
                        );
                      }
                    }
                  }
                  #[cfg(target_os = "windows")]
                  {
                    use crate::platform_browser;
                    if let Err(e) = platform_browser::windows::kill_browser_process_impl(pid).await
                    {
                      log::error!("Failed to force kill Wayfern process {}: {}", pid, e);
                    } else {
                      sleep(Duration::from_millis(500)).await;
                      let system = System::new_all();
                      process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                      if process_actually_stopped {
                        log::info!(
                          "Successfully force killed Wayfern process {} (PID: {:?})",
                          wayfern_process.id,
                          pid
                        );
                      }
                    }
                  }
                }
              } else {
                process_actually_stopped = true;
              }
            }
            Err(e) => {
              log::error!(
                "Error stopping Wayfern process {}: {}",
                wayfern_process.id,
                e
              );
              // Try to force kill if we have a PID
              if let Some(pid) = wayfern_process.processId {
                log::info!(
                  "Attempting force kill after stop_wayfern error for PID: {}",
                  pid
                );
                #[cfg(target_os = "macos")]
                {
                  use crate::platform_browser;
                  if let Err(kill_err) =
                    platform_browser::macos::kill_browser_process_impl(pid, Some(&profile_path_str))
                      .await
                  {
                    log::error!("Failed to force kill Wayfern process {}: {}", pid, kill_err);
                  } else {
                    use tokio::time::{sleep, Duration};
                    sleep(Duration::from_millis(500)).await;
                    use sysinfo::{Pid, System};
                    let system = System::new_all();
                    process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                  }
                }
                #[cfg(target_os = "linux")]
                {
                  use crate::platform_browser;
                  if let Err(kill_err) =
                    platform_browser::linux::kill_browser_process_impl(pid, Some(&profile_path_str))
                      .await
                  {
                    log::error!("Failed to force kill Wayfern process {}: {}", pid, kill_err);
                  } else {
                    use tokio::time::{sleep, Duration};
                    sleep(Duration::from_millis(500)).await;
                    use sysinfo::{Pid, System};
                    let system = System::new_all();
                    process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                  }
                }
                #[cfg(target_os = "windows")]
                {
                  use crate::platform_browser;
                  if let Err(kill_err) =
                    platform_browser::windows::kill_browser_process_impl(pid).await
                  {
                    log::error!("Failed to force kill Wayfern process {}: {}", pid, kill_err);
                  } else {
                    use tokio::time::{sleep, Duration};
                    sleep(Duration::from_millis(500)).await;
                    use sysinfo::{Pid, System};
                    let system = System::new_all();
                    process_actually_stopped = system.process(Pid::from(pid as usize)).is_none();
                  }
                }
              }
            }
          }
        }
        None => {
          log::info!(
            "No running Wayfern process found for profile: {} (ID: {})",
            profile.name,
            profile.id
          );
          process_actually_stopped = true;
        }
      }

      // If process wasn't confirmed stopped, return an error
      if !process_actually_stopped {
        log::error!(
          "Failed to stop Wayfern process for profile: {} (ID: {}) - process may still be running",
          profile.name,
          profile.id
        );
        return Err(
          format!(
            "Failed to stop Wayfern process for profile {} - process may still be running",
            profile.name
          )
          .into(),
        );
      }

      // Clear the process ID from the profile and save immediately so that
      // subsequent calls to update_profile_version (which re-reads from disk)
      // see the cleared process_id.
      let mut updated_profile = profile.clone();
      updated_profile.process_id = None;
      self
        .save_process_info(&updated_profile)
        .map_err(|e| format!("Failed to update profile: {e}"))?;

      // Check for pending updates and apply them
      if let Ok(Some(pending_update)) = self
        .auto_updater
        .get_pending_update(&profile.browser, &profile.version)
      {
        log::info!(
          "Found pending update for Wayfern profile {}: {} -> {}",
          profile.name,
          profile.version,
          pending_update.new_version
        );

        match self.profile_manager.update_profile_version(
          &app_handle,
          &profile.id.to_string(),
          &pending_update.new_version,
        ) {
          Ok(updated_profile_after_update) => {
            log::info!(
              "Successfully updated Wayfern profile {} from version {} to {}",
              profile.name,
              profile.version,
              pending_update.new_version
            );
            updated_profile = updated_profile_after_update;

            if let Err(e) = self
              .auto_updater
              .dismiss_update_notification(&pending_update.id)
            {
              log::warn!("Warning: Failed to dismiss pending update notification: {e}");
            }
          }
          Err(e) => {
            log::error!(
              "Failed to apply pending update for Wayfern profile {}: {}",
              profile.name,
              e
            );
          }
        }
      }

      // If no pending update was applied, check if a newer installed version exists
      if updated_profile.version == profile.version {
        if let Some(p) = self
          .auto_updater
          .update_profile_to_latest_installed(&app_handle, &updated_profile)
        {
          updated_profile = p;
        }
      }

      log::info!(
        "Emitting profile events for successful Wayfern kill: {}",
        updated_profile.name
      );

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &updated_profile) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }

      // Emit minimal running changed event
      #[derive(Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }
      let payload = RunningChangedPayload {
        id: updated_profile.id.to_string(),
        is_running: false,
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      } else {
        log::info!(
          "Successfully emitted profile-running-changed event for Wayfern {}: running={}",
          updated_profile.name,
          payload.is_running
        );
      }

      if profile.password_protected {
        // Await the re-encryption so the queued sync (released later by
        // `mark_profile_stopped` in `kill_browser`) sees fresh ciphertext on
        // disk instead of the previous snapshot.
        crate::profile::password::complete_after_quit_and_wait(profile).await;
      } else if profile.ephemeral {
        crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
      }

      log::info!(
        "Wayfern process cleanup completed for profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Consolidate browser versions after stopping a browser
      if let Ok(consolidated) = self
        .downloaded_browsers_registry
        .consolidate_browser_versions(&app_handle)
      {
        if !consolidated.is_empty() {
          log::info!("Post-stop version consolidation results:");
          for action in &consolidated {
            log::info!("  {action}");
          }
        }
      }

      return Ok(());
    }

    // For non-camoufox/wayfern browsers, use the existing logic
    let pid = if let Some(pid) = profile.process_id {
      // First verify the stored PID is still valid and belongs to our profile
      let system = System::new_all();
      if let Some(process) = system.process(sysinfo::Pid::from(pid as usize)) {
        let cmd = process.cmd();
        let exe_name = process.name().to_string_lossy();

        // Verify this process is actually our browser
        let is_correct_browser = match profile.browser.as_str() {
          "firefox" => {
            exe_name.contains("firefox")
              && !exe_name.contains("developer")
              && !exe_name.contains("camoufox")
          }
          "firefox-developer" => {
            // More flexible detection for Firefox Developer Edition
            (exe_name.contains("firefox") && exe_name.contains("developer"))
              || (exe_name.contains("firefox")
                && cmd.iter().any(|arg| {
                  let arg_str = arg.to_str().unwrap_or("");
                  arg_str.contains("Developer")
                    || arg_str.contains("developer")
                    || arg_str.contains("FirefoxDeveloperEdition")
                    || arg_str.contains("firefox-developer")
                }))
              || exe_name == "firefox" // Firefox Developer might just show as "firefox"
          }
          "zen" => exe_name.contains("zen"),
          "chromium" => exe_name.contains("chromium") || exe_name.contains("chrome"),
          "brave" => exe_name.contains("brave") || exe_name.contains("Brave"),
          _ => false,
        };

        if is_correct_browser {
          // Verify profile path match
          let profiles_dir = self.profile_manager.get_profiles_dir();
          let profile_data_path = profile.get_profile_data_path(&profiles_dir);
          let profile_data_path_str = profile_data_path.to_string_lossy();

          let profile_path_match = if matches!(
            profile.browser.as_str(),
            "firefox" | "firefox-developer" | "zen"
          ) {
            // Firefox-based browsers: look for -profile argument followed by path
            let mut found_profile_arg = false;
            for (i, arg) in cmd.iter().enumerate() {
              if let Some(arg_str) = arg.to_str() {
                if arg_str == "-profile" && i + 1 < cmd.len() {
                  if let Some(next_arg) = cmd.get(i + 1).and_then(|a| a.to_str()) {
                    if next_arg == profile_data_path_str {
                      found_profile_arg = true;
                      break;
                    }
                  }
                }
                // Also check for combined -profile=path format
                if arg_str == format!("-profile={profile_data_path_str}") {
                  found_profile_arg = true;
                  break;
                }
                // Check if the argument is the profile path directly
                if arg_str == profile_data_path_str {
                  found_profile_arg = true;
                  break;
                }
              }
            }
            found_profile_arg
          } else {
            // Chromium-based browsers: look for --user-data-dir argument
            cmd.iter().any(|s| {
              if let Some(arg) = s.to_str() {
                arg == format!("--user-data-dir={profile_data_path_str}")
                  || arg == profile_data_path_str
              } else {
                false
              }
            })
          };

          if profile_path_match {
            log::info!(
              "Verified stored PID {} is valid for profile {} (ID: {})",
              pid,
              profile.name,
              profile.id
            );
            pid
          } else {
            log::info!("Stored PID {} doesn't match profile path for {} (ID: {}), searching for correct process", pid, profile.name, profile.id);
            // Fall through to search for correct process
            self.find_browser_process_by_profile(profile)?
          }
        } else {
          log::info!("Stored PID {} doesn't match browser type for {} (ID: {}), searching for correct process", pid, profile.name, profile.id);
          // Fall through to search for correct process
          self.find_browser_process_by_profile(profile)?
        }
      } else {
        log::info!(
          "Stored PID {} is no longer valid for profile {} (ID: {}), searching for correct process",
          pid,
          profile.name,
          profile.id
        );
        // Fall through to search for correct process
        self.find_browser_process_by_profile(profile)?
      }
    } else {
      // No stored PID, search for the process
      self.find_browser_process_by_profile(profile)?
    };

    log::info!("Attempting to kill browser process with PID: {pid}");

    // Stop any associated proxy first
    if let Err(e) = PROXY_MANAGER.stop_proxy(app_handle.clone(), pid).await {
      log::warn!("Warning: Failed to stop proxy for PID {pid}: {e}");
    }

    #[cfg(target_os = "macos")]
    {
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path = profile.get_profile_data_path(&profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy().to_string();
      platform_browser::macos::kill_browser_process_impl(pid, Some(&profile_path_str)).await?;
    }

    #[cfg(target_os = "windows")]
    platform_browser::windows::kill_browser_process_impl(pid).await?;

    #[cfg(target_os = "linux")]
    {
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path = profile.get_profile_data_path(&profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy().to_string();
      platform_browser::linux::kill_browser_process_impl(pid, Some(&profile_path_str)).await?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Err("Unsupported platform".into());

    let system = System::new_all();
    if system.process(sysinfo::Pid::from(pid as usize)).is_some() {
      log::error!(
        "Browser process {} is still running after kill attempt for profile: {} (ID: {})",
        pid,
        profile.name,
        profile.id
      );
      return Err(
        format!(
          "Browser process {} is still running after kill attempt",
          pid
        )
        .into(),
      );
    }

    log::info!(
      "Verified browser process {} is terminated for profile: {} (ID: {})",
      pid,
      profile.name,
      profile.id
    );

    // Clear the process ID from the profile and save immediately so that
    // subsequent calls to update_profile_version (which re-reads from disk)
    // see the cleared process_id.
    let mut updated_profile = profile.clone();
    updated_profile.process_id = None;
    self
      .save_process_info(&updated_profile)
      .map_err(|e| format!("Failed to update profile: {e}"))?;

    // Check for pending updates and apply them
    if let Ok(Some(pending_update)) = self
      .auto_updater
      .get_pending_update(&profile.browser, &profile.version)
    {
      log::info!(
        "Found pending update for profile {}: {} -> {}",
        profile.name,
        profile.version,
        pending_update.new_version
      );

      match self.profile_manager.update_profile_version(
        &app_handle,
        &profile.id.to_string(),
        &pending_update.new_version,
      ) {
        Ok(updated_profile_after_update) => {
          log::info!(
            "Successfully updated profile {} from version {} to {}",
            profile.name,
            profile.version,
            pending_update.new_version
          );
          updated_profile = updated_profile_after_update;

          if let Err(e) = self
            .auto_updater
            .dismiss_update_notification(&pending_update.id)
          {
            log::warn!("Warning: Failed to dismiss pending update notification: {e}");
          }
        }
        Err(e) => {
          log::error!(
            "Failed to apply pending update for profile {}: {}",
            profile.name,
            e
          );
        }
      }
    }

    // If no pending update was applied, check if a newer installed version exists
    if updated_profile.version == profile.version {
      if let Some(p) = self
        .auto_updater
        .update_profile_to_latest_installed(&app_handle, &updated_profile)
      {
        updated_profile = p;
      }
    }

    log::info!(
      "Emitting profile events for successful kill: {}",
      updated_profile.name
    );

    // Emit profile update event to frontend
    if let Err(e) = events::emit("profile-updated", &updated_profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    // Emit minimal running changed event to frontend immediately
    #[derive(Serialize)]
    struct RunningChangedPayload {
      id: String,
      is_running: bool,
    }
    let payload = RunningChangedPayload {
      id: updated_profile.id.to_string(),
      is_running: false, // Explicitly set to false since we just killed it
    };

    if let Err(e) = events::emit("profile-running-changed", &payload) {
      log::warn!("Warning: Failed to emit profile running changed event: {e}");
    } else {
      log::info!(
        "Successfully emitted profile-running-changed event for {}: running={}",
        updated_profile.name,
        payload.is_running
      );
    }

    // Consolidate browser versions after stopping a browser
    if let Ok(consolidated) = self
      .downloaded_browsers_registry
      .consolidate_browser_versions(&app_handle)
    {
      if !consolidated.is_empty() {
        log::info!("Post-stop version consolidation results:");
        for action in &consolidated {
          log::info!("  {action}");
        }
      }
    }

    Ok(())
  }

  /// Helper method to find browser process by profile path
  fn find_browser_process_by_profile(
    &self,
    profile: &BrowserProfile,
  ) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    let system = System::new_all();
    let profiles_dir = self.profile_manager.get_profiles_dir();
    let profile_data_path = profile.get_profile_data_path(&profiles_dir);
    let profile_data_path_str = profile_data_path.to_string_lossy();

    log::info!(
      "Searching for {} browser process with profile path: {}",
      profile.browser,
      profile_data_path_str
    );

    for (pid, process) in system.processes() {
      let cmd = process.cmd();
      if cmd.is_empty() {
        continue;
      }

      // Check if this is the right browser executable first
      let exe_name = process.name().to_string_lossy().to_lowercase();
      let is_correct_browser = match profile.browser.as_str() {
        "firefox" => {
          exe_name.contains("firefox")
            && !exe_name.contains("developer")
            && !exe_name.contains("camoufox")
        }
        "firefox-developer" => {
          // More flexible detection for Firefox Developer Edition
          (exe_name.contains("firefox") && exe_name.contains("developer"))
            || (exe_name.contains("firefox")
              && cmd.iter().any(|arg| {
                let arg_str = arg.to_str().unwrap_or("");
                arg_str.contains("Developer")
                  || arg_str.contains("developer")
                  || arg_str.contains("FirefoxDeveloperEdition")
                  || arg_str.contains("firefox-developer")
              }))
            || exe_name == "firefox" // Firefox Developer might just show as "firefox"
        }
        "zen" => exe_name.contains("zen"),
        "chromium" => exe_name.contains("chromium") || exe_name.contains("chrome"),
        "brave" => exe_name.contains("brave") || exe_name.contains("Brave"),
        _ => false,
      };

      if !is_correct_browser {
        continue;
      }

      // Check for profile path match with improved logic
      let profile_path_match = if matches!(
        profile.browser.as_str(),
        "firefox" | "firefox-developer" | "zen"
      ) {
        // Firefox-based browsers: look for -profile argument followed by path
        let mut found_profile_arg = false;
        for (i, arg) in cmd.iter().enumerate() {
          if let Some(arg_str) = arg.to_str() {
            if arg_str == "-profile" && i + 1 < cmd.len() {
              if let Some(next_arg) = cmd.get(i + 1).and_then(|a| a.to_str()) {
                if next_arg == profile_data_path_str {
                  found_profile_arg = true;
                  break;
                }
              }
            }
            // Also check for combined -profile=path format
            if arg_str == format!("-profile={profile_data_path_str}") {
              found_profile_arg = true;
              break;
            }
            // Check if the argument is the profile path directly
            if arg_str == profile_data_path_str {
              found_profile_arg = true;
              break;
            }
          }
        }
        found_profile_arg
      } else {
        // Chromium-based browsers: look for --user-data-dir argument
        cmd.iter().any(|s| {
          if let Some(arg) = s.to_str() {
            arg == format!("--user-data-dir={profile_data_path_str}")
              || arg == profile_data_path_str
          } else {
            false
          }
        })
      };

      if profile_path_match {
        let pid_u32 = pid.as_u32();
        log::info!(
          "Found matching {} browser process with PID: {} for profile: {} (ID: {})",
          profile.browser,
          pid_u32,
          profile.name,
          profile.id
        );
        return Ok(pid_u32);
      }
    }

    Err(
      format!(
        "No running {} browser process found for profile: {} (ID: {})",
        profile.browser, profile.name, profile.id
      )
      .into(),
    )
  }

  pub async fn open_url_with_profile(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: String,
    url: String,
  ) -> Result<(), String> {
    // Get the profile by name
    let profiles = self
      .profile_manager
      .list_profiles()
      .map_err(|e| format!("Failed to list profiles: {e}"))?;
    let profile = profiles
      .into_iter()
      .find(|p| p.id.to_string() == profile_id)
      .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    if profile.is_cross_os() {
      return Err(format!(
        "Cannot open URL with profile '{}': this profile was created on {} and cannot be used on a different operating system",
        profile.name,
        profile.host_os.as_deref().unwrap_or("another OS"),
      ));
    }

    log::info!("Opening URL '{url}' with profile '{profile_id}'");

    // Use launch_or_open_url which handles both launching new instances and opening in existing ones
    self
      .launch_or_open_url(app_handle, &profile, Some(url.clone()), None)
      .await
      .map_err(|e| {
        log::info!("Failed to open URL with profile '{profile_id}': {e}");
        format!("Failed to open URL with profile: {e}")
      })?;

    log::info!("Successfully opened URL '{url}' with profile '{profile_id}'");
    Ok(())
  }
}

#[tauri::command]
pub async fn launch_browser_profile(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
  url: Option<String>,
) -> Result<BrowserProfile, String> {
  launch_browser_profile_impl(app_handle, profile, url, None, false, false).await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchFailureCleanup {
  PreserveExisting,
  RollbackOwnedAutomation,
}

struct ProfileLaunchOptions {
  url: Option<String>,
  remote_debugging_port: Option<u16>,
  headless: bool,
  force_new: bool,
  restore_last_session: bool,
  failure_cleanup: LaunchFailureCleanup,
}

#[derive(Default)]
struct LaunchResourceSnapshot {
  process_ids: std::collections::HashSet<u32>,
  proxy_ids: std::collections::HashSet<String>,
  active_proxy_id: Option<String>,
}

impl LaunchResourceSnapshot {
  fn capture(profile: &BrowserProfile) -> Self {
    Self {
      process_ids: profile_process_ids(profile),
      proxy_ids: profile_proxy_ids(&profile.id.to_string()),
      active_proxy_id: PROXY_MANAGER.active_proxy_id_for_profile(&profile.id.to_string()),
    }
  }
}

fn normalized_path(path: &std::path::Path) -> PathBuf {
  path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn profile_launch_paths(profile: &BrowserProfile) -> Vec<PathBuf> {
  let profiles_dir = BrowserRunner::instance().profile_manager.get_profiles_dir();
  let mut paths = vec![normalized_path(
    &profile.get_profile_data_path(&profiles_dir),
  )];
  let effective = normalized_path(&crate::ephemeral_dirs::get_effective_profile_path(
    profile,
    &profiles_dir,
  ));
  if !paths.contains(&effective) {
    paths.push(effective);
  }
  paths
}

fn command_line_uses_profile(cmd: &[std::ffi::OsString], paths: &[PathBuf]) -> bool {
  for (index, arg) in cmd.iter().enumerate() {
    let Some(arg) = arg.to_str() else { continue };
    let candidate = if let Some(path) = arg.strip_prefix("--user-data-dir=") {
      Some(path)
    } else if arg == "-profile" {
      cmd.get(index + 1).and_then(|next| next.to_str())
    } else {
      None
    };
    if candidate.is_some_and(|candidate| {
      let candidate = normalized_path(std::path::Path::new(candidate));
      paths.contains(&candidate)
    }) {
      return true;
    }
  }
  false
}

fn profile_process_ids(profile: &BrowserProfile) -> std::collections::HashSet<u32> {
  let paths = profile_launch_paths(profile);
  let system = System::new_all();
  system
    .processes()
    .iter()
    .filter_map(|(pid, process)| {
      command_line_uses_profile(process.cmd(), &paths).then_some(pid.as_u32())
    })
    .collect()
}

/// Live PIDs that are provably a browser we launched for one of `profiles`,
/// paired with when each started.
///
/// Identity comes from the profile directory on the process's own command line,
/// never from a PID remembered in `metadata.json`. A remembered PID is a claim
/// about the past: the browser may have crashed, and on Windows — where the PID
/// pool is small and recycled fast — that number is quite likely to belong to
/// something else by now. Killing on that basis takes an unrelated process down.
///
/// One process-table scan for all profiles; the caller is running inside
/// `RunEvent::Exit` and does not get to spend a scan per profile.
pub(crate) fn launched_browser_roots(profiles: &[BrowserProfile]) -> Vec<(u32, u64)> {
  let paths: Vec<PathBuf> = profiles.iter().flat_map(profile_launch_paths).collect();
  if paths.is_empty() {
    return Vec::new();
  }
  let system = System::new_all();
  system
    .processes()
    .iter()
    .filter(|&(_pid, process)| command_line_uses_profile(process.cmd(), &paths))
    .map(|(pid, process)| (pid.as_u32(), process.start_time()))
    .collect()
}

fn profile_proxy_ids(profile_id: &str) -> std::collections::HashSet<String> {
  crate::proxy_storage::list_proxy_configs()
    .into_iter()
    .filter(|config| config.profile_id.as_deref() == Some(profile_id))
    .map(|config| config.id)
    .collect()
}

async fn stop_owned_process(pid: u32) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  #[cfg(target_os = "macos")]
  return platform_browser::macos::kill_browser_process_impl(pid, None).await;

  #[cfg(target_os = "windows")]
  return platform_browser::windows::kill_browser_process_impl(pid).await;

  #[cfg(target_os = "linux")]
  return platform_browser::linux::kill_browser_process_impl(pid, None).await;

  #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
  Err("Unsupported platform".into())
}

async fn rollback_owned_automation_launch(
  app_handle: &tauri::AppHandle,
  profile: &BrowserProfile,
  before: LaunchResourceSnapshot,
  sync_marked_running: bool,
) {
  // The shared per-profile launch guard is still held here, and automation
  // performed a second occupancy check inside that guard before `before` was
  // captured.  Consequently every process in this set difference belongs to
  // this cold-start attempt; a live manual/API browser can never be selected.
  let profile_id = profile.id.to_string();
  let prior_active_proxy_id = before.active_proxy_id.clone();

  let after_processes = profile_process_ids(profile);
  for pid in after_processes.difference(&before.process_ids).copied() {
    if let Err(e) = stop_owned_process(pid).await {
      log::warn!("Failed to stop automation-owned browser PID {pid}: {e}");
    }
  }

  let after_proxies = profile_proxy_ids(&profile_id);
  for proxy_id in after_proxies.difference(&before.proxy_ids) {
    if let Err(e) = PROXY_MANAGER
      .stop_proxy_by_id(app_handle.clone(), proxy_id)
      .await
    {
      log::warn!("Failed to stop automation-owned proxy {proxy_id} for {profile_id}: {e}");
    }
  }
  if let Some(proxy_id) = prior_active_proxy_id {
    if PROXY_MANAGER.restore_profile_proxy_mapping_if_absent(&profile_id, &proxy_id) {
      log::info!(
        "Restored prior proxy mapping {proxy_id} after failed automation launch for {profile_id}"
      );
    }
  }

  crate::team_lock::release_team_lock_if_needed(profile).await;
  if sync_marked_running {
    if let Some(scheduler) = crate::sync::get_global_scheduler() {
      scheduler.mark_profile_stopped(&profile_id).await;
    }
  }
}

/// Launch a browser session owned by the discovery scheduler.
///
/// Automation starts clean instead of restoring every historical tab.  Apart
/// from avoiding unrelated content scripts claiming work, this keeps launch
/// time bounded: generic Wayfern startup applies several CDP commands to every
/// restored page before returning.
pub async fn launch_browser_profile_for_automation(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
) -> Result<BrowserProfile, String> {
  launch_browser_profile_impl_with_restore(
    app_handle,
    profile,
    ProfileLaunchOptions {
      url: None,
      remote_debugging_port: None,
      headless: false,
      force_new: false,
      restore_last_session: false,
      failure_cleanup: LaunchFailureCleanup::RollbackOwnedAutomation,
    },
  )
  .await
}

pub async fn launch_browser_profile_impl(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
  url: Option<String>,
  remote_debugging_port: Option<u16>,
  headless: bool,
  force_new: bool,
) -> Result<BrowserProfile, String> {
  launch_browser_profile_impl_with_restore(
    app_handle,
    profile,
    ProfileLaunchOptions {
      url,
      remote_debugging_port,
      headless,
      force_new,
      restore_last_session: true,
      failure_cleanup: LaunchFailureCleanup::PreserveExisting,
    },
  )
  .await
}

async fn launch_browser_profile_impl_with_restore(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
  options: ProfileLaunchOptions,
) -> Result<BrowserProfile, String> {
  let ProfileLaunchOptions {
    url,
    remote_debugging_port,
    headless,
    force_new,
    restore_last_session,
    failure_cleanup,
  } = options;
  log::info!(
    "Launch request received for profile: {} (ID: {})",
    profile.name,
    profile.id
  );

  if profile.is_cross_os() {
    return Err(format!(
      "Cannot launch profile '{}': this profile was created on {} and cannot be launched on a different operating system",
      profile.name,
      profile.host_os.as_deref().unwrap_or("another OS"),
    ));
  }

  let browser_runner = BrowserRunner::instance();
  // Both manual/API and automation launches take this same guard.  The
  // automation occupancy check and its failure cleanup therefore describe one
  // uninterrupted ownership window, without taking the teardown mutex (which
  // the status check may itself need).
  let _launch_guard = browser_runner.launch_guard(&profile.id.to_string()).await;

  let owned_snapshot = if failure_cleanup == LaunchFailureCleanup::RollbackOwnedAutomation {
    match browser_runner
      .check_browser_status(app_handle.clone(), &profile)
      .await
    {
      Ok(false) => {}
      Ok(true) => {
        return Err(format!(
          "Automation launch aborted because profile '{}' became occupied",
          profile.name
        ));
      }
      Err(e) => {
        return Err(format!(
          "Automation launch aborted because profile '{}' status could not be verified: {e}",
          profile.name
        ));
      }
    }
    let snapshot = LaunchResourceSnapshot::capture(&profile);
    if !snapshot.process_ids.is_empty() {
      return Err(format!(
        "Automation launch aborted because profile '{}' became occupied",
        profile.name
      ));
    }
    Some(snapshot)
  } else {
    None
  };

  // Team lock check: if profile is sync-enabled and user is on a team, acquire lock
  crate::team_lock::acquire_team_lock_if_needed(&profile).await?;

  // Notify sync scheduler that profile is now running and queue sync for when it stops
  let mut sync_marked_running = false;
  if let Some(scheduler) = crate::sync::get_global_scheduler() {
    let pid = profile.id.to_string();
    scheduler.mark_profile_running(&pid).await;
    sync_marked_running = true;
    if profile.is_sync_enabled() {
      scheduler.queue_profile_sync(pid).await;
    }
  }

  // Resolve the most up-to-date profile from disk by ID to avoid using stale proxy_id/browser state
  let profile_for_launch = match browser_runner
    .profile_manager
    .list_profiles()
    .map_err(|e| format!("Failed to list profiles: {e}"))
  {
    Ok(profiles) => profiles
      .into_iter()
      .find(|p| p.id == profile.id)
      .unwrap_or_else(|| profile.clone()),
    Err(e) => {
      if let Some(snapshot) = owned_snapshot {
        rollback_owned_automation_launch(&app_handle, &profile, snapshot, sync_marked_running)
          .await;
      }
      return Err(e);
    }
  };

  log::info!(
    "Resolved profile for launch: {} (ID: {})",
    profile_for_launch.name,
    profile_for_launch.id
  );

  log::info!(
    "Starting browser launch for profile: {} (ID: {})",
    profile_for_launch.name,
    profile_for_launch.id
  );

  // Launch browser or open URL in existing instance. Camoufox and Wayfern
  // start their own local proxies inside `launch_browser_internal`; any
  // other browser type is rejected there (we only support those for import,
  // not launch), so no proxy needs to be staged here.
  //
  // `force_new` callers (API/MCP) always start a fresh instance with the
  // requested debug port and headless mode, bypassing the "open URL in the
  // existing window" path which would otherwise ignore both.
  let launch_result = if force_new {
    browser_runner
      .launch_browser_with_debugging(
        app_handle.clone(),
        &profile_for_launch,
        url,
        remote_debugging_port,
        headless,
        restore_last_session,
      )
      .await
  } else {
    browser_runner
      .launch_or_open_url_with_restore(
        app_handle.clone(),
        &profile_for_launch,
        url,
        None,
        restore_last_session,
      )
      .await
  };
  let updated_profile = match launch_result {
    Ok(profile) => profile,
    Err(e) => {
      log::info!(
        "Browser launch failed for profile: {}, error: {}",
        profile_for_launch.name,
        e
      );

      // Compute the user-facing error before the async rollback consumes this
      // branch.  All launch-side state is released before returning so a
      // transient failure cannot leave the next run locked or "already
      // running" with only a detached proxy behind it.
      let message = if let Some(io_error) = e.downcast_ref::<std::io::Error>() {
        if io_error.kind() == std::io::ErrorKind::Other
          && io_error.to_string().contains("Exec format error")
        {
          format!(
            "Failed to launch browser: Executable format error. This browser version is not compatible with your system architecture ({}). Please try a different browser or version that supports your platform.",
            std::env::consts::ARCH
          )
        } else {
          format!("Failed to launch browser or open URL: {e}")
        }
      } else {
        format!("Failed to launch browser or open URL: {e}")
      };

      if let Some(snapshot) = owned_snapshot {
        rollback_owned_automation_launch(
          &app_handle,
          &profile_for_launch,
          snapshot,
          sync_marked_running,
        )
        .await;
      }

      // Emit a failure event to clear loading states in the frontend
      #[derive(serde::Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }
      let payload = RunningChangedPayload {
        id: profile_for_launch.id.to_string(),
        is_running: !profile_process_ids(&profile_for_launch).is_empty(),
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      }

      return Err(message);
    }
  };

  log::info!(
    "Browser launch completed for profile: {} (ID: {})",
    updated_profile.name,
    updated_profile.id
  );

  // Now update the proxy with the correct PID if we have one
  if let Some(actual_pid) = updated_profile.process_id {
    // Update the proxy manager with the correct PID (we always started with temp pid 1 for non-Camoufox)
    let _ = PROXY_MANAGER.update_proxy_pid(1u32, actual_pid);
  }

  Ok(updated_profile)
}

#[tauri::command]
pub fn check_browser_exists(browser_str: String, version: String) -> bool {
  // This is an alias for is_browser_downloaded to provide clearer semantics for auto-updates
  let runner = BrowserRunner::instance();
  runner
    .downloaded_browsers_registry
    .is_browser_downloaded(&browser_str, &version)
}

#[tauri::command]
pub async fn kill_browser_profile(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
) -> Result<(), String> {
  log::info!(
    "Kill request received for profile: {} (ID: {})",
    profile.name,
    profile.id
  );

  let browser_runner = BrowserRunner::instance();

  match browser_runner
    .kill_browser_process(app_handle.clone(), &profile)
    .await
  {
    Ok(()) => {
      log::info!(
        "Successfully killed browser profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Release team lock if applicable
      crate::team_lock::release_team_lock_if_needed(&profile).await;

      // Notify sync scheduler that profile stopped (sync was queued at launch)
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        scheduler
          .mark_profile_stopped(&profile.id.to_string())
          .await;
      }

      // Auto-update non-running profiles and cleanup unused binaries
      let browser_for_update = profile.browser.clone();
      let app_handle_for_update = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        let registry = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance();
        let mut versions = registry.get_downloaded_versions(&browser_for_update);
        if !versions.is_empty() {
          versions.sort_by(|a, b| crate::api_client::compare_versions(b, a));
          let latest_version = &versions[0];

          let auto_updater = crate::auto_updater::AutoUpdater::instance();
          match auto_updater
            .auto_update_profile_versions(
              &app_handle_for_update,
              &browser_for_update,
              latest_version,
            )
            .await
          {
            Ok(updated) => {
              if !updated.is_empty() {
                log::info!(
                  "Auto-updated {} profiles after stop: {:?}",
                  updated.len(),
                  updated
                );
              }
            }
            Err(e) => {
              log::error!("Failed to auto-update profile versions after stop: {e}");
            }
          }
        }

        match registry.cleanup_unused_binaries() {
          Ok(cleaned) => {
            if !cleaned.is_empty() {
              log::info!("Cleaned up unused binaries after stop: {:?}", cleaned);
            }
          }
          Err(e) => {
            log::error!("Failed to cleanup unused binaries after stop: {e}");
          }
        }
      });

      Ok(())
    }
    Err(e) => {
      log::info!("Failed to kill browser profile {}: {}", profile.name, e);

      // Emit a failure event to clear loading states in the frontend
      #[derive(serde::Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }
      // On kill failure, we assume the process is still running
      let payload = RunningChangedPayload {
        id: profile.id.to_string(),
        is_running: true,
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      }

      Err(format!("Failed to kill browser: {e}"))
    }
  }
}

#[tauri::command]
pub async fn open_url_with_profile(
  app_handle: tauri::AppHandle,
  profile_id: String,
  url: String,
) -> Result<(), String> {
  let browser_runner = BrowserRunner::instance();
  browser_runner
    .open_url_with_profile(app_handle, profile_id, url)
    .await
}

// Global singleton instance
lazy_static::lazy_static! {
  static ref BROWSER_RUNNER: BrowserRunner = BrowserRunner::new();
}

#[cfg(test)]
mod concurrency_guard_tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::Arc;

  // `BrowserRunner` is a process-wide lazy_static, so `teardown_locks` and
  // `launching` are shared by every test in this binary. Each test therefore
  // uses profile ids unique to itself instead of serializing the whole suite.

  /// Teardown is not idempotent and its force-kill matches by PROFILE PATH, so
  /// two overlapping runs for one profile can escalate into killing a browser
  /// that a relaunch just started. The guard must serialize per profile.
  #[tokio::test]
  async fn teardown_guard_serializes_the_same_profile() {
    let runner = BrowserRunner::instance();
    let inside = Arc::new(AtomicUsize::new(0));
    let max_seen = Arc::new(AtomicUsize::new(0));

    let mut tasks = Vec::new();
    for _ in 0..8 {
      let inside = inside.clone();
      let max_seen = max_seen.clone();
      tasks.push(tokio::spawn(async move {
        let _g = BrowserRunner::instance()
          .teardown_guard("guard-test-same-profile")
          .await;
        let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
        max_seen.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        inside.fetch_sub(1, Ordering::SeqCst);
      }));
    }
    for t in tasks {
      t.await.unwrap();
    }
    let _ = runner;
    assert_eq!(
      max_seen.load(Ordering::SeqCst),
      1,
      "two teardowns ran concurrently for one profile"
    );
  }

  /// Different profiles must not block each other — otherwise closing one
  /// browser would stall every other profile's teardown.
  #[tokio::test]
  async fn teardown_guard_admits_different_profiles_concurrently() {
    let a = BrowserRunner::instance()
      .teardown_guard("guard-test-distinct-a")
      .await;
    // Would deadlock (or time out) if the lock were global rather than per id.
    let b = tokio::time::timeout(
      std::time::Duration::from_secs(2),
      BrowserRunner::instance().teardown_guard("guard-test-distinct-b"),
    )
    .await
    .expect("a second profile must not be blocked by the first");
    drop((a, b));
  }

  #[tokio::test]
  async fn launch_guard_serializes_manual_and_automation_entry_points() {
    let first = BrowserRunner::instance()
      .launch_guard("guard-test-launch-owner")
      .await;
    let waiter = tokio::spawn(async {
      BrowserRunner::instance()
        .launch_guard("guard-test-launch-owner")
        .await
    });

    assert!(
      tokio::time::timeout(std::time::Duration::from_millis(25), waiter)
        .await
        .is_err(),
      "a second launch for the same profile entered the ownership window"
    );
    drop(first);

    tokio::time::timeout(
      std::time::Duration::from_secs(1),
      BrowserRunner::instance().launch_guard("guard-test-launch-owner"),
    )
    .await
    .expect("the launch guard must be released after the first launch completes");
  }

  #[test]
  fn process_ownership_requires_an_exact_profile_argument() {
    use std::ffi::OsString;

    let paths = vec![PathBuf::from("/tmp/marine-profile-owned")];
    assert!(command_line_uses_profile(
      &[
        OsString::from("wayfern"),
        OsString::from("--user-data-dir=/tmp/marine-profile-owned"),
      ],
      &paths,
    ));
    assert!(command_line_uses_profile(
      &[
        OsString::from("camoufox"),
        OsString::from("-profile"),
        OsString::from("/tmp/marine-profile-owned"),
      ],
      &paths,
    ));
    assert!(!command_line_uses_profile(
      &[
        OsString::from("wayfern"),
        OsString::from("--user-data-dir=/tmp/marine-profile-owned-by-someone-else"),
      ],
      &paths,
    ));
  }

  /// The launch window between spawning the process and registering the
  /// instance is long (a CDP-ready wait sits in it). A teardown there would
  /// kill the browser being launched, so the marker must be set — and it must
  /// clear on drop even when the launch bails out early with `?`.
  #[test]
  fn launch_marker_is_set_and_cleared_on_drop_including_early_return() {
    let runner = BrowserRunner::instance();
    let id = "guard-test-launch-marker";
    assert!(!runner.launch_in_flight(id));

    {
      let _marker = runner.mark_launching(id);
      assert!(
        runner.launch_in_flight(id),
        "marker must cover the launch window"
      );
    }
    assert!(!runner.launch_in_flight(id), "marker must clear on drop");

    // Simulate the early-`?`-return shape: the guard is dropped by unwinding
    // out of the scope, not by an explicit clear call.
    fn bail(runner: &BrowserRunner, id: &str) -> Result<(), ()> {
      let _marker = runner.mark_launching(id);
      Err(())
    }
    let _ = bail(runner, id);
    assert!(
      !runner.launch_in_flight(id),
      "an early return must not leak the launch marker"
    );
  }
}
