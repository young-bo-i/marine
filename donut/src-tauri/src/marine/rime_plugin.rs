//! Installation contract for Marine's RimeBuffer action-plugin manifest.
//!
//! The manifest is durable application metadata. It is copied from Marine's
//! bundled resources into RimeBuffer's plugin directory at app startup and is
//! deliberately independent from the short-lived runtime credential file in
//! `rime.rs`.

use serde::Deserialize;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::Manager;

const PLUGIN_ID: &str = "marine";
const BUNDLED_MANIFEST_RELATIVE_PATH: &str = "rime-plugin/manifest.json";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestSyncOutcome {
  Installed,
  Updated,
  Unchanged,
}

#[derive(Deserialize)]
struct ManifestIdentity {
  id: String,
}

/// Install or upgrade the bundled Marine manifest for the current macOS user.
///
/// This is best-effort at the app boundary: callers should log an error and
/// continue launching Marine. The lower-level sync is strict about identity,
/// so an existing manifest that belongs to another plugin (or whose identity
/// cannot be verified) is never replaced.
#[cfg(target_os = "macos")]
pub fn sync_bundled_manifest(app_handle: &tauri::AppHandle) -> Result<ManifestSyncOutcome, String> {
  let source = bundled_manifest_path(app_handle).ok_or_else(|| {
    format!("bundled RimeBuffer plugin manifest not found ({BUNDLED_MANIFEST_RELATIVE_PATH})")
  })?;
  let home =
    dirs::home_dir().ok_or_else(|| "could not resolve the user home directory".to_string())?;
  sync_manifest_at(&source, &installed_manifest_path(&home))
}

fn bundled_manifest_path(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
  let explicit = std::env::var_os("MARINE_RIME_PLUGIN_MANIFEST").map(PathBuf::from);
  let resource_dir = app_handle.path().resource_dir().ok();
  let executable = std::env::current_exe().ok();
  find_bundled_manifest(
    explicit.as_deref(),
    resource_dir.as_deref(),
    executable.as_deref(),
  )
}

fn find_bundled_manifest(
  explicit: Option<&Path>,
  resource_dir: Option<&Path>,
  executable: Option<&Path>,
) -> Option<PathBuf> {
  if let Some(path) = explicit.filter(|path| path.is_file()) {
    return Some(path.to_path_buf());
  }
  if let Some(resource_dir) = resource_dir {
    let path = resource_dir.join(BUNDLED_MANIFEST_RELATIVE_PATH);
    if path.is_file() {
      return Some(path);
    }
  }
  // `cargo run` does not assemble a Tauri resource directory. Walk up from
  // the executable so development builds use the same checked-in manifest.
  if let Some(executable) = executable {
    for ancestor in executable.ancestors() {
      let path = ancestor.join(BUNDLED_MANIFEST_RELATIVE_PATH);
      if path.is_file() {
        return Some(path);
      }
    }
  }

  None
}

fn installed_manifest_path(home: &Path) -> PathBuf {
  home
    .join("Library")
    .join("RimeBuffer")
    .join("plugins")
    .join(PLUGIN_ID)
    .join("manifest.json")
}

fn sync_manifest_at(source: &Path, destination: &Path) -> Result<ManifestSyncOutcome, String> {
  let source_bytes = read_manifest(source, "bundled")?;
  let source_id = manifest_id(&source_bytes, "bundled")?;
  if source_id != PLUGIN_ID {
    return Err(format!(
      "refusing to install bundled plugin id {source_id:?}; expected {PLUGIN_ID:?}"
    ));
  }

  match read_installed_manifest(destination)? {
    Some(existing_bytes) => {
      let existing_id = manifest_id(&existing_bytes, "installed")?;
      if existing_id != source_id {
        return Err(format!(
          "refusing to replace installed plugin id {existing_id:?} with {source_id:?}"
        ));
      }
      if existing_bytes == source_bytes {
        return Ok(ManifestSyncOutcome::Unchanged);
      }
      write_manifest_atomically(destination, &source_bytes)?;
      Ok(ManifestSyncOutcome::Updated)
    }
    None => {
      write_manifest_atomically(destination, &source_bytes)?;
      Ok(ManifestSyncOutcome::Installed)
    }
  }
}

