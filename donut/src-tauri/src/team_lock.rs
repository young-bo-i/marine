use lazy_static::lazy_static;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock as StdRwLock;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

use crate::cloud_auth::{CloudAuthManager, CLOUD_API_URL, CLOUD_AUTH};

// ===== Self-hosted lock backend (cross-device mutual exclusion) =====
//
// Cloud mode locks profiles via the Donut cloud API. Self-hosted (token-mode)
// sync had NO cross-device lock: the same profile could be opened on both
// machines at once, and the resulting concurrent Cookie/State writes are what
// produced sync conflicts and eaten logins. These locks live on the donut-sync
// server (`/v1/locks/*`, S3 `locks/<id>.json` written server-side), which is
// deliberately invisible to the sync SSE watcher — heartbeats cause zero sync
// traffic.
//
// Availability over strictness: if the lock SERVER is unreachable we log and
// allow the launch (fail-open). When the server is down, sync is down too, so
// concurrent use cannot produce mid-session sync conflicts; the 3-way merge
// reconciles (with backups) once it returns. Fail-closed would turn server
// downtime into "can't open any synced profile", which is worse.

#[derive(Clone)]
struct SelfHostedLockConfig {
  base_url: String,
  token: String,
}

static SELF_HOSTED_LOCKS: StdRwLock<Option<SelfHostedLockConfig>> = StdRwLock::new(None);

/// Hand the lock manager the self-hosted sync server's URL + token. Called from
/// app setup once sync is configured (resolving the token needs the AppHandle,
/// which this module doesn't have).
pub fn configure_self_hosted_locks(base_url: String, token: String) {
  if let Ok(mut cfg) = SELF_HOSTED_LOCKS.write() {
    *cfg = Some(SelfHostedLockConfig {
      base_url: base_url.trim_end_matches('/').to_string(),
      token,
    });
  }
}

fn self_hosted_config() -> Option<SelfHostedLockConfig> {
  SELF_HOSTED_LOCKS.read().ok().and_then(|c| c.clone())
}

