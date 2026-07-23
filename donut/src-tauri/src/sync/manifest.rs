use chrono::{DateTime, Utc};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::SystemTime;

use super::types::{SyncError, SyncResult};

/// Default exclude patterns for volatile browser profile files.
/// Patterns use `**/` prefix to match at any directory depth, since the sync
/// engine scans from `profiles/{uuid}/` which contains `profile/Default/...`.
pub const DEFAULT_EXCLUDE_PATTERNS: &[&str] = &[
  "**/Cache/**",
  "**/Code Cache/**",
  "**/GPUCache/**",
  "**/GrShaderCache/**",
  "**/ShaderCache/**",
  "**/DawnCache/**",
  "**/DawnGraphiteCache/**",
  "**/Service Worker/CacheStorage/**",
  "**/Service Worker/ScriptCache/**",
  "**/Session Storage/**",
  "**/blob_storage/**",
  "**/Crashpad/**",
  "**/Crash Reports/**",
  "**/BrowserMetrics/**",
  "**/optimization_guide_model_store/**",
  "**/Safe Browsing/**",
  "**/component_crx_cache/**",
  "**/cache2/**",
  "**/startupCache/**",
  "**/safebrowsing/**",
  "**/storage/temporary/**",
  "**/storage/default/*/cache/**",
  "**/datareporting/**",
  "**/saved-telemetry-pings/**",
  "**/sessionstore-backups/**",
  // Chromium's `Sessions/` dir (Session_*/Tabs_*) holds open-tab state. Syncing
  // it across devices is DEFERRED pending the sync-frequency fix: those files
  // rewrite constantly and inflated sync churn. Local tab restore still works
  // via the `--restore-last-session` launch flag; only cross-device tab sync is
  // on hold here.
  "**/sessions/**",
  "**/serviceworker.txt",
  "**/AlternateServices.bin",
  "**/SiteSecurityServiceState.bin",
  "**/favicons.sqlite",
  "**/favicons.sqlite-*",
  "**/crashes/**",
  "**/minidumps/**",
  "*.tmp",
  "**/LOG",
  "**/LOG.old",
  "**/LOCK",
  "**/*-journal",
  "**/*-wal",
  "**/SingletonLock",
  "**/SingletonSocket",
  "**/SingletonCookie",
  "**/Secure Preferences",
  "**/GraphiteDawnCache/**",
  "**/DawnWebGPUCache/**",
  "**/BrowserMetrics*",
  "**/.DS_Store",
  // The profile-root `metadata.json` is the profile CONFIG. It is synced
  // separately as the `profiles/<id>/metadata.json` config blob (see
  // `upload_profile_metadata`), so including it in the file manifest is
  // redundant. Worse, it carries `last_sync`, which is rewritten on every sync
  // as bookkeeping — leaving it in the manifest made the file diff perpetually
  // non-empty and drove an upload loop. Excluding it (glob has no `**`, so it
  // matches only the top-level file, never a nested `profile/.../metadata.json`)
  // decouples `last_sync` writes from the manifest entirely.
  "metadata.json",
  ".donut-sync/**",
  // Orphaned local-only marker from earlier rollover-based fingerprint
  // regeneration. Keep excluding it so any markers left on disk from
  // prior builds never get uploaded.
  ".last-fp-refresh",
];

/// A single file entry in the manifest
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestFileEntry {
  pub path: String,
  pub size: u64,
  pub mtime: i64,
  pub hash: String,
}

/// The sync manifest for a profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
  pub version: u32,
  #[serde(rename = "profileId")]
  pub profile_id: String,
  #[serde(rename = "generatedAt")]
  pub generated_at: String,
  #[serde(rename = "updatedAt")]
  pub updated_at: String,
  #[serde(rename = "excludeGlobs")]
  pub exclude_globs: Vec<String>,
  pub files: Vec<ManifestFileEntry>,
  #[serde(default)]
  pub encrypted: bool,
}

impl SyncManifest {
  pub fn new(profile_id: String, exclude_globs: Vec<String>) -> Self {
    let now = Utc::now().to_rfc3339();
    Self {
      version: 1,
      profile_id,
      generated_at: now.clone(),
      updated_at: now,
      exclude_globs,
      files: Vec::new(),
      encrypted: false,
    }
  }

  pub fn updated_at_datetime(&self) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&self.updated_at)
      .ok()
      .map(|dt| dt.with_timezone(&Utc))
  }
}

