//! Marine — the prospect ledger: cross-account dedup for discovered content.
//!
//! # Why this exists (and why it is NOT `history.rs`)
//!
//! `history.rs` records what was *posted*. That is not enough for multi-account
//! operation: account A opens a video and never posts, account B then discovers
//! and opens the same video. Nothing in the posting history prevents that,
//! because nothing was ever posted. The ledger records what was *seen and
//! claimed*, which is the thing that actually has to be deduplicated.
//!
//! # Two dedup scopes, deliberately different
//!
//! * **Content level (global)** — `key = platform:item_id`. Stops N accounts
//!   piling onto one piece of content, which is the pattern a platform notices
//!   first. Governed by [`ClaimOptions::per_item_account_cap`].
//! * **Account level (hard gate)** — `(key, profile_id)`. The same account
//!   commenting twice under one item is the one failure a platform will
//!   certainly see. This is enforced inside the claim critical section, never
//!   by a caller-side `if`.
//!
//! # Search filters do not deduplicate
//!
//! Assigning each account a different sort order (`order=click` vs `pubdate` …)
//! reduces collisions; it does not prevent them, because popular content ranks
//! under several sorts at once. Filters are an optimisation. This ledger is the
//! guarantee.
//!
//! # `open_url` durability is per-platform, and it is not cosmetic
//!
//! Bilibili / Zhihu / Douyin URLs are permanent (`https://.../video/BV…`). A
//! Xiaohongshu note URL carries an `xsec_token` without which the note will not
//! open — measured: a wrong token yields `error_code=300031`. Whether a *valid*
//! token expires was never established, so this module treats such URLs as a
//! cache of unknown TTL: the id is stored forever (dedup keeps working), the URL
//! is marked [`Durability::Session`] and must be re-resolved before use once it
//! is older than the caller's threshold. See [`ProspectRecord::url_is_stale`].

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::NamedTempFile;
use thiserror::Error;
use utoipa::ToSchema;

/// Ledger file name inside [`crate::app_dirs::prospects_dir`].
const LEDGER_FILE: &str = "ledger.json";

/// A claim older than this with no terminal outcome is considered abandoned
/// (browser crashed, app killed mid-run) and may be re-claimed. Without this a
/// single crash would permanently strand a candidate.
const DEFAULT_CLAIM_TTL_SECS: u64 = 6 * 60 * 60;

fn now_secs() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

#[derive(Debug, Error)]
pub enum ProspectError {
  #[error("failed to read prospect ledger at {path}: {source}")]
  Read {
    path: PathBuf,
    source: std::io::Error,
  },
  #[error("failed to write prospect ledger at {path}: {source}")]
  Write {
    path: PathBuf,
    source: std::io::Error,
  },
  #[error("prospect ledger at {path} is not valid JSON: {source}")]
  InvalidJson {
    path: PathBuf,
    source: serde_json::Error,
  },
  #[error("unsupported platform: {0}")]
  UnsupportedPlatform(String),
  #[error("candidate is missing a stable item id")]
  MissingItemId,
}

/// Whether a candidate's `open_url` survives being stored and used later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Durability {
  /// URL is a plain permalink; safe to store and open at any point later.
  Permanent,
  /// URL embeds a per-session credential (Xiaohongshu `xsec_token`). The id
  /// stays valid for dedup, the URL must be re-resolved before use.
  Session,
}

/// Lifecycle of one candidate with respect to our accounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProspectState {
  /// Discovered by a search, not yet handed to any account.
  Seen,
  /// Handed to an account which is currently working on it.
  Claimed,
  /// An account posted under it.
  Posted,
  /// An account looked at it and deliberately passed.
  Skipped,
  /// Draft text was written into the comment box but NOT sent.
  ///
  /// This is the terminal state of the current debug phase: the pipeline runs
  /// all the way to "ready to click send" and stops. Kept distinct from
  /// `Posted` because the two are not interchangeable — a filled draft has no
  /// public footprint, so counting it as posted would corrupt both the
  /// per-item account cap and any reporting built on the ledger.
  Filled,
  /// The attempt failed (risk-control interstitial, editor not found, generate
  /// error…). Recorded rather than retried, per the operating decision that a
  /// failed attempt is data, not something to hammer at.
  Failed,
  /// Commenting is closed on this item, for everybody.
  ///
  /// Observed on Bilibili as "由于UP主隐私设置，你无法评论" where the composer
  /// should be; the uploader has switched comments off.
  ///
  /// This is the ONE state that legitimately withholds an item from every
  /// account, and it earns that by being a property of the *content* rather
  /// than of us. Every other terminal state answers "what did this account do
  /// here" and must not gate other accounts — see the match in
  /// [`ProspectLedger::claim_next`]. Recording it globally is the whole point:
  /// without it, all five accounts would each spend a full leg discovering the
  /// same closed video.
  ///
  /// Deliberately NOT counted by [`ProspectRecord::posted_account_count`]: no
  /// comment was made, so there is no public footprint to charge against the
  /// per-item cap.
  Blocked,
}

