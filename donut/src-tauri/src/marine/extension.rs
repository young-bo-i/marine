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

/// The stamped connection file. Generated per profile — never copied in from
/// the bundle, which ships only an empty placeholder. See [`sync_dir`].
const RUNTIME_CONFIG_FILE: &str = "marine-runtime-config.json";

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

fn write_runtime_config(path: &Path, config: &serde_json::Value) -> std::io::Result<()> {
  let contents =
    serde_json::to_vec_pretty(config).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
  write_private_file(path, &contents)
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
  // 2) Dev builds: prefer the live worktree over the bundled resource. In a debug
  //    build `resource_dir()` is `target/debug/`, whose `marine-extension/` is a
  //    COPY made at build time — editing the extension then relaunching a profile
  //    would silently resync that stale snapshot over the edits, so dev changes
  //    appear not to take effect at all. The worktree is the source of truth here.
  if cfg!(debug_assertions) {
    if let Some(dir) = worktree_extension_dir() {
      return Some(dir);
    }
  }
  // 3) Bundled resource (release builds).
  if let Ok(res) = app_handle.path().resource_dir() {
    let pb = res.join("marine-extension");
    if pb.join("manifest.json").exists() {
      return Some(pb);
    }
  }
  // 4) Last resort (layouts that keep the extension beside the exe).
  nearby_extension_dir()
}

/// The extension inside the checked-out worktree. Identified by an ancestor that
/// holds BOTH `marine-extension/` and `src-tauri/` — that pair only exists at the
/// repo's `donut/` root, so this never picks up `target/debug/marine-extension`
/// (the build-time resource copy, which sits next to the dev exe).
fn worktree_extension_dir() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  exe.ancestors().find_map(|ancestor| {
    let candidate = ancestor.join("marine-extension");
    (ancestor.join("src-tauri").is_dir() && candidate.join("manifest.json").exists())
      .then_some(candidate)
  })
}

/// Nearest `marine-extension/` above the running exe, whatever the layout.
fn nearby_extension_dir() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  exe.ancestors().find_map(|ancestor| {
    let candidate = ancestor.join("marine-extension");
    candidate
      .join("manifest.json")
      .exists()
      .then_some(candidate)
  })
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
///
/// The runtime config is deliberately NOT copied. The bundle ships it as an
/// empty placeholder (`{"apiBase":"","token":"","profileId":""}`), and copying
/// that in would blank the profile's stamped connection *before*
/// [`ensure_for_profile`] has obtained the token and port it needs to write the
/// real one back. Every failure between those two points — the API not ready
/// inside its 10s budget, a token error, a failed write — would then leave the
/// profile holding the placeholder, which the extension cannot tell apart from
/// "never configured": it reports 「Marine 本地服务未连接」 and no request ever
/// reaches the local API, so nothing about it appears in the app log either.
/// Skipping the copy means a previously working config survives every launch
/// that fails to produce a new one.
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
    // Only at the extension root, where `defer_manifest` marks the top-level
    // call. It stays in `source_names`, so the prune below still leaves the
    // stamped file alone.
    if defer_manifest && entry.file_name() == RUNTIME_CONFIG_FILE {
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
  bound_persona_id: Option<&str>,
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
  // wait for the live port and obtain the token atomically.  Startup and a
  // first profile launch can overlap; neither a guessed port nor two racing
  // token generations is a usable runtime configuration.
  let manager = crate::settings_manager::SettingsManager::instance();
  let token = match manager.get_or_create_api_token(app_handle).await {
    Ok(token) => token,
    Err(e) => {
      log::error!("Marine: failed to obtain API token: {e}");
      return None;
    }
  };

  let port = match crate::api_server::wait_for_api_server_ready(std::time::Duration::from_secs(10))
    .await
  {
    Ok(port) => port,
    Err(e) => {
      log::error!("Marine: local API is not ready; refusing to stamp a stale runtime config: {e}");
      return None;
    }
  };

  // Stamp the derived capability, never the full bearer: this file lives inside
  // the browser profile, and the extension only needs `/v1/marine/*`.
  let capability = super::extension_capability_token(&token);

  let cfg = serde_json::json!({
    "apiBase": format!("http://127.0.0.1:{port}/v1/marine"),
    "token": capability,
    "profileId": profile_id,
    "personaId": normalized_persona_id(bound_persona_id),
  });
  if let Err(e) = write_runtime_config(&dst.join(RUNTIME_CONFIG_FILE), &cfg) {
    log::error!("Marine: failed to stamp runtime config: {e}");
    return None;
  }

  Some(dst)
}

