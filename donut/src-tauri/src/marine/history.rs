//! Local-first, append-only posting history for Marine identities.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::NamedTempFile;
use thiserror::Error;
use utoipa::ToSchema;

use crate::events;

fn default_confirmation_source() -> String {
  "manual".to_string()
}

fn default_status() -> String {
  "manual_confirmed".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PostingRecord {
  pub id: String,
  /// Stable receipt id supplied by a supported platform integration.
  #[serde(default)]
  pub event_id: Option<String>,
  pub profile_id: String,
  /// Snapshot retained even if the Marine identity is renamed or deleted.
  #[serde(default)]
  pub profile_name_snapshot: String,
  pub brand_id: String,
  pub target_url: String,
  #[serde(default)]
  pub page_title: String,
  pub platform: String,
  pub kind: String, // "direct" | "reply"
  pub angle: String,
  pub text_snapshot: String,
  #[serde(default)]
  pub site_account_id: Option<String>,
  #[serde(default)]
  pub site_account_name: Option<String>,
  #[serde(default)]
  pub platform_comment_id: Option<String>,
  #[serde(default)]
  pub target_comment_id: Option<String>,
  #[serde(default)]
  pub target_author: Option<String>,
  #[serde(default)]
  pub parent_id: Option<String>,
  #[serde(default)]
  pub root_id: Option<String>,
  #[serde(default)]
  pub context_id: Option<String>,
  /// `manual` for legacy/operator confirmation, or a platform receipt source.
  #[serde(default = "default_confirmation_source")]
  pub confirmation_source: String,
  /// `manual_confirmed` or `published`.
  #[serde(default = "default_status")]
  pub status: String,
  pub posted_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendOutcome {
  Inserted(PostingRecord),
  Duplicate(PostingRecord),
}

impl AppendOutcome {
  pub fn record(&self) -> &PostingRecord {
    match self {
      Self::Inserted(record) | Self::Duplicate(record) => record,
    }
  }
}

#[derive(Debug, Error)]
pub enum HistoryError {
  #[error("invalid Marine profile id: {0}")]
  InvalidProfileId(String),
  #[error("invalid history file name: {0}")]
  InvalidHistoryFile(PathBuf),
  #[error("failed to read history file {path}: {source}")]
  Read {
    path: PathBuf,
    #[source]
    source: std::io::Error,
  },
  #[error("invalid JSON in history file {path}: {source}")]
  InvalidJson {
    path: PathBuf,
    #[source]
    source: serde_json::Error,
  },
  #[error("history file {path} contains a record for profile {actual}, expected {expected}")]
  ProfileMismatch {
    path: PathBuf,
    expected: String,
    actual: String,
  },
  #[error("failed to create history directory {path}: {source}")]
  CreateDir {
    path: PathBuf,
    #[source]
    source: std::io::Error,
  },
  #[error("failed to serialize posting history: {0}")]
  Serialize(#[from] serde_json::Error),
  #[error("failed to write history file {path}: {source}")]
  Write {
    path: PathBuf,
    #[source]
    source: std::io::Error,
  },
}

pub struct HistoryManager;

impl Default for HistoryManager {
  fn default() -> Self {
    Self::new()
  }
}

impl HistoryManager {
  pub fn new() -> Self {
    Self
  }

  fn canonical_profile_id(profile_id: &str) -> Result<String, HistoryError> {
    uuid::Uuid::parse_str(profile_id)
      .map(|id| id.to_string())
      .map_err(|_| HistoryError::InvalidProfileId(profile_id.to_string()))
  }

  fn file_for_canonical_id(&self, profile_id: &str) -> PathBuf {
    crate::app_dirs::history_dir().join(format!("{profile_id}.json"))
  }

  fn load_canonical(&self, profile_id: &str) -> Result<Vec<PostingRecord>, HistoryError> {
    let path = self.file_for_canonical_id(profile_id);
    if !path.exists() {
      return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|source| HistoryError::Read {
      path: path.clone(),
      source,
    })?;
    let records: Vec<PostingRecord> =
      serde_json::from_str(&contents).map_err(|source| HistoryError::InvalidJson {
        path: path.clone(),
        source,
      })?;
    if let Some(record) = records
      .iter()
      .find(|record| record.profile_id != profile_id)
    {
      return Err(HistoryError::ProfileMismatch {
        path,
        expected: profile_id.to_string(),
        actual: record.profile_id.clone(),
      });
    }
    Ok(records)
  }

  /// All posting records for one Marine identity, oldest first.
  pub fn list_for_profile(&self, profile_id: &str) -> Result<Vec<PostingRecord>, HistoryError> {
    let profile_id = Self::canonical_profile_id(profile_id)?;
    self.load_canonical(&profile_id)
  }

  /// All histories across identities, newest first.
  pub fn list_all(&self) -> Result<Vec<PostingRecord>, HistoryError> {
    let dir = crate::app_dirs::history_dir();
    if !dir.exists() {
      return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|source| HistoryError::Read {
      path: dir.clone(),
      source,
    })?;
    let mut records = Vec::new();
    for entry in entries {
      let entry = entry.map_err(|source| HistoryError::Read {
        path: dir.clone(),
        source,
      })?;
      let path = entry.path();
      if path.extension().and_then(|value| value.to_str()) != Some("json") {
        continue;
      }
      let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return Err(HistoryError::InvalidHistoryFile(path));
      };
      let profile_id = Self::canonical_profile_id(stem)
        .map_err(|_| HistoryError::InvalidHistoryFile(path.clone()))?;
      records.extend(self.load_canonical(&profile_id)?);
    }
    records.sort_by(|left, right| {
      right
        .posted_at
        .cmp(&left.posted_at)
        .then_with(|| right.id.cmp(&left.id))
    });
    Ok(records)
  }

  /// Append unless an automatic platform receipt was already recorded.
  pub fn append(&self, mut record: PostingRecord) -> Result<AppendOutcome, HistoryError> {
    let profile_id = Self::canonical_profile_id(&record.profile_id)?;
    record.profile_id.clone_from(&profile_id);
    let dir = crate::app_dirs::history_dir();
    fs::create_dir_all(&dir).map_err(|source| HistoryError::CreateDir {
      path: dir.clone(),
      source,
    })?;
    let mut records = self.load_canonical(&profile_id)?;
    let duplicate = records.iter().find(|existing| {
      record
        .event_id
        .as_ref()
        .zip(existing.event_id.as_ref())
        .is_some_and(|(left, right)| left == right)
        || record
          .platform_comment_id
          .as_ref()
          .zip(existing.platform_comment_id.as_ref())
          .is_some_and(|(left, right)| {
            left == right
              && existing.profile_id == record.profile_id
              && existing.platform == record.platform
          })
    });
    if let Some(existing) = duplicate {
      return Ok(AppendOutcome::Duplicate(existing.clone()));
    }

    records.push(record.clone());
    self.write_atomic(&self.file_for_canonical_id(&profile_id), &records)?;
    if let Err(error) = events::emit_empty("history-changed") {
      log::error!("Failed to emit history-changed event: {error}");
    }
    Ok(AppendOutcome::Inserted(record))
  }

  fn write_atomic(&self, path: &Path, records: &[PostingRecord]) -> Result<(), HistoryError> {
    let bytes = serde_json::to_vec_pretty(records)?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = NamedTempFile::new_in(dir).map_err(|source| HistoryError::Write {
      path: path.to_path_buf(),
      source,
    })?;
    temp
      .write_all(&bytes)
      .and_then(|_| temp.write_all(b"\n"))
      .and_then(|_| temp.as_file().sync_all())
      .map_err(|source| HistoryError::Write {
        path: path.to_path_buf(),
        source,
      })?;
    temp.persist(path).map_err(|error| HistoryError::Write {
      path: path.to_path_buf(),
      source: error.error,
    })?;
    Ok(())
  }
}

lazy_static::lazy_static! {
  pub static ref HISTORY_MANAGER: Mutex<HistoryManager> = Mutex::new(HistoryManager::new());
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn record(profile_id: uuid::Uuid, comment_id: Option<&str>, posted_at: u64) -> PostingRecord {
    PostingRecord {
      id: uuid::Uuid::new_v4().to_string(),
      event_id: comment_id.map(|id| format!("bilibili:{id}")),
      profile_id: profile_id.to_string(),
      profile_name_snapshot: "Researcher".into(),
      brand_id: "scholay".into(),
      target_url: "https://www.bilibili.com/video/BV1test".into(),
      page_title: "Test video".into(),
      platform: "bilibili".into(),
      kind: "direct".into(),
      angle: String::new(),
      text_snapshot: "A final comment".into(),
      site_account_id: Some("42".into()),
      site_account_name: Some("viewer".into()),
      platform_comment_id: comment_id.map(str::to_string),
      target_comment_id: None,
      target_author: None,
      parent_id: None,
      root_id: None,
      context_id: None,
      confirmation_source: "bilibili-api".into(),
      status: "published".into(),
      posted_at,
    }
  }

  #[test]
  fn legacy_records_receive_manual_defaults() {
    let profile_id = uuid::Uuid::new_v4();
    let legacy = serde_json::json!({
      "id": "legacy-id",
      "profile_id": profile_id,
      "brand_id": "scholay",
      "target_url": "https://example.com",
      "platform": "web",
      "kind": "direct",
      "angle": "",
      "text_snapshot": "legacy comment",
      "posted_at": 1
    });
    let parsed: PostingRecord = serde_json::from_value(legacy).unwrap();
    assert_eq!(parsed.status, "manual_confirmed");
    assert_eq!(parsed.confirmation_source, "manual");
    assert!(parsed.page_title.is_empty());
    assert!(parsed.platform_comment_id.is_none());
  }

  #[test]
  fn invalid_profile_id_cannot_escape_history_directory() {
    let manager = HistoryManager::new();
    let error = manager.list_for_profile("../../profiles").unwrap_err();
    assert!(matches!(error, HistoryError::InvalidProfileId(_)));
  }

  #[test]
  fn corrupt_history_is_reported_and_not_overwritten() {
    let temp = tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = HistoryManager::new();
    let profile_id = uuid::Uuid::new_v4();
    let dir = crate::app_dirs::history_dir();
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{profile_id}.json"));
    fs::write(&path, "not-json").unwrap();

    assert!(matches!(
      manager.list_for_profile(&profile_id.to_string()),
      Err(HistoryError::InvalidJson { .. })
    ));
    assert!(manager.append(record(profile_id, Some("10"), 1)).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "not-json");
  }

  #[test]
  fn automatic_receipts_are_idempotent() {
    let temp = tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = HistoryManager::new();
    let profile_id = uuid::Uuid::new_v4();
    let first = record(profile_id, Some("9001"), 100);
    let mut retry = first.clone();
    retry.id = uuid::Uuid::new_v4().to_string();
    retry.event_id = None;

    assert!(matches!(
      manager.append(first),
      Ok(AppendOutcome::Inserted(_))
    ));
    let duplicate = manager.append(retry).unwrap();
    assert!(matches!(duplicate, AppendOutcome::Duplicate(_)));
    assert_eq!(
      manager
        .list_for_profile(&profile_id.to_string())
        .unwrap()
        .len(),
      1
    );
  }

  #[test]
  fn a_new_receipt_atomically_replaces_an_existing_profile_file() {
    let temp = tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = HistoryManager::new();
    let profile_id = uuid::Uuid::new_v4();
    manager
      .append(record(profile_id, Some("100"), 100))
      .unwrap();
    manager
      .append(record(profile_id, Some("200"), 200))
      .unwrap();

    let records = manager.list_for_profile(&profile_id.to_string()).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].platform_comment_id.as_deref(), Some("100"));
    assert_eq!(records[1].platform_comment_id.as_deref(), Some("200"));
  }

  #[test]
  fn list_all_merges_profiles_newest_first() {
    let temp = tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = HistoryManager::new();
    let first_profile = uuid::Uuid::new_v4();
    let second_profile = uuid::Uuid::new_v4();
    manager
      .append(record(first_profile, Some("1"), 100))
      .unwrap();
    manager
      .append(record(second_profile, Some("2"), 200))
      .unwrap();

    let all = manager.list_all().unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].posted_at, 200);
    assert_eq!(all[1].posted_at, 100);
  }
}