fn read_installed_manifest(path: &Path) -> Result<Option<Vec<u8>>, String> {
  let metadata = match fs::metadata(path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => {
      return Err(format!(
        "read installed RimeBuffer plugin manifest metadata {}: {error}",
        path.display()
      ));
    }
  };
  if !metadata.is_file() {
    return Err("installed plugin manifest is not a regular file".to_string());
  }
  if metadata.len() > MAX_MANIFEST_BYTES {
    return Err(format!(
      "installed plugin manifest exceeds {MAX_MANIFEST_BYTES} bytes"
    ));
  }
  fs::read(path)
    .map(Some)
    .map_err(|error| format!("read installed plugin manifest: {error}"))
}

fn read_manifest(path: &Path, description: &str) -> Result<Vec<u8>, String> {
  let metadata = fs::metadata(path)
    .map_err(|error| format!("read {description} plugin manifest metadata: {error}"))?;
  if !metadata.is_file() {
    return Err(format!(
      "{description} plugin manifest is not a regular file"
    ));
  }
  if metadata.len() > MAX_MANIFEST_BYTES {
    return Err(format!(
      "{description} plugin manifest exceeds {MAX_MANIFEST_BYTES} bytes"
    ));
  }
  fs::read(path).map_err(|error| format!("read {description} plugin manifest: {error}"))
}

fn manifest_id(bytes: &[u8], description: &str) -> Result<String, String> {
  let identity: ManifestIdentity = serde_json::from_slice(bytes)
    .map_err(|error| format!("parse {description} plugin manifest identity: {error}"))?;
  let id = identity.id.trim();
  if id.is_empty() {
    return Err(format!("{description} plugin manifest has an empty id"));
  }
  Ok(id.to_string())
}

