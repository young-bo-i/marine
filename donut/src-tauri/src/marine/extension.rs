//! Auto-load the in-browser Marine (截流) extension into launched Wayfern
//! profiles: copy the extension into the profile, stamp its runtime config
//! (local API base + bearer token + profile id), and hand its path back to the
//! launcher for `--load-extension`.
//!
//! The Marine extension does the page-context work (grab / comment extraction /
//! reply injection); it calls Marine's local REST API (`/v1/marine/*`) for
//! prompt preparation, brands, and history. Rime owns connector authorization
//! and AI execution. The stamped `marine-runtime-config.json` tells the
//! extension where that API is. Launching a profile auto-ensures that API: a
//! token is generated if missing and the local server is started if not already
//! running, so the extension connects with zero manual setup. The manual-config
//! panel in the side panel is only a debug fallback.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
  #[cfg(unix)]
  {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = fs::OpenOptions::new()
      .create(true)
      .truncate(true)
      .write(true)
      .mode(0o600)
      .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    // `mode` only applies when a file is first created. The extension bundle
    // already contains an empty runtime-config placeholder, so explicitly
    // narrow permissions after truncating that copied file as well.
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
  }

  #[cfg(not(unix))]
  {
    fs::write(path, contents)
  }
}

/// Resolve the source of the bundled Marine extension.
fn source_dir(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
  // 1) Explicit override (useful for dev / testing).
  if let Ok(p) = std::env::var("DONUT_MARINE_EXT_DIR") {
    let pb = PathBuf::from(p);
    if pb.join("manifest.json").exists() {
      return Some(pb);
    }
  }
  // 2) Bundled resource (release builds).
  if let Ok(res) = app_handle.path().resource_dir() {
    let pb = res.join("marine-extension");
    if pb.join("manifest.json").exists() {
      return Some(pb);
    }
  }
  // 3) Dev: walk up from the running exe to find `donut/marine-extension`
  //    (exe is at donut/src-tauri/target/debug/donutbrowser).
  if let Ok(exe) = std::env::current_exe() {
    for ancestor in exe.ancestors() {
      let pb = ancestor.join("marine-extension");
      if pb.join("manifest.json").exists() {
        return Some(pb);
      }
    }
  }
  None
}

fn read_extension_version(dir: &Path) -> io::Result<String> {
  let manifest_path = dir.join("manifest.json");
  let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path)?)
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
  manifest
    .get("version")
    .and_then(serde_json::Value::as_str)
    .filter(|version| !version.is_empty())
    .map(str::to_owned)
    .ok_or_else(|| {
      io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{} has no extension version", manifest_path.display()),
      )
    })
}

/// Synchronize a bundled extension directory into a profile. Files removed
/// from the bundle are pruned from the profile copy, and the root manifest is
/// copied last so Chromium never observes the new extension version before its
/// worker and other assets are in place.
fn sync_dir(src: &Path, dst: &Path, defer_manifest: bool) -> io::Result<()> {
  fs::create_dir_all(dst)?;
  let entries = fs::read_dir(src)?.collect::<Result<Vec<_>, _>>()?;
  let source_names = entries
    .iter()
    .map(|entry| entry.file_name())
    .collect::<std::collections::HashSet<_>>();

  for entry in &entries {
    if defer_manifest && entry.file_name() == "manifest.json" {
      continue;
    }
    let from = entry.path();
    let to = dst.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      sync_dir(&from, &to, false)?;
    } else {
      fs::copy(&from, &to)?;
    }
  }

  for entry in fs::read_dir(dst)? {
    let entry = entry?;
    if source_names.contains(&entry.file_name()) {
      continue;
    }
    if entry.file_type()?.is_dir() {
      fs::remove_dir_all(entry.path())?;
    } else {
      fs::remove_file(entry.path())?;
    }
  }

  if defer_manifest {
    fs::copy(src.join("manifest.json"), dst.join("manifest.json"))?;
  }
  Ok(())
}