/// One account's interaction with one candidate. Append-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AccountTouch {
  pub profile_id: String,
  pub state: ProspectState,
  pub at: u64,
}

/// A discovered piece of content, plus every account that has touched it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ProspectRecord {
  /// `platform:item_id`. Platform prefix is mandatory, not tidiness: Zhihu and
  /// Douyin ids are both 19-digit decimals and share a namespace.
  pub key: String,
  pub platform: String,
  pub item_id: String,
  #[serde(default)]
  pub title: String,
  pub open_url: String,
  pub open_url_durability: Durability,
  /// When `open_url` was obtained. Only meaningful for [`Durability::Session`].
  pub resolved_at: u64,
  pub first_seen_at: u64,
  /// Keyword that surfaced this candidate; kept for reporting, never part of
  /// the dedup key (one item legitimately surfaces under several keywords).
  #[serde(default)]
  pub keywords: Vec<String>,
  pub state: ProspectState,
  #[serde(default)]
  pub claimed_by: Option<String>,
  #[serde(default)]
  pub claimed_at: Option<u64>,
  #[serde(default)]
  pub touches: Vec<AccountTouch>,
}

impl ProspectRecord {
  /// Accounts that are done with this item, whatever the outcome.
  ///
  /// `Filled` counts: in the debug phase a filled draft means this account has
  /// already spent this target, so handing it the same one again would produce
  /// a duplicate. `Failed` counts too — retrying is deliberately not done.
  pub fn settled_accounts(&self) -> impl Iterator<Item = &str> {
    self
      .touches
      .iter()
      .filter(|t| {
        matches!(
          t.state,
          ProspectState::Posted
            | ProspectState::Skipped
            | ProspectState::Filled
            | ProspectState::Failed
            | ProspectState::Blocked
        )
      })
      .map(|t| t.profile_id.as_str())
  }

  /// True when this profile already reached a terminal outcome here. The
  /// account-level hard gate.
  pub fn touched_by(&self, profile_id: &str) -> bool {
    self.settled_accounts().any(|p| p == profile_id)
  }

  /// Number of distinct accounts that have PUBLICLY posted under this item.
  ///
  /// Only `Posted` counts. A `Filled` draft was never sent, so it leaves no
  /// footprint for a platform to correlate — letting it consume the cap would
  /// starve the pool during the debug phase for no safety benefit.
  pub fn posted_account_count(&self) -> usize {
    let mut seen: Vec<&str> = self
      .touches
      .iter()
      .filter(|t| t.state == ProspectState::Posted)
      .map(|t| t.profile_id.as_str())
      .collect();
    seen.sort_unstable();
    seen.dedup();
    seen.len()
  }

  /// Whether a stored `open_url` is too old to trust. Permanent URLs never are.
  pub fn url_is_stale(&self, max_age_secs: u64, now: u64) -> bool {
    match self.open_url_durability {
      Durability::Permanent => false,
      // `>=` so a window of 0 means "never reuse a stored token", matching
      // `claim_is_stale`. Both knobs read the same way at their edges.
      Durability::Session => now.saturating_sub(self.resolved_at) >= max_age_secs,
    }
  }

  fn claim_is_stale(&self, ttl: u64, now: u64) -> bool {
    match (self.state, self.claimed_at) {
      // `>=`, not `>`: a TTL of 0 must mean "reclaimable immediately", which is
      // both the sane reading and what makes the behaviour testable without
      // sleeping through a wall-clock second.
      (ProspectState::Claimed, Some(at)) => now.saturating_sub(at) >= ttl,
      // Claimed with no timestamp is corrupt state; treat as abandoned rather
      // than stranding the item forever.
      (ProspectState::Claimed, None) => true,
      _ => false,
    }
  }
}

