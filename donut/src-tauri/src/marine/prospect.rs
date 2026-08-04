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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
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
  #[error("prospect ledger at {path} exists but is empty; refusing to treat it as no records")]
  EmptyLedger { path: PathBuf },
  #[error("unsupported platform: {0}")]
  UnsupportedPlatform(String),
  #[error("candidate is missing a stable item id")]
  MissingItemId,
  #[error("prospect not found: {0}")]
  NotFound(String),
  #[error("prospect {key} is not currently claimed by profile {profile_id}")]
  ClaimOwnerMismatch { key: String, profile_id: String },
}

/// The question id out of a Zhihu answer URL, if it carries one.
///
/// `https://www.zhihu.com/question/606932275/answer/2053034914010895538`
/// → `606932275`. Article URLs (`zhuanlan.zhihu.com/p/…`) have none.
fn zhihu_question_id(open_url: &str) -> Option<&str> {
  let rest = open_url.split("/question/").nth(1)?;
  let id = rest.split(['/', '?', '#']).next()?;
  (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

/// Whether a failed atomic replace is worth retrying.
///
/// `PermissionDenied` is what Windows maps `ERROR_SHARING_VIOLATION` /
/// `ERROR_ACCESS_DENIED` to when a scanner has the file open; both clear on
/// their own within milliseconds. Anything else (a full disk, a bad path) will
/// not fix itself and must surface immediately.
fn is_transient_replace_error(error: &std::io::Error) -> bool {
  matches!(
    error.kind(),
    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Interrupted
  )
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
  /// The publish control was clicked, but no authoritative success/failure
  /// receipt arrived before the observation deadline.
  ///
  /// This is conservatively charged as one public footprint.  Treating it as a
  /// normal failure would let another account publish the same comment target
  /// even though the first click may already have succeeded.
  Unconfirmed,
  /// An account looked at it and deliberately passed.
  Skipped,
  /// Draft text was written into the comment box but NOT sent.
  ///
  /// Terminal state for a fill-only workflow or a platform without a verified
  /// receipt-backed submit path. Kept distinct from `Posted` because the two
  /// are not interchangeable — a filled draft has no public footprint, so
  /// counting it as posted would corrupt both the per-item account cap and any
  /// reporting built on the ledger.
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
  /// Deliberately NOT counted by [`ProspectRecord::public_footprint_count`]: no
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
  /// The current owner crossed the irreversible-send guard.
  ///
  /// Once set, this claim is not reclaimed by TTL: the browser may already
  /// have published while its settlement response was lost.  The extension
  /// sets it through the owner-checked `prepare_send` transition immediately
  /// before clicking.
  #[serde(default)]
  pub send_started_at: Option<u64>,
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
            | ProspectState::Unconfirmed
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

  /// The "one place" an operator — and a platform's risk control — perceives.
  ///
  /// For every platform but Zhihu that is the item itself: a Bilibili video, a
  /// Douyin note and a Xiaohongshu note each have exactly one comment section.
  /// Zhihu nests answers under a question, so two answers to one question are
  /// two records but **one thread**, and an account that comments under both
  /// shows up twice in the same place — precisely the pattern this ledger
  /// exists to prevent. Observed: `question/2050569952449634692` was handed out
  /// twice, under `answer/2053182600689333370` and `answer/2057478634580063639`.
  ///
  /// The answer id has to stay the record key regardless: `open_url` needs it to
  /// reach the right editor. So the thread is derived, never stored, which also
  /// means every ledger already on disk gets the new grouping with no migration.
  pub fn thread_key(&self) -> String {
    if self.platform != "zhihu" {
      return self.key.clone();
    }
    match zhihu_question_id(&self.open_url) {
      Some(question) => format!("zhihu:question:{question}"),
      // Zhuanlan articles have no question above them, and an answer URL that
      // lost its question id is only ever itself.
      None => self.key.clone(),
    }
  }

  /// Number of distinct accounts that may have left a PUBLIC footprint.
  ///
  /// `Posted` and a click with an `Unconfirmed` receipt both count. A `Filled`
  /// draft or pre-click `Failed` attempt was never sent, so it leaves no
  /// footprint for a platform to correlate; charging those would starve the
  /// pool for no safety benefit.
  pub fn public_footprint_count(&self) -> usize {
    let mut seen: Vec<&str> = self
      .touches
      .iter()
      .filter(|t| matches!(t.state, ProspectState::Posted | ProspectState::Unconfirmed))
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
    if self.send_started_at.is_some() {
      return false;
    }
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
      // An existing-but-empty ledger is damage, not a fresh start. Treating it
      // as "no records" silently switches dedup off: every target already
      // commented on looks new again, and the accounts go post a second time on
      // content they have already touched. A hard error keeps the evidence.
      return Err(ProspectError::EmptyLedger { path });
    }
    serde_json::from_str(&contents).map_err(|source| ProspectError::InvalidJson { path, source })
  }

  /// Replace `path` with `tmp`, retrying while the OS says the file is busy.
  ///
  /// Unix replaces an open file happily. Windows does not: `MoveFileExW` needs
  /// DELETE access on both ends, and Defender's real-time scan, the Search
  /// indexer, or any backup client holding the ledger open for a few
  /// milliseconds makes the replace fail with `ERROR_SHARING_VIOLATION` (32).
  ///
  /// The ledger is rewritten in full on every ingest / claim / prepare_send /
  /// settle, so the odds of landing in one of those windows grow with how long
  /// the run has been going. A failed `settle` throws the in-memory change away
  /// and leaves the record on disk as `Claimed` with `send_started_at` already
  /// set — no other account can take it and the stale-claim TTL never releases
  /// it, because from disk it looks like a send in progress.
  fn persist_with_retry(mut tmp: NamedTempFile, path: &Path) -> Result<(), ProspectError> {
    const ATTEMPTS: u32 = 5;
    let mut backoff = Duration::from_millis(20);
    for attempt in 1..=ATTEMPTS {
      match tmp.persist(path) {
        Ok(_) => return Ok(()),
        Err(e) if attempt < ATTEMPTS && is_transient_replace_error(&e.error) => {
          log::warn!(
            "Prospect ledger replace blocked ({}), attempt {attempt}/{ATTEMPTS}; retrying in {}ms",
            e.error,
            backoff.as_millis()
          );
          // `persist` gives the temp file back on failure, so the written bytes
          // survive the retry and we never rebuild the JSON.
          tmp = e.file;
          std::thread::sleep(backoff);
          backoff *= 2;
        }
        Err(e) => {
          return Err(ProspectError::Write {
            path: path.to_path_buf(),
            source: e.error,
          })
        }
      }
    }
    unreachable!("the loop either returns or exhausts ATTEMPTS with an error")
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
    // `flush` on a `File` is a no-op — the bytes are still only in the page
    // cache. Without `sync_all` a kernel-level crash (power loss, panic) leaves
    // a file of the right length full of zeros, which `load` then rejects as
    // invalid JSON and the whole automation stops until someone deletes it by
    // hand. `history.rs::write_atomic` already does this; the ledger is the one
    // file where losing dedup evidence is worse.
    tmp
      .flush()
      .and_then(|_| tmp.as_file().sync_all())
      .map_err(|source| ProspectError::Write {
        path: path.clone(),
        source,
      })?;
    Self::persist_with_retry(tmp, &path)
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
            send_started_at: None,
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

    // Every thread this account has already been seen in on this platform.
    //
    // The gate has to be thread-wide, not per-record: on Zhihu the same
    // question owns several answers, and checking only the record in hand let
    // one account comment under two answers of one question — from the page,
    // and from risk control's side, that is the same account posting twice in
    // the same place.
    let touched_threads: std::collections::HashSet<String> = records
      .iter()
      .filter(|r| r.platform == platform && r.touched_by(profile_id))
      .map(|r| r.thread_key())
      .collect();

    let pick = records.iter().position(|r| {
      if r.platform != platform {
        return false;
      }
      // Account-level hard gate, applied to the whole thread.
      if touched_threads.contains(&r.thread_key()) {
        return false;
      }
      // Content-level cap.
      if r.public_footprint_count() >= opts.per_item_account_cap {
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
        | ProspectState::Unconfirmed
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
    records[i].send_started_at = None;
    let claimed = records[i].clone();
    self.save(&records)?;
    Ok(Some(claimed))
  }

  /// Persist the pre-click, irreversible-send boundary for the current owner.
  ///
  /// The extension must receive this acknowledgement before it may click the
  /// platform publish button.  From that point until terminal settlement, TTL
  /// reclamation is disabled because the public side effect may already have
  /// happened even when the local API response is lost.
  pub fn prepare_send(&self, key: &str, profile_id: &str) -> Result<(), ProspectError> {
    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    let mut records = self.load()?;
    let Some(rec) = records.iter_mut().find(|r| r.key == key) else {
      return Err(ProspectError::NotFound(key.to_string()));
    };
    if rec.state != ProspectState::Claimed || rec.claimed_by.as_deref() != Some(profile_id) {
      return Err(ProspectError::ClaimOwnerMismatch {
        key: key.to_string(),
        profile_id: profile_id.to_string(),
      });
    }
    if rec.send_started_at.is_none() {
      rec.send_started_at = Some(now_secs());
      self.save(&records)?;
    }
    Ok(())
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
    let Some(rec) = records.iter_mut().find(|r| r.key == key) else {
      return Err(ProspectError::NotFound(key.to_string()));
    };
    // The API response can be lost after the atomic save has committed.  A
    // later account may already own the item by the time the original browser
    // retries (for non-public outcomes), so idempotence is proven by the
    // append-only account touch rather than mutable owner fields.  Since the
    // account claim gate forbids a second attempt, a matching touch can only be
    // this exact committed retry.  A different state still fails ownership.
    let exact_retry = rec
      .touches
      .iter()
      .any(|touch| touch.profile_id == profile_id && touch.state == state);
    if exact_retry {
      return Ok(());
    }
    if rec.state != ProspectState::Claimed || rec.claimed_by.as_deref() != Some(profile_id) {
      return Err(ProspectError::ClaimOwnerMismatch {
        key: key.to_string(),
        profile_id: profile_id.to_string(),
      });
    }
    rec.state = state;
    rec.claimed_by = None;
    rec.claimed_at = None;
    rec.send_started_at = None;
    rec.touches.push(AccountTouch {
      profile_id: profile_id.to_string(),
      state,
      at: now_secs(),
    });
    self.save(&records)?;
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

    l.claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .unwrap();
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
  fn only_the_current_claim_owner_can_settle() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let claim = l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .unwrap();

    assert!(matches!(
      l.settle(&claim.key, "p2", ProspectState::Posted),
      Err(ProspectError::ClaimOwnerMismatch { .. })
    ));
    let still_claimed = &l.list().unwrap()[0];
    assert_eq!(still_claimed.state, ProspectState::Claimed);
    assert_eq!(still_claimed.claimed_by.as_deref(), Some("p1"));

    l.settle(&claim.key, "p1", ProspectState::Posted).unwrap();
    l.settle(&claim.key, "p1", ProspectState::Posted)
      .expect("an exact retry after a lost response must be idempotent");
    assert_eq!(l.list().unwrap()[0].touches.len(), 1);
    assert!(matches!(
      l.settle(&claim.key, "p1", ProspectState::Failed),
      Err(ProspectError::ClaimOwnerMismatch { .. })
    ));
  }

  #[test]
  fn settling_an_unknown_key_is_not_silently_accepted() {
    let (l, _g) = ledger();
    assert!(matches!(
      l.settle("bilibili:missing", "p1", ProspectState::Failed),
      Err(ProspectError::NotFound(_))
    ));
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
  fn prepared_send_claim_is_never_reclaimed_by_ttl() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let claim = l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .unwrap();

    assert!(matches!(
      l.prepare_send(&claim.key, "p2"),
      Err(ProspectError::ClaimOwnerMismatch { .. })
    ));
    l.prepare_send(&claim.key, "p1").unwrap();
    l.prepare_send(&claim.key, "p1")
      .expect("prepare-send must be idempotent for the active owner");

    let expire_now = ClaimOptions {
      claim_ttl_secs: 0,
      ..Default::default()
    };
    assert!(
      l.claim_next("p2", "bilibili", &expire_now)
        .unwrap()
        .is_none(),
      "an irreversible send lease must not be handed to another profile"
    );
    let guarded = &l.list().unwrap()[0];
    assert_eq!(guarded.claimed_by.as_deref(), Some("p1"));
    assert!(guarded.send_started_at.is_some());

    l.settle(&claim.key, "p1", ProspectState::Posted).unwrap();
    let settled = &l.list().unwrap()[0];
    assert!(settled.send_started_at.is_none());
    assert_eq!(settled.state, ProspectState::Posted);
  }

  #[test]
  fn committed_settle_retry_does_not_disturb_a_new_owner() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let opts = ClaimOptions {
      per_item_account_cap: 10,
      ..Default::default()
    };
    let first = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    l.settle(&first.key, "p1", ProspectState::Skipped).unwrap();
    l.claim_next("p2", "bilibili", &opts)
      .unwrap()
      .expect("a skip should leave the item available to another account");

    l.settle(&first.key, "p1", ProspectState::Skipped)
      .expect("a lost-response retry must remain idempotent after reassignment");
    let rec = &l.list().unwrap()[0];
    assert_eq!(rec.state, ProspectState::Claimed);
    assert_eq!(rec.claimed_by.as_deref(), Some("p2"));
    assert_eq!(rec.touches.len(), 1);
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
      l.list().unwrap()[0].public_footprint_count(),
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
    assert_eq!(l.list().unwrap()[0].public_footprint_count(), 0);
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
  fn drafts_and_pre_click_failures_do_not_consume_the_public_footprint_cap() {
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
    assert_eq!(l.list().unwrap()[0].public_footprint_count(), 0);
    assert!(
      l.claim_next("p3", "bilibili", &o).unwrap().is_some(),
      "两次非发布的接触不该吃掉 cap=2 的额度"
    );
  }

  #[test]
  fn an_unconfirmed_click_consumes_the_public_footprint_cap() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV_uncertain", "https://b/uncertain")])
      .unwrap();
    let opts = ClaimOptions::default(); // cap = 1
    let first = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    l.prepare_send(&first.key, "p1").unwrap();
    l.settle(&first.key, "p1", ProspectState::Unconfirmed)
      .unwrap();

    let record = &l.list().unwrap()[0];
    assert_eq!(record.public_footprint_count(), 1);
    assert!(record.touched_by("p1"));
    assert!(
      l.claim_next("p2", "bilibili", &opts).unwrap().is_none(),
      "a click without a receipt may already be public and must consume cap=1"
    );
  }

  /// 台账文件存在但为空 = 写坏了，不是「还没有记录」。
  ///
  /// 当成空台账的后果是**去重静默失效**：所有已经评论过的目标全部重新变成
  /// 新目标，账号会在同一条内容下二次发言 —— 那正是平台第一眼就会注意到的模式。
  #[test]
  fn an_empty_ledger_file_is_damage_not_a_fresh_start() {
    let (l, _g) = ledger();

    // 先正常写入一条，确认能读回来。
    l.ingest(&[cand("bilibili", "BV1", "https://b.test/1")])
      .expect("ingest");
    assert_eq!(l.list().expect("list").len(), 1);

    // 模拟掉电后留下的零长度文件。
    std::fs::write(l.path(), b"").expect("truncate");

    let err = l.list().expect_err("空文件必须报错，不能当成空台账");
    assert!(
      matches!(err, ProspectError::EmptyLedger { .. }),
      "应当是 EmptyLedger，实际是 {err:?}"
    );
  }

  /// 全空白（不只是零长度）同样算写坏。
  #[test]
  fn a_whitespace_only_ledger_is_also_rejected() {
    let (l, _g) = ledger();
    l.ingest(&[cand("zhihu", "Z1", "https://z.test/1")])
      .expect("ingest");
    std::fs::write(l.path(), b"   \n\t\n").expect("blank");
    assert!(matches!(
      l.list().expect_err("空白文件要报错"),
      ProspectError::EmptyLedger { .. }
    ));
  }

  /// 台账**不存在**仍然是合法的空台账 —— 别把首次运行也拒了。
  #[test]
  fn a_missing_ledger_is_still_an_empty_one() {
    let (l, _g) = ledger();
    assert!(l.list().expect("首次运行不该报错").is_empty());
  }

  /// 每次写都要落到磁盘，且写完能原样读回。
  #[test]
  fn a_saved_ledger_round_trips_through_the_atomic_replace() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV1", "https://b.test/1"),
      cand("douyin", "D1", "https://d.test/1"),
    ])
    .expect("ingest");

    // 反复重写 —— persist_with_retry 的正常路径必须一次成功，不能引入退避延迟。
    for i in 0..5 {
      l.ingest(&[cand("zhihu", &format!("Z{i}"), "https://z.test/x")])
        .expect("ingest again");
    }

    let on_disk = std::fs::read_to_string(l.path()).expect("read");
    assert!(!on_disk.trim().is_empty(), "落盘内容不该为空");
    assert_eq!(l.list().expect("list").len(), 7);
  }

  /// 只有「文件正被别人占着」这类会自己消失的错误才值得重试。
  /// 磁盘满、路径不对这些重试多少次都一样，必须立刻报出来。
  #[test]
  fn only_self_clearing_replace_failures_are_retried() {
    use std::io::{Error, ErrorKind};
    // Windows 把 ERROR_SHARING_VIOLATION / ERROR_ACCESS_DENIED 映射到这里。
    assert!(is_transient_replace_error(&Error::from(
      ErrorKind::PermissionDenied
    )));
    assert!(is_transient_replace_error(&Error::from(
      ErrorKind::Interrupted
    )));
    for kind in [
      ErrorKind::NotFound,
      ErrorKind::AlreadyExists,
      ErrorKind::InvalidInput,
      ErrorKind::OutOfMemory,
    ] {
      assert!(
        !is_transient_replace_error(&Error::from(kind)),
        "{kind:?} 不会自己好，重试只是拖延报错"
      );
    }
  }

  // ---------------------------------------------------------------- 知乎话题级去重
  //
  // 实测到的重复：question/2050569952449634692 下面挂着两个回答，
  // 系统把它们当成两条无关目标，同一个账号在同一个问题里评了两次。

  const Q: &str = "2050569952449634692";
  fn zhihu_answer(aid: &str) -> Candidate {
    Candidate {
      platform: "zhihu".to_string(),
      item_id: format!("zhihu:answer:{aid}"),
      title: "到目前为止，你觉得最好用的科研工具是什么？".to_string(),
      open_url: format!("https://www.zhihu.com/question/{Q}/answer/{aid}"),
      keyword: Some("科研工具".to_string()),
    }
  }

  #[test]
  fn a_question_id_is_read_out_of_a_zhihu_answer_url() {
    assert_eq!(
      zhihu_question_id("https://www.zhihu.com/question/606932275/answer/2053034914010895538"),
      Some("606932275")
    );
    assert_eq!(
      zhihu_question_id("https://www.zhihu.com/question/606932275/answer/1?utm_id=0"),
      Some("606932275")
    );
    // 专栏文章头上没有问题。
    assert_eq!(
      zhihu_question_id("https://zhuanlan.zhihu.com/p/2027315517946442938"),
      None
    );
    // 形态不对时宁可退回按单条去重，也不要凑出一个错的分组把别的内容一起挡掉。
    assert_eq!(
      zhihu_question_id("https://www.zhihu.com/question//answer/1"),
      None
    );
    assert_eq!(
      zhihu_question_id("https://www.zhihu.com/question/abc/answer/1"),
      None
    );
    assert_eq!(
      zhihu_question_id("https://www.bilibili.com/video/BV1"),
      None
    );
  }

  /// 同一个问题下的第二个回答，同一个账号不能再拿。
  #[test]
  fn one_account_cannot_comment_under_two_answers_of_the_same_question() {
    let (l, _g) = ledger();
    l.ingest(&[
      zhihu_answer("2053182600689333370"),
      zhihu_answer("2057478634580063639"),
    ])
    .unwrap();
    let opts = ClaimOptions::default();

    let first = l.claim_next("p1", "zhihu", &opts).unwrap().unwrap();
    l.prepare_send(&first.key, "p1").unwrap();
    l.settle(&first.key, "p1", ProspectState::Posted).unwrap();

    assert!(
      l.claim_next("p1", "zhihu", &opts).unwrap().is_none(),
      "同一个问题下的另一个回答不能再发给同一个账号 —— 页面上看就是同一个人在同一个问题里评了两次"
    );
  }

  /// 但这是**账号级**闸门：换个账号仍然可以进这个问题（受 cap 约束）。
  #[test]
  fn another_account_may_still_take_a_different_answer_in_that_question() {
    let (l, _g) = ledger();
    l.ingest(&[
      zhihu_answer("2053182600689333370"),
      zhihu_answer("2057478634580063639"),
    ])
    .unwrap();
    let opts = ClaimOptions {
      per_item_account_cap: 2,
      ..ClaimOptions::default()
    };

    let first = l.claim_next("p1", "zhihu", &opts).unwrap().unwrap();
    l.prepare_send(&first.key, "p1").unwrap();
    l.settle(&first.key, "p1", ProspectState::Posted).unwrap();

    let second = l
      .claim_next("p2", "zhihu", &opts)
      .unwrap()
      .expect("换账号不该被话题级闸门挡住 —— 那是账号级判据，不是内容级");
    // 拿到哪一条不重要（按位置取，多半还是第一条）；重要的是它**在这个问题里**：
    // 话题级闸门只拦同一个账号，跨账号仍由 per_item_account_cap 说了算。
    assert_eq!(second.thread_key(), format!("zhihu:question:{Q}"));
  }

  /// 分组只对知乎生效。别的平台一条内容就是一个评论区，
  /// 误分组会把整批候选一起挡掉。
  #[test]
  fn other_platforms_are_grouped_one_record_at_a_time() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV1", "https://www.bilibili.com/video/BV1"),
      cand("bilibili", "BV2", "https://www.bilibili.com/video/BV2"),
    ])
    .unwrap();
    let opts = ClaimOptions::default();

    let first = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    l.prepare_send(&first.key, "p1").unwrap();
    l.settle(&first.key, "p1", ProspectState::Posted).unwrap();

    assert!(
      l.claim_next("p1", "bilibili", &opts).unwrap().is_some(),
      "两个不同的视频是两个评论区，同一个账号都能投"
    );
  }

  /// 专栏文章没有上级问题，各自独立。
  #[test]
  fn zhihu_articles_are_not_grouped_together() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("zhihu", "zhihu:article:1", "https://zhuanlan.zhihu.com/p/1"),
      cand("zhihu", "zhihu:article:2", "https://zhuanlan.zhihu.com/p/2"),
    ])
    .unwrap();
    let opts = ClaimOptions::default();

    let first = l.claim_next("p1", "zhihu", &opts).unwrap().unwrap();
    l.prepare_send(&first.key, "p1").unwrap();
    l.settle(&first.key, "p1", ProspectState::Posted).unwrap();

    assert!(
      l.claim_next("p1", "zhihu", &opts).unwrap().is_some(),
      "两篇专栏文章是两个评论区，不该被归成一组"
    );
  }
}
