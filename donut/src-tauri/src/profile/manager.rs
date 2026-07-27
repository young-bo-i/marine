use crate::api_client::is_browser_version_nightly;
use crate::browser::{create_browser, BrowserType, ProxySettings};
use crate::camoufox_manager::CamoufoxConfig;
use crate::cloud_auth::CLOUD_AUTH;
use crate::downloaded_browsers_registry::DownloadedBrowsersRegistry;
use crate::events;
use crate::profile::types::{get_host_os, BrowserProfile, SyncMode};
use crate::proxy_manager::PROXY_MANAGER;
use crate::wayfern_manager::WayfernConfig;
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
use url::Url;

fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
  let tmp = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
    Some(ext) => format!("{ext}.tmp"),
    None => "tmp".to_string(),
  });
  {
    let mut f = fs::File::create(&tmp)?;
    use std::io::Write;
    f.write_all(data)?;
    f.sync_all()?;
  }
  fs::rename(&tmp, path)
}

/// The `tags` array of an already-stored profile, without deserializing the rest
/// of it — a `metadata.json` is tens of KB because `wayfern_config.fingerprint`
/// alone is ~48 KB, and `save_profile` only needs to know whether the tag set
/// moved.
///
/// `None` means "unknown" (absent, unreadable or unparsable file), which the
/// caller must treat as "assume changed" so a corrupt file still heals on the
/// next save, exactly as it did when the rebuild was unconditional.
fn stored_tags(metadata_file: &Path) -> Option<Vec<String>> {
  #[derive(serde::Deserialize)]
  struct TagsOnly {
    #[serde(default)]
    tags: Vec<String>,
  }
  let content = fs::read_to_string(metadata_file).ok()?;
  serde_json::from_str::<TagsOnly>(&content)
    .ok()
    .map(|parsed| parsed.tags)
}

pub struct ProfileManager {
  camoufox_manager: &'static crate::camoufox_manager::CamoufoxManager,
  wayfern_manager: &'static crate::wayfern_manager::WayfernManager,
}

impl ProfileManager {
  fn new() -> Self {
    Self {
      camoufox_manager: crate::camoufox_manager::CamoufoxManager::instance(),
      wayfern_manager: crate::wayfern_manager::WayfernManager::instance(),
    }
  }