/// A freshly parsed search result, before it enters the ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Candidate {
  pub platform: String,
  pub item_id: String,
  #[serde(default)]
  pub title: String,
  pub open_url: String,
  #[serde(default)]
  pub keyword: Option<String>,
}

/// Platforms the ledger accepts. Rejecting unknown platforms here keeps a typo
/// from silently creating a parallel key namespace that dedups against nothing.
const SUPPORTED_PLATFORMS: [&str; 4] = ["bilibili", "zhihu", "douyin", "xiaohongshu"];

/// `open_url` durability is a property of the platform, not of the caller.
/// Deriving it here means a caller cannot accidentally mark a Xiaohongshu URL
/// permanent and poison the store with links that will not open.
pub fn durability_for(platform: &str) -> Durability {
  match platform {
    "xiaohongshu" => Durability::Session,
    _ => Durability::Permanent,
  }
}

pub fn make_key(platform: &str, item_id: &str) -> String {
  format!("{platform}:{item_id}")
}

/// Knobs for [`ProspectLedger::claim_next`].
#[derive(Debug, Clone)]
pub struct ClaimOptions {
  /// How many distinct accounts may post under one item. `1` means never two
  /// of our accounts under the same content.
  pub per_item_account_cap: usize,
  /// Abandoned-claim reclaim window.
  pub claim_ttl_secs: u64,
  /// A [`Durability::Session`] URL older than this is not handed out; the
  /// caller must re-resolve it first.
  pub session_url_max_age_secs: u64,
}

impl Default for ClaimOptions {
  fn default() -> Self {
    Self {
      per_item_account_cap: 1,
      claim_ttl_secs: DEFAULT_CLAIM_TTL_SECS,
      session_url_max_age_secs: 30 * 60,
    }
  }
}

/// Outcome of ingesting a batch of search results.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct IngestReport {
  pub inserted: usize,
  pub refreshed: usize,
  pub already_known: usize,
}

pub struct ProspectLedger {
  lock: Mutex<()>,
}

impl Default for ProspectLedger {
  fn default() -> Self {
    Self::new()
  }
}

impl ProspectLedger {
  pub fn new() -> Self {
    Self {
      lock: Mutex::new(()),
    }
  }

  fn path(&self) -> PathBuf {
    crate::app_dirs::prospects_dir().join(LEDGER_FILE)
  }

  fn load(&self) -> Result<Vec<ProspectRecord>, ProspectError> {
    let path = self.path();
    if !path.exists() {
      return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|source| ProspectError::Read {
      path: path.clone(),
      source,
    })?;
    if contents.trim().is_empty() {
      return Ok(Vec::new());
    }
    serde_json::from_str(&contents).map_err(|source| ProspectError::InvalidJson { path, source })
  }

  fn save(&self, records: &[ProspectRecord]) -> Result<(), ProspectError> {
    let dir = crate::app_dirs::prospects_dir();
    fs::create_dir_all(&dir).map_err(|source| ProspectError::Write {
      path: dir.clone(),
      source,
    })?;
    let path = self.path();
    let json =
      serde_json::to_string_pretty(records).map_err(|source| ProspectError::InvalidJson {
        path: path.clone(),
        source,
      })?;
    // Same atomic-replace discipline as history.rs: a torn ledger would be far
    // worse than a lost batch, because dedup would silently start passing.
    let mut tmp = NamedTempFile::new_in(&dir).map_err(|source| ProspectError::Write {
      path: dir.clone(),
      source,
    })?;
    tmp
      .write_all(json.as_bytes())
      .map_err(|source| ProspectError::Write {
        path: path.clone(),
        source,
      })?;
    tmp.flush().map_err(|source| ProspectError::Write {
      path: path.clone(),
      source,
    })?;
    tmp.persist(&path).map_err(|e| ProspectError::Write {
      path,
      source: e.error,
    })?;
    Ok(())
  }

  fn validate(candidate: &Candidate) -> Result<(), ProspectError> {
    if !SUPPORTED_PLATFORMS.contains(&candidate.platform.as_str()) {
      return Err(ProspectError::UnsupportedPlatform(
        candidate.platform.clone(),
      ));
    }
    if candidate.item_id.trim().is_empty() {
      return Err(ProspectError::MissingItemId);
    }
    Ok(())
  }

