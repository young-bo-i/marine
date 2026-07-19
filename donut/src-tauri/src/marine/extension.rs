//! Auto-load the in-browser Marine (截流) extension into launched Wayfern
//! profiles: copy the extension into the profile, stamp its runtime config
//! (local API base + bearer token + profile id), and hand its path back to the
//! launcher for `--load-extension`.
//!
//! The Marine extension does the page-context work (grab / comment extraction /
//! reply injection); it calls Donut's local REST API (`/v1/marine/*`) for
//! generation, brands, and history. The stamped `marine-runtime-config.json`
//! tells it where that API is. Launching a profile auto-ensures that API: a
//! token is generated if missing and the local server is started if not already
//! running, so the extension connects with zero manual setup. The manual-config
//! panel in the side panel is only a debug fallback.

use std::fs;
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

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
  fs::create_dir_all(dst)?;
  for entry in fs::read_dir(src)? {
    let entry = entry?;
    let from = entry.path();
    let to = dst.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      copy_dir(&from, &to)?;
    } else {
      fs::copy(&from, &to)?;
    }
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

  let dst = profile_data_path.join("marine-ext");
  if let Err(e) = copy_dir(&src, &dst) {
    log::warn!("Marine: failed to copy extension into profile: {e}");
    return None;
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

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

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
}