  pub fn instance() -> &'static ProfileManager {
    &PROFILE_MANAGER
  }

  pub fn get_profiles_dir(&self) -> PathBuf {
    crate::app_dirs::profiles_dir()
  }

  pub fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  fn normalize_launch_hook(
    launch_hook: Option<String>,
  ) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let Some(raw) = launch_hook else {
      return Ok(None);
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
      return Ok(None);
    }

    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid launch hook URL: {e}"))?;
    match parsed.scheme() {
      "http" | "https" => Ok(Some(parsed.to_string())),
      _ => Err("Launch hook URL must use http or https".into()),
    }
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn create_profile_with_group(
    &self,
    app_handle: &tauri::AppHandle,
    name: &str,
    browser: &str,
    version: &str,
    release_type: &str,
    proxy_id: Option<String>,
    vpn_id: Option<String>,
    camoufox_config: Option<CamoufoxConfig>,
    wayfern_config: Option<WayfernConfig>,
    group_id: Option<String>,
    ephemeral: bool,
    dns_blocklist: Option<String>,
    launch_hook: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    if proxy_id.is_some() && vpn_id.is_some() {
      return Err("Cannot set both proxy_id and vpn_id".into());
    }

    let launch_hook = Self::normalize_launch_hook(launch_hook)?;

    // Sync cloud proxy credentials if the profile uses a cloud or cloud-derived proxy
    if let Some(ref pid) = proxy_id {
      if PROXY_MANAGER.is_cloud_or_derived(pid) || pid == crate::proxy_manager::CLOUD_PROXY_ID {
        log::info!("Syncing cloud proxy credentials before profile creation");
        CLOUD_AUTH.sync_cloud_proxy().await;
      }
    }

    log::info!("Attempting to create profile: {name}");

    // Check if a profile with this name already exists (case insensitive)
    let existing_profiles = self.list_profiles()?;
    if existing_profiles
      .iter()
      .any(|p| p.name.to_lowercase() == name.to_lowercase())
    {
      return Err(format!("Profile with name '{name}' already exists").into());
    }

    // Generate a new UUID for this profile
    let profile_id = uuid::Uuid::new_v4();
    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile_id.to_string());
    let profile_data_dir = profile_uuid_dir.join("profile");
    let profile_file = profile_uuid_dir.join("metadata.json");

    // Create profile directory with UUID and profile subdirectory
    create_dir_all(&profile_uuid_dir)?;
    if !ephemeral {
      create_dir_all(&profile_data_dir)?;
    }

    // For Camoufox profiles, generate fingerprint during creation
    let final_camoufox_config = if browser == "camoufox" {
      let mut config = camoufox_config.unwrap_or_else(|| {
        log::info!("Creating default Camoufox config for profile: {name}");
        crate::camoufox_manager::CamoufoxConfig::default()
      });

      // Pass upstream proxy information to config for fingerprint generation
      if let Some(proxy_id_ref) = &proxy_id {
        if let Some(proxy_settings) = PROXY_MANAGER.get_proxy_settings_by_id(proxy_id_ref) {
          // For fingerprint generation, pass upstream proxy directly with credentials if present
          let proxy_url = if let (Some(username), Some(password)) =
            (&proxy_settings.username, &proxy_settings.password)
          {
            format!(
              "{}://{}:{}@{}:{}",
              proxy_settings.proxy_type.to_lowercase(),
              username,
              password,
              proxy_settings.host,
              proxy_settings.port
            )
          } else {
            format!(
              "{}://{}:{}",
              proxy_settings.proxy_type.to_lowercase(),
              proxy_settings.host,
              proxy_settings.port
            )
          };
          config.proxy = Some(proxy_url);
          log::info!(
            "Using upstream proxy for Camoufox fingerprint generation: {}://{}:{}",
            proxy_settings.proxy_type.to_lowercase(),
            proxy_settings.host,
            proxy_settings.port
          );
        }
      }

      // Generate fingerprint if not already provided
      if config.fingerprint.is_none() {
        log::info!("Generating fingerprint for Camoufox profile: {name}");

        // Use the camoufox launcher to generate the config

        // Create a temporary profile for fingerprint generation
        let temp_profile = BrowserProfile {
          id: uuid::Uuid::new_v4(),
          name: name.to_string(),
          browser: browser.to_string(),
          version: version.to_string(),
          proxy_id: proxy_id.clone(),
          vpn_id: None,
          launch_hook: launch_hook.clone(),
          process_id: None,
          last_launch: None,
          release_type: release_type.to_string(),
          camoufox_config: None,
          wayfern_config: None,
          group_id: group_id.clone(),
          tags: Vec::new(),
          note: None,
          sync_mode: SyncMode::Disabled,
          encryption_salt: None,
          last_sync: None,
          host_os: None,
          ephemeral: false,
          extension_group_id: None,
          brand_id: None,
          proxy_bypass_rules: Vec::new(),
          created_by_id: None,
          created_by_email: None,
          dns_blocklist: None,
          password_protected: false,
          created_at: None,
          updated_at: None,
          default_bookmarks_seeded: false,
        };

        match self
          .camoufox_manager
          .generate_fingerprint_config(app_handle, &temp_profile, &config)
          .await
        {
          Ok(generated_fingerprint) => {
            config.fingerprint = Some(generated_fingerprint);
            log::info!("Successfully generated fingerprint for profile: {name}");
          }
          Err(e) => {
            return Err(
              format!("Failed to generate fingerprint for Camoufox profile '{name}': {e}").into(),
            );
          }
        }
      } else {
        log::info!("Using provided fingerprint for Camoufox profile: {name}");
      }

      // Clear the proxy from config after fingerprint generation
      // Browser launch should always use local proxy, never direct to upstream
      config.proxy = None;

      Some(config)
    } else {
      camoufox_config.clone()
    };

    // For Wayfern profiles, generate fingerprint during creation
    let final_wayfern_config = if browser == "wayfern" {
      let mut config = wayfern_config.unwrap_or_else(|| {
        log::info!("Creating default Wayfern config for profile: {name}");
        crate::wayfern_manager::WayfernConfig::default()
      });

      // Always ensure executable_path is set to the user's binary location
      // Pass upstream proxy information to config for fingerprint generation
      if let Some(proxy_id_ref) = &proxy_id {
        if let Some(proxy_settings) = PROXY_MANAGER.get_proxy_settings_by_id(proxy_id_ref) {
          let proxy_url = if let (Some(username), Some(password)) =
            (&proxy_settings.username, &proxy_settings.password)
          {
            format!(
              "{}://{}:{}@{}:{}",
              proxy_settings.proxy_type.to_lowercase(),
              username,
              password,
              proxy_settings.host,
              proxy_settings.port
            )
          } else {
            format!(
              "{}://{}:{}",
              proxy_settings.proxy_type.to_lowercase(),
              proxy_settings.host,
              proxy_settings.port
            )
          };
          config.proxy = Some(proxy_url);
          log::info!(
            "Using upstream proxy for Wayfern fingerprint generation: {}://{}:{}",
            proxy_settings.proxy_type.to_lowercase(),
            proxy_settings.host,
            proxy_settings.port
          );
        }
      }

      // Generate fingerprint if not already provided
      if config.fingerprint.is_none() {
        log::info!("Generating fingerprint for Wayfern profile: {name}");

        // Create a temporary profile for fingerprint generation
        let temp_profile = BrowserProfile {
          id: uuid::Uuid::new_v4(),
          name: name.to_string(),
          browser: browser.to_string(),
          version: version.to_string(),
          proxy_id: proxy_id.clone(),
          vpn_id: None,
          launch_hook: launch_hook.clone(),
          process_id: None,
          last_launch: None,
          release_type: release_type.to_string(),
          camoufox_config: None,
          wayfern_config: None,
          group_id: group_id.clone(),
          tags: Vec::new(),
          note: None,
          sync_mode: SyncMode::Disabled,
          encryption_salt: None,
          last_sync: None,
          host_os: None,
          ephemeral: false,
          extension_group_id: None,
          brand_id: None,
          proxy_bypass_rules: Vec::new(),
          created_by_id: None,
          created_by_email: None,
          dns_blocklist: None,
          password_protected: false,
          created_at: None,
          updated_at: None,
          default_bookmarks_seeded: false,
        };

        match self
          .wayfern_manager
          .generate_fingerprint_config(app_handle, &temp_profile, &config)
          .await
        {
          Ok(generated_fingerprint) => {
            config.fingerprint = Some(generated_fingerprint);
            log::info!("Successfully generated fingerprint for Wayfern profile: {name}");
          }
          Err(e) => {
            return Err(
              format!("Failed to generate fingerprint for Wayfern profile '{name}': {e}").into(),
            );
          }
        }
      } else {
        log::info!("Using provided fingerprint for Wayfern profile: {name}");
      }

      // Record which proxy/geoip the fingerprint's location data was computed
      // for. On launch this is compared against the profile's current routing
      // so a proxy that was changed after creation triggers a location refresh
      // instead of showing a stale timezone.
      config.geo_proxy_signature = Some(crate::wayfern_manager::WayfernManager::geo_signature(
        proxy_id
          .as_ref()
          .and_then(|id| PROXY_MANAGER.get_proxy_settings_by_id(id))
          .as_ref(),
        None,
        config.geoip.as_ref(),
      ));

      // Clear the proxy from config after fingerprint generation
      config.proxy = None;

      Some(config)
    } else {
      wayfern_config.clone()
    };

    let profile = BrowserProfile {
      id: profile_id,
      name: name.to_string(),
      browser: browser.to_string(),
      version: version.to_string(),
      proxy_id: proxy_id.clone(),
      vpn_id: vpn_id.clone(),
      launch_hook,
      process_id: None,
      last_launch: None,
      release_type: release_type.to_string(),
      camoufox_config: final_camoufox_config,
      wayfern_config: final_wayfern_config,
      group_id: group_id.clone(),
      tags: Vec::new(),
      note: None,
      sync_mode: SyncMode::Disabled,
      encryption_salt: None,
      last_sync: None,
      host_os: Some(get_host_os()),
      ephemeral,
      extension_group_id: None,
      brand_id: None,
      proxy_bypass_rules: Vec::new(),
      created_by_id: None,
      created_by_email: None,
      dns_blocklist,
      password_protected: false,
      created_at: Some(
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_secs())
          .unwrap_or(0),
      ),
      updated_at: Some(crate::proxy_manager::now_secs()),
      default_bookmarks_seeded: false,
    };

    // Save profile info
    self.save_profile(&profile)?;

    // Verify the profile was saved correctly
    if !profile_file.exists() {
      return Err(format!("Failed to create profile file for '{name}'").into());
    }

    log::info!("Profile '{name}' created successfully with ID: {profile_id}");

    // `apply_proxy_settings_to_profile` writes a Firefox-style user.js
    // with the upstream proxy host. That is wrong for both supported
    // browser types:
    // - Camoufox: camoufox_manager rewrites user.js at every launch with
    //   the local donut-proxy host; writing the upstream here leaves a
    //   stale, wrong proxy in user.js until the next launch.
    // - Wayfern: Chromium gets its proxy via `--proxy-pac-url=` at launch
    //   (see wayfern_manager.rs) and never reads user.js.
    // So we only call it for any unrecognized browser type that might be
    // a true Firefox-family target (none currently). Ephemeral profiles
    // skip regardless because their data dir is created at launch time.
    if !ephemeral && !matches!(browser, "camoufox" | "wayfern") {
      if let Some(proxy_id_ref) = &proxy_id {
        if let Some(proxy_settings) = PROXY_MANAGER.get_proxy_settings_by_id(proxy_id_ref) {
          self.apply_proxy_settings_to_profile(&profile_data_dir, &proxy_settings, None)?;
        } else {
          // Proxy ID provided but not found, disable proxy
          self.disable_proxy_settings_in_profile(&profile_data_dir)?;
        }
      } else {
        // Create user.js with common Firefox preferences but no proxy
        self.disable_proxy_settings_in_profile(&profile_data_dir)?;
      }
    }

    // Emit profile creation event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn save_profile(&self, profile: &BrowserProfile) -> Result<(), Box<dyn std::error::Error>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
    let profile_file = profile_uuid_dir.join("metadata.json");

    // Ensure the UUID directory exists
    create_dir_all(&profile_uuid_dir)?;

    // Read the previous tag set BEFORE overwriting the file.
    let previous_tags = stored_tags(&profile_file);

    let json = serde_json::to_string_pretty(profile)?;
    atomic_write(&profile_file, json.as_bytes())?;

    // Rebuilding tag suggestions rescans every profile on disk, so doing it after
    // ANY save made save_profile O(P) — and every caller that saves in a loop or
    // fans out concurrently O(P^2), all of it serialized on this std mutex. The
    // tag set can only move when this profile's `tags` moved, so gate on that.
    // A missing/corrupt previous file counts as "changed" to preserve the old
    // heal-on-any-save behaviour. Profile DELETION shrinks the set with no save
    // behind it and still rebuilds explicitly in `delete_profile`.
    let tags_changed = previous_tags
      .map(|previous| previous != profile.tags)
      .unwrap_or(true);
    if tags_changed {
      let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
        let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
      });
    }

    Ok(())
  }

  /// Read one profile out of its UUID directory. Shared by `list_profiles` and
  /// `get_profile_by_id` so the `host_os` backfill lives in exactly one place.
  /// Returns `None` (with a warning) for anything unreadable, which is what makes
  /// one corrupt profile skippable instead of fatal.
  fn read_profile_dir(path: &Path) -> Option<BrowserProfile> {
    let metadata_file = path.join("metadata.json");
    if !metadata_file.exists() {
      return None;
    }

    let content = match fs::read_to_string(&metadata_file) {
      Ok(c) => c,
      Err(e) => {
        log::warn!(
          "Skipping profile at {}: failed to read metadata.json: {e}",
          path.display()
        );
        return None;
      }
    };
    let mut profile: BrowserProfile = match serde_json::from_str(&content) {
      Ok(p) => p,
      Err(e) => {
        log::warn!(
          "Skipping profile at {}: invalid metadata.json: {e}",
          path.display()
        );
        return None;
      }
    };

    // Backfill host_os from browser config for profiles created before
    // the field existed (or synced without it).
    if profile.host_os.is_none() {
      let inferred_os = profile.resolved_os().map(str::to_string);
      if let Some(os) = inferred_os {
        profile.host_os = Some(os);
        if let Ok(json) = serde_json::to_string_pretty(&profile) {
          let _ = atomic_write(&metadata_file, json.as_bytes());
        }
      }
    }

    Some(profile)
  }

  pub fn list_profiles(&self) -> Result<Vec<BrowserProfile>, Box<dyn std::error::Error>> {
    let profiles_dir = self.get_profiles_dir();
    if !profiles_dir.exists() {
      return Ok(vec![]);
    }

    let mut profiles = Vec::new();
    for entry in fs::read_dir(profiles_dir)? {
      let entry = entry?;
      let path = entry.path();

      // Look for UUID directories containing metadata.json
      if path.is_dir() {
        if let Some(profile) = Self::read_profile_dir(&path) {
          profiles.push(profile);
        }
      }
    }

    Ok(profiles)
  }

  /// Read a single profile by id. The directory name IS the UUID at every
  /// construction site, so "list every profile and `.find()` one" is pure waste —
  /// each `metadata.json` is tens of KB and callers do this inside loops and
  /// per-request handlers.
  ///
  /// The id is canonicalized through `Uuid` before it is joined onto a path, so a
  /// caller-supplied string can neither traverse out of the profiles directory nor
  /// miss the on-disk name through casing.
  pub fn get_profile_by_id(&self, profile_id: &str) -> Option<BrowserProfile> {
    let parsed = uuid::Uuid::parse_str(profile_id).ok()?;
    let path = self.get_profiles_dir().join(parsed.to_string());
    if !path.is_dir() {
      return None;
    }
    Self::read_profile_dir(&path)
  }

  pub fn rename_profile(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    new_name: &str,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Check if new name already exists (case insensitive)
    let existing_profiles = self.list_profiles()?;
    if existing_profiles
      .iter()
      .any(|p| p.name.to_lowercase() == new_name.to_lowercase())
    {
      return Err(format!("Profile with name '{new_name}' already exists").into());
    }

    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let mut profile = existing_profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Update profile name (no need to move directories since we use UUID)
    profile.name = new_name.to_string();
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    // Save profile with new name
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // No tag rebuild here: a rename touches only `name` and `updated_at`, so the
    // tag set cannot have moved. `save_profile` rebuilds when it actually does.

    // Emit profile rename event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn delete_profile(
    &self,
    app_handle: &tauri::AppHandle,
    profile_id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Attempting to delete profile with ID: {profile_id}");

    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Check if browser is running (cross-OS profiles can't be running locally)
    if profile.process_id.is_some() && !profile.is_cross_os() {
      return Err(
        "Cannot delete profile while browser is running. Please stop the browser first.".into(),
      );
    }

    // Remember sync mode before deleting local files
    let was_sync_enabled = profile.is_sync_enabled();

    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile.id.to_string());

    // Delete the entire UUID directory (contains both metadata.json and profile data)
    if profile_uuid_dir.exists() {
      log::info!("Deleting profile directory: {}", profile_uuid_dir.display());
      fs::remove_dir_all(&profile_uuid_dir)?;
      log::info!("Profile directory deleted successfully");
    }

    // Verify deletion was successful
    if profile_uuid_dir.exists() {
      return Err(format!("Failed to completely delete profile '{}'", profile.name).into());
    }

    log::info!(
      "Profile '{}' (ID: {}) deleted successfully",
      profile.name,
      profile_id
    );

    // If sync was enabled, also delete from S3
    if was_sync_enabled {
      let profile_id_owned = profile_id.to_string();
      let app_handle_clone = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        match crate::sync::SyncEngine::create_from_settings(&app_handle_clone).await {
          Ok(engine) => {
            if let Err(e) = engine.delete_profile(&profile_id_owned).await {
              log::warn!(
                "Failed to delete profile {} from sync: {}",
                profile_id_owned,
                e
              );
            } else {
              log::info!("Profile {} deleted from S3 sync storage", profile_id_owned);
            }
          }
          Err(e) => {
            log::debug!("Sync not configured, skipping remote deletion: {}", e);
          }
        }
      });
    }

    // Rebuild tag suggestions after deletion
    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
      let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    // Always perform cleanup after profile deletion to remove unused binaries
    if let Err(e) = DownloadedBrowsersRegistry::instance().cleanup_unused_binaries() {
      log::warn!("Warning: Failed to cleanup unused binaries after profile deletion: {e}");
    }

    // Emit profile deletion event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  /// Delete a profile from the local filesystem only, without triggering remote sync deletion.
  /// Used when a profile was deleted on another device and the local copy should be cleaned up.
  pub fn delete_profile_local_only(
    &self,
    profile_id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_dir = profiles_dir.join(profile_id);
    if profile_dir.exists() {
      fs::remove_dir_all(&profile_dir)?;
      log::info!("Deleted local profile {} (tombstoned remotely)", profile_id);
    }

    if let Err(e) = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance()
      .cleanup_unused_binaries()
    {
      log::warn!("Failed to cleanup binaries after tombstone deletion: {e}");
    }

    let _ = crate::events::emit_empty("profiles-changed");
    Ok(())
  }

  pub fn update_profile_version(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    version: &str,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Check if the browser is currently running
    if profile.process_id.is_some() {
      return Err(
        "Cannot update version while browser is running. Please stop the browser first.".into(),
      );
    }

    // Verify the new version is downloaded
    let browser_type = BrowserType::from_str(&profile.browser)
      .map_err(|_| format!("Invalid browser type: {}", profile.browser))?;
    let browser = create_browser(browser_type.clone());
    let binaries_dir = self.get_binaries_dir();

    if !browser.is_version_downloaded(version, &binaries_dir) {
      return Err(format!("Browser version {version} is not downloaded").into());
    }

    // Update version
    profile.version = version.to_string();

    // Update the release_type based on the version and browser
    profile.release_type = if is_browser_version_nightly(&profile.browser, version, None) {
      "nightly".to_string()
    } else {
      "stable".to_string()
    };

    // Save the updated profile
    self.save_profile(&profile)?;

    // Emit profile update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn assign_profiles_to_group(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_ids: Vec<String>,
    group_id: Option<String>,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;

    for profile_id in profile_ids {
      let profile_uuid = uuid::Uuid::parse_str(&profile_id)
        .map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
      let mut profile = profiles
        .iter()
        .find(|p| p.id == profile_uuid)
        .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?
        .clone();

      // Check if browser is running
      if profile.process_id.is_some() {
        return Err(format!(
          "Cannot modify group for profile '{}' while browser is running. Please stop the browser first.", profile.name
        ).into());
      }

      profile.group_id = group_id.clone();
      profile.updated_at = Some(crate::proxy_manager::now_secs());
      self.save_profile(&profile)?;

      crate::sync::queue_profile_sync_if_eligible(&profile);

      // Auto-enable sync for new group if profile has sync enabled
      if profile.is_sync_enabled() {
        if let Some(ref new_group_id) = group_id {
          let group_id_clone = new_group_id.clone();
          tauri::async_runtime::spawn(async move {
            let _ = crate::sync::enable_group_sync_if_needed(&group_id_clone).await;
            if let Some(scheduler) = crate::sync::get_global_scheduler() {
              scheduler.queue_group_sync(group_id_clone).await;
            }
          });
        }
      }
    }

    // No tag rebuild here: group assignment touches only `group_id` and
    // `updated_at`. `save_profile` rebuilds when the tag set actually moves.

    // Emit profile group assignment event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  pub fn update_profile_tags(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    tags: Vec<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<String> = Vec::with_capacity(tags.len());
    for t in tags.into_iter() {
      if seen.insert(t.clone()) {
        deduped.push(t);
      }
    }
    profile.tags = deduped;
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    // Save profile
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // No rebuild here: this is THE path that changes tags, so the `save_profile`
    // above always rebuilds. Keeping a second one would make the one legitimate
    // rebuild path scan every profile twice.

    // Emit profile tags update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_note(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    note: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Update note (trim whitespace, set to None if empty)
    profile.note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    // Save profile
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Emit profile note update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_launch_hook(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    launch_hook: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.launch_hook = Self::normalize_launch_hook(launch_hook)?;
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_proxy_bypass_rules(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    rules: Vec<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.proxy_bypass_rules = rules;
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_dns_blocklist(
    &self,
    profile_id: &str,
    dns_blocklist: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.dns_blocklist = dns_blocklist;
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn delete_multiple_profiles(
    &self,
    app_handle: &tauri::AppHandle,
    profile_ids: Vec<String>,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;
    let mut sync_enabled_ids: Vec<String> = Vec::new();

    for profile_id in profile_ids {
      let profile_uuid = uuid::Uuid::parse_str(&profile_id)
        .map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
      let profile = profiles
        .iter()
        .find(|p| p.id == profile_uuid)
        .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

      // Check if browser is running (cross-OS profiles can't be running locally)
      if profile.process_id.is_some() && !profile.is_cross_os() {
        return Err(
          format!(
            "Cannot delete profile '{}' while browser is running. Please stop the browser first.",
            profile.name
          )
          .into(),
        );
      }

      // Track sync-enabled profiles for remote deletion
      if profile.is_sync_enabled() {
        sync_enabled_ids.push(profile_id.clone());
      }

      // Delete the profile
      let profiles_dir = self.get_profiles_dir();
      let profile_uuid_dir = profiles_dir.join(profile.id.to_string());

      if profile_uuid_dir.exists() {
        std::fs::remove_dir_all(&profile_uuid_dir)?;
      }
    }

    // Delete sync-enabled profiles from S3
    if !sync_enabled_ids.is_empty() {
      let app_handle_clone = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        if let Ok(engine) = crate::sync::SyncEngine::create_from_settings(&app_handle_clone).await {
          for profile_id in sync_enabled_ids {
            if let Err(e) = engine.delete_profile(&profile_id).await {
              log::warn!("Failed to delete profile {} from sync: {}", profile_id, e);
            }
          }
        }
      });
    }

    // Emit profile deletion event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  fn generate_clone_name(&self, original_name: &str) -> Result<String, Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;
    let existing_names: std::collections::HashSet<String> =
      profiles.iter().map(|p| p.name.clone()).collect();

    let candidate = format!("{original_name} (Copy)");
    if !existing_names.contains(&candidate) {
      return Ok(candidate);
    }

    for i in 2.. {
      let candidate = format!("{original_name} (Copy {i})");
      if !existing_names.contains(&candidate) {
        return Ok(candidate);
      }
    }

    unreachable!()
  }

  pub fn clone_profile(
    &self,
    profile_id: &str,
    custom_name: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let source = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    if source.process_id.is_some() {
      return Err(
        "Cannot clone profile while browser is running. Please stop the browser first.".into(),
      );
    }

    let new_id = uuid::Uuid::new_v4();
    let clone_name = match custom_name {
      Some(name) if !name.trim().is_empty() => name.trim().to_string(),
      _ => self.generate_clone_name(&source.name)?,
    };

    let profiles_dir = self.get_profiles_dir();
    let source_dir = profiles_dir.join(source.id.to_string());
    let dest_dir = profiles_dir.join(new_id.to_string());

    if source_dir.exists() {
      crate::profile_importer::ProfileImporter::copy_directory_recursive(&source_dir, &dest_dir)?;
    } else {
      fs::create_dir_all(&dest_dir)?;
    }

    let mut new_profile = BrowserProfile {
      id: new_id,
      name: clone_name,
      browser: source.browser,
      version: source.version,
      proxy_id: source.proxy_id,
      vpn_id: source.vpn_id,
      launch_hook: source.launch_hook,
      process_id: None,
      last_launch: None,
      release_type: source.release_type,
      camoufox_config: source.camoufox_config,
      wayfern_config: source.wayfern_config,
      group_id: source.group_id,
      tags: source.tags,
      note: source.note,
      sync_mode: SyncMode::Disabled,
      encryption_salt: None,
      last_sync: None,
      host_os: Some(get_host_os()),
      ephemeral: false,
      extension_group_id: source.extension_group_id,
      brand_id: source.brand_id,
      proxy_bypass_rules: source.proxy_bypass_rules,
      created_by_id: None,
      created_by_email: None,
      dns_blocklist: source.dns_blocklist,
      password_protected: false,
      created_at: Some(
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_secs())
          .unwrap_or(0),
      ),
      updated_at: Some(crate::proxy_manager::now_secs()),
      default_bookmarks_seeded: false,
    };

    // Donut: a clone must NOT be linkable to its source. The source
    // wayfern_config embeds the persisted fingerprint JSON (including the
    // canvas_noise_seed), so copying it verbatim makes the clone emit
    // BYTE-IDENTICAL canvas/WebGL/audio readback hashes and identical device
    // signals as the source — trivially linkable if both run concurrently. Clear
    // the fingerprint so the launch path mints a fresh one (a new
    // canvas_noise_seed via RandBytes + an independent device fingerprint),
    // exactly as create_profile does when fingerprint.is_none(). NOTE: the
    // user-data-dir copy above still duplicates cookies/localStorage/TLS state —
    // a separate storage-linkage vector the user must clear if they want full
    // isolation between a clone and its source.
    if let Some(cfg) = new_profile.wayfern_config.as_mut() {
      cfg.fingerprint = None;
    }

    self.save_profile(&new_profile)?;

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(new_profile)
  }

  pub async fn update_camoufox_config(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: &str,
    config: CamoufoxConfig,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find the profile by ID
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Check if the browser is currently running using the comprehensive status check
    let is_running = self
      .check_browser_status(app_handle.clone(), &profile)
      .await?;

    if is_running {
      return Err(
        "Cannot update Camoufox configuration while browser is running. Please stop the browser first.".into(),
      );
    }

    // Update the Camoufox configuration
    profile.camoufox_config = Some(config);

    // Save the updated profile
    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    log::info!(
      "Camoufox configuration updated for profile '{}' (ID: {}).",
      profile.name,
      profile_id
    );

    // Emit profile config update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  pub async fn update_wayfern_config(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: &str,
    config: WayfernConfig,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find the profile by ID
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Check if the browser is currently running using the comprehensive status check
    let is_running = self
      .check_browser_status(app_handle.clone(), &profile)
      .await?;

    if is_running {
      return Err(
        "Cannot update Wayfern configuration while browser is running. Please stop the browser first.".into(),
      );
    }

    // Update the Wayfern configuration
    profile.wayfern_config = Some(config);

    // Save the updated profile
    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    log::info!(
      "Wayfern configuration updated for profile '{}' (ID: {}).",
      profile.name,
      profile_id
    );

    // Emit profile config update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  pub async fn update_profile_proxy(
    &self,
    _app_handle: tauri::AppHandle,
    profile_id: &str,
    proxy_id: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    // Find the profile by ID
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;

    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Remember old proxy_id for cleanup (not used yet, but may be needed for cleanup)
    let _old_proxy_id = profile.proxy_id.clone();

    // Update proxy settings and clear VPN (mutual exclusion)
    profile.proxy_id = proxy_id.clone();
    profile.vpn_id = None;
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    // Save the updated profile
    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Auto-enable sync for new proxy if profile has sync enabled
    if profile.is_sync_enabled() {
      if let Some(ref new_proxy_id) = proxy_id {
        let _ = crate::sync::enable_proxy_sync_if_needed(new_proxy_id).await;
        if let Some(scheduler) = crate::sync::get_global_scheduler() {
          scheduler.queue_proxy_sync(new_proxy_id.clone()).await;
        }
      }
    }

    // Update on-disk browser profile config immediately.
    // Both supported browser types ignore this write (Camoufox rewrites
    // user.js at launch with the local donut-proxy host, Wayfern takes its
    // proxy via `--proxy-pac-url=` and never reads user.js), and for
    // Camoufox specifically writing the upstream host here would leave a
    // stale, wrong proxy in user.js until the next launch.
    if !matches!(profile.browser.as_str(), "camoufox" | "wayfern") {
      if let Some(proxy_id_ref) = &proxy_id {
        if let Some(proxy_settings) = PROXY_MANAGER.get_proxy_settings_by_id(proxy_id_ref) {
          let profiles_dir = self.get_profiles_dir();
          let profile_path = profiles_dir.join(profile.id.to_string()).join("profile");
          self
            .apply_proxy_settings_to_profile(&profile_path, &proxy_settings, None)
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
              format!("Failed to apply proxy settings: {e}").into()
            })?;
        } else {
          // Proxy ID provided but proxy not found, disable proxy
          let profiles_dir = self.get_profiles_dir();
          let profile_path = profiles_dir.join(profile.id.to_string()).join("profile");
          self
            .disable_proxy_settings_in_profile(&profile_path)
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
              format!("Failed to disable proxy settings: {e}").into()
            })?;
        }
      } else {
        // No proxy ID provided, disable proxy
        let profiles_dir = self.get_profiles_dir();
        let profile_path = profiles_dir.join(profile.id.to_string()).join("profile");
        self
          .disable_proxy_settings_in_profile(&profile_path)
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
            format!("Failed to disable proxy settings: {e}").into()
          })?;
      }
    }

    // Emit profile update event so frontend UIs can refresh immediately (e.g. proxy manager)
    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    // Emit general profiles changed event for profile list updates
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub async fn update_profile_vpn(
    &self,
    _app_handle: tauri::AppHandle,
    profile_id: &str,
    vpn_id: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;

    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Update VPN and clear proxy (mutual exclusion)
    profile.vpn_id = vpn_id.clone();
    profile.proxy_id = None;
    profile.updated_at = Some(crate::proxy_manager::now_secs());

    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Auto-enable sync for the new VPN if profile has sync enabled.
    if profile.is_sync_enabled() {
      if let Some(ref new_vpn_id) = vpn_id {
        let _ = crate::sync::enable_vpn_sync_if_needed(new_vpn_id).await;
        if let Some(scheduler) = crate::sync::get_global_scheduler() {
          scheduler.queue_vpn_sync(new_vpn_id.clone()).await;
        }
      }
    }

    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_extension_group(
    &self,
    profile_id: &str,
    extension_group_id: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.extension_group_id = extension_group_id.clone();
    profile.updated_at = Some(crate::proxy_manager::now_secs());
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Auto-enable sync for the new extension group if profile has sync
    // enabled. The helper is sync internally; we fire-and-forget through
    // the async runtime so any I/O doesn't block this caller.
    if profile.is_sync_enabled() {
      if let Some(new_group_id) = extension_group_id {
        tauri::async_runtime::spawn(async move {
          let _ = crate::sync::enable_extension_group_sync_if_needed(&new_group_id).await;
          if let Some(scheduler) = crate::sync::get_global_scheduler() {
            scheduler.queue_extension_group_sync(new_group_id).await;
          }
        });
      }
    }

    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Failed to emit profile update event: {e}");
    }
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub async fn check_browser_status(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    // Handle Camoufox profiles using CamoufoxManager-based status checking
    if profile.browser == "camoufox" {
      return self.check_camoufox_status(&app_handle, profile).await;
    }

    // Handle Wayfern profiles using WayfernManager-based status checking
    if profile.browser == "wayfern" {
      return self.check_wayfern_status(&app_handle, profile).await;
    }

    // For non-camoufox browsers, use the existing PID-based logic
    let inner_profile = profile.clone();
    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    let mut is_running = false;
    let mut found_pid: Option<u32> = None;

    // First check if the stored PID is still valid
    if let Some(pid) = profile.process_id {
      if let Some(process) = system.process(Pid::from(pid as usize)) {
        let cmd = process.cmd();
        // Verify this process is actually our browser with the correct profile
        let profiles_dir = self.get_profiles_dir();
        let profile_data_path = profile.get_profile_data_path(&profiles_dir);
        let profile_data_path_str = profile_data_path.to_string_lossy();
        let profile_path_match = cmd.iter().any(|s| {
          let arg = s.to_str().unwrap_or("");
          // For Firefox-based browsers, check for exact profile path match
          if profile.browser == "camoufox" {
            arg == profile_data_path_str
              || arg == format!("-profile={profile_data_path_str}")
              || (arg == "-profile"
                && cmd
                  .iter()
                  .any(|s2| s2.to_str().unwrap_or("") == profile_data_path_str))
          } else {
            // For Chromium-based browsers (Wayfern), check for user-data-dir
            arg.contains(&format!("--user-data-dir={profile_data_path_str}"))
              || arg == profile_data_path_str
          }
        });

        if profile_path_match {
          is_running = true;
          found_pid = Some(pid);
        }
      }
    }

    // If we didn't find the browser with the stored PID, search all processes
    if !is_running {
      for (pid, process) in system.processes() {
        let cmd = process.cmd();
        if cmd.len() >= 2 {
          // Check if this is the right browser executable first
          let exe_name = process.name().to_string_lossy().to_lowercase();
          let is_correct_browser = match profile.browser.as_str() {
            "camoufox" => exe_name.contains("camoufox") || exe_name.contains("firefox"),
            "wayfern" => {
              exe_name.contains("wayfern")
                || exe_name.contains("chromium")
                || exe_name.contains("chrome")
            }
            _ => false,
          };

          if !is_correct_browser {
            continue;
          }

          // Check for profile path match
          let profiles_dir = self.get_profiles_dir();
          let profile_data_path = profile.get_profile_data_path(&profiles_dir);
          let profile_data_path_str = profile_data_path.to_string_lossy();
          let profile_path_match = cmd.iter().any(|s| {
            let arg = s.to_str().unwrap_or("");
            // For Firefox-based browsers, check for exact profile path match
            if profile.browser == "camoufox" {
              arg == profile_data_path_str
                || arg == format!("-profile={profile_data_path_str}")
                || (arg == "-profile"
                  && cmd
                    .iter()
                    .any(|s2| s2.to_str().unwrap_or("") == profile_data_path_str))
            } else {
              // For Chromium-based browsers (Wayfern), check for user-data-dir
              arg.contains(&format!("--user-data-dir={profile_data_path_str}"))
                || arg == profile_data_path_str
            }
          });

          if profile_path_match {
            // Found a matching process
            found_pid = Some(pid.as_u32());
            is_running = true;
            log::info!(
              "Found browser process with PID: {} for profile: {}",
              pid.as_u32(),
              profile.name
            );
            break;
          }
        }
      }
    }

    // Only persist status changes if the profile metadata still exists on disk
    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
    let metadata_file = profile_uuid_dir.join("metadata.json");
    let metadata_exists = metadata_file.exists();

    if metadata_exists {
      // Load the latest profile from disk to avoid overwriting fields like proxy_id
      let latest_profile: BrowserProfile = match std::fs::read_to_string(&metadata_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
      {
        Some(p) => p,
        None => inner_profile.clone(),
      };

      let mut merged = latest_profile.clone();
      let mut detected_stop = false;

      if let Some(pid) = found_pid {
        if merged.process_id != Some(pid) {
          let old_pid = merged.process_id;
          merged.process_id = Some(pid);
          if let Err(e) = self.save_profile(&merged) {
            log::warn!("Warning: Failed to update profile with new PID: {e}");
          }
          if let Some(prev) = old_pid {
            let _ = crate::proxy_manager::PROXY_MANAGER.update_proxy_pid(prev, pid);
          }
        }
      } else if merged.process_id.is_some() {
        // Clear the PID if no process found
        merged.process_id = None;
        if let Err(e) = self.save_profile(&merged) {
          log::warn!("Warning: Failed to clear profile PID: {e}");
        }
        detected_stop = true;
      }

      if detected_stop {
        if let Some(updated) = crate::auto_updater::AutoUpdater::instance()
          .update_profile_to_latest_installed(&app_handle, &merged)
        {
          merged = updated;
        }
      }

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &merged) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }
    }

    Ok(is_running)
  }

  // Check Camoufox status using CamoufoxManager
  async fn check_camoufox_status(
    &self,
    app_handle: &tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let launcher = self.camoufox_manager;
    let profiles_dir = self.get_profiles_dir();
    let profile_data_path =
      crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
    let profile_path_str = profile_data_path.to_string_lossy();

    // Check if there's a running Camoufox instance for this profile
    match launcher.find_camoufox_by_profile(&profile_path_str).await {
      Ok(Some(camoufox_process)) => {
        // Found a running instance, update profile with process info if changed
        let profiles_dir = self.get_profiles_dir();
        let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
        let metadata_file = profile_uuid_dir.join("metadata.json");
        let metadata_exists = metadata_file.exists();

        if metadata_exists {
          // Load latest to avoid overwriting other fields
          let mut latest: BrowserProfile = match std::fs::read_to_string(&metadata_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
          {
            Some(p) => p,
            None => profile.clone(),
          };

          if latest.process_id != camoufox_process.processId {
            let old_pid = latest.process_id;
            latest.process_id = camoufox_process.processId;
            if let Err(e) = self.save_profile(&latest) {
              log::warn!("Warning: Failed to update Camoufox profile with process info: {e}");
            }
            if let (Some(prev), Some(new)) = (old_pid, camoufox_process.processId) {
              let _ = crate::proxy_manager::PROXY_MANAGER.update_proxy_pid(prev, new);
            }

            // Emit profile update event to frontend
            if let Err(e) = events::emit("profile-updated", &latest) {
              log::warn!("Warning: Failed to emit profile update event: {e}");
            }

            log::info!(
              "Camoufox process has started for profile '{}' with PID: {:?}",
              profile.name,
              camoufox_process.processId
            );
          }
        }
        Ok(true)
      }
      Ok(None) => {
        // No running instance found, clear process ID if set and stop proxy
        if profile.ephemeral {
          crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
        }

        let profiles_dir = self.get_profiles_dir();
        let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
        let metadata_file = profile_uuid_dir.join("metadata.json");
        let metadata_exists = metadata_file.exists();

        if metadata_exists {
          let mut latest: BrowserProfile = match std::fs::read_to_string(&metadata_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
          {
            Some(p) => p,
            None => profile.clone(),
          };

          if latest.process_id.is_some() {
            latest.process_id = None;
            if let Err(e) = self.save_profile(&latest) {
              log::warn!("Warning: Failed to clear Camoufox profile process info: {e}");
            }

            if let Some(updated) = crate::auto_updater::AutoUpdater::instance()
              .update_profile_to_latest_installed(app_handle, &latest)
            {
              latest = updated;
            }

            if let Err(e) = events::emit("profile-updated", &latest) {
              log::warn!("Warning: Failed to emit profile update event: {e}");
            }
          }
        }
        Ok(false)
      }
      Err(e) => {
        // Error checking status, assume not running and clear process ID
        log::warn!("Warning: Failed to check Camoufox status: {e}");
        if profile.ephemeral {
          crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
        }

        let profiles_dir = self.get_profiles_dir();
        let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
        let metadata_file = profile_uuid_dir.join("metadata.json");
        let metadata_exists = metadata_file.exists();

        if metadata_exists {
          let mut latest: BrowserProfile = match std::fs::read_to_string(&metadata_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
          {
            Some(p) => p,
            None => profile.clone(),
          };

          if latest.process_id.is_some() {
            latest.process_id = None;
            if let Err(e2) = self.save_profile(&latest) {
              log::warn!(
                "Warning: Failed to clear Camoufox profile process info after error: {e2}"
              );
            }

            if let Some(updated) = crate::auto_updater::AutoUpdater::instance()
              .update_profile_to_latest_installed(app_handle, &latest)
            {
              latest = updated;
            }

            // Emit profile update event to frontend
            if let Err(e3) = events::emit("profile-updated", &latest) {
              log::warn!("Warning: Failed to emit profile update event: {e3}");
            }
          }
        }
        Ok(false)
      }
    }
  }

  // Check Wayfern status using WayfernManager
  async fn check_wayfern_status(
    &self,
    app_handle: &tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let manager = self.wayfern_manager;
    let profiles_dir = self.get_profiles_dir();
    let profile_data_path =
      crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
    let profile_path_str = profile_data_path.to_string_lossy();

    // Check if there's a running Wayfern instance for this profile
    match manager.find_wayfern_by_profile(&profile_path_str).await {
      Some(wayfern_process) => {
        // Found a running instance, update profile with process info if changed
        let profiles_dir = self.get_profiles_dir();
        let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
        let metadata_file = profile_uuid_dir.join("metadata.json");
        let metadata_exists = metadata_file.exists();

        if metadata_exists {
          // Load latest to avoid overwriting other fields
          let mut latest: BrowserProfile = match std::fs::read_to_string(&metadata_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
          {
            Some(p) => p,
            None => profile.clone(),
          };

          if latest.process_id != wayfern_process.processId {
            let old_pid = latest.process_id;
            latest.process_id = wayfern_process.processId;
            if let Err(e) = self.save_profile(&latest) {
              log::warn!("Warning: Failed to update Wayfern profile with process info: {e}");
            }
            if let (Some(prev), Some(new)) = (old_pid, wayfern_process.processId) {
              let _ = crate::proxy_manager::PROXY_MANAGER.update_proxy_pid(prev, new);
            }

            // Emit profile update event to frontend
            if let Err(e) = events::emit("profile-updated", &latest) {
              log::warn!("Warning: Failed to emit profile update event: {e}");
            }

            log::info!(
              "Wayfern process has started for profile '{}' with PID: {:?}",
              profile.name,
              wayfern_process.processId
            );
          }
        }
        Ok(true)
      }
      None => {
        // No running instance found, clear process ID if set
        if profile.ephemeral {
          crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
        }

        let profiles_dir = self.get_profiles_dir();
        let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
        let metadata_file = profile_uuid_dir.join("metadata.json");
        let metadata_exists = metadata_file.exists();

        if metadata_exists {
          let mut latest: BrowserProfile = match std::fs::read_to_string(&metadata_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
          {
            Some(p) => p,
            None => profile.clone(),
          };

          if latest.process_id.is_some() {
            latest.process_id = None;
            if let Err(e) = self.save_profile(&latest) {
              log::warn!("Warning: Failed to clear Wayfern profile process info: {e}");
            }

            if let Some(updated) = crate::auto_updater::AutoUpdater::instance()
              .update_profile_to_latest_installed(app_handle, &latest)
            {
              latest = updated;
            }

            if let Err(e) = events::emit("profile-updated", &latest) {
              log::warn!("Warning: Failed to emit profile update event: {e}");
            }
          }
        }
        Ok(false)
      }
    }
  }

  fn get_common_firefox_preferences(&self) -> Vec<String> {
    vec![
      // Disable default browser check
      "user_pref(\"browser.shell.checkDefaultBrowser\", false);".to_string(),
      "user_pref(\"browser.shell.skipDefaultBrowserCheckOnFirstRun\", true);".to_string(),
      "user_pref(\"browser.preferences.moreFromMozilla\", false);".to_string(),
      "user_pref(\"services.sync.prefs.sync.browser.startup.upgradeDialog.enabled\", false);"
        .to_string(),
      // Disable welcome / first-run screens
      "user_pref(\"browser.aboutwelcome.enabled\", false);".to_string(),
      "user_pref(\"browser.startup.homepage_override.mstone\", \"ignore\");".to_string(),
      "user_pref(\"startup.homepage_welcome_url\", \"\");".to_string(),
      "user_pref(\"startup.homepage_welcome_url.additional\", \"\");".to_string(),
      "user_pref(\"startup.homepage_override_url\", \"\");".to_string(),
      // Keep extension updates enabled and allow sideloaded extensions.
      // - autoDisableScopes=0: profile-installed extensions are enabled by default.
      // - startupScanScopes=1: rescan SCOPE_PROFILE on each launch so freshly
      //   dropped .xpi files in <profile>/extensions/ get registered.
      // - signatures.required=false: accept unsigned/dev .xpi files. Camoufox
      //   is built without MOZ_REQUIRE_SIGNING so this is honored.
      "user_pref(\"extensions.update.enabled\", true);".to_string(),
      "user_pref(\"extensions.update.autoUpdateDefault\", true);".to_string(),
      "user_pref(\"extensions.autoDisableScopes\", 0);".to_string(),
      "user_pref(\"extensions.startupScanScopes\", 1);".to_string(),
      "user_pref(\"xpinstall.signatures.required\", false);".to_string(),
      // Completely disable browser update checking
      "user_pref(\"app.update.enabled\", false);".to_string(),
      "user_pref(\"app.update.auto\", false);".to_string(),
      "user_pref(\"app.update.mode\", 0);".to_string(),
      "user_pref(\"app.update.service.enabled\", false);".to_string(),
      "user_pref(\"app.update.staging.enabled\", false);".to_string(),
      "user_pref(\"app.update.silent\", true);".to_string(),
      "user_pref(\"app.update.disabledForTesting\", true);".to_string(),
      // Prevent update URL access entirely
      "user_pref(\"app.update.url\", \"\");".to_string(),
      "user_pref(\"app.update.url.manual\", \"\");".to_string(),
      "user_pref(\"app.update.url.details\", \"\");".to_string(),
      // Disable update timing/scheduling
      "user_pref(\"app.update.timerFirstInterval\", 999999999);".to_string(),
      "user_pref(\"app.update.interval\", 999999999);".to_string(),
      "user_pref(\"app.update.background.interval\", 999999999);".to_string(),
      "user_pref(\"app.update.idletime\", 999999999);".to_string(),
      "user_pref(\"app.update.promptWaitTime\", 999999999);".to_string(),
      // Disable update attempts
      "user_pref(\"app.update.download.maxAttempts\", 0);".to_string(),
      "user_pref(\"app.update.elevate.maxAttempts\", 0);".to_string(),
      "user_pref(\"app.update.checkInstallTime\", false);".to_string(),
      // Suppress update UI/prompts/notifications
      "user_pref(\"app.update.doorhanger\", false);".to_string(),
      "user_pref(\"app.update.badge\", false);".to_string(),
      "user_pref(\"app.update.notifyDuringDownload\", false);".to_string(),
      "user_pref(\"app.update.background.scheduling.enabled\", false);".to_string(),
      "user_pref(\"app.update.background.enabled\", false);".to_string(),
      // Disable BITS (Windows Background Intelligent Transfer Service) updates
      "user_pref(\"app.update.BITS.enabled\", false);".to_string(),
      // Disable language pack updates
      "user_pref(\"app.update.langpack.enabled\", false);".to_string(),
      // Suppress upgrade dialogs on startup
      "user_pref(\"browser.startup.upgradeDialog.enabled\", false);".to_string(),
      // Disable update ping telemetry
      "user_pref(\"toolkit.telemetry.updatePing.enabled\", false);".to_string(),
      // Zen browser specific - disable welcome screen and updates
      "user_pref(\"zen.welcome-screen.seen\", true);".to_string(),
      "user_pref(\"zen.updates.enabled\", false);".to_string(),
      "user_pref(\"zen.updates.check-for-updates\", false);".to_string(),
      // Additional first-run suppressions
      "user_pref(\"app.normandy.first_run\", false);".to_string(),
      "user_pref(\"trailhead.firstrun.didSeeAboutWelcome\", true);".to_string(),
      "user_pref(\"datareporting.policy.dataSubmissionPolicyBypassNotification\", true);"
        .to_string(),
      "user_pref(\"toolkit.telemetry.reportingpolicy.firstRun\", false);".to_string(),
      // Disable quit confirmation dialogs
      "user_pref(\"browser.warnOnQuit\", false);".to_string(),
      "user_pref(\"browser.showQuitWarning\", false);".to_string(),
      "user_pref(\"browser.tabs.warnOnClose\", false);".to_string(),
      "user_pref(\"browser.tabs.warnOnCloseOtherTabs\", false);".to_string(),
      "user_pref(\"browser.sessionstore.warnOnQuit\", false);".to_string(),
    ]
  }

  pub fn apply_proxy_settings_to_profile(
    &self,
    profile_data_path: &Path,
    proxy: &ProxySettings,
    internal_proxy: Option<&ProxySettings>,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let user_js_path = profile_data_path.join("user.js");
    let prefs_js_path = profile_data_path.join("prefs.js");

    // Remove prefs.js if it exists to ensure Firefox reads user.js instead
    // Firefox may cache proxy settings in prefs.js, so we need to clear it
    if prefs_js_path.exists() {
      log::info!("Removing prefs.js to ensure Firefox reads updated user.js settings");
      let _ = fs::remove_file(&prefs_js_path);
    }

    let mut preferences = Vec::new();

    // Add common Firefox preferences (like disabling default browser check)
    preferences.extend(self.get_common_firefox_preferences());

    // Determine which proxy settings to use
    let effective_proxy = internal_proxy.unwrap_or(proxy);
    let proxy_host = &effective_proxy.host;
    let proxy_port = effective_proxy.port;

    // Check if this is a SOCKS proxy (only possible when using upstream directly)
    let is_socks =
      internal_proxy.is_none() && (proxy.proxy_type == "socks4" || proxy.proxy_type == "socks5");

    log::info!(
      "Applying manual proxy settings to Firefox profile: {}:{} (is_internal: {}, is_socks: {})",
      proxy_host,
      proxy_port,
      internal_proxy.is_some(),
      is_socks
    );

    // Use MANUAL proxy configuration (type 1) instead of PAC file (type 2)
    // PAC files with file:// URLs are blocked by privacy-focused browsers like Zen
    // Manual proxy configuration works reliably across all Firefox variants
    preferences.push("user_pref(\"network.proxy.type\", 1);".to_string());

    if is_socks {
      // SOCKS proxy configuration
      preferences.extend([
        format!("user_pref(\"network.proxy.socks\", \"{}\");", proxy_host),
        format!("user_pref(\"network.proxy.socks_port\", {});", proxy_port),
        format!(
          "user_pref(\"network.proxy.socks_version\", {});",
          if proxy.proxy_type == "socks5" { 5 } else { 4 }
        ),
        "user_pref(\"network.proxy.http\", \"\");".to_string(),
        "user_pref(\"network.proxy.http_port\", 0);".to_string(),
        "user_pref(\"network.proxy.ssl\", \"\");".to_string(),
        "user_pref(\"network.proxy.ssl_port\", 0);".to_string(),
      ]);
    } else {
      // HTTP/HTTPS proxy configuration (including our internal local proxy)
      preferences.extend([
        format!("user_pref(\"network.proxy.http\", \"{}\");", proxy_host),
        format!("user_pref(\"network.proxy.http_port\", {});", proxy_port),
        format!("user_pref(\"network.proxy.ssl\", \"{}\");", proxy_host),
        format!("user_pref(\"network.proxy.ssl_port\", {});", proxy_port),
        format!("user_pref(\"network.proxy.ftp\", \"{}\");", proxy_host),
        format!("user_pref(\"network.proxy.ftp_port\", {});", proxy_port),
        "user_pref(\"network.proxy.socks\", \"\");".to_string(),
        "user_pref(\"network.proxy.socks_port\", 0);".to_string(),
      ]);
    }

    // Common proxy settings - keep it simple like proxy-chain expected
    preferences.extend([
      "user_pref(\"network.proxy.no_proxies_on\", \"\");".to_string(),
      "user_pref(\"network.proxy.autoconfig_url\", \"\");".to_string(),
      // Disable QUIC/HTTP3 - it bypasses HTTP proxy
      "user_pref(\"network.http.http3.enable\", false);".to_string(),
      "user_pref(\"network.http.http3.enabled\", false);".to_string(),
    ]);

    // Write settings to user.js file
    let user_js_content = preferences.join("\n");
    fs::write(user_js_path, &user_js_content)?;
    log::info!(
      "Updated user.js with manual proxy settings: {}:{}",
      proxy_host,
      proxy_port
    );

    Ok(())
  }

  pub fn disable_proxy_settings_in_profile(
    &self,
    profile_data_path: &Path,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let user_js_path = profile_data_path.join("user.js");
    let mut preferences = Vec::new();

    // Get the UUID directory (parent of profile data directory)
    let uuid_dir = profile_data_path
      .parent()
      .ok_or("Invalid profile path - cannot find UUID directory")?;

    // Add common Firefox preferences (like disabling default browser check)
    preferences.extend(self.get_common_firefox_preferences());

    preferences.push("user_pref(\"network.proxy.type\", 0);".to_string());
    preferences.push("user_pref(\"network.proxy.failover_direct\", true);".to_string());

    // Create a direct proxy PAC file in UUID directory
    let pac_content = "function FindProxyForURL(url, host) { return 'DIRECT'; }";
    let pac_path = uuid_dir.join("proxy.pac");
    fs::write(&pac_path, pac_content)?;
    let pac_url =
      url::Url::from_file_path(&pac_path).map_err(|_| "Failed to convert PAC path to file URL")?;
    preferences.push(format!(
      "user_pref(\"network.proxy.autoconfig_url\", \"{}\");",
      pac_url.as_str()
    ));

    fs::write(user_js_path, preferences.join("\n"))?;

    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  use tempfile::TempDir;

  /// Keeps the temp directory AND the `app_dirs` override alive for the whole
  /// test. Named `_temp_dir` at the call sites, so its shape is what matters.
  struct TestEnv {
    _temp_dir: TempDir,
    _data_guard: crate::app_dirs::TestDirGuard,
  }

  impl TestEnv {
    fn path(&self) -> &Path {
      self._temp_dir.path()
    }
  }

  fn create_test_profile_manager() -> (&'static ProfileManager, TestEnv) {
    let temp_dir = TempDir::new().unwrap();

    // NOT `set_var("HOME", ...)`: `app_dirs` caches `BaseDirs` in a `OnceLock`
    // (app_dirs.rs:5-10), so once any test in this binary has resolved a real
    // path, HOME is never consulted again — and every later test wrote straight
    // into the developer's actual application-support directory. Anything that
    // asserted on shared state (tags.json) then saw the real machine's data.
    //
    // `set_test_data_dir` is the thread-local override built for this. It is
    // per-thread, so tests stay isolated without serializing them, and it unsets
    // itself on drop. The "Marine" component keeps the path shaped like the real
    // one for assertions that check it.
    let data_guard = crate::app_dirs::set_test_data_dir(temp_dir.path().join("Marine"));

    let profile_manager = ProfileManager::instance();
    (
      profile_manager,
      TestEnv {
        _temp_dir: temp_dir,
        _data_guard: data_guard,
      },
    )
  }

  #[test]
  fn test_profile_manager_creation() {
    let (_manager, _temp_dir) = create_test_profile_manager();
    // If we get here without panicking, the test passes
  }

  fn tagged_test_profile(name: &str, tags: &[&str]) -> BrowserProfile {
    BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: name.to_string(),
      browser: "wayfern".to_string(),
      version: "1.0.0".to_string(),
      proxy_id: None,
      vpn_id: None,
      launch_hook: None,
      process_id: None,
      last_launch: None,
      release_type: "stable".to_string(),
      camoufox_config: None,
      wayfern_config: None,
      group_id: None,
      tags: tags.iter().map(|t| t.to_string()).collect(),
      note: None,
      sync_mode: SyncMode::Disabled,
      encryption_salt: None,
      last_sync: None,
      host_os: Some(get_host_os()),
      ephemeral: false,
      extension_group_id: None,
      brand_id: None,
      proxy_bypass_rules: Vec::new(),
      created_by_id: None,
      created_by_email: None,
      dns_blocklist: None,
      password_protected: false,
      created_at: Some(0),
      updated_at: Some(0),
      default_bookmarks_seeded: false,
    }
  }

  /// `save_profile` used to rescan every profile on disk after ANY save, which
  /// made it O(P) and every loop/fan-out over it O(P^2). The rebuild is now gated
  /// on the tag set actually moving. Deleting `tags.json` between saves makes the
  /// rebuild directly observable: only a save that changes tags recreates it.
  #[test]
  fn save_profile_rebuilds_tags_only_when_the_tag_set_moves() {
    let (manager, _temp_dir) = create_test_profile_manager();
    let tags_file = crate::app_dirs::data_subdir().join("tags.json");

    let mut profile = tagged_test_profile("tagged", &["alpha", "beta"]);
    manager.save_profile(&profile).unwrap();
    assert!(
      tags_file.exists(),
      "the first save of a profile must build the tag suggestions"
    );

    // A save that leaves `tags` alone (the overwhelmingly common case: last_sync
    // stamps, PID writes, proxy/group edits) must not rebuild.
    fs::remove_file(&tags_file).unwrap();
    profile.last_sync = Some(1_700_000_000);
    manager.save_profile(&profile).unwrap();
    assert!(
      !tags_file.exists(),
      "a save that does not change tags must not rescan every profile"
    );

    // Growing the set must rebuild...
    profile.tags.push("gamma".to_string());
    manager.save_profile(&profile).unwrap();
    let after_growth = crate::tag_manager::TAG_MANAGER
      .lock()
      .unwrap()
      .get_all_tags()
      .unwrap();
    assert_eq!(after_growth, vec!["alpha", "beta", "gamma"]);

    // ...and so must shrinking it. This is the case an additive-only index
    // would have silently missed.
    profile.tags.retain(|t| t != "beta");
    manager.save_profile(&profile).unwrap();
    let after_shrink = crate::tag_manager::TAG_MANAGER
      .lock()
      .unwrap()
      .get_all_tags()
      .unwrap();
    assert_eq!(after_shrink, vec!["alpha", "gamma"]);
  }

  /// Renaming and group assignment had their own full rebuilds, deleted because
  /// neither can move the tag set. Pin that the suggestions survive a rename via
  /// the `save_profile` those paths already perform.
  #[test]
  fn renaming_a_tagged_profile_keeps_its_tag_suggestions() {
    let (manager, _temp_dir) = create_test_profile_manager();

    let profile = tagged_test_profile("before", &["keepme"]);
    manager.save_profile(&profile).unwrap();

    let mut renamed = profile.clone();
    renamed.name = "after".to_string();
    manager.save_profile(&renamed).unwrap();

    let tags = crate::tag_manager::TAG_MANAGER
      .lock()
      .unwrap()
      .get_all_tags()
      .unwrap();
    assert_eq!(
      tags,
      vec!["keepme"],
      "a rename must not drop tag suggestions"
    );
  }

  /// `get_profile_by_id` replaced "list every profile and .find() one" at the
  /// hot call sites. It must agree with `list_profiles` and must refuse to be
  /// walked out of the profiles directory.
  #[test]
  fn get_profile_by_id_matches_list_profiles_and_rejects_traversal() {
    let (manager, _temp_dir) = create_test_profile_manager();

    let profile = tagged_test_profile("byid", &["x"]);
    manager.save_profile(&profile).unwrap();
    let id = profile.id.to_string();

    let direct = manager
      .get_profile_by_id(&id)
      .expect("profile must be found");
    let listed = manager
      .list_profiles()
      .unwrap()
      .into_iter()
      .find(|p| p.id == profile.id)
      .expect("profile must be listed");
    assert_eq!(direct.id, listed.id);
    assert_eq!(direct.name, listed.name);
    assert_eq!(direct.tags, listed.tags);

    assert!(manager.get_profile_by_id("not-a-uuid").is_none());
    assert!(manager.get_profile_by_id("../../etc").is_none());
    assert!(manager
      .get_profile_by_id(&uuid::Uuid::new_v4().to_string())
      .is_none());
    // The on-disk directory is the canonical lowercase UUID; an uppercase id
    // must still resolve rather than silently miss.
    assert!(manager.get_profile_by_id(&id.to_uppercase()).is_some());
  }

  #[test]
  fn test_get_profiles_dir() {
    let (manager, _temp_dir) = create_test_profile_manager();
    let profiles_dir = manager.get_profiles_dir();

    assert!(
      profiles_dir.to_string_lossy().contains("Marine"),
      "Profiles dir should contain Marine"
    );
    assert!(
      profiles_dir.to_string_lossy().contains("profiles"),
      "Profiles dir should contain profiles"
    );
  }

  #[test]
  fn test_get_common_firefox_preferences() {
    let (manager, _temp_dir) = create_test_profile_manager();

    let prefs = manager.get_common_firefox_preferences();
    assert!(!prefs.is_empty(), "Should return non-empty preferences");

    // Check for some expected preferences
    let prefs_string = prefs.join("\n");
    assert!(
      prefs_string.contains("browser.shell.checkDefaultBrowser"),
      "Should contain default browser check preference"
    );
    assert!(
      prefs_string.contains("app.update.enabled"),
      "Should contain update preference"
    );
  }

  #[test]
  fn test_get_binaries_dir() {
    let (manager, _temp_dir) = create_test_profile_manager();

    let binaries_dir = manager.get_binaries_dir();
    let path_str = binaries_dir.to_string_lossy();

    assert!(
      path_str.contains("Marine"),
      "Binaries dir should contain Marine"
    );
    assert!(
      path_str.contains("binaries"),
      "Binaries dir should contain binaries"
    );
  }

  #[test]
  fn test_disable_proxy_settings_in_profile() {
    let (manager, temp_dir) = create_test_profile_manager();

    // Create a test profile directory
    let profile_dir = temp_dir.path().join("test_profile");
    fs::create_dir_all(&profile_dir).expect("Should create profile directory");

    let result = manager.disable_proxy_settings_in_profile(&profile_dir);
    assert!(result.is_ok(), "Should successfully disable proxy settings");

    // Check that user.js was created
    let user_js_path = profile_dir.join("user.js");
    assert!(user_js_path.exists(), "user.js should be created");

    let content = fs::read_to_string(&user_js_path).expect("Should read user.js");
    assert!(
      content.contains("network.proxy.type"),
      "Should contain proxy type setting"
    );
    assert!(
      content.contains("0"),
      "Should set proxy type to 0 (no proxy)"
    );
  }

  #[test]
  fn test_apply_proxy_settings_to_profile() {
    let (manager, temp_dir) = create_test_profile_manager();

    // Create a test profile directory structure
    let uuid_dir = temp_dir.path().join("test_uuid");
    let profile_dir = uuid_dir.join("profile");
    fs::create_dir_all(&profile_dir).expect("Should create profile directory");

    let proxy_settings = ProxySettings {
      proxy_type: "http".to_string(),
      host: "proxy.example.com".to_string(),
      port: 8080,
      username: Some("user".to_string()),
      password: Some("pass".to_string()),
    };

    let result = manager.apply_proxy_settings_to_profile(&profile_dir, &proxy_settings, None);
    assert!(result.is_ok(), "Should successfully apply proxy settings");

    // Check that user.js was created
    let user_js_path = profile_dir.join("user.js");
    assert!(user_js_path.exists(), "user.js should be created");

    let content = fs::read_to_string(&user_js_path).expect("Should read user.js");

    // Check for manual proxy configuration (type 1) instead of PAC (type 2)
    // Manual proxy is used because PAC file:// URLs are blocked by privacy browsers like Zen
    assert!(
      content.contains("network.proxy.type\", 1"),
      "Should set proxy type to 1 (manual)"
    );
    assert!(
      content.contains("network.proxy.http\", \"proxy.example.com\""),
      "Should set HTTP proxy host"
    );
    assert!(
      content.contains("network.proxy.http_port\", 8080"),
      "Should set HTTP proxy port"
    );
    assert!(
      content.contains("network.proxy.ssl\", \"proxy.example.com\""),
      "Should set SSL proxy host"
    );
    assert!(
      content.contains("network.proxy.ssl_port\", 8080"),
      "Should set SSL proxy port"
    );
  }

  #[test]
  fn test_pac_url_encodes_spaces_in_path() {
    let (manager, temp_dir) = create_test_profile_manager();

    let uuid_dir = temp_dir.path().join("path with spaces");
    let profile_dir = uuid_dir.join("profile");
    fs::create_dir_all(&profile_dir).expect("Should create profile directory");

    let result = manager.disable_proxy_settings_in_profile(&profile_dir);
    assert!(result.is_ok(), "Should handle paths with spaces");

    let user_js = fs::read_to_string(profile_dir.join("user.js")).unwrap();
    let pac_line = user_js
      .lines()
      .find(|l| l.contains("autoconfig_url"))
      .expect("Should have autoconfig_url preference");

    assert!(
      !pac_line.contains("path with spaces"),
      "PAC URL should not contain raw spaces: {pac_line}"
    );
    assert!(
      pac_line.contains("path%20with%20spaces"),
      "PAC URL should percent-encode spaces: {pac_line}"
    );
  }

  #[test]
  fn test_normalize_launch_hook_accepts_http_and_https() {
    let http =
      ProfileManager::normalize_launch_hook(Some(" http://localhost:3000/hook ".to_string()))
        .unwrap();
    let https = ProfileManager::normalize_launch_hook(Some(
      "https://example.com/hooks/profile-launch".to_string(),
    ))
    .unwrap();

    assert_eq!(http.as_deref(), Some("http://localhost:3000/hook"));
    assert_eq!(
      https.as_deref(),
      Some("https://example.com/hooks/profile-launch")
    );
  }

  #[test]
  fn test_normalize_launch_hook_clears_empty_values() {
    let result = ProfileManager::normalize_launch_hook(Some("   ".to_string())).unwrap();
    assert!(result.is_none());
  }

  #[test]
  fn test_normalize_launch_hook_rejects_invalid_scheme() {
    let err = ProfileManager::normalize_launch_hook(Some("ftp://example.com/hook".to_string()))
      .unwrap_err();
    assert!(err.to_string().contains("http or https"));
  }

  #[test]
  fn test_validate_launch_hook_accepts_https_url() {
    let result = super::validate_launch_hook(Some("https://example.com/track")).unwrap();
    assert_eq!(result.as_deref(), Some("https://example.com/track"));
  }

  #[test]
  fn test_validate_launch_hook_rejects_garbage_with_code() {
    let err = super::validate_launch_hook(Some("not a url")).unwrap_err();
    let parsed: serde_json::Value = serde_json::from_str(&err).expect("error must be JSON");
    assert_eq!(parsed["code"], "INVALID_LAUNCH_HOOK_URL");
  }

  #[test]
  fn test_validate_launch_hook_rejects_non_http_scheme_with_code() {
    let err = super::validate_launch_hook(Some("ftp://example.com/hook")).unwrap_err();
    let parsed: serde_json::Value = serde_json::from_str(&err).expect("error must be JSON");
    assert_eq!(parsed["code"], "INVALID_LAUNCH_HOOK_URL");
  }

  #[test]
  fn test_validate_launch_hook_empty_clears_hook() {
    let result = super::validate_launch_hook(Some("")).unwrap();
    assert!(result.is_none());

    let result_ws = super::validate_launch_hook(Some("   ")).unwrap();
    assert!(result_ws.is_none());

    let result_none = super::validate_launch_hook(None).unwrap();
    assert!(result_none.is_none());
  }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_browser_profile_with_group(
  app_handle: tauri::AppHandle,
  name: String,
  browser: String,
  version: String,
  release_type: String,
  proxy_id: Option<String>,
  vpn_id: Option<String>,
  camoufox_config: Option<CamoufoxConfig>,
  wayfern_config: Option<WayfernConfig>,
  group_id: Option<String>,
  ephemeral: bool,
  dns_blocklist: Option<String>,
  launch_hook: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .create_profile_with_group(
      &app_handle,
      &name,
      &browser,
      &version,
      &release_type,
      proxy_id,
      vpn_id,
      camoufox_config,
      wayfern_config,
      group_id,
      ephemeral,
      dns_blocklist,
      launch_hook,
    )
    .await
    .map_err(|e| format!("Failed to create profile: {e}"))
}

#[tauri::command]
pub fn list_browser_profiles() -> Result<Vec<BrowserProfile>, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .list_profiles()
    .map_err(|e| format!("Failed to list profiles: {e}"))
}

#[tauri::command]
pub async fn update_profile_proxy(
  app_handle: tauri::AppHandle,
  profile_id: String,
  proxy_id: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_proxy(app_handle, &profile_id, proxy_id)
    .await
    .map_err(|e| format!("Failed to update profile: {e}"))
}

#[tauri::command]
pub async fn update_profile_vpn(
  app_handle: tauri::AppHandle,
  profile_id: String,
  vpn_id: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_vpn(app_handle, &profile_id, vpn_id)
    .await
    .map_err(|e| format!("Failed to update profile VPN: {e}"))
}

#[tauri::command]
pub fn update_profile_tags(
  app_handle: tauri::AppHandle,
  profile_id: String,
  tags: Vec<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_tags(&app_handle, &profile_id, tags)
    .map_err(|e| format!("Failed to update profile tags: {e}"))
}

#[tauri::command]
pub fn update_profile_note(
  app_handle: tauri::AppHandle,
  profile_id: String,
  note: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_note(&app_handle, &profile_id, note)
    .map_err(|e| format!("Failed to update profile note: {e}"))
}

/// Validate a launch hook value. Returns `Ok(None)` for "clear the hook"
/// (`None`, empty, or whitespace-only), `Ok(Some(_))` for a valid http(s)
/// URL, or `Err` with the `INVALID_LAUNCH_HOOK_URL` code payload.
pub(crate) fn validate_launch_hook(launch_hook: Option<&str>) -> Result<Option<String>, String> {
  let Some(raw) = launch_hook else {
    return Ok(None);
  };
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }
  let ok = url::Url::parse(trimmed)
    .ok()
    .map(|u| matches!(u.scheme(), "http" | "https"))
    .unwrap_or(false);
  if !ok {
    return Err(serde_json::json!({ "code": "INVALID_LAUNCH_HOOK_URL" }).to_string());
  }
  Ok(Some(trimmed.to_string()))
}

#[tauri::command]
pub fn update_profile_launch_hook(
  app_handle: tauri::AppHandle,
  profile_id: String,
  launch_hook: Option<String>,
) -> Result<BrowserProfile, String> {
  validate_launch_hook(launch_hook.as_deref())?;
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_launch_hook(&app_handle, &profile_id, launch_hook)
    .map_err(|e| format!("Failed to update profile launch hook: {e}"))
}

#[tauri::command]
pub fn update_profile_proxy_bypass_rules(
  app_handle: tauri::AppHandle,
  profile_id: String,
  rules: Vec<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_proxy_bypass_rules(&app_handle, &profile_id, rules)
    .map_err(|e| format!("Failed to update proxy bypass rules: {e}"))
}

#[tauri::command]
pub fn update_profile_dns_blocklist(
  profile_id: String,
  dns_blocklist: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_dns_blocklist(&profile_id, dns_blocklist)
    .map_err(|e| format!("Failed to update DNS blocklist: {e}"))
}

#[tauri::command]
pub async fn check_browser_status(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
) -> Result<bool, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .check_browser_status(app_handle, &profile)
    .await
    .map_err(|e| format!("Failed to check browser status: {e}"))
}

#[tauri::command]
pub fn rename_profile(
  app_handle: tauri::AppHandle,
  profile_id: String,
  new_name: String,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .rename_profile(&app_handle, &profile_id, &new_name)
    .map_err(|e| format!("Failed to rename profile: {e}"))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_browser_profile_new(
  app_handle: tauri::AppHandle,
  name: String,
  browser_str: String,
  version: String,
  release_type: String,
  proxy_id: Option<String>,
  vpn_id: Option<String>,
  camoufox_config: Option<CamoufoxConfig>,
  wayfern_config: Option<WayfernConfig>,
  group_id: Option<String>,
  ephemeral: Option<bool>,
  dns_blocklist: Option<String>,
  launch_hook: Option<String>,
) -> Result<BrowserProfile, String> {
  // A dead/unreachable proxy or VPN (or a 402 from an expired proxy
  // subscription) cancels creation with a translatable error.
  crate::validate_profile_network(proxy_id.as_deref(), vpn_id.as_deref()).await?;

  let browser_type =
    BrowserType::from_str(&browser_str).map_err(|e| format!("Invalid browser type: {e}"))?;
  create_browser_profile_with_group(
    app_handle,
    name,
    browser_type.as_str().to_string(),
    version,
    release_type,
    proxy_id,
    vpn_id,
    camoufox_config,
    wayfern_config,
    group_id,
    ephemeral.unwrap_or(false),
    dns_blocklist,
    launch_hook,
  )
  .await
}

#[tauri::command]
pub async fn update_camoufox_config(
  app_handle: tauri::AppHandle,
  profile_id: String,
  config: CamoufoxConfig,
) -> Result<(), String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_camoufox_config(app_handle, &profile_id, config)
    .await
    .map_err(|e| format!("Failed to update Camoufox config: {e}"))
}

#[tauri::command]
pub async fn update_wayfern_config(
  app_handle: tauri::AppHandle,
  profile_id: String,
  config: WayfernConfig,
) -> Result<(), String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_wayfern_config(app_handle, &profile_id, config)
    .await
    .map_err(|e| format!("Failed to update Wayfern config: {e}"))
}

#[tauri::command]
pub fn clone_profile(profile_id: String, name: Option<String>) -> Result<BrowserProfile, String> {
  ProfileManager::instance()
    .clone_profile(&profile_id, name)
    .map_err(|e| format!("Failed to clone profile: {e}"))
}

#[tauri::command]
pub fn delete_profile(app_handle: tauri::AppHandle, profile_id: String) -> Result<(), String> {
  ProfileManager::instance()
    .delete_profile(&app_handle, &profile_id)
    .map_err(|e| format!("Failed to delete profile: {e}"))
}

lazy_static::lazy_static! {
  static ref PROFILE_MANAGER: ProfileManager = ProfileManager::new();
}