/// Local hash cache to avoid re-hashing unchanged files
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HashCache {
  pub entries: HashMap<String, HashCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashCacheEntry {
  pub size: u64,
  pub mtime: i64,
  pub hash: String,
}

impl HashCache {
  pub fn load(cache_path: &Path) -> Self {
    if !cache_path.exists() {
      return Self::default();
    }

    match fs::read_to_string(cache_path) {
      Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
      Err(_) => Self::default(),
    }
  }

  pub fn save(&self, cache_path: &Path) -> SyncResult<()> {
    if let Some(parent) = cache_path.parent() {
      fs::create_dir_all(parent).map_err(|e| {
        SyncError::IoError(format!(
          "Failed to create cache directory {}: {e}",
          parent.display()
        ))
      })?;
    }

    let json = serde_json::to_string_pretty(self)
      .map_err(|e| SyncError::SerializationError(format!("Failed to serialize hash cache: {e}")))?;

    fs::write(cache_path, json).map_err(|e| {
      SyncError::IoError(format!(
        "Failed to write hash cache {}: {e}",
        cache_path.display()
      ))
    })?;

    Ok(())
  }

  pub fn get(&self, path: &str, size: u64, mtime: i64) -> Option<&str> {
    self.entries.get(path).and_then(|entry| {
      if entry.size == size && entry.mtime == mtime {
        Some(entry.hash.as_str())
      } else {
        None
      }
    })
  }

  pub fn insert(&mut self, path: String, size: u64, mtime: i64, hash: String) {
    self
      .entries
      .insert(path, HashCacheEntry { size, mtime, hash });
  }
}

/// Build a GlobSet from exclude patterns
fn build_exclude_globset(patterns: &[String]) -> SyncResult<GlobSet> {
  let mut builder = GlobSetBuilder::new();
  for pattern in patterns {
    let glob = Glob::new(pattern)
      .map_err(|e| SyncError::InvalidData(format!("Invalid exclude pattern '{}': {e}", pattern)))?;
    builder.add(glob);
  }
  builder
    .build()
    .map_err(|e| SyncError::InvalidData(format!("Failed to build exclude globset: {e}")))
}

/// Compute blake3 hash of a file
/// Returns None if the file doesn't exist (was deleted)
fn hash_file(path: &Path) -> Result<Option<String>, SyncError> {
  let file = match File::open(path) {
    Ok(f) => f,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to open {}: {e}",
        path.display()
      )));
    }
  };

  let mut reader = BufReader::new(file);
  let mut hasher = blake3::Hasher::new();
  let mut buffer = [0u8; 65536]; // 64KB buffer

  loop {
    let bytes_read = reader
      .read(&mut buffer)
      .map_err(|e| SyncError::IoError(format!("Failed to read {}: {e}", path.display())))?;
    if bytes_read == 0 {
      break;
    }
    hasher.update(&buffer[..bytes_read]);
  }

  Ok(Some(hasher.finalize().to_hex().to_string()))
}

/// Get mtime as unix timestamp
/// Returns None if the file doesn't exist (was deleted)
fn get_mtime(path: &Path) -> Result<Option<i64>, SyncError> {
  let metadata = match path.metadata() {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to get metadata for {}: {e}",
        path.display()
      )));
    }
  };

  let mtime = metadata
    .modified()
    .map_err(|e| SyncError::IoError(format!("Failed to get mtime for {}: {e}", path.display())))?;

  Ok(Some(
    mtime
      .duration_since(SystemTime::UNIX_EPOCH)
      .map(|d| d.as_secs() as i64)
      .unwrap_or(0),
  ))
}