  /// Record a batch of freshly discovered candidates.
  ///
  /// Known items are NOT reset to `Seen` — that would undo dedup. Their
  /// `open_url` is refreshed though, which is what lets a Xiaohongshu note
  /// picked up in a later search become usable again with a fresh token.
  pub fn ingest(&self, candidates: &[Candidate]) -> Result<IngestReport, ProspectError> {
    for c in candidates {
      Self::validate(c)?;
    }
    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    let mut records = self.load()?;
    let mut index: HashMap<String, usize> = records
      .iter()
      .enumerate()
      .map(|(i, r)| (r.key.clone(), i))
      .collect();

    let now = now_secs();
    let mut report = IngestReport::default();

    for c in candidates {
      let key = make_key(&c.platform, &c.item_id);
      match index.get(&key) {
        Some(&i) => {
          let rec = &mut records[i];
          report.already_known += 1;
          if rec.open_url != c.open_url {
            rec.open_url = c.open_url.clone();
            rec.resolved_at = now;
            report.refreshed += 1;
          } else if rec.open_url_durability == Durability::Session {
            // Same URL seen again in a fresh session: the token is live now.
            rec.resolved_at = now;
            report.refreshed += 1;
          }
          if let Some(kw) = &c.keyword {
            if !rec.keywords.iter().any(|k| k == kw) {
              rec.keywords.push(kw.clone());
            }
          }
          if rec.title.is_empty() && !c.title.is_empty() {
            rec.title = c.title.clone();
          }
        }
        None => {
          records.push(ProspectRecord {
            key: key.clone(),
            platform: c.platform.clone(),
            item_id: c.item_id.clone(),
            title: c.title.clone(),
            open_url: c.open_url.clone(),
            open_url_durability: durability_for(&c.platform),
            resolved_at: now,
            first_seen_at: now,
            keywords: c.keyword.clone().into_iter().collect(),
            state: ProspectState::Seen,
            claimed_by: None,
            claimed_at: None,
            touches: Vec::new(),
          });
          index.insert(key, records.len() - 1);
          report.inserted += 1;
        }
      }
    }

    self.save(&records)?;
    Ok(report)
  }

  /// Atomically hand one candidate to `profile_id`, or `None` if nothing is
  /// eligible.
  ///
  /// Everything that makes a candidate ineligible is evaluated inside the same
  /// critical section as the write, so two profiles launching concurrently
  /// cannot receive the same item.
  pub fn claim_next(
    &self,
    profile_id: &str,
    platform: &str,
    opts: &ClaimOptions,
  ) -> Result<Option<ProspectRecord>, ProspectError> {
    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    let mut records = self.load()?;
    let now = now_secs();

    let pick = records.iter().position(|r| {
      if r.platform != platform {
        return false;
      }
      // Account-level hard gate.
      if r.touched_by(profile_id) {
        return false;
      }
      // Content-level cap.
      if r.posted_account_count() >= opts.per_item_account_cap {
        return false;
      }
      // A session URL we can no longer trust must be re-resolved by a fresh
      // search before it is handed out; serving it would just fail to open.
      if r.url_is_stale(opts.session_url_max_age_secs, now) {
        return false;
      }
      // `state` records the LAST outcome on this item, not "this item is
      // finished for everybody". Letting Posted/Skipped block other accounts
      // here would silently override `per_item_account_cap` — with a cap of 10,
      // the 2nd account could still never claim. Who may take it is decided by
      // the account-level gate and the cap above; the only thing `state` itself
      // withholds is an item someone is actively working on right now.
      match r.state {
        // 谁能拿由上面的账号级判断和 cap 决定，`state` 只拦「别人正在做」。
        ProspectState::Seen
        | ProspectState::Posted
        | ProspectState::Skipped
        | ProspectState::Filled
        | ProspectState::Failed => true,
        ProspectState::Claimed => r.claim_is_stale(opts.claim_ttl_secs, now),
        // The single exception to the rule above, and only because it is not a
        // statement about an account: nobody can comment where commenting is
        // off, so handing this out again would burn another account's leg to
        // rediscover the same fact.
        ProspectState::Blocked => false,
      }
    });

    let Some(i) = pick else { return Ok(None) };
    records[i].state = ProspectState::Claimed;
    records[i].claimed_by = Some(profile_id.to_string());
    records[i].claimed_at = Some(now);
    let claimed = records[i].clone();
    self.save(&records)?;
    Ok(Some(claimed))
  }