fn write_manifest_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
  use std::io::Write;

  let parent = path
    .parent()
    .ok_or_else(|| "installed plugin manifest path has no parent".to_string())?;
  fs::create_dir_all(parent)
    .map_err(|error| format!("create RimeBuffer plugin directory: {error}"))?;

  let mut temporary = tempfile::Builder::new()
    .prefix(".manifest-")
    .tempfile_in(parent)
    .map_err(|error| format!("create temporary plugin manifest: {error}"))?;
  temporary
    .write_all(bytes)
    .map_err(|error| format!("write temporary plugin manifest: {error}"))?;
  temporary
    .as_file()
    .sync_all()
    .map_err(|error| format!("sync temporary plugin manifest: {error}"))?;
  temporary
    .persist(path)
    .map_err(|error| format!("replace installed plugin manifest: {}", error.error))?;

  #[cfg(unix)]
  fs::File::open(parent)
    .and_then(|directory| directory.sync_all())
    .map_err(|error| format!("sync RimeBuffer plugin directory: {error}"))?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(path: &Path, contents: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
  }

  #[test]
  fn installed_path_matches_rimebuffer_contract() {
    assert_eq!(
      installed_manifest_path(Path::new("/Users/tester")),
      Path::new("/Users/tester/Library/RimeBuffer/plugins/marine/manifest.json")
    );
  }

  #[test]
  fn installs_then_becomes_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("bundle/manifest.json");
    let destination = directory.path().join("install/manifest.json");
    let contents = br#"{"schemaVersion":1,"id":"marine","version":"1.0.0","actions":[]}"#;
    write(&source, contents);

    assert_eq!(
      sync_manifest_at(&source, &destination).unwrap(),
      ManifestSyncOutcome::Installed
    );
    assert_eq!(fs::read(&destination).unwrap(), contents);
    assert_eq!(
      sync_manifest_at(&source, &destination).unwrap(),
      ManifestSyncOutcome::Unchanged
    );
  }

  #[test]
  fn upgrades_an_existing_manifest_with_the_same_id() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("bundle/manifest.json");
    let destination = directory.path().join("install/manifest.json");
    let old = br#"{"id":"marine","version":"1.0.0"}"#;
    let new = br#"{"id":"marine","version":"2.0.0"}"#;
    write(&source, new);
    write(&destination, old);

    assert_eq!(
      sync_manifest_at(&source, &destination).unwrap(),
      ManifestSyncOutcome::Updated
    );
    assert_eq!(fs::read(&destination).unwrap(), new);
  }

  #[test]
  fn never_overwrites_a_different_plugin_id() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("bundle/manifest.json");
    let destination = directory.path().join("install/manifest.json");
    let marine = br#"{"id":"marine","version":"2.0.0"}"#;
    let other = br#"{"id":"another-plugin","version":"1.0.0"}"#;
    write(&source, marine);
    write(&destination, other);

    let error = sync_manifest_at(&source, &destination).unwrap_err();
    assert!(error.contains("refusing to replace installed plugin id"));
    assert_eq!(fs::read(&destination).unwrap(), other);
  }

  #[test]
  fn never_overwrites_an_installed_manifest_with_unverifiable_identity() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("bundle/manifest.json");
    let destination = directory.path().join("install/manifest.json");
    let marine = br#"{"id":"marine","version":"2.0.0"}"#;
    let invalid = b"not-json";
    write(&source, marine);
    write(&destination, invalid);

    let error = sync_manifest_at(&source, &destination).unwrap_err();
    assert!(error.contains("parse installed plugin manifest identity"));
    assert_eq!(fs::read(&destination).unwrap(), invalid);
  }

  #[test]
  fn rejects_a_misidentified_bundled_manifest() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("bundle/manifest.json");
    let destination = directory.path().join("install/manifest.json");
    write(&source, br#"{"id":"another-plugin"}"#);

    let error = sync_manifest_at(&source, &destination).unwrap_err();
    assert!(error.contains("expected \"marine\""));
    assert!(!destination.exists());
  }

  #[test]
  fn tauri_bundle_includes_the_rimebuffer_manifest() {
    let config: serde_json::Value =
      serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(
      config["bundle"]["resources"]["../rime-plugin/manifest.json"],
      "rime-plugin/manifest.json"
    );
  }

  #[test]
  fn bundled_manifest_declares_the_v5_context_only_prepare_contract() {
    let manifest: serde_json::Value =
      serde_json::from_str(include_str!("../../../rime-plugin/manifest.json")).unwrap();
    assert_eq!(manifest["schemaVersion"], 1);
    assert_eq!(manifest["id"], "marine");
    assert_eq!(manifest["version"], "0.5.0");
    let actions = manifest["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 2);
    for action in actions {
      assert_eq!(action["preparePath"], "/rime/prepare");
      assert_eq!(action["invokePath"], "/rime/invoke");
      assert_eq!(action["requiresFocus"], false);
      assert!(action.get("streamPath").is_none());
      assert_eq!(action["presentationId"], "marine.generate-comment");
      assert_eq!(action["presentationTitle"], "生成评论");
    }
  }

  #[test]
  fn packaged_resource_path_matches_tauri_resource_directory() {
    let directory = tempfile::tempdir().unwrap();
    let resource_dir = directory.path().join("Marine.app/Contents/Resources");
    let manifest = resource_dir.join(BUNDLED_MANIFEST_RELATIVE_PATH);
    write(&manifest, br#"{"id":"marine"}"#);

    assert_eq!(
      find_bundled_manifest(None, Some(&resource_dir), None),
      Some(manifest)
    );
  }

  #[test]
  fn cargo_run_executable_can_reach_the_checked_in_manifest() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = directory.path().join(BUNDLED_MANIFEST_RELATIVE_PATH);
    let executable = directory.path().join("src-tauri/target/debug/donutbrowser");
    write(&manifest, br#"{"id":"marine"}"#);

    assert_eq!(
      find_bundled_manifest(None, None, Some(&executable)),
      Some(manifest)
    );
  }
}