/// Generate a manifest for a profile directory
pub fn generate_manifest(
  profile_id: &str,
  profile_dir: &Path,
  cache: &mut HashCache,
) -> SyncResult<SyncManifest> {
  let exclude_patterns: Vec<String> = DEFAULT_EXCLUDE_PATTERNS
    .iter()
    .map(|s| s.to_string())
    .collect();
  let globset = build_exclude_globset(&exclude_patterns)?;

  let mut manifest = SyncManifest::new(profile_id.to_string(), exclude_patterns);
  let mut max_mtime: i64 = 0;

  if !profile_dir.exists() {
    log::debug!(
      "Profile directory doesn't exist: {}, creating empty manifest",
      profile_dir.display()
    );
    return Ok(manifest);
  }

  fn walk_dir(
    dir: &Path,
    base_dir: &Path,
    globset: &GlobSet,
    cache: &mut HashCache,
    files: &mut Vec<ManifestFileEntry>,
    max_mtime: &mut i64,
  ) -> SyncResult<()> {
    let entries = fs::read_dir(dir).map_err(|e| {
      SyncError::IoError(format!("Failed to read directory {}: {e}", dir.display()))
    })?;

    for entry in entries {
      let entry = entry.map_err(|e| {
        SyncError::IoError(format!("Failed to read entry in {}: {e}", dir.display()))
      })?;

      let path = entry.path();
      let relative_path = path
        .strip_prefix(base_dir)
        .map_err(|_| SyncError::IoError("Failed to compute relative path".to_string()))?
        .to_string_lossy()
        .replace('\\', "/");

      // Check if excluded
      if globset.is_match(&relative_path) {
        continue;
      }

      // Get metadata - skip if file was deleted between directory read and metadata access
      let metadata = match path.metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
          log::debug!(
            "File disappeared during manifest generation, skipping: {}",
            path.display()
          );
          continue;
        }
        Err(e) => {
          return Err(SyncError::IoError(format!(
            "Failed to get metadata for {}: {e}",
            path.display()
          )));
        }
      };

      if metadata.is_dir() {
        walk_dir(&path, base_dir, globset, cache, files, max_mtime)?;
      } else if metadata.is_file() {
        let size = metadata.len();
        let mtime = match get_mtime(&path)? {
          Some(m) => m,
          None => {
            // File was deleted, skip it
            log::debug!(
              "File disappeared during manifest generation, skipping: {}",
              path.display()
            );
            continue;
          }
        };

        *max_mtime = (*max_mtime).max(mtime);

        // Check cache for existing hash
        let hash = if let Some(cached_hash) = cache.get(&relative_path, size, mtime) {
          cached_hash.to_string()
        } else {
          match hash_file(&path)? {
            Some(computed_hash) => {
              cache.insert(relative_path.clone(), size, mtime, computed_hash.clone());
              computed_hash
            }
            None => {
              // File was deleted, skip it
              log::debug!(
                "File disappeared during manifest generation, skipping: {}",
                path.display()
              );
              continue;
            }
          }
        };

        files.push(ManifestFileEntry {
          path: relative_path,
          size,
          mtime,
          hash,
        });
      }
    }

    Ok(())
  }

  walk_dir(
    profile_dir,
    profile_dir,
    &globset,
    cache,
    &mut manifest.files,
    &mut max_mtime,
  )?;

  // Sort files for deterministic manifest
  manifest.files.sort_by(|a, b| a.path.cmp(&b.path));

  // Update the updatedAt timestamp to max mtime
  if max_mtime > 0 {
    if let Some(dt) = DateTime::from_timestamp(max_mtime, 0) {
      manifest.updated_at = dt.to_rfc3339();
    }
  }

  Ok(manifest)
}

/// Compute the diff between local and remote manifests
#[derive(Debug, Default)]
pub struct ManifestDiff {
  pub files_to_upload: Vec<ManifestFileEntry>,
  pub files_to_download: Vec<ManifestFileEntry>,
  pub files_to_delete_local: Vec<String>,
  pub files_to_delete_remote: Vec<String>,
  /// Paths where BOTH devices changed the file since the last agreed state (a
  /// true conflict) and the REMOTE side won (its copy is newer). Subset of
  /// `files_to_download`; the caller backs up the local copy before overwriting
  /// so the loser's bytes are never silently lost. Empty on the 2-way path.
  pub conflicts: Vec<String>,
  /// True conflicts where the LOCAL side won (its copy is newer). Subset of
  /// `files_to_upload`; the caller backs up the remote copy before overwriting
  /// it on the server, because the other device will later blind-download our
  /// winner over its local copy.
  pub conflict_uploads: Vec<String>,
}

impl ManifestDiff {
  pub fn is_empty(&self) -> bool {
    self.files_to_upload.is_empty()
      && self.files_to_download.is_empty()
      && self.files_to_delete_local.is_empty()
      && self.files_to_delete_remote.is_empty()
  }
}

/// Path to the per-device baseline manifest — the file set both sides agreed on
/// at the end of the last successful sync. Stored under `.donut-sync/` (which is
/// excluded from sync), so it is local to this device and never uploaded.
pub fn get_baseline_path(profile_dir: &Path) -> std::path::PathBuf {
  profile_dir.join(".donut-sync").join("baseline.json")
}

/// Load this device's baseline manifest, or None if there isn't one yet
/// (first sync, or a legacy profile that pre-dates 3-way reconcile).
pub fn load_baseline(profile_dir: &Path) -> Option<SyncManifest> {
  let content = fs::read_to_string(get_baseline_path(profile_dir)).ok()?;
  serde_json::from_str(&content).ok()
}

/// Persist the baseline manifest (the state both sides now agree on).
pub fn save_baseline(profile_dir: &Path, manifest: &SyncManifest) -> SyncResult<()> {
  let path = get_baseline_path(profile_dir);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| {
      SyncError::IoError(format!(
        "Failed to create baseline dir {}: {e}",
        parent.display()
      ))
    })?;
  }
  let json = serde_json::to_string(manifest)
    .map_err(|e| SyncError::SerializationError(format!("Failed to serialize baseline: {e}")))?;
  fs::write(&path, json)
    .map_err(|e| SyncError::IoError(format!("Failed to write baseline {}: {e}", path.display())))?;
  Ok(())
}