  /// Record a terminal outcome.
  ///
  /// Anything except `Seen`/`Claimed`: a caller must not be able to walk an item
  /// back to "not touched yet", because that erases the dedup evidence this
  /// ledger exists to hold.
  pub fn settle(
    &self,
    key: &str,
    profile_id: &str,
    state: ProspectState,
  ) -> Result<(), ProspectError> {
    debug_assert!(!matches!(
      state,
      ProspectState::Seen | ProspectState::Claimed
    ));
    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    let mut records = self.load()?;
    if let Some(rec) = records.iter_mut().find(|r| r.key == key) {
      rec.state = state;
      rec.claimed_by = None;
      rec.claimed_at = None;
      rec.touches.push(AccountTouch {
        profile_id: profile_id.to_string(),
        state,
        at: now_secs(),
      });
      self.save(&records)?;
    }
    Ok(())
  }

  pub fn list(&self) -> Result<Vec<ProspectRecord>, ProspectError> {
    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    self.load()
  }
}

lazy_static::lazy_static! {
  pub static ref PROSPECTS: ProspectLedger = ProspectLedger::new();
}

#[cfg(test)]
mod tests {
  use super::*;

  fn cand(platform: &str, id: &str, url: &str) -> Candidate {
    Candidate {
      platform: platform.to_string(),
      item_id: id.to_string(),
      title: format!("t-{id}"),
      open_url: url.to_string(),
      keyword: Some("科研工具".to_string()),
    }
  }

  fn ledger() -> (ProspectLedger, crate::app_dirs::TestDirGuard) {
    let dir = tempfile::tempdir().expect("tempdir");
    let guard = crate::app_dirs::set_test_data_dir(dir.keep());
    (ProspectLedger::new(), guard)
  }

  #[test]
  fn zhihu_and_douyin_ids_share_a_namespace_so_keys_must_be_prefixed() {
    // Both platforms hand out 19-digit decimal ids. A bare id as the key would
    // silently collide across platforms.
    let same_digits = "7550160854285684020";
    assert_ne!(
      make_key("zhihu", same_digits),
      make_key("douyin", same_digits)
    );
  }

  #[test]
  fn ingest_is_idempotent_and_never_resets_progress() {
    let (l, _g) = ledger();
    let c = vec![cand("bilibili", "BV1", "https://b/1")];
    assert_eq!(l.ingest(&c).unwrap().inserted, 1);

    l.settle("bilibili:BV1", "p1", ProspectState::Posted)
      .unwrap();

    // Re-discovering an item must not walk it back to Seen.
    let r = l.ingest(&c).unwrap();
    assert_eq!(r.inserted, 0);
    assert_eq!(r.already_known, 1);
    assert_eq!(l.list().unwrap()[0].state, ProspectState::Posted);
  }

  #[test]
  fn one_item_is_never_handed_to_two_profiles_at_once() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let o = ClaimOptions::default();