fn normalized_persona_id(value: Option<&str>) -> Option<String> {
  let raw = value?.trim();
  let candidate = raw
    .strip_prefix("scholay:")
    .or_else(|| raw.strip_prefix("SCHOLAY:"))
    .unwrap_or(raw)
    .to_ascii_uppercase();
  let number = candidate.strip_prefix('P')?.parse::<u8>().ok()?;
  (1..=12).contains(&number).then(|| format!("P{number:02}"))
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
  fn runtime_config_write_failure_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("marine-runtime-config.json");
    fs::create_dir(&destination).unwrap();

    assert!(write_runtime_config(
      &destination,
      &serde_json::json!({ "apiBase": "http://127.0.0.1:10108" }),
    )
    .is_err());
    assert!(destination.is_dir());
  }

  #[test]
  fn bound_persona_ids_are_normalized_and_bounded() {
    assert_eq!(normalized_persona_id(Some("P1")), Some("P01".into()));
    assert_eq!(
      normalized_persona_id(Some("scholay:p12")),
      Some("P12".into())
    );
    assert_eq!(normalized_persona_id(Some("scholay")), None);
    assert_eq!(normalized_persona_id(Some("P13")), None);
    assert_eq!(normalized_persona_id(None), None);
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

  /// The bug this guards against cost a full investigation: an upgrade copied
  /// the bundle's empty placeholder over a working stamped config, and every
  /// path that then failed to re-stamp left the profile reporting
  /// 「Marine 本地服务未连接」 with nothing in the app log to explain it.
  #[test]
  fn sync_dir_keeps_a_stamped_runtime_config() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let destination = directory.path().join("destination");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&destination).unwrap();
    fs::write(
      source.join("manifest.json"),
      br#"{"manifest_version":3,"version":"0.1.5"}"#,
    )
    .unwrap();
    // The bundle ships the placeholder, exactly as it exists in the repo.
    fs::write(
      source.join(RUNTIME_CONFIG_FILE),
      br#"{"apiBase":"","token":"","profileId":""}"#,
    )
    .unwrap();
    let stamped = br#"{"apiBase":"http://127.0.0.1:10108/v1/marine","token":"real"}"#;
    fs::write(destination.join(RUNTIME_CONFIG_FILE), stamped).unwrap();

    sync_dir(&source, &destination, true).unwrap();

    assert_eq!(
      fs::read(destination.join(RUNTIME_CONFIG_FILE)).unwrap(),
      stamped,
      "a stamped runtime config must survive an extension upgrade"
    );
  }

  #[test]
  fn bundled_manifest_versions_worker_registration_url() {
    let manifest: serde_json::Value =
      serde_json::from_str(include_str!("../../../marine-extension/manifest.json")).unwrap();
    let version = manifest["version"].as_str().unwrap();
    let worker = manifest["background"]["service_worker"].as_str().unwrap();
    assert_eq!(version, "0.1.37");
    assert_eq!(worker, format!("src/sw-entry-{version}.js"));
    let entry = fs::read_to_string(
      Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../marine-extension")
        .join(worker),
    )
    .unwrap();
    assert!(entry.contains(&format!("sw.js?v={version}")));
  }

  /// Editing ANY script the worker imports, without moving its URL, ships a
  /// silent no-op.
  ///
  /// Chromium caches worker scripts by URL, and each `importScripts` target is
  /// its own cache entry. The manifest registers `src/sw-entry-<v>.js`, whose
  /// body is `importScripts('sw.js?v=<v>')`, and `sw.js` in turn imports
  /// `scholay-skill.js?v=<v>`. Every one of those URLs has to move together.
  ///
  /// Measured against Wayfern 150.0.7871.102, persistent profile, full browser
  /// restart between runs:
  ///
  /// | changed                       | worker |
  /// |-------------------------------|--------|
  /// | an imported script only       | stale  |
  /// | that + manifest `version`     | stale  |
  /// | the entry filename            | fresh  |
  ///
  /// This has now bitten twice. First: three consecutive `sw.js` fixes shipped
  /// as no-ops. Then, one release after the guard was added for `sw.js` alone,
  /// `scholay-skill.js` was edited — the browser kept the old copy, which
  /// expected a six-paragraph mother draft while the bundle now shipped nine,
  /// so the skill build threw, the Rime context PUT never went out, and
  /// automation could not even reach the generate step. Hence: every imported
  /// script, not just the entry's.
  ///
  /// Failing here means: rename the entry, bump every `?v=` alongside it, and
  /// paste the new digests — all in the same commit as the edit.
  #[test]
  fn editing_any_worker_script_requires_bumping_its_url() {
    use sha2::{Digest, Sha256};
    let hex = |bytes: &[u8]| -> String {
      Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
    };
    for (name, actual, expected) in [
      (
        "sw.js",
        hex(include_bytes!("../../../marine-extension/src/sw.js")),
        "31da9102c3a92ef820ec70318319031212ea04fdc86cba70cd9e731d3d06dfe8",
      ),
      (
        "scholay-skill.js",
        hex(include_bytes!(
          "../../../marine-extension/src/scholay-skill.js"
        )),
        "510f08e48b415a3d70bf3fc30b8509684dcf97207e1b1273d37cb0405d2ad2d5",
      ),
    ] {
      assert_eq!(
        actual, expected,
        "\n\n{name} changed. Chromium will keep running the OLD copy — it caches \
         each imported script by URL — unless that URL moves. In the SAME commit:\n\
         \n  1. git mv src/sw-entry-<old>.js src/sw-entry-<new>.js\
         \n  2. bump every `?v=` (the entry's importScripts AND sw.js's)\
         \n  3. manifest.json: version + background.service_worker\
         \n  4. the version asserts above, and this digest = {actual}\n"
      );
    }
  }

  #[test]
  fn bundled_scholay_assets_match_their_manifest() {
    use sha2::{Digest, Sha256};
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
      "../../../marine-extension/skills/scholay/generated/manifest.json"
    ))
    .unwrap();
    for (name, bytes) in [
      (
        "personas.json",
        include_bytes!("../../../marine-extension/skills/scholay/generated/personas.json")
          .as_slice(),
      ),
      (
        "comment-exemplars.json",
        include_bytes!("../../../marine-extension/skills/scholay/generated/comment-exemplars.json")
          .as_slice(),
      ),
      (
        "generation-policy.json",
        include_bytes!("../../../marine-extension/skills/scholay/generated/generation-policy.json")
          .as_slice(),
      ),
    ] {
      let actual = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
      assert_eq!(
        manifest["assetHashes"][name].as_str(),
        Some(actual.as_str()),
        "generated Scholay asset does not match manifest: {name}",
      );
    }
  }
}