/// Three-way per-file reconcile against a shared `baseline` (the last agreed
/// state), so two devices editing DIFFERENT files converge and neither silently
/// clobbers the other.
///
/// For each path we compare the local hash (L), remote hash (R) and baseline
/// hash (B):
/// - `L == R` → already agreed, nothing to do.
/// - `L == B, R != B` → only remote changed → download (or delete local if
///   remote removed it).
/// - `R == B, L != B` → only local changed → upload (or delete remote if local
///   removed it).
/// - `L != B && R != B` (both moved) → true conflict: the side with the NEWER
///   file mtime wins (tie → remote). The path is recorded in `conflicts`
///   (remote won → back up local first) or `conflict_uploads` (local won →
///   back up the remote copy first).
///
/// A missing baseline (first sync / legacy) makes B == None everywhere, which
/// degrades gracefully: local-only files upload, remote-only files download,
/// files that differ on both sides are treated as conflicts (newer mtime wins,
/// loser backed up), and NOTHING is deleted (a delete needs baseline evidence
/// that the file once existed and one side removed it). This is strictly safer
/// than the old whole-profile max-mtime direction, which clobbered the "losing"
/// side.
pub fn compute_diff_3way(
  local: &SyncManifest,
  remote: Option<&SyncManifest>,
  baseline: Option<&SyncManifest>,
) -> ManifestDiff {
  let mut diff = ManifestDiff::default();

  let Some(remote) = remote else {
    // Nothing on the server yet — upload everything we have.
    diff.files_to_upload = local.files.clone();
    return diff;
  };

  // Data-loss guard: local empty but remote populated means the on-disk profile
  // data was wiped while metadata survived. Never read that as "user deleted
  // everything" (which would delete remote) — recover by downloading.
  if local.files.is_empty() && !remote.files.is_empty() {
    log::info!(
      "Local manifest empty but remote has {} files — downloading to recover",
      remote.files.len()
    );
    diff.files_to_download = remote.files.clone();
    return diff;
  }

  let local_files: HashMap<&str, &ManifestFileEntry> =
    local.files.iter().map(|f| (f.path.as_str(), f)).collect();
  let remote_files: HashMap<&str, &ManifestFileEntry> =
    remote.files.iter().map(|f| (f.path.as_str(), f)).collect();
  let baseline_files: HashMap<&str, &ManifestFileEntry> = baseline
    .map(|b| b.files.iter().map(|f| (f.path.as_str(), f)).collect())
    .unwrap_or_default();

  let mut all_paths: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
  all_paths.extend(local_files.keys().copied());
  all_paths.extend(remote_files.keys().copied());
  all_paths.extend(baseline_files.keys().copied());

  for path in all_paths {
    let l = local_files.get(path).map(|f| f.hash.as_str());
    let r = remote_files.get(path).map(|f| f.hash.as_str());
    let b = baseline_files.get(path).map(|f| f.hash.as_str());

    if l == r {
      continue; // both sides agree (present-equal, or both absent)
    }

    let local_unchanged = l == b;
    let remote_unchanged = r == b;

    if local_unchanged {
      // Only remote moved.
      match remote_files.get(path) {
        Some(re) => diff.files_to_download.push((*re).clone()),
        None => diff.files_to_delete_local.push(path.to_string()),
      }
    } else if remote_unchanged {
      // Only local moved.
      match local_files.get(path) {
        Some(le) => diff.files_to_upload.push((*le).clone()),
        None => diff.files_to_delete_remote.push(path.to_string()),
      }
    } else {
      // Both moved since baseline → conflict.
      match (local_files.get(path), remote_files.get(path)) {
        (Some(le), Some(re)) => {
          // Both edited: the NEWER copy (file mtime) wins, ties go to remote.
          // "Always remote wins" ate fresh logins: with both browsers open, the
          // machine that synced LAST had its just-written Cookies replaced by
          // the other side's earlier upload. mtime is genuine on both sides
          // here — a conflict requires the browser to have really written the
          // file since the last sync (a downloaded-untouched copy hashes equal
          // to baseline and never reaches this branch). The loser is backed up
          // either way.
          if le.mtime > re.mtime {
            diff.files_to_upload.push((*le).clone());
            diff.conflict_uploads.push(path.to_string());
          } else {
            diff.files_to_download.push((*re).clone());
            diff.conflicts.push(path.to_string());
          }
        }
        (Some(le), None) => {
          // Local edited, remote deleted: keep the edit (resurrect on remote).
          diff.files_to_upload.push((*le).clone());
        }
        (None, Some(re)) => {
          // Local deleted, remote edited: keep the edit (resurrect locally).
          diff.files_to_download.push((*re).clone());
        }
        (None, None) => {}
      }
    }
  }

  diff
}