    let a = l.claim_next("p1", "bilibili", &o).unwrap();
    let b = l.claim_next("p2", "bilibili", &o).unwrap();
    assert!(a.is_some(), "first profile should get it");
    assert!(b.is_none(), "second profile must not get the same item");
  }

  #[test]
  fn same_account_never_gets_the_same_item_twice() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    // cap high enough that the content-level rule is not what blocks it
    let o = ClaimOptions {
      per_item_account_cap: 10,
      ..Default::default()
    };

    let first = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&first.key, "p1", ProspectState::Posted).unwrap();

    assert!(
      l.claim_next("p1", "bilibili", &o).unwrap().is_none(),
      "account-level gate must hold even when the content-level cap allows more"
    );
    assert!(
      l.claim_next("p2", "bilibili", &o).unwrap().is_some(),
      "a different account is still allowed under a cap of 10"
    );
  }

  #[test]
  fn per_item_account_cap_stops_accounts_piling_on() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let o = ClaimOptions::default(); // cap = 1

    let c = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Posted).unwrap();

    for p in ["p2", "p3", "p4"] {
      assert!(
        l.claim_next(p, "bilibili", &o).unwrap().is_none(),
        "{p} must not be able to pile onto an item already posted under"
      );
    }
  }

  #[test]
  fn skipped_frees_the_item_for_other_accounts_but_not_the_skipper() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let o = ClaimOptions::default();

    let c = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Skipped).unwrap();

    assert!(l.claim_next("p1", "bilibili", &o).unwrap().is_none());
    assert!(
      l.claim_next("p2", "bilibili", &o).unwrap().is_some(),
      "skipping is not posting, so the cap is untouched"
    );
  }

  #[test]
  fn abandoned_claims_are_reclaimable_so_a_crash_does_not_strand_content() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();

    let never_expire = ClaimOptions::default();
    l.claim_next("p1", "bilibili", &never_expire)
      .unwrap()
      .unwrap();
    assert!(l
      .claim_next("p2", "bilibili", &never_expire)
      .unwrap()
      .is_none());

    let expire_now = ClaimOptions {
      claim_ttl_secs: 0,
      ..Default::default()
    };
    assert!(
      l.claim_next("p2", "bilibili", &expire_now)
        .unwrap()
        .is_some(),
      "a claim past its TTL must be reclaimable"
    );
  }

  #[test]
  fn xiaohongshu_urls_are_session_scoped_and_go_stale() {
    let (l, _g) = ledger();
    l.ingest(&[cand(
      "xiaohongshu",
      "68b6891b000000001c0306b8",
      "https://www.xiaohongshu.com/explore/68b6891b000000001c0306b8?xsec_token=AB",
    )])
    .unwrap();

    let rec = &l.list().unwrap()[0];
    assert_eq!(rec.open_url_durability, Durability::Session);

    let fresh = ClaimOptions::default();
    assert!(l.claim_next("p1", "xiaohongshu", &fresh).unwrap().is_some());

    // With a zero freshness window the token is assumed unusable and the
    // candidate must be withheld rather than handed out to fail on open.
    let stale = ClaimOptions {
      session_url_max_age_secs: 0,
      ..Default::default()
    };
    l.settle(
      "xiaohongshu:68b6891b000000001c0306b8",
      "p1",
      ProspectState::Skipped,
    )
    .unwrap();
    assert!(l.claim_next("p2", "xiaohongshu", &stale).unwrap().is_none());
  }

  #[test]
  fn permanent_urls_never_go_stale() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let stale = ClaimOptions {
      session_url_max_age_secs: 0,
      ..Default::default()
    };
    assert!(
      l.claim_next("p1", "bilibili", &stale).unwrap().is_some(),
      "a permalink has no freshness window"
    );
  }

  #[test]
  fn re_ingesting_a_session_url_refreshes_its_resolved_at() {
    let (l, _g) = ledger();
    let c = vec![cand(
      "xiaohongshu",
      "68b6891b000000001c0306b8",
      "https://x/1?xsec_token=OLD",
    )];
    l.ingest(&c).unwrap();

    let updated = vec![cand(
      "xiaohongshu",
      "68b6891b000000001c0306b8",
      "https://x/1?xsec_token=NEW",
    )];
    let r = l.ingest(&updated).unwrap();
    assert_eq!(r.refreshed, 1);
    assert!(l.list().unwrap()[0].open_url.ends_with("NEW"));
  }

  #[test]
  fn one_item_under_several_keywords_stays_one_record() {
    let (l, _g) = ledger();
    let mut a = cand("bilibili", "BV1", "https://b/1");
    a.keyword = Some("科研工具".into());
    let mut b = cand("bilibili", "BV1", "https://b/1");
    b.keyword = Some("文献管理".into());
    l.ingest(&[a]).unwrap();
    l.ingest(&[b]).unwrap();

    let all = l.list().unwrap();
    assert_eq!(
      all.len(),
      1,
      "keyword is reporting metadata, not part of the key"
    );
    assert_eq!(all[0].keywords.len(), 2);
  }

  #[test]
  fn unknown_platform_is_rejected_rather_than_creating_a_dead_namespace() {
    let (l, _g) = ledger();
    let err = l
      .ingest(&[cand("weibo", "1", "https://w/1")])
      .expect_err("unsupported platform must not be silently accepted");
    assert!(matches!(err, ProspectError::UnsupportedPlatform(_)));
  }

  #[test]
  fn claims_are_scoped_per_platform() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV1", "https://b/1"),
      cand("zhihu", "answer:1", "https://z/1"),
    ])
    .unwrap();
    let o = ClaimOptions::default();
    let got = l.claim_next("p1", "zhihu", &o).unwrap().unwrap();
    assert_eq!(got.platform, "zhihu");
  }

  #[test]
  fn a_filled_draft_blocks_the_same_account_but_not_the_cap() {
    // 调试期的终局：草稿已填入但没发出去。
    //   · 对本账号：等于这条已经用掉了，不能再领（否则会重复填）
    //   · 对 per-item cap：不占额度 —— 没发出去就没有公开足迹，让它占额度
    //     只会在调试期白白饿死候选池
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let o = ClaimOptions::default(); // cap = 1

    let c = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Filled).unwrap();

    assert!(
      l.claim_next("p1", "bilibili", &o).unwrap().is_none(),
      "同一账号不该再领到自己已经填过的那条"
    );
    assert!(
      l.claim_next("p2", "bilibili", &o).unwrap().is_some(),
      "填入不等于发布，不该占用 per-item cap"
    );
    assert_eq!(
      l.list().unwrap()[0].posted_account_count(),
      0,
      "Filled 绝不能被算成 Posted"
    );
  }

  #[test]
  fn a_failed_attempt_is_recorded_and_not_retried() {
    // 决策：发送失败只记录、不重试。所以 Failed 必须挡住同一账号再领。
    let (l, _g) = ledger();
    l.ingest(&[cand("zhihu", "answer:1", "https://z/1")])
      .unwrap();
    let o = ClaimOptions::default();

    let c = l.claim_next("p1", "zhihu", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Failed).unwrap();

    assert!(
      l.claim_next("p1", "zhihu", &o).unwrap().is_none(),
      "失败不重试 —— 同一账号不该再拿到它"
    );
    let rec = &l.list().unwrap()[0];
    assert_eq!(rec.state, ProspectState::Failed);
    assert_eq!(rec.touches.len(), 1, "失败要留下可追溯的记录");
    assert_eq!(rec.touches[0].profile_id, "p1");
  }

  #[test]
  fn a_blocked_item_is_withheld_from_every_account_not_just_the_one_that_found_it() {
    // 「UP主关了评论区」是内容的属性，不是某个账号的遭遇。不全局挡住的话，
    // 5 个号会各花一条腿去重新发现同一个事实。
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV_closed", "https://b/closed")])
      .unwrap();
    let o = ClaimOptions::default();

    let c = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Blocked).unwrap();

    for who in ["p1", "p2", "p3"] {
      assert!(
        l.claim_next(who, "bilibili", &o).unwrap().is_none(),
        "评论区关闭后 {who} 也不该再拿到它"
      );
    }
    let rec = &l.list().unwrap()[0];
    assert_eq!(rec.state, ProspectState::Blocked);
    assert_eq!(rec.touches.len(), 1, "谁发现的要留痕");
  }

  #[test]
  fn blocked_does_not_consume_the_public_footprint_cap() {
    // Blocked 没有公开足迹 —— 不能像 Posted 那样占额度，否则调高 cap 也没用。
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV_b", "https://b/b")])
      .unwrap();
    let o = ClaimOptions::default();
    let c = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Blocked).unwrap();
    assert_eq!(l.list().unwrap()[0].posted_account_count(), 0);
  }

  #[test]
  fn blocked_never_starves_a_different_item() {
    // 全局挡住的只能是那一条，不能顺手把同平台其他候选也挡了。
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV_closed", "https://b/closed"),
      cand("bilibili", "BV_open", "https://b/open"),
    ])
    .unwrap();
    let o = ClaimOptions::default();

    let first = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&first.key, "p1", ProspectState::Blocked).unwrap();

    let next = l.claim_next("p2", "bilibili", &o).unwrap();
    assert!(next.is_some(), "另一条候选必须照常发得出去");
    assert_ne!(next.unwrap().key, first.key);
  }

  #[test]
  fn only_posted_consumes_the_public_footprint_cap() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV9", "https://b/9")]).unwrap();
    let o = ClaimOptions {
      per_item_account_cap: 2,
      ..Default::default()
    };

    for (p, st) in [("p1", ProspectState::Filled), ("p2", ProspectState::Failed)] {
      let c = l.claim_next(p, "bilibili", &o).unwrap().unwrap();
      l.settle(&c.key, p, st).unwrap();
    }
    assert_eq!(l.list().unwrap()[0].posted_account_count(), 0);
    assert!(
      l.claim_next("p3", "bilibili", &o).unwrap().is_some(),
      "两次非发布的接触不该吃掉 cap=2 的额度"
    );
  }
}