/// Copy the Marine extension into `<profile_data_path>/marine-ext`, stamp its
/// runtime config, and return the directory to pass to `--load-extension`.
/// Returns `None` (and logs) if the extension source can't be found or copied —
/// the launch then proceeds without Marine rather than failing.
pub async fn ensure_for_profile(
  app_handle: &tauri::AppHandle,
  profile_data_path: &Path,
  profile_id: &str,
) -> Option<PathBuf> {
  let src = match source_dir(app_handle) {
    Some(s) => s,
    None => {
      log::warn!("Marine: extension source not found; skipping auto-load");
      return None;
    }
  };

  let source_version = match read_extension_version(&src) {
    Ok(version) => version,
    Err(e) => {
      log::warn!("Marine: bundled extension manifest is invalid: {e}");
      return None;
    }
  };

  let dst = profile_data_path.join("marine-ext");
  let previous_version = read_extension_version(&dst).ok();
  if let Err(e) = sync_dir(&src, &dst, true) {
    log::warn!("Marine: failed to copy extension into profile: {e}");
    return None;
  }
  match previous_version {
    Some(previous) if previous != source_version => log::info!(
      "Marine: upgraded profile extension from {previous} to {source_version}; Chromium will register the new MV3 worker on this launch"
    ),
    None => log::info!("Marine: installed profile extension {source_version}"),
    _ => log::debug!("Marine: profile extension {source_version} is current"),
  }

  // Stamp the connection so the extension auto-connects. The local API server
  // itself is started (and its token generated) once at app startup — see the
  // Marine auto-start block in `lib.rs` setup — because this launch path is
  // reachable from the `run_profile` API handler, and referencing the server's
  // router-building `start()` from here would create a type cycle. Here we only
  // read the live port (or fall back to the preferred one) and the token,
  // generating a token if one somehow doesn't exist yet.
  let manager = crate::settings_manager::SettingsManager::instance();
  let preferred_port = manager.load_settings().map(|s| s.api_port).unwrap_or(10108);

  let token = match manager.get_api_token(app_handle).await.ok().flatten() {
    Some(t) => t,
    None => match manager.generate_api_token(app_handle).await {
      Ok(t) => t,
      Err(e) => {
        log::warn!("Marine: failed to generate API token: {e}");
        String::new()
      }
    },
  };

  let port = match crate::api_server::get_api_server_status().await {
    Ok(Some(p)) => p,
    _ => preferred_port,
  };

  let cfg = serde_json::json!({
    "apiBase": format!("http://127.0.0.1:{port}/v1/marine"),
    "token": token,
    "profileId": profile_id,
  });
  let config_json = serde_json::to_vec_pretty(&cfg).unwrap_or_default();
  if let Err(e) = write_private_file(&dst.join("marine-runtime-config.json"), &config_json) {
    log::warn!("Marine: failed to stamp runtime config: {e}");
  }

  Some(dst)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[cfg(unix)]
  use std::os::unix::fs::PermissionsExt;

  #[cfg(unix)]
  #[test]
  fn runtime_config_permissions_are_narrowed_even_for_existing_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("marine-runtime-config.json");
    fs::write(&path, b"placeholder").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    write_private_file(&path, b"{\"token\":\"secret\"}").unwrap();

    assert_eq!(
      fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    assert_eq!(fs::read(&path).unwrap(), b"{\"token\":\"secret\"}");
  }

  #[test]
  fn sync_dir_upgrades_manifest_and_prunes_stale_bundle_files() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let destination = directory.path().join("destination");
    fs::create_dir_all(source.join("src")).unwrap();
    fs::create_dir_all(destination.join("src")).unwrap();
    fs::write(
      source.join("manifest.json"),
      br#"{"manifest_version":3,"version":"0.1.5"}"#,
    )
    .unwrap();
    fs::write(source.join("src/sw.js"), b"new worker").unwrap();
    fs::write(
      destination.join("manifest.json"),
      br#"{"manifest_version":3,"version":"0.1.3"}"#,
    )
    .unwrap();
    fs::write(destination.join("src/sw.js"), b"old worker").unwrap();
    fs::write(destination.join("stale.js"), b"removed from bundle").unwrap();

    sync_dir(&source, &destination, true).unwrap();

    assert_eq!(read_extension_version(&destination).unwrap(), "0.1.5");
    assert_eq!(
      fs::read(destination.join("src/sw.js")).unwrap(),
      b"new worker"
    );
    assert!(!destination.join("stale.js").exists());
  }

  #[test]
  fn bundled_manifest_versions_worker_registration_url() {
    let manifest: serde_json::Value =
      serde_json::from_str(include_str!("../../../marine-extension/manifest.json")).unwrap();
    let version = manifest["version"].as_str().unwrap();
    let worker = manifest["background"]["service_worker"].as_str().unwrap();
    assert_eq!(version, "0.1.8");
    assert_eq!(worker, format!("src/sw-entry-{version}.js"));
    let entry = fs::read_to_string(
      Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../marine-extension")
        .join(worker),
    )
    .unwrap();
    assert!(entry.contains(&format!("sw.js?v={version}")));
  }
}