/// Compute what needs to be synced between local and remote
pub fn compute_diff(local: &SyncManifest, remote: Option<&SyncManifest>) -> ManifestDiff {
  let mut diff = ManifestDiff::default();

  let Some(remote) = remote else {
    // No remote manifest - upload everything
    diff.files_to_upload = local.files.clone();
    return diff;
  };

  // Build hash maps for quick lookup
  let local_files: HashMap<&str, &ManifestFileEntry> =
    local.files.iter().map(|f| (f.path.as_str(), f)).collect();
  let remote_files: HashMap<&str, &ManifestFileEntry> =
    remote.files.iter().map(|f| (f.path.as_str(), f)).collect();

  // Safety: if local is empty but remote has files, always download from remote.
  // This prevents data loss when profile data files are deleted but metadata
  // survives — the newly generated manifest would have updated_at=NOW, which
  // would appear "newer" and cause all remote files to be deleted.
  if local.files.is_empty() && !remote.files.is_empty() {
    log::info!(
      "Local manifest is empty but remote has {} files — downloading from remote to recover",
      remote.files.len()
    );
    diff.files_to_download = remote.files.clone();
    return diff;
  }

  // Compare timestamps to determine direction
  let local_updated = local.updated_at_datetime();
  let remote_updated = remote.updated_at_datetime();

  let local_is_newer = match (local_updated, remote_updated) {
    (Some(l), Some(r)) => l > r,
    (Some(_), None) => true,
    (None, Some(_)) => false,
    (None, None) => true, // Default to uploading
  };

  if local_is_newer {
    // Upload changed/new files, delete remote files that don't exist locally
    for (path, local_entry) in &local_files {
      match remote_files.get(path) {
        Some(remote_entry) if remote_entry.hash != local_entry.hash => {
          diff.files_to_upload.push((*local_entry).clone());
        }
        None => {
          diff.files_to_upload.push((*local_entry).clone());
        }
        _ => {}
      }
    }

    for path in remote_files.keys() {
      if !local_files.contains_key(path) {
        diff.files_to_delete_remote.push(path.to_string());
      }
    }
  } else {
    // Download changed/new files, delete local files that don't exist remotely
    for (path, remote_entry) in &remote_files {
      match local_files.get(path) {
        Some(local_entry) if local_entry.hash != remote_entry.hash => {
          diff.files_to_download.push((*remote_entry).clone());
        }
        None => {
          diff.files_to_download.push((*remote_entry).clone());
        }
        _ => {}
      }
    }

    for path in local_files.keys() {
      if !remote_files.contains_key(path) {
        diff.files_to_delete_local.push(path.to_string());
      }
    }
  }

  diff
}

