//! PostingRecord — append-only per-persona posting history. Local-first.
//! Written when the operator marks a draft as posted; gives each persona a
//! timeline and feeds anti-repetition into future generation (P3d).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use utoipa::ToSchema;

use crate::events;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PostingRecord {
  pub id: String,
  pub profile_id: String,
  pub brand_id: String,
  pub target_url: String,
  pub platform: String,
  pub kind: String, // "direct" | "reply"
  pub angle: String,
  pub text_snapshot: String,
  pub posted_at: u64,
}

pub struct HistoryManager;

impl HistoryManager {
  pub fn new() -> Self {
    Self
  }

  fn file(&self, profile_id: &str) -> PathBuf {
    crate::app_dirs::history_dir().join(format!("{profile_id}.json"))
  }

  fn load(&self, profile_id: &str) -> Vec<PostingRecord> {
    let path = self.file(profile_id);
    if !path.exists() {
      return Vec::new();
    }
    fs::read_to_string(&path)
      .ok()
      .and_then(|s| serde_json::from_str::<Vec<PostingRecord>>(&s).ok())
      .unwrap_or_default()
  }

  /// All posting records for a persona, oldest first.
  pub fn list_for_profile(&self, profile_id: &str) -> Vec<PostingRecord> {
    self.load(profile_id)
  }

  /// Append a record to the persona's history (creating the file if needed).
  pub fn append(&self, record: PostingRecord) -> Result<(), Box<dyn std::error::Error>> {
    let dir = crate::app_dirs::history_dir();
    fs::create_dir_all(&dir)?;
    let mut records = self.load(&record.profile_id);
    let profile_id = record.profile_id.clone();
    records.push(record);
    fs::write(
      self.file(&profile_id),
      serde_json::to_string_pretty(&records)?,
    )?;
    if let Err(e) = events::emit_empty("history-changed") {
      log::error!("Failed to emit history-changed event: {e}");
    }
    Ok(())
  }
}

lazy_static::lazy_static! {
  pub static ref HISTORY_MANAGER: Mutex<HistoryManager> = Mutex::new(HistoryManager::new());
}