/// Stable per-installation device id, persisted under the app data dir so it
/// survives restarts (lock ownership must not change identity across runs).
pub fn device_id() -> String {
  use std::sync::OnceLock;
  static ID: OnceLock<String> = OnceLock::new();
  ID.get_or_init(|| {
    let path = crate::app_dirs::data_dir().join("device-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
      let trimmed = existing.trim().to_string();
      if !trimmed.is_empty() {
        return trimmed;
      }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(crate::app_dirs::data_dir());
    let _ = std::fs::write(&path, &id);
    id
  })
  .clone()
}

/// Human-readable device name for "in use on <device>" messages.
pub fn device_name() -> String {
  sysinfo::System::host_name().unwrap_or_else(|| "unknown-device".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockAcquireRequest {
  profile_id: String,
  device_id: String,
  device_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockAcquireResponse {
  acquired: bool,
  #[serde(default)]
  locked_by: Option<String>,
  #[serde(default)]
  locked_by_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockRefRequest {
  profile_id: String,
  device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLockEntry {
  profile_id: String,
  device_id: String,
  #[serde(default)]
  device_name: String,
  #[serde(default)]
  heartbeat_at: String,
}

#[derive(Deserialize)]
struct LocksListResponse {
  locks: Vec<RemoteLockEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileLockInfo {
  #[serde(rename = "profileId")]
  pub profile_id: String,
  #[serde(rename = "lockedBy")]
  pub locked_by: String,
  #[serde(rename = "lockedByEmail")]
  pub locked_by_email: String,
  #[serde(rename = "lockedAt")]
  pub locked_at: String,
  #[serde(rename = "expiresAt", default)]
  pub expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct AcquireLockResponse {
  success: bool,
  #[serde(rename = "lockedBy")]
  locked_by: Option<String>,
  #[serde(rename = "lockedByEmail")]
  locked_by_email: Option<String>,
}

pub struct ProfileLockManager {
  locks: RwLock<HashMap<String, ProfileLockInfo>>,
  heartbeat_handle: Mutex<Option<JoinHandle<()>>>,
  connected: Mutex<bool>,
}

lazy_static! {
  pub static ref PROFILE_LOCK: ProfileLockManager = ProfileLockManager::new();
}

// Keep backward compatibility alias
pub use PROFILE_LOCK as TEAM_LOCK;

impl ProfileLockManager {
  fn new() -> Self {
    Self {
      locks: RwLock::new(HashMap::new()),
      heartbeat_handle: Mutex::new(None),
      connected: Mutex::new(false),
    }
  }

  pub async fn connect(&self) {
    log::info!("Connecting profile lock manager");

    {
      let mut c = self.connected.lock().await;
      *c = true;
    }

    if let Err(e) = self.fetch_locks_any().await {
      log::warn!("Failed to fetch initial profile locks: {e}");
    }

    self.start_heartbeat_loop().await;
  }

  /// Fetch the current lock table from whichever backend applies: the cloud
  /// lock API when logged in, otherwise the self-hosted sync server.
  async fn fetch_locks_any(&self) -> Result<(), String> {
    if CLOUD_AUTH.is_logged_in().await {
      return self.fetch_locks().await;
    }
    if let Some(cfg) = self_hosted_config() {
      return self.fetch_locks_self_hosted(&cfg).await;
    }
    Ok(())
  }

  pub async fn disconnect(&self) {
    log::info!("Disconnecting profile lock manager");

    {
      let mut handle = self.heartbeat_handle.lock().await;
      if let Some(h) = handle.take() {
        h.abort();
      }
    }

    {
      let mut locks = self.locks.write().await;
      locks.clear();
    }

    {
      let mut c = self.connected.lock().await;
      *c = false;
    }
  }

  pub async fn is_connected(&self) -> bool {
    *self.connected.lock().await
  }

  pub async fn acquire_lock(&self, profile_id: &str) -> Result<(), String> {
    let client = Client::new();
    let access_token =
      CloudAuthManager::load_access_token()?.ok_or_else(|| "Not logged in".to_string())?;

    let url = format!("{CLOUD_API_URL}/api/profile-locks/{profile_id}");
    let response = client
      .post(&url)
      .header("Authorization", format!("Bearer {access_token}"))
      .send()
      .await
      .map_err(|e| format!("Failed to acquire lock: {e}"))?;

    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(format!("Lock acquisition failed ({status}): {body}"));
    }

    let result: AcquireLockResponse = response
      .json()
      .await
      .map_err(|e| format!("Failed to parse lock response: {e}"))?;

    if !result.success {
      let email = result
        .locked_by_email
        .unwrap_or_else(|| "another device".to_string());
      return Err(format!("Profile is in use by {email}"));
    }

    // Update local cache
    if let Some(user) = CLOUD_AUTH.get_user().await {
      let mut locks = self.locks.write().await;
      locks.insert(
        profile_id.to_string(),
        ProfileLockInfo {
          profile_id: profile_id.to_string(),
          locked_by: user.user.id.clone(),
          locked_by_email: user.user.email.clone(),
          locked_at: chrono::Utc::now().to_rfc3339(),
          expires_at: None,
        },
      );
    }

    let _ = crate::events::emit(
      "profile-lock-changed",
      serde_json::json!({ "profileId": profile_id, "action": "acquired" }),
    );

    Ok(())
  }

  pub async fn release_lock(&self, profile_id: &str) -> Result<(), String> {
    let client = Client::new();
    let access_token =
      CloudAuthManager::load_access_token()?.ok_or_else(|| "Not logged in".to_string())?;

    let url = format!("{CLOUD_API_URL}/api/profile-locks/{profile_id}");
    let _ = client
      .delete(&url)
      .header("Authorization", format!("Bearer {access_token}"))
      .send()
      .await;

    {
      let mut locks = self.locks.write().await;
      locks.remove(profile_id);
    }

    let _ = crate::events::emit(
      "profile-lock-changed",
      serde_json::json!({ "profileId": profile_id, "action": "released" }),
    );

    Ok(())
  }

  pub async fn get_locks(&self) -> Vec<ProfileLockInfo> {
    let locks = self.locks.read().await;
    locks.values().cloned().collect()
  }

  pub async fn get_lock_status(&self, profile_id: &str) -> Option<ProfileLockInfo> {
    let locks = self.locks.read().await;
    locks.get(profile_id).cloned()
  }

  pub async fn is_locked_by_another(&self, profile_id: &str) -> bool {
    let locks = self.locks.read().await;
    if let Some(lock) = locks.get(profile_id) {
      if let Some(user) = CLOUD_AUTH.get_user().await {
        return lock.locked_by != user.user.id;
      }
      // Self-hosted mode: lock ownership is per-device, not per-user.
      return lock.locked_by != device_id();
    }
    false
  }

  // ===== Self-hosted lock operations =====

  fn lock_http() -> Client {
    Client::builder()
      .connect_timeout(Duration::from_secs(5))
      .timeout(Duration::from_secs(10))
      .build()
      .unwrap_or_else(|_| Client::new())
  }

  /// Try to take the cross-device lock for `profile_id` on the self-hosted
  /// server. `Err` (launch blocked) ONLY when another device verifiably holds
  /// the lock; any server/network problem fails OPEN with a warning.
  async fn acquire_lock_self_hosted(
    &self,
    cfg: &SelfHostedLockConfig,
    profile_id: &str,
  ) -> Result<(), String> {
    let resp = Self::lock_http()
      .post(format!("{}/v1/locks/acquire", cfg.base_url))
      .header("Authorization", format!("Bearer {}", cfg.token))
      .json(&LockAcquireRequest {
        profile_id: profile_id.to_string(),
        device_id: device_id(),
        device_name: device_name(),
      })
      .send()
      .await;

    let resp = match resp {
      Ok(r) if r.status().is_success() => r,
      Ok(r) => {
        log::warn!(
          "Profile lock acquire got HTTP {} — allowing launch (fail-open)",
          r.status()
        );
        return Ok(());
      }
      Err(e) => {
        log::warn!("Profile lock server unreachable ({e}) — allowing launch (fail-open)");
        return Ok(());
      }
    };

    let body: LockAcquireResponse = match resp.json().await {
      Ok(b) => b,
      Err(e) => {
        log::warn!("Profile lock acquire: bad response ({e}) — allowing launch (fail-open)");
        return Ok(());
      }
    };

    if body.acquired {
      let mut locks = self.locks.write().await;
      locks.insert(
        profile_id.to_string(),
        ProfileLockInfo {
          profile_id: profile_id.to_string(),
          locked_by: device_id(),
          locked_by_email: device_name(),
          locked_at: chrono::Utc::now().to_rfc3339(),
          expires_at: None,
        },
      );
      drop(locks);
      let _ = crate::events::emit(
        "profile-lock-changed",
        serde_json::json!({ "profileId": profile_id, "action": "acquired" }),
      );
      return Ok(());
    }

    // Verifiably held by another device → block the launch.
    let holder = body
      .locked_by_name
      .filter(|s| !s.is_empty())
      .unwrap_or_else(|| "another device".to_string());
    {
      let mut locks = self.locks.write().await;
      locks.insert(
        profile_id.to_string(),
        ProfileLockInfo {
          profile_id: profile_id.to_string(),
          locked_by: body.locked_by.unwrap_or_default(),
          locked_by_email: holder.clone(),
          locked_at: chrono::Utc::now().to_rfc3339(),
          expires_at: None,
        },
      );
    }
    Err(
      serde_json::json!({
        "code": "PROFILE_IN_USE_ON_DEVICE",
        "params": { "device": holder }
      })
      .to_string(),
    )
  }

  async fn release_lock_self_hosted(&self, cfg: &SelfHostedLockConfig, profile_id: &str) {
    let _ = Self::lock_http()
      .post(format!("{}/v1/locks/release", cfg.base_url))
      .header("Authorization", format!("Bearer {}", cfg.token))
      .json(&LockRefRequest {
        profile_id: profile_id.to_string(),
        device_id: device_id(),
      })
      .send()
      .await;

    {
      let mut locks = self.locks.write().await;
      locks.remove(profile_id);
    }
    let _ = crate::events::emit(
      "profile-lock-changed",
      serde_json::json!({ "profileId": profile_id, "action": "released" }),
    );
  }

  async fn heartbeat_self_hosted(&self, cfg: &SelfHostedLockConfig, profile_id: &str) {
    let _ = Self::lock_http()
      .post(format!("{}/v1/locks/heartbeat", cfg.base_url))
      .header("Authorization", format!("Bearer {}", cfg.token))
      .json(&LockRefRequest {
        profile_id: profile_id.to_string(),
        device_id: device_id(),
      })
      .send()
      .await;
  }

  async fn fetch_locks_self_hosted(&self, cfg: &SelfHostedLockConfig) -> Result<(), String> {
    let resp = Self::lock_http()
      .post(format!("{}/v1/locks/list", cfg.base_url))
      .header("Authorization", format!("Bearer {}", cfg.token))
      .json(&serde_json::json!({}))
      .send()
      .await
      .map_err(|e| format!("Failed to fetch locks: {e}"))?;

    if !resp.status().is_success() {
      return Err(format!("Failed to fetch locks: HTTP {}", resp.status()));
    }

    let list: LocksListResponse = resp
      .json()
      .await
      .map_err(|e| format!("Failed to parse locks: {e}"))?;

    let mut locks = self.locks.write().await;
    locks.clear();
    for entry in list.locks {
      locks.insert(
        entry.profile_id.clone(),
        ProfileLockInfo {
          profile_id: entry.profile_id,
          locked_by: entry.device_id,
          locked_by_email: entry.device_name,
          locked_at: entry.heartbeat_at.clone(),
          expires_at: None,
        },
      );
    }
    Ok(())
  }

  async fn fetch_locks(&self) -> Result<(), String> {
    let client = Client::new();
    let access_token =
      CloudAuthManager::load_access_token()?.ok_or_else(|| "Not logged in".to_string())?;

    let url = format!("{CLOUD_API_URL}/api/profile-locks");
    let response = client
      .get(&url)
      .header("Authorization", format!("Bearer {access_token}"))
      .send()
      .await
      .map_err(|e| format!("Failed to fetch locks: {e}"))?;

    if !response.status().is_success() {
      return Err("Failed to fetch locks".to_string());
    }

    let lock_list: Vec<ProfileLockInfo> = response
      .json()
      .await
      .map_err(|e| format!("Failed to parse locks: {e}"))?;

    let mut locks = self.locks.write().await;
    locks.clear();
    for lock in lock_list {
      locks.insert(lock.profile_id.clone(), lock);
    }

    Ok(())
  }

  async fn start_heartbeat_loop(&self) {
    let mut handle = self.heartbeat_handle.lock().await;
    if let Some(h) = handle.take() {
      h.abort();
    }

    let h = tokio::spawn(async move {
      loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        if !PROFILE_LOCK.is_connected().await {
          break;
        }

        if CLOUD_AUTH.is_logged_in().await {
          // Cloud mode: heartbeat each lock held by this USER via the cloud API.
          let held_locks: Vec<String> = {
            let locks = PROFILE_LOCK.locks.read().await;
            if let Some(user) = CLOUD_AUTH.get_user().await {
              locks
                .values()
                .filter(|l| l.locked_by == user.user.id)
                .map(|l| l.profile_id.clone())
                .collect()
            } else {
              vec![]
            }
          };

          for profile_id in held_locks {
            let client = Client::new();
            if let Ok(Some(token)) = CloudAuthManager::load_access_token() {
              let url = format!("{CLOUD_API_URL}/api/profile-locks/{profile_id}/heartbeat");
              let _ = client
                .post(&url)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await;
            }
          }
        } else if let Some(cfg) = self_hosted_config() {
          // Self-hosted mode: heartbeat each lock held by this DEVICE. A lock
          // that stops being heartbeated (crash / power loss) goes stale on the
          // server after 90s and the other machine can take it over.
          let held_locks: Vec<String> = {
            let locks = PROFILE_LOCK.locks.read().await;
            let me = device_id();
            locks
              .values()
              .filter(|l| l.locked_by == me)
              .map(|l| l.profile_id.clone())
              .collect()
          };

          for profile_id in held_locks {
            PROFILE_LOCK.heartbeat_self_hosted(&cfg, &profile_id).await;
          }
        }

        // Refresh lock state from whichever backend applies
        if let Err(e) = PROFILE_LOCK.fetch_locks_any().await {
          log::debug!("Failed to refresh profile locks: {e}");
        }
      }
    });

    *handle = Some(h);
  }
}

/// Acquire the cross-device profile lock before a launch. Cloud mode uses the
/// cloud lock API (paid feature, unchanged); self-hosted token-mode sync uses
/// the donut-sync server's `/v1/locks/*`. Called from EVERY launch entry point
/// (GUI, MCP, API), so a profile open on one device cannot be opened on
/// another — the concurrent-use pattern that produced sync conflicts and eaten
/// logins.
pub async fn acquire_team_lock_if_needed(
  profile: &crate::profile::BrowserProfile,
) -> Result<(), String> {
  if !profile.is_sync_enabled() {
    return Ok(());
  }

  // Cloud path (unchanged): requires a paid subscription.
  if CLOUD_AUTH.has_active_paid_subscription().await {
    // Ensure lock manager is connected
    if !PROFILE_LOCK.is_connected().await {
      PROFILE_LOCK.connect().await;
    }

    if PROFILE_LOCK
      .is_locked_by_another(&profile.id.to_string())
      .await
    {
      if let Some(lock) = PROFILE_LOCK.get_lock_status(&profile.id.to_string()).await {
        return Err(format!("Profile is in use by {}", lock.locked_by_email));
      }
      return Err("Profile is in use on another device".to_string());
    }

    return PROFILE_LOCK.acquire_lock(&profile.id.to_string()).await;
  }

  // Self-hosted path: the server-side acquire is authoritative (it atomically
  // checks-and-takes), so no local pre-check is needed.
  if !CLOUD_AUTH.is_logged_in().await {
    if let Some(cfg) = self_hosted_config() {
      if !PROFILE_LOCK.is_connected().await {
        PROFILE_LOCK.connect().await;
      }
      return PROFILE_LOCK
        .acquire_lock_self_hosted(&cfg, &profile.id.to_string())
        .await;
    }
  }

  Ok(())
}

/// Release the cross-device profile lock after a stop (explicit kill AND
/// natural browser exit both route here).
pub async fn release_team_lock_if_needed(profile: &crate::profile::BrowserProfile) {
  if !profile.is_sync_enabled() {
    return;
  }

  if CLOUD_AUTH.has_active_paid_subscription().await {
    if let Err(e) = PROFILE_LOCK.release_lock(&profile.id.to_string()).await {
      log::warn!("Failed to release profile lock for {}: {e}", profile.id);
    }
    return;
  }

  if !CLOUD_AUTH.is_logged_in().await {
    if let Some(cfg) = self_hosted_config() {
      PROFILE_LOCK
        .release_lock_self_hosted(&cfg, &profile.id.to_string())
        .await;
    }
  }
}

// --- Tauri commands ---

#[tauri::command]
pub async fn get_team_locks() -> Result<Vec<ProfileLockInfo>, String> {
  Ok(PROFILE_LOCK.get_locks().await)
}

#[tauri::command]
pub async fn get_team_lock_status(profile_id: String) -> Result<Option<ProfileLockInfo>, String> {
  Ok(PROFILE_LOCK.get_lock_status(&profile_id).await)
}