/// Get the path to the hash cache file for a profile
pub fn get_cache_path(profile_dir: &Path) -> std::path::PathBuf {
  profile_dir.join(".donut-sync").join("cache.json")
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::profile::types::BrowserProfile;
  use tempfile::TempDir;

  #[test]
  fn test_hash_cache_operations() {
    let cache_dir = TempDir::new().unwrap();
    let cache_path = cache_dir.path().join("cache.json");

    let mut cache = HashCache::default();
    cache.insert(
      "test.txt".to_string(),
      100,
      1234567890,
      "abc123".to_string(),
    );

    assert_eq!(cache.get("test.txt", 100, 1234567890), Some("abc123"));
    assert_eq!(cache.get("test.txt", 100, 999), None); // Different mtime
    assert_eq!(cache.get("test.txt", 50, 1234567890), None); // Different size

    cache.save(&cache_path).unwrap();

    let loaded = HashCache::load(&cache_path);
    assert_eq!(loaded.get("test.txt", 100, 1234567890), Some("abc123"));
  }

  #[test]
  fn test_generate_manifest_empty_dir() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.profile_id, "test-profile");
    assert_eq!(manifest.version, 1);
    assert!(manifest.files.is_empty());
  }

  #[test]
  fn test_generate_manifest_with_files() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    fs::write(profile_dir.join("file1.txt"), "hello").unwrap();
    fs::write(profile_dir.join("file2.txt"), "world").unwrap();
    fs::create_dir_all(profile_dir.join("subdir")).unwrap();
    fs::write(profile_dir.join("subdir/file3.txt"), "nested").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.files.len(), 3);
    assert!(manifest.files.iter().any(|f| f.path == "file1.txt"));
    assert!(manifest.files.iter().any(|f| f.path == "file2.txt"));
    assert!(manifest.files.iter().any(|f| f.path == "subdir/file3.txt"));
  }

  #[test]
  fn test_generate_manifest_excludes_cache() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    fs::write(profile_dir.join("file1.txt"), "keep").unwrap();
    fs::create_dir_all(profile_dir.join("Cache")).unwrap();
    fs::write(profile_dir.join("Cache/data"), "exclude").unwrap();
    fs::create_dir_all(profile_dir.join("Code Cache")).unwrap();
    fs::write(profile_dir.join("Code Cache/wasm"), "exclude").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].path, "file1.txt");
  }

  #[test]
  fn test_generate_manifest_excludes_nested_caches() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile_root");
    fs::create_dir_all(&profile_dir).unwrap();

    // Simulate real Chromium structure: profile/Default/Cache/...
    let default_dir = profile_dir.join("profile/Default");
    fs::create_dir_all(&default_dir).unwrap();
    fs::write(default_dir.join("Cookies"), "keep").unwrap();
    fs::create_dir_all(default_dir.join("Cache")).unwrap();
    fs::write(default_dir.join("Cache/data_0"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Code Cache/js")).unwrap();
    fs::write(default_dir.join("Code Cache/js/abc"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("GPUCache")).unwrap();
    fs::write(default_dir.join("GPUCache/data_0"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Session Storage")).unwrap();
    fs::write(default_dir.join("Session Storage/000003.log"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Local Storage/leveldb")).unwrap();
    fs::write(default_dir.join("Local Storage/leveldb/000001.ldb"), "keep").unwrap();

    // Caches at user-data-dir level
    fs::create_dir_all(profile_dir.join("profile/ShaderCache")).unwrap();
    fs::write(profile_dir.join("profile/ShaderCache/data"), "exclude").unwrap();
    fs::create_dir_all(profile_dir.join("profile/Crashpad")).unwrap();
    fs::write(profile_dir.join("profile/Crashpad/report"), "exclude").unwrap();

    // metadata.json at root
    let profile = BrowserProfile::default();
    fs::write(
      profile_dir.join("metadata.json"),
      serde_json::to_string(&profile).unwrap(),
    )
    .unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
      !paths.contains(&"metadata.json"),
      "profile-root metadata.json is the config blob and must be excluded from the file manifest"
    );
    assert!(
      paths.contains(&"profile/Default/Cookies"),
      "Cookies should be synced"
    );
    assert!(
      paths.contains(&"profile/Default/Local Storage/leveldb/000001.ldb"),
      "Local Storage should be synced"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Cache")),
      "Cache directories should be excluded: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Session Storage")),
      "Session Storage should be excluded: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Crashpad")),
      "Crashpad should be excluded: {paths:?}"
    );
  }

  #[test]
  fn test_compute_diff_upload_all_when_no_remote() {
    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: Utc::now().to_rfc3339(),
      updated_at: Utc::now().to_rfc3339(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "file1.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "abc".to_string(),
        },
        ManifestFileEntry {
          path: "file2.txt".to_string(),
          size: 20,
          mtime: 2000,
          hash: "def".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, None);

    assert_eq!(diff.files_to_upload.len(), 2);
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
  }

  #[test]
  fn test_compute_diff_detect_changes() {
    let old_time = "2024-01-01T00:00:00Z";
    let new_time = "2024-01-02T00:00:00Z";

    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: new_time.to_string(),
      updated_at: new_time.to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "unchanged.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "same".to_string(),
        },
        ManifestFileEntry {
          path: "changed.txt".to_string(),
          size: 10,
          mtime: 2000,
          hash: "new_hash".to_string(),
        },
        ManifestFileEntry {
          path: "new_file.txt".to_string(),
          size: 5,
          mtime: 3000,
          hash: "new".to_string(),
        },
      ],
      encrypted: false,
    };

    let remote = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: old_time.to_string(),
      updated_at: old_time.to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "unchanged.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "same".to_string(),
        },
        ManifestFileEntry {
          path: "changed.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "old_hash".to_string(),
        },
        ManifestFileEntry {
          path: "deleted.txt".to_string(),
          size: 8,
          mtime: 500,
          hash: "gone".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, Some(&remote));

    // Local is newer, so we upload changed/new and delete remote-only
    assert_eq!(diff.files_to_upload.len(), 2); // changed + new
    assert!(diff.files_to_upload.iter().any(|f| f.path == "changed.txt"));
    assert!(diff
      .files_to_upload
      .iter()
      .any(|f| f.path == "new_file.txt"));
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert_eq!(diff.files_to_delete_remote.len(), 1);
    assert!(diff
      .files_to_delete_remote
      .contains(&"deleted.txt".to_string()));
  }

  #[test]
  fn test_manifest_encrypted_flag_default() {
    let json = r#"{"version":1,"profileId":"test","generatedAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","excludeGlobs":[],"files":[]}"#;
    let manifest: SyncManifest = serde_json::from_str(json).unwrap();
    assert!(!manifest.encrypted);
  }

  #[test]
  fn test_manifest_with_encrypted_flag() {
    let json = r#"{"version":1,"profileId":"test","generatedAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","excludeGlobs":[],"files":[],"encrypted":true}"#;
    let manifest: SyncManifest = serde_json::from_str(json).unwrap();
    assert!(manifest.encrypted);

    let serialized = serde_json::to_string(&manifest).unwrap();
    let deserialized: SyncManifest = serde_json::from_str(&serialized).unwrap();
    assert!(deserialized.encrypted);
  }

  #[test]
  fn test_compute_diff_empty_local_downloads_from_remote() {
    // When local has no files but remote does, always download from remote.
    // This prevents data loss when profile data is deleted but metadata survives.
    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: Utc::now().to_rfc3339(),
      updated_at: Utc::now().to_rfc3339(), // NOW — appears newer than remote
      exclude_globs: vec![],
      files: vec![],
      encrypted: false,
    };

    let remote = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: "2024-01-01T00:00:00Z".to_string(),
      updated_at: "2024-01-01T00:00:00Z".to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "Cookies".to_string(),
          size: 100,
          mtime: 1000,
          hash: "abc".to_string(),
        },
        ManifestFileEntry {
          path: "Local State".to_string(),
          size: 200,
          mtime: 1000,
          hash: "def".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, Some(&remote));

    // Must download all remote files, NOT delete them
    assert_eq!(diff.files_to_download.len(), 2);
    assert!(diff.files_to_upload.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
  }

  #[test]
  fn test_generate_manifest_excludes_profile_root_metadata() {
    // The profile-root metadata.json is the config blob (synced separately). It
    // must never enter the file manifest — it carries `last_sync`, which is
    // rewritten every sync, so including it would make the diff perpetually
    // non-empty and drive an upload loop.
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    let profile_id = uuid::Uuid::new_v4();

    // A top-level metadata.json (config) plus a real synced file and a nested
    // metadata.json that should still be included.
    let profile = BrowserProfile {
      id: profile_id,
      name: "test-profile".to_string(),
      last_sync: Some(100),
      process_id: Some(1234),
      ..Default::default()
    };
    fs::write(
      profile_dir.join("metadata.json"),
      serde_json::to_string(&profile).unwrap(),
    )
    .unwrap();
    fs::create_dir_all(profile_dir.join("profile/Default")).unwrap();
    fs::write(profile_dir.join("profile/Default/Cookies"), "keep").unwrap();
    // A nested file that happens to be named metadata.json must NOT be excluded:
    // the exclusion targets only the top-level config blob.
    fs::write(profile_dir.join("profile/Default/metadata.json"), "keep").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest(&profile_id.to_string(), &profile_dir, &mut cache).unwrap();
    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();

    assert!(
      !paths.contains(&"metadata.json"),
      "top-level metadata.json must be excluded: {paths:?}"
    );
    assert!(
      paths.contains(&"profile/Default/Cookies"),
      "Cookies should be synced: {paths:?}"
    );
    assert!(
      paths.contains(&"profile/Default/metadata.json"),
      "nested metadata.json must still be synced: {paths:?}"
    );

    // Rewriting the top-level metadata.json with a new last_sync must leave the
    // manifest byte-identical (it isn't part of the manifest at all).
    let files_before = manifest.files.clone();
    let profile2 = BrowserProfile {
      id: profile_id,
      name: "test-profile".to_string(),
      last_sync: Some(999),
      process_id: Some(5678),
      ..Default::default()
    };
    fs::write(
      profile_dir.join("metadata.json"),
      serde_json::to_string(&profile2).unwrap(),
    )
    .unwrap();
    let manifest2 = generate_manifest(&profile_id.to_string(), &profile_dir, &mut cache).unwrap();
    assert_eq!(
      files_before, manifest2.files,
      "rewriting profile-root metadata.json must not change the manifest file set"
    );
  }

  /// Build a manifest from (path, hash) pairs for 3-way reconcile tests.
  fn mk(files: &[(&str, &str)]) -> SyncManifest {
    let mut m = SyncManifest::new("test".to_string(), vec![]);
    m.files = files
      .iter()
      .map(|(p, h)| ManifestFileEntry {
        path: p.to_string(),
        size: 1,
        mtime: 1,
        hash: h.to_string(),
      })
      .collect();
    m
  }

  #[test]
  fn test_3way_only_remote_changed_downloads() {
    let base = mk(&[("a", "v1")]);
    let local = mk(&[("a", "v1")]); // unchanged locally
    let remote = mk(&[("a", "v2")]); // remote edited
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_download.len(), 1);
    assert_eq!(diff.files_to_download[0].hash, "v2");
    assert!(diff.files_to_upload.is_empty());
    assert!(diff.conflicts.is_empty());
  }

  #[test]
  fn test_3way_only_local_changed_uploads() {
    let base = mk(&[("a", "v1")]);
    let local = mk(&[("a", "v2")]); // local edited
    let remote = mk(&[("a", "v1")]); // remote unchanged
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_upload.len(), 1);
    assert_eq!(diff.files_to_upload[0].hash, "v2");
    assert!(diff.files_to_download.is_empty());
  }

  #[test]
  fn test_3way_both_changed_is_conflict_remote_wins() {
    // Equal mtimes (mk sets mtime=1 everywhere) → tie → remote wins.
    let base = mk(&[("a", "v1")]);
    let local = mk(&[("a", "vLocal")]);
    let remote = mk(&[("a", "vRemote")]);
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    // Remote wins (download), but the path is flagged so the caller backs up local.
    assert_eq!(diff.files_to_download.len(), 1);
    assert_eq!(diff.files_to_download[0].hash, "vRemote");
    assert_eq!(diff.conflicts, vec!["a".to_string()]);
    assert!(diff.files_to_upload.is_empty());
    assert!(diff.conflict_uploads.is_empty());
  }

  /// Like `mk` but with an explicit mtime per file, for conflict-resolution tests.
  fn mk_mt(files: &[(&str, &str, i64)]) -> SyncManifest {
    let mut m = SyncManifest::new("test".to_string(), vec![]);
    m.files = files
      .iter()
      .map(|(p, h, t)| ManifestFileEntry {
        path: p.to_string(),
        size: 1,
        mtime: *t,
        hash: h.to_string(),
      })
      .collect();
    m
  }

  #[test]
  fn test_3way_conflict_newer_local_wins() {
    // The login-loss scenario: both machines used the profile, but the LOCAL
    // copy (e.g. Cookies written by the just-closed browser with a fresh login)
    // is newer → local must win and be uploaded, with the remote loser flagged
    // for backup. "Always remote wins" would have eaten the login.
    let base = mk_mt(&[("Cookies", "v1", 100)]);
    let local = mk_mt(&[("Cookies", "vLoginFresh", 300)]); // newer
    let remote = mk_mt(&[("Cookies", "vStale", 200)]);
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_upload.len(), 1);
    assert_eq!(diff.files_to_upload[0].hash, "vLoginFresh");
    assert_eq!(diff.conflict_uploads, vec!["Cookies".to_string()]);
    assert!(diff.files_to_download.is_empty());
    assert!(diff.conflicts.is_empty());
  }

  #[test]
  fn test_3way_conflict_newer_remote_wins() {
    let base = mk_mt(&[("Cookies", "v1", 100)]);
    let local = mk_mt(&[("Cookies", "vOld", 200)]);
    let remote = mk_mt(&[("Cookies", "vNewer", 300)]); // newer
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_download.len(), 1);
    assert_eq!(diff.files_to_download[0].hash, "vNewer");
    assert_eq!(diff.conflicts, vec!["Cookies".to_string()]);
    assert!(diff.files_to_upload.is_empty());
    assert!(diff.conflict_uploads.is_empty());
  }

  #[test]
  fn test_3way_concurrent_edits_to_different_files_dont_clobber() {
    // The core two-device bug: A edits x, B edits y. Neither may lose.
    let base = mk(&[("x", "x1"), ("y", "y1")]);
    let local = mk(&[("x", "x2"), ("y", "y1")]); // this device edited x
    let remote = mk(&[("x", "x1"), ("y", "y2")]); // other device edited y
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_upload.len(), 1);
    assert_eq!(diff.files_to_upload[0].path, "x");
    assert_eq!(diff.files_to_download.len(), 1);
    assert_eq!(diff.files_to_download[0].path, "y");
    assert!(diff.conflicts.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
  }

  #[test]
  fn test_3way_local_delete_propagates_to_remote() {
    let base = mk(&[("a", "v1"), ("b", "v1")]);
    let local = mk(&[("a", "v1")]); // b deleted locally
    let remote = mk(&[("a", "v1"), ("b", "v1")]); // remote still has b
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_delete_remote, vec!["b".to_string()]);
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_upload.is_empty());
  }

  #[test]
  fn test_3way_remote_delete_propagates_to_local() {
    let base = mk(&[("a", "v1"), ("b", "v1")]);
    let local = mk(&[("a", "v1"), ("b", "v1")]);
    let remote = mk(&[("a", "v1")]); // b deleted on other device
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_delete_local, vec!["b".to_string()]);
  }

  #[test]
  fn test_3way_no_baseline_never_deletes() {
    // First sync (no baseline): local-only uploads, remote-only downloads,
    // differing files conflict (remote wins), and NOTHING is deleted.
    let local = mk(&[("shared", "sL"), ("localonly", "l1")]);
    let remote = mk(&[("shared", "sR"), ("remoteonly", "r1")]);
    let diff = compute_diff_3way(&local, Some(&remote), None);
    assert!(diff.files_to_delete_local.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
    assert!(diff.files_to_upload.iter().any(|f| f.path == "localonly"));
    assert!(diff
      .files_to_download
      .iter()
      .any(|f| f.path == "remoteonly"));
    // "shared" differs on both with no baseline → conflict.
    assert_eq!(diff.conflicts, vec!["shared".to_string()]);
  }

  #[test]
  fn test_3way_empty_local_recovers_from_remote() {
    // Data-loss guard: wiped local dir must download, never delete remote.
    let base = mk(&[("a", "v1")]);
    let local = mk(&[]);
    let remote = mk(&[("a", "v1")]);
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_download.len(), 1);
    assert!(diff.files_to_delete_remote.is_empty());
  }

  #[test]
  fn test_3way_in_sync_is_noop() {
    let base = mk(&[("a", "v1")]);
    let local = mk(&[("a", "v1")]);
    let remote = mk(&[("a", "v1")]);
    let diff = compute_diff_3way(&local, Some(&remote), Some(&base));
    assert!(diff.is_empty());
  }
}
