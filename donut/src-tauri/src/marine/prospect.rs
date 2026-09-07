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
//! * **Exact item (global)** — `key = platform:item_id`. The first terminal
//!   touch closes that item to every profile, even when the outcome was
//!   `Failed`, `Filled`, or `Skipped`. Repeating a broken target across the
//!   account fleet is still repeated automation and was observed in practice.
//! * **Account thread (hard gate)** — on Zhihu, one profile that touched any
//!   answer under a question cannot take another answer in the same question.
//!   Different answers remain distinct global items, so another profile may
//!   take an untouched answer. Both gates are enforced inside the claim
//!   critical section, never by a caller-side `if`.
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
  #[error("prospect {key} already has terminal evidence and cannot be sent again")]
  AlreadySpent { key: String },
  #[error("prospect settlement requires a terminal state, got {state:?}")]
  InvalidSettlementState { state: ProspectState },
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
  /// This is conservatively charged as one public footprint. Like every other
  /// terminal touch it also closes the exact item globally.
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
  /// This explicitly records that the content itself cannot be used. Every
  /// terminal touch now withholds the exact item globally; `Blocked` remains
  /// distinct because it explains why no profile can use it and may exist in a
  /// foreign shard even when an older writer omitted its touch.
  ///
  /// Deliberately NOT counted by [`ProspectRecord::public_footprint_accounts`]: no
  /// comment was made, so there is no public footprint to charge against the
  /// per-item cap.
  Blocked,
}

impl ProspectState {
  /// `Seen` and `Claimed` are the only outcomes that have not completed an
  /// attempt. Kept in one place so local and foreign-shard fail-safes cannot
  /// drift apart when another terminal state is added.
  fn is_terminal(self) -> bool {
    !matches!(self, Self::Seen | Self::Claimed)
  }
}

/// 一条内容最多容忍几次「闸前失败」。
///
/// 放开失败复用是运营决策，但不能变成对着坏靶子无限锤 —— 那正是原来「失败不重试」
/// 想避免的。3 次之后仍然失败，就当作这条内容确实用不了，按终态关闭。
const MAX_FAILED_ATTEMPTS: usize = 3;

/// One account's interaction with one candidate. Append-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AccountTouch {
  pub profile_id: String,
  pub state: ProspectState,
  pub at: u64,
  /// 这次失败是否发生在**发送闸武装之前**。
  ///
  /// 只有 `Failed` 会带 true。它是唯一能把「点击绝无可能发生过」和「点击也许发生
  /// 过」分开的证据 —— 扩展在 `prospect-run.js` 里把 `sendStarted` 连同
  /// `pendingSettlement` 一起原子写进交接单，那是跨 document 唯一持久的不可逆边界。
  ///
  /// `serde(default)` 是刻意的：磁盘上的旧 touch 和所有外部分片反序列化成 `false`，
  /// 于是它们继续按「已用掉」处理，一条都不会被误放回池子。放开只对本次改动之后
  /// 新产生、且明确证明未发送的失败生效。
  #[serde(default)]
  pub pre_send: bool,
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
  /// The thread this item hangs under, as reported by the parser.
  ///
  /// Authoritative when present; [`Self::thread_key`] only falls back to
  /// picking it out of `open_url` when it is missing. Stored because URL shape
  /// is not something the ledger controls: a Zhihu answer that was surfaced
  /// without its question id gets a bare `/answer/<id>`, and a grouping derived
  /// from that silently degrades to per-answer.
  #[serde(default)]
  pub thread_hint: Option<String>,
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
      .filter(|t| t.state.is_terminal())
      .map(|t| t.profile_id.as_str())
  }

  /// True when this profile already reached a terminal outcome here. The
  /// account-level hard gate.
  pub fn touched_by(&self, profile_id: &str) -> bool {
    self.settled_accounts().any(|p| p == profile_id)
  }

  /// Whether any profile has completed an actual attempt on this exact item.
  ///
  /// Touches are append-only and therefore remain authoritative even when the
  /// record's mutable `state` later changed under the old multi-account rules.
  pub fn has_terminal_touch(&self) -> bool {
    self.settled_accounts().next().is_some()
  }

  /// Terminal evidence, including a legacy/corrupt mutable state whose writer
  /// omitted the append-only touch. This fail-safe is intentionally broader
  /// than [`Self::has_terminal_touch`]: losing history must not make a spent
  /// target claimable again, locally or after shard sync.
  /// 只因失败而不可用、且还在重试预算内的候选。
  ///
  /// 运营决策：失败不该永久烧掉一条内容。实测一次 7 小时的运行里，171 条被消耗的
  /// 候选只有 120 条产出了公开评论 —— 29.8% 颗粒无收；光一次 LLM 配额中断就永久
  /// 烧掉最多 27 条。那些失败连点击都没发生过，没有任何公开足迹。
  ///
  /// 但**只放开证明未发送的那部分**（`pre_send`）。审计逐点验过七个写 `failed` 的
  /// 位置：跨平台遗留、fill_failed、target_changed_before_send 三类在发送闸之前，
  /// 可以回收；prepare_send_failed 之后的几类都落在闸内，即使没点到按钮，页面上也
  /// 可能已经发生过浏览器级的可信输入，一律仍按用掉处理。
  fn recyclable_failures(&self) -> usize {
    if !matches!(
      self.state,
      ProspectState::Seen | ProspectState::Claimed | ProspectState::Failed
    ) {
      return 0;
    }
    if self.touches.is_empty() {
      return 0;
    }
    // 只要有一条不是「闸前失败」，这条内容就真的用掉了。
    if !self
      .touches
      .iter()
      .all(|t| t.state == ProspectState::Failed && t.pre_send)
    {
      return 0;
    }
    self.touches.len()
  }

  /// 还能不能再试一次。
  ///
  /// 上限存在的理由和放开一样硬：原设计写着「失败是数据，不是拿来反复锤的」。
  /// 对着一条永远打不开的内容无限重试，只会把每一轮的腿都喂给同一个坏靶子。
  fn failure_is_recyclable(&self) -> bool {
    let n = self.recyclable_failures();
    n > 0 && n < MAX_FAILED_ATTEMPTS
  }

  fn has_terminal_evidence(&self) -> bool {
    if self.failure_is_recyclable() {
      return false;
    }
    self.has_terminal_touch() || self.state.is_terminal()
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
    // Whatever the parser knew beats whatever the URL happens to show.
    if let Some(hint) = self.thread_hint.as_deref().filter(|h| !h.trim().is_empty()) {
      return format!("zhihu:question:{hint}");
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
  /// draft or pre-click `Failed` attempt was never sent, so it leaves no public
  /// footprint. Those outcomes still close the exact item through the separate
  /// terminal-evidence rule; this function answers only whether a comment may
  /// be visible publicly.
  /// The distinct accounts that may have left a PUBLIC footprint.
  ///
  /// Exposed separately so the cap can be summed across devices without
  /// double-counting an account that appears in both ledgers.
  pub fn public_footprint_accounts(&self) -> Vec<&str> {
    let mut seen: Vec<&str> = self
      .touches
      .iter()
      .filter(|t| matches!(t.state, ProspectState::Posted | ProspectState::Unconfirmed))
      .map(|t| t.profile_id.as_str())
      .collect();
    seen.sort_unstable();
    seen.dedup();
    seen
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
  /// The thread this item hangs under, when the parser already knows it.
  ///
  /// On Zhihu that is the question id. Deriving it from `open_url` works only
  /// while the URL carries `/question/<id>/`, and the search parsers do fall
  /// back to a bare `/answer/<id>` when they cannot resolve the question — at
  /// which point the grouping silently degrades to per-answer and the same
  /// account can take a second answer under a question it already commented on.
  /// Passing it explicitly removes that dependency on URL shape.
  #[serde(default)]
  pub thread_hint: Option<String>,
}

/// Platforms the ledger accepts. Rejecting unknown platforms here keeps a typo
/// from silently creating a parallel key namespace that dedups against nothing.
pub const SUPPORTED_PLATFORMS: [&str; 4] = ["bilibili", "zhihu", "douyin", "xiaohongshu"];

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
  /// Upper bound for public footprints retained for API compatibility and as a
  /// defensive `0 = disabled` gate. The exact-item terminal-touch rule is
  /// stricter: after the first completed attempt, no later profile may claim.
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
  /// Sightings whose `open_url` was rejected because taking it would have
  /// dropped the record out of its thread. Non-zero is normal on Zhihu.
  #[serde(default)]
  pub already_known_kept_url: usize,
}

/// Claims resolved when an operator cancels one scheduler leg.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CancelledClaimsReport {
  /// Pre-send claims recorded as an intentional skip.
  pub skipped: usize,
  /// Claims that crossed the send guard and may already be public.
  pub unconfirmed: usize,
}

impl CancelledClaimsReport {
  pub fn total(self) -> usize {
    self.skipped + self.unconfirmed
  }
}

/// Directory holding other devices' ledger shards, one JSON file per device.
///
/// Populated by the sync layer; this module only ever reads it.
const REMOTE_DIR: &str = "remote";

/// What another device has already done, folded into the two questions
/// [`ProspectLedger::claim_next`] needs to answer.
///
/// Built fresh per claim rather than cached across calls: a stale index is
/// indistinguishable from an empty one, and the failure it produces — an
/// account posting twice under one thread — is exactly what this exists to
/// prevent. Reading a handful of small JSON files is far cheaper than that.
#[derive(Debug, Default)]
pub struct ForeignIndex {
  /// Exact `platform:item` keys with terminal evidence on another device.
  spent_items: std::collections::HashSet<String>,
  /// `(platform, profile_id) → thread keys that account has already spent`.
  spent_threads: std::collections::HashSet<(String, String, String)>,
  /// `key → how many distinct accounts left a public footprint elsewhere`.
  foreign_footprints: HashMap<String, std::collections::HashSet<String>>,
  /// Content that another device found to have commenting switched off.
  blocked: std::collections::HashSet<String>,
}

impl ForeignIndex {
  /// Read every shard under `prospects/remote/`.
  ///
  /// A missing directory is fine — it just means nothing has synced yet. A file
  /// that is present but unreadable is **not** fine and returns an error: the
  /// whole point of the index is to withhold targets other devices already
  /// took, so silently treating a damaged shard as "no records" would restore
  /// precisely the duplicate-posting behaviour it prevents. Same reasoning as
  /// [`ProspectError::EmptyLedger`].
  pub fn load() -> Result<Self, ProspectError> {
    let dir = crate::app_dirs::prospects_dir().join(REMOTE_DIR);
    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
      Err(source) => return Err(ProspectError::Read { path: dir, source }),
    };
    Self::load_paths(&dir, entries.map(|entry| entry.map(|entry| entry.path())))
  }

  fn load_paths<I>(dir: &Path, paths: I) -> Result<Self, ProspectError>
  where
    I: IntoIterator<Item = Result<PathBuf, std::io::Error>>,
  {
    let mut index = Self::default();
    for path in paths {
      let path = path.map_err(|source| ProspectError::Read {
        path: dir.to_path_buf(),
        source,
      })?;
      if path.extension().and_then(|e| e.to_str()) != Some("json") {
        continue;
      }
      let raw = fs::read_to_string(&path).map_err(|source| ProspectError::Read {
        path: path.clone(),
        source,
      })?;
      if raw.trim().is_empty() {
        return Err(ProspectError::EmptyLedger { path });
      }
      let records: Vec<ProspectRecord> =
        serde_json::from_str(&raw).map_err(|source| ProspectError::InvalidJson {
          path: path.clone(),
          source,
        })?;
      index.absorb(&records);
    }
    Ok(index)
  }

  fn absorb(&mut self, records: &[ProspectRecord]) {
    for r in records {
      if r.state == ProspectState::Blocked {
        self.blocked.insert(r.key.clone());
      }
      if r.has_terminal_evidence() {
        self.spent_items.insert(r.key.clone());
      }
      let thread = r.thread_key();
      for profile in r.settled_accounts() {
        self
          .spent_threads
          .insert((r.platform.clone(), profile.to_string(), thread.clone()));
      }
      for profile in r.public_footprint_accounts() {
        self
          .foreign_footprints
          .entry(r.key.clone())
          .or_default()
          .insert(profile.to_string());
      }
    }
  }

  fn item_is_spent(&self, key: &str) -> bool {
    self.spent_items.contains(key)
  }

  fn thread_is_spent(&self, platform: &str, profile_id: &str, thread: &str) -> bool {
    self.spent_threads.contains(&(
      platform.to_string(),
      profile_id.to_string(),
      thread.to_string(),
    ))
  }

  fn is_blocked(&self, key: &str) -> bool {
    self.blocked.contains(key)
  }

  /// Accounts with a public footprint on `key` that are not already counted
  /// locally — added to the local count so the cap is global, not per-machine.
  fn extra_footprints(&self, key: &str, local: &[&str]) -> usize {
    self
      .foreign_footprints
      .get(key)
      .map(|accounts| {
        accounts
          .iter()
          .filter(|a| !local.contains(&a.as_str()))
          .count()
      })
      .unwrap_or(0)
  }
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
          // Grouping only ever gets sharper, never blunter.
          //
          // A later sighting can arrive without the question id (the search
          // parsers fall back to a bare `/answer/<id>`). Letting that overwrite
          // a URL that *did* carry it would silently drop the record out of its
          // thread, and the account that already commented under that question
          // would immediately be allowed to take another answer in it.
          let had_thread = rec.thread_key() != rec.key;
          if c.thread_hint.is_some() && rec.thread_hint.is_none() {
            rec.thread_hint = c.thread_hint.clone();
          }
          let would_lose_thread = had_thread && {
            let mut probe = rec.clone();
            probe.open_url = c.open_url.clone();
            probe.thread_key() == probe.key
          };
          if would_lose_thread {
            // Keep the older, better-formed URL. Its token may be staler, and
            // `url_is_stale` already handles that; losing the grouping is not
            // recoverable the same way.
            report.already_known_kept_url += 1;
          } else if rec.open_url != c.open_url {
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
            thread_hint: c.thread_hint.clone(),
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
    // What other devices already did. Errors propagate on purpose: running
    // blind is how the same account ends up posting twice under one thread.
    let foreign = ForeignIndex::load()?;

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

    // 为什么统计拒绝原因，而不是只回一个 bool：
    //
    // 实测一次 7 小时的运行里，**141 条腿**以「no eligible targets left for this
    // account」结束，占全部腿的 42.5% —— 而这个函数返回 `Ok(None)` 时不写任何
    // 日志。六个互不相同的拒绝判据，零可观测性：运维看到的只有「没有可执行任务」，
    // 分不清是池子真的用完了、还是被线程闸挡了、还是 URL 过期了，而这三者的下一
    // 步完全不同（去翻页 / 换账号 / 重新搜索）。
    //
    // 只在**一条都没领到**时才落一行汇总，正常路径零成本。
    let mut rejects: std::collections::BTreeMap<&'static str, usize> =
      std::collections::BTreeMap::new();
    let mut bump = |reason: &'static str| {
      *rejects.entry(reason).or_insert(0) += 1;
    };
    let eligible = |r: &ProspectRecord, bump: &mut dyn FnMut(&'static str)| -> bool {
      if r.platform != platform {
        return false;
      }
      // A completed attempt spends the exact item for the whole fleet. Touches
      // rather than mutable `state` are the evidence: older ledgers could move
      // a Failed record back to Claimed for a second profile while retaining
      // the first profile's append-only touch.
      if r.has_terminal_evidence() || foreign.item_is_spent(&r.key) {
        bump("已被舰队用掉（含失败）");
        return false;
      }
      // Account-level hard gate, applied to the whole thread — here and on
      // every other device that has synced its shard to us.
      let thread = r.thread_key();
      if touched_threads.contains(&thread) || foreign.thread_is_spent(platform, profile_id, &thread)
      {
        bump("本账号已在该主题下出现过");
        return false;
      }
      // Content-level cap, counted across devices. An account present in both
      // ledgers is counted once.
      let local_accounts = r.public_footprint_accounts();
      let footprints = local_accounts.len() + foreign.extra_footprints(&r.key, &local_accounts);
      if footprints >= opts.per_item_account_cap {
        bump("内容级账号配额已满");
        return false;
      }
      // Commenting being switched off is a property of the content, so another
      // device discovering it spares this one a wasted leg.
      if foreign.is_blocked(&r.key) {
        bump("该内容已关闭评论");
        return false;
      }
      // A session URL we can no longer trust must be re-resolved by a fresh
      // search before it is handed out; serving it would just fail to open.
      if r.url_is_stale(opts.session_url_max_age_secs, now) {
        bump("会话 URL 已过期，需重新搜索");
        return false;
      }
      // Normally terminal states also carry a touch and were rejected above.
      // Reject them here as a fail-safe for legacy/corrupt rows that retained
      // the mutable outcome but lost their append-only evidence.
      match r.state {
        ProspectState::Seen => true,
        ProspectState::Claimed => r.claim_is_stale(opts.claim_ttl_secs, now),
        // `Failed` 不再一律拒绝：证明过发送闸从未武装、且还没撞上重试上限的，
        // 放回池子。判据仍然是**append-only 的 touch**，不是这个可变字段 ——
        // 旧账本可能保留了 Failed 却丢了 touch，那种行 recyclable_failures()
        // 返回 0，照旧被这里挡掉。
        ProspectState::Failed if r.failure_is_recyclable() => true,
        ProspectState::Posted
        | ProspectState::Unconfirmed
        | ProspectState::Skipped
        | ProspectState::Filled
        | ProspectState::Failed
        | ProspectState::Blocked => false,
      }
    };

    // Spread the choice across devices instead of taking the first match.
    //
    // Two machines running the same plan hold ledgers in the same order, so
    // "first eligible" makes them deterministically reach for the *same*
    // record — the one case where a claim collision is guaranteed rather than
    // unlikely. Ordering by a per-device hash keeps each machine's own choice
    // stable and reproducible while making the two disagree. With ~190 eligible
    // candidates in practice this turns a near-certain collision into ~1/190.
    //
    // Not a substitute for a cross-device lock: it lowers the odds, it does not
    // make double-claiming impossible. See `claim_next`'s caller in
    // `api_server`, which refuses to claim unless this device holds the
    // profile's lease.
    let device = crate::team_lock::device_id();
    let pick = records
      .iter()
      .enumerate()
      .filter(|(_, r)| eligible(r, &mut bump))
      .min_by_key(|(_, r)| {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&device, &mut hasher);
        std::hash::Hash::hash(&r.key, &mut hasher);
        std::hash::Hasher::finish(&hasher)
      })
      .map(|(i, _)| i);

    let Some(i) = pick else {
      // 领不到就把「为什么」写出来。这是 141 条腿的头号结局，而在此之前它在任何
      // 地方都不留证据 —— 运维只能看到「无可执行任务」，无从判断该去翻页、换账号
      // 还是重新搜索。
      //
      // 同时给出这个平台的库存总量：分母不写出来，「拒了 40 条」既可能是池子干了，
      // 也可能是这个平台压根就没入过账。
      let total = records.iter().filter(|r| r.platform == platform).count();
      let breakdown = if rejects.is_empty() {
        "无候选可评估".to_string()
      } else {
        rejects
          .iter()
          .map(|(reason, n)| format!("{reason}×{n}"))
          .collect::<Vec<_>>()
          .join("，")
      };
      log::info!(
        "Prospect claim: {profile_id} 在 {platform} 上无可领取靶子（该平台库存 {total} 条）：{breakdown}"
      );
      return Ok(None);
    };
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
    // Old multi-profile writers could leave a new active claim on a record
    // whose append-only touches already prove that another profile completed
    // an attempt. `claim_next` now rejects that shape, but an in-flight legacy
    // browser may cross an upgrade boundary and arrive directly at this final
    // pre-click guard. Refuse it here too: no migration window may bypass the
    // exact-item rule.
    if rec.has_terminal_evidence() {
      return Err(ProspectError::AlreadySpent {
        key: key.to_string(),
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
  /// 结算，不带「闸前」证据 —— 等价于 `pre_send = false`，即按最保守处理。
  ///
  /// **只保留给测试。** 生产路径一律走 [`Self::settle_with_evidence`]：证据是台账
  /// 敢不敢把一条失败的候选放回池子的唯一依据，让调用方「忘了传」而默默落到保守
  /// 一侧，会把一个安全决定变成一个笔误。clippy 会盯着这一点——真有生产调用方回到
  /// 这个签名，`dead_code` 就不再触发，那正是我们想被提醒的时刻。
  #[cfg(test)]
  pub fn settle(
    &self,
    key: &str,
    profile_id: &str,
    state: ProspectState,
  ) -> Result<(), ProspectError> {
    self.settle_with_evidence(key, profile_id, state, false)
  }

  pub fn settle_with_evidence(
    &self,
    key: &str,
    profile_id: &str,
    state: ProspectState,
    pre_send: bool,
  ) -> Result<(), ProspectError> {
    if !state.is_terminal() {
      return Err(ProspectError::InvalidSettlementState { state });
    }
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
      // 只有明确证明「发送闸从未武装」的失败才带 true。其余一律 false —— 包括
      // 所有非 Failed 状态，以及调用方没给出证据的失败。
      pre_send: state == ProspectState::Failed && pre_send,
    });
    self.save(&records)?;
    Ok(())
  }

  /// Atomically resolve claims left behind when one scheduler leg is stopped.
  ///
  /// Only claims owned by `profile_id` on `platform` and created at or after
  /// `leg_started_at` belong to this leg. A pre-send claim is an intentional
  /// `Skipped`; once the irreversible send guard was crossed, absence of a
  /// receipt must be recorded conservatively as `Unconfirmed`.
  pub fn settle_cancelled_claims(
    &self,
    profile_id: &str,
    platform: &str,
    leg_started_at: u64,
  ) -> Result<CancelledClaimsReport, ProspectError> {
    if !SUPPORTED_PLATFORMS.contains(&platform) {
      return Err(ProspectError::UnsupportedPlatform(platform.to_string()));
    }

    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    let mut records = self.load()?;
    let now = now_secs();
    let mut report = CancelledClaimsReport::default();

    for rec in &mut records {
      let belongs_to_leg = rec.platform == platform
        && rec.state == ProspectState::Claimed
        && rec.claimed_by.as_deref() == Some(profile_id)
        && matches!(rec.claimed_at, Some(at) if at >= leg_started_at);
      if !belongs_to_leg {
        continue;
      }

      let state = if rec.send_started_at.is_some() {
        report.unconfirmed += 1;
        ProspectState::Unconfirmed
      } else {
        report.skipped += 1;
        ProspectState::Skipped
      };
      rec.state = state;
      rec.claimed_by = None;
      rec.claimed_at = None;
      rec.send_started_at = None;
      rec.touches.push(AccountTouch {
        profile_id: profile_id.to_string(),
        state,
        at: now,
        // 取消路径只写 Unconfirmed / Skipped，都不是 Failed —— 回收判据只看
        // Failed，所以这里恒为 false，写死比传参更不容易被后人改错。
        pre_send: false,
      });
    }

    if report.total() > 0 {
      self.save(&records)?;
    }
    Ok(report)
  }

  /// This device's ledger, serialized the way a sync shard must be.
  ///
  /// Canonical on purpose: records sorted by key, touches sorted, compact
  /// (never pretty). The upload decision is "did these bytes change", so two
  /// runs that produced the same facts have to produce the same bytes — a
  /// formatting difference would look like new data and two machines would
  /// push at each other forever, breaking the "no change means no PUT"
  /// invariant the sync layer relies on.
  pub fn shard_bytes(&self) -> Result<String, ProspectError> {
    let _guard = self.lock.lock().expect("prospect ledger mutex poisoned");
    let mut records = self.load()?;
    records.sort_by(|a, b| a.key.cmp(&b.key));
    for r in &mut records {
      r.touches.sort_by(|a, b| {
        (a.at, &a.profile_id, format!("{:?}", a.state)).cmp(&(
          b.at,
          &b.profile_id,
          format!("{:?}", b.state),
        ))
      });
      r.touches.dedup();
      // Claims are this machine's current business, not a fact about the
      // content. Shipping them would let a lease that is about to expire here
      // look active everywhere.
      r.claimed_by = None;
      r.claimed_at = None;
      r.send_started_at = None;
    }
    serde_json::to_string(&records).map_err(|source| ProspectError::InvalidJson {
      path: self.path(),
      source,
    })
  }

  /// This machine's own ledger, and nothing else.
  ///
  /// Named `list_local` rather than `list` so the compiler is the thing that
  /// stops foreign records leaking into callers that must only ever count what
  /// happened here — `scheduler::count_leg_touches` in particular decides when
  /// a leg is finished, and a touch that arrived over sync would end the leg
  /// on someone else's work. A comment saying so has already failed to hold
  /// once; a rename cannot be ignored.
  pub fn list_local(&self) -> Result<Vec<ProspectRecord>, ProspectError> {
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
      thread_hint: None,
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
    assert_eq!(l.list_local().unwrap()[0].state, ProspectState::Posted);
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
    let still_claimed = &l.list_local().unwrap()[0];
    assert_eq!(still_claimed.state, ProspectState::Claimed);
    assert_eq!(still_claimed.claimed_by.as_deref(), Some("p1"));

    l.settle(&claim.key, "p1", ProspectState::Posted).unwrap();
    l.settle(&claim.key, "p1", ProspectState::Posted)
      .expect("an exact retry after a lost response must be idempotent");
    assert_eq!(l.list_local().unwrap()[0].touches.len(), 1);
    assert!(matches!(
      l.settle(&claim.key, "p1", ProspectState::Failed),
      Err(ProspectError::ClaimOwnerMismatch { .. })
    ));
  }

  #[test]
  fn settle_rejects_non_terminal_states_without_mutating_the_claim() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let claim = l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .unwrap();

    for state in [ProspectState::Seen, ProspectState::Claimed] {
      assert!(matches!(
        l.settle(&claim.key, "p1", state),
        Err(ProspectError::InvalidSettlementState { state: actual }) if actual == state
      ));

      let unchanged = &l.list_local().unwrap()[0];
      assert_eq!(unchanged.state, ProspectState::Claimed);
      assert_eq!(unchanged.claimed_by.as_deref(), Some("p1"));
      assert!(unchanged.touches.is_empty());
    }
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
  fn a_terminal_touch_closes_the_exact_item_for_every_profile() {
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
      "the profile that touched it must not retry"
    );
    assert!(
      l.claim_next("p2", "bilibili", &o).unwrap().is_none(),
      "an exact terminal touch is global even when the footprint cap is 10"
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
  fn skipped_closes_the_item_for_every_account() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let o = ClaimOptions::default();

    let c = l.claim_next("p1", "bilibili", &o).unwrap().unwrap();
    l.settle(&c.key, "p1", ProspectState::Skipped).unwrap();

    assert!(l.claim_next("p1", "bilibili", &o).unwrap().is_none());
    assert!(
      l.claim_next("p2", "bilibili", &o).unwrap().is_none(),
      "a deliberate skip spends the exact target globally"
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
    let guarded = &l.list_local().unwrap()[0];
    assert_eq!(guarded.claimed_by.as_deref(), Some("p1"));
    assert!(guarded.send_started_at.is_some());

    l.settle(&claim.key, "p1", ProspectState::Posted).unwrap();
    let settled = &l.list_local().unwrap()[0];
    assert!(settled.send_started_at.is_none());
    assert_eq!(settled.state, ProspectState::Posted);
  }

  #[test]
  fn prepare_send_rejects_an_in_flight_legacy_claim_on_a_spent_item() {
    let (l, _g) = ledger();
    l.ingest(&[cand("zhihu", "answer:1", "https://z/1")])
      .unwrap();
    let claim = l
      .claim_next("p1", "zhihu", &ClaimOptions::default())
      .unwrap()
      .unwrap();
    l.settle(&claim.key, "p1", ProspectState::Failed).unwrap();

    // This is a state an older multi-profile writer could persist while a new
    // app version was starting: the mutable row belongs to p2, but p1's
    // terminal touch remains as authoritative evidence that the item is spent.
    let mut records = l.load().unwrap();
    records[0].state = ProspectState::Claimed;
    records[0].claimed_by = Some("p2".to_string());
    records[0].claimed_at = Some(now_secs());
    l.save(&records).unwrap();

    assert!(matches!(
      l.prepare_send(&claim.key, "p2"),
      Err(ProspectError::AlreadySpent { key }) if key == claim.key
    ));
    let unchanged = &l.list_local().unwrap()[0];
    assert_eq!(unchanged.state, ProspectState::Claimed);
    assert_eq!(unchanged.claimed_by.as_deref(), Some("p2"));
    assert!(unchanged.send_started_at.is_none());
    assert_eq!(unchanged.touches.len(), 1);
  }

  #[test]
  fn committed_settle_retry_remains_idempotent_after_the_item_is_closed() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let opts = ClaimOptions {
      per_item_account_cap: 10,
      ..Default::default()
    };
    let first = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    l.settle(&first.key, "p1", ProspectState::Skipped).unwrap();
    assert!(l.claim_next("p2", "bilibili", &opts).unwrap().is_none());

    l.settle(&first.key, "p1", ProspectState::Skipped)
      .expect("a lost-response retry must remain idempotent after settlement");
    let rec = &l.list_local().unwrap()[0];
    assert_eq!(rec.state, ProspectState::Skipped);
    assert_eq!(rec.claimed_by, None);
    assert_eq!(rec.touches.len(), 1);
  }

  #[test]
  fn cancelling_a_leg_settles_only_its_recent_matching_claims() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV_old", "https://b/old"),
      cand("bilibili", "BV_recent", "https://b/recent"),
      cand("bilibili", "BV_other", "https://b/other"),
      cand("zhihu", "answer:1", "https://z/1"),
    ])
    .unwrap();
    let opts = ClaimOptions::default();

    let old = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    let leg_started_at = now_secs();
    let mut records = l.load().unwrap();
    records
      .iter_mut()
      .find(|r| r.key == old.key)
      .unwrap()
      .claimed_at = Some(leg_started_at.saturating_sub(1));
    l.save(&records).unwrap();

    let recent = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    let another_profile = l.claim_next("p2", "bilibili", &opts).unwrap().unwrap();
    let another_platform = l.claim_next("p1", "zhihu", &opts).unwrap().unwrap();

    let report = l
      .settle_cancelled_claims("p1", "bilibili", leg_started_at)
      .unwrap();
    assert_eq!(
      report,
      CancelledClaimsReport {
        skipped: 1,
        unconfirmed: 0,
      }
    );
    assert_eq!(report.total(), 1);

    let records = l.list_local().unwrap();
    let find = |key: &str| records.iter().find(|r| r.key == key).unwrap();

    let old_record = find(&old.key);
    assert_eq!(old_record.state, ProspectState::Claimed);
    assert_eq!(old_record.claimed_by.as_deref(), Some("p1"));

    let cancelled = find(&recent.key);
    assert_eq!(cancelled.state, ProspectState::Skipped);
    assert_eq!(cancelled.claimed_by, None);
    assert_eq!(cancelled.claimed_at, None);
    assert_eq!(cancelled.send_started_at, None);
    assert_eq!(cancelled.touches.len(), 1);
    assert_eq!(cancelled.touches[0].profile_id, "p1");
    assert_eq!(cancelled.touches[0].state, ProspectState::Skipped);

    assert_eq!(find(&another_profile.key).claimed_by.as_deref(), Some("p2"));
    assert_eq!(
      find(&another_platform.key).claimed_by.as_deref(),
      Some("p1")
    );

    assert_eq!(
      l.settle_cancelled_claims("p1", "bilibili", leg_started_at)
        .unwrap(),
      CancelledClaimsReport::default(),
      "a repeated stop must not append a second touch"
    );
    assert_eq!(
      l.list_local()
        .unwrap()
        .iter()
        .find(|r| r.key == recent.key)
        .unwrap()
        .touches
        .len(),
      1
    );
  }

  #[test]
  fn cancelling_after_the_send_guard_is_conservatively_unconfirmed() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let leg_started_at = now_secs();
    let claim = l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .unwrap();
    l.prepare_send(&claim.key, "p1").unwrap();

    let report = l
      .settle_cancelled_claims("p1", "bilibili", leg_started_at)
      .unwrap();
    assert_eq!(
      report,
      CancelledClaimsReport {
        skipped: 0,
        unconfirmed: 1,
      }
    );

    let record = &l.list_local().unwrap()[0];
    assert_eq!(record.state, ProspectState::Unconfirmed);
    assert_eq!(record.claimed_by, None);
    assert_eq!(record.claimed_at, None);
    assert_eq!(record.send_started_at, None);
    assert_eq!(record.touches.len(), 1);
    assert_eq!(record.touches[0].state, ProspectState::Unconfirmed);
    assert_eq!(record.public_footprint_accounts(), vec!["p1"]);
    assert!(l
      .claim_next("p2", "bilibili", &ClaimOptions::default())
      .unwrap()
      .is_none());
  }

  #[test]
  fn cancelling_claims_rejects_an_unknown_platform() {
    let (l, _g) = ledger();
    assert!(matches!(
      l.settle_cancelled_claims("p1", "weibo", 0),
      Err(ProspectError::UnsupportedPlatform(platform)) if platform == "weibo"
    ));
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

    let rec = &l.list_local().unwrap()[0];
    assert_eq!(rec.open_url_durability, Durability::Session);

    // With a zero freshness window the token is assumed unusable and the
    // candidate must be withheld rather than handed out to fail on open.
    let stale = ClaimOptions {
      session_url_max_age_secs: 0,
      ..Default::default()
    };
    assert!(l.claim_next("p1", "xiaohongshu", &stale).unwrap().is_none());

    let fresh = ClaimOptions::default();
    assert!(l.claim_next("p1", "xiaohongshu", &fresh).unwrap().is_some());
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
    assert!(l.list_local().unwrap()[0].open_url.ends_with("NEW"));
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

    let all = l.list_local().unwrap();
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
  fn a_filled_draft_closes_the_item_without_becoming_a_public_footprint() {
    // 调试期的终局：草稿已填入但没发出去。
    // 没发出去就没有公开足迹，但实际尝试过的 exact item 仍全局关闭。
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
      l.claim_next("p2", "bilibili", &o).unwrap().is_none(),
      "填入虽不占 footprint cap，但 exact item 已经用过"
    );
    assert_eq!(
      l.list_local().unwrap()[0].public_footprint_accounts().len(),
      0,
      "Filled 绝不能被算成 Posted"
    );
  }

  #[test]
  fn a_failed_attempt_is_recorded_and_closes_the_item() {
    // 决策：发送失败只记录、不重试，而且不能让账号池轮流撞同一个坏目标。
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
    assert!(
      l.claim_next("p2", "zhihu", &o).unwrap().is_none(),
      "另一个账号也不该重新撞同一个失败目标"
    );
    let rec = &l.list_local().unwrap()[0];
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
    let rec = &l.list_local().unwrap()[0];
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
    assert_eq!(
      l.list_local().unwrap()[0].public_footprint_accounts().len(),
      0
    );
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
  fn drafts_and_pre_click_failures_close_only_their_exact_items_without_footprints() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV_filled", "https://b/filled"),
      cand("bilibili", "BV_failed", "https://b/failed"),
    ])
    .unwrap();
    let o = ClaimOptions {
      per_item_account_cap: 2,
      ..Default::default()
    };

    for (p, st) in [("p1", ProspectState::Filled), ("p2", ProspectState::Failed)] {
      let c = l.claim_next(p, "bilibili", &o).unwrap().unwrap();
      l.settle(&c.key, p, st).unwrap();
    }
    assert_eq!(
      l.list_local()
        .unwrap()
        .iter()
        .map(|r| r.public_footprint_accounts().len())
        .sum::<usize>(),
      0
    );
    assert!(
      l.claim_next("p3", "bilibili", &o).unwrap().is_none(),
      "两个 exact item 都已有终局接触，不能再发给第三个账号"
    );
  }

  /// 闸前失败要能放回池子 —— 这是本次运营决策的核心。
  ///
  /// 实测依据：一次 7 小时的运行里 171 条被消耗的候选只有 120 条产出公开评论，
  /// 29.8% 颗粒无收；光一次 LLM 配额中断就永久烧掉最多 27 条，而那些连点击都
  /// 没发生过。
  #[test]
  fn a_pre_send_failure_returns_the_candidate_to_the_pool() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let opts = ClaimOptions::default();

    let first = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    l.settle_with_evidence(&first.key, "p1", ProspectState::Failed, true)
      .unwrap();

    // 另一个账号必须还能领到它。
    let again = l.claim_next("p2", "bilibili", &opts).unwrap();
    assert!(again.is_some(), "闸前失败不该永久烧掉候选");
  }

  /// 但闸**后**的失败不行 —— 页面上可能已经发生过浏览器级可信输入。
  #[test]
  fn a_failure_past_the_send_guard_still_spends_the_item() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let opts = ClaimOptions::default();

    let first = l.claim_next("p1", "bilibili", &opts).unwrap().unwrap();
    // 没有证据 = 保守处理，等价于旧行为。
    l.settle(&first.key, "p1", ProspectState::Failed).unwrap();

    assert!(
      l.claim_next("p2", "bilibili", &opts).unwrap().is_none(),
      "无法证明未发送的失败必须继续按用掉处理",
    );
  }

  /// 放开不等于无限重试：坏靶子撞满上限后按终态关闭。
  #[test]
  fn recycled_failures_are_capped() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let opts = ClaimOptions::default();

    for i in 0..MAX_FAILED_ATTEMPTS {
      let profile = format!("p{i}");
      let claimed = l
        .claim_next(&profile, "bilibili", &opts)
        .unwrap()
        .unwrap_or_else(|| panic!("第 {i} 次应当还能领到"));
      l.settle_with_evidence(&claimed.key, &profile, ProspectState::Failed, true)
        .unwrap();
    }
    assert!(
      l.claim_next("pX", "bilibili", &opts).unwrap().is_none(),
      "撞满 MAX_FAILED_ATTEMPTS 之后必须停手",
    );
  }

  /// 磁盘上的旧 touch 没有这个字段，反序列化成 false —— 一条都不能被误放回。
  #[test]
  fn legacy_touches_without_the_flag_stay_spent() {
    let touch: AccountTouch =
      serde_json::from_str(r#"{"profile_id":"p1","state":"failed","at":1}"#).unwrap();
    assert!(!touch.pre_send, "缺字段必须落到保守的一侧");
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

    let record = &l.list_local().unwrap()[0];
    assert_eq!(record.public_footprint_accounts().len(), 1);
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
    assert_eq!(l.list_local().expect("list").len(), 1);

    // 模拟掉电后留下的零长度文件。
    std::fs::write(l.path(), b"").expect("truncate");

    let err = l.list_local().expect_err("空文件必须报错，不能当成空台账");
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
      l.list_local().expect_err("空白文件要报错"),
      ProspectError::EmptyLedger { .. }
    ));
  }

  /// 台账**不存在**仍然是合法的空台账 —— 别把首次运行也拒了。
  #[test]
  fn a_missing_ledger_is_still_an_empty_one() {
    let (l, _g) = ledger();
    assert!(l.list_local().expect("首次运行不该报错").is_empty());
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
    assert_eq!(l.list_local().expect("list").len(), 7);
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
      thread_hint: None,
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

  /// 但 thread 是**账号级**闸门：换个账号仍可拿这个问题下另一条未触碰的回答。
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
    assert_ne!(
      second.key, first.key,
      "跨账号也绝不能重复同一个 exact answer"
    );
    // thread 闸门只拦同账号；另一个账号仍可拿问题下未触碰的另一回答。
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

  /// 解析器给了 question_id 就以它为准，不再依赖 URL 长什么样。
  ///
  /// 知乎搜索拿不到 questionId 时给的是裸 `/answer/<id>`，从 URL 抠分组会当场
  /// 退化成按回答算 —— 同一个账号立刻能领走同问题下的另一个回答。
  #[test]
  fn a_parser_supplied_thread_hint_beats_the_url_shape() {
    let (l, _g) = ledger();
    let mut c = zhihu_answer("2053182600689333370");
    c.open_url = "https://www.zhihu.com/answer/2053182600689333370".to_string(); // 裸链接
    c.thread_hint = Some(Q.to_string());
    l.ingest(&[c]).unwrap();

    let rec = &l.list_local().unwrap()[0];
    assert_eq!(
      rec.thread_key(),
      format!("zhihu:question:{Q}"),
      "有 hint 就不该退回按回答分组"
    );
  }

  /// 后来的一次抓取没带 question_id 时，不能把已经分好组的记录打散。
  #[test]
  fn a_later_bare_url_cannot_dissolve_an_existing_thread() {
    let (l, _g) = ledger();
    let aid = "2053182600689333370";
    l.ingest(&[zhihu_answer(aid)]).unwrap(); // 带 /question/<Q>/ 的完整 URL
    let before = l.list_local().unwrap()[0].thread_key();
    assert_eq!(before, format!("zhihu:question:{Q}"));

    // 同一条内容再次被发现，这次只有裸链接、也没有 hint。
    let mut bare = zhihu_answer(aid);
    bare.open_url = format!("https://www.zhihu.com/answer/{aid}");
    bare.thread_hint = None;
    let report = l.ingest(&[bare]).unwrap();

    let rec = &l.list_local().unwrap()[0];
    assert_eq!(rec.thread_key(), before, "分组只能变细，不能被打散");
    assert_eq!(report.already_known_kept_url, 1, "应当明确记下这次拒绝");
    assert!(
      rec.open_url.contains("/question/"),
      "保留信息更全的那个 URL"
    );
  }

  /// 两台机器的台账收敛后顺序相同，「取第一个合格项」会让它们确定性地抢同一条。
  /// 换成按设备散列取之后，同一台机器的选择依然稳定，两台机器则会分开。
  #[test]
  fn two_devices_do_not_deterministically_reach_for_the_same_record() {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let keys: Vec<String> = (0..190).map(|i| format!("bilibili:BV{i}")).collect();
    let pick_for = |device: &str| -> String {
      keys
        .iter()
        .min_by_key(|k| {
          let mut h = DefaultHasher::new();
          device.hash(&mut h);
          k.hash(&mut h);
          h.finish()
        })
        .unwrap()
        .clone()
    };

    // 同一台机器反复算必须得到同一个答案（可复现，便于排查）。
    assert_eq!(pick_for("device-a"), pick_for("device-a"));
    // 不同机器应当分开。190 个候选里撞上的概率约 1/190。
    assert_ne!(
      pick_for("device-a"),
      pick_for("device-b"),
      "两台设备不该确定性地选中同一条"
    );
  }

  // ---------------------------------------------------------------- 跨设备去重
  //
  // 别的机器的历史通过 prospects/remote/<device>.json 参与判断。
  // 这些用例钉的是：外来历史真的挡得住，而且**读不动时必须报错而不是当成没有**。

  fn write_remote_shard(name: &str, records: &[ProspectRecord]) {
    let dir = crate::app_dirs::prospects_dir().join("remote");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
      dir.join(format!("{name}.json")),
      serde_json::to_string(records).unwrap(),
    )
    .unwrap();
  }

  /// 别的机器上同一个账号已经在这个问题下评过 —— 本机不能再发给它。
  #[test]
  fn a_thread_spent_on_another_device_is_withheld_here() {
    let (l, _g) = ledger();
    l.ingest(&[zhihu_answer("2053182600689333370")]).unwrap();

    // 远端分片：p1 已经在同一个问题下的**另一个回答**上发过。
    let mut other = l.list_local().unwrap()[0].clone();
    other.key = "zhihu:zhihu:answer:2057478634580063639".to_string();
    other.item_id = "zhihu:answer:2057478634580063639".to_string();
    other.touches = vec![AccountTouch {
      profile_id: "p1".to_string(),
      state: ProspectState::Posted,
      at: 1,
      pre_send: false,
    }];
    let other_key = other.key.clone();
    write_remote_shard("device-b", &[other]);

    let opts = ClaimOptions::default();
    assert!(
      l.claim_next("p1", "zhihu", &opts).unwrap().is_none(),
      "同一账号在别的机器上已经进过这个问题，本机必须挡住"
    );
    // 换个账号仍然可以拿本机这条不同回答（thread 是账号级闸门）。
    let p2 = l.claim_next("p2", "zhihu", &opts).unwrap().unwrap();
    assert_ne!(p2.key, other_key);
  }

  /// cap 是全局的：本机 0 个足迹 + 远端 1 个，cap=1 就该挡住。
  #[test]
  fn the_per_item_cap_counts_across_devices() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();

    let mut remote = l.list_local().unwrap()[0].clone();
    remote.touches = vec![AccountTouch {
      profile_id: "p9".to_string(),
      state: ProspectState::Posted,
      at: 1,
      pre_send: false,
    }];
    write_remote_shard("device-b", &[remote]);

    let opts = ClaimOptions::default(); // cap = 1
    assert!(
      l.claim_next("p1", "bilibili", &opts).unwrap().is_none(),
      "远端已经用掉了唯一的名额"
    );
  }

  /// Legacy writers could leave a terminal mutable state without its touch.
  /// A foreign shard must fail safe exactly as the local ledger does.
  #[test]
  fn every_terminal_state_in_a_foreign_shard_spends_the_exact_item_without_a_touch() {
    for state in [
      ProspectState::Posted,
      ProspectState::Unconfirmed,
      ProspectState::Skipped,
      ProspectState::Filled,
      ProspectState::Failed,
      ProspectState::Blocked,
    ] {
      let (l, _g) = ledger();
      l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();

      let mut remote = l.list_local().unwrap()[0].clone();
      remote.state = state;
      remote.touches.clear();
      write_remote_shard("legacy-device", &[remote]);

      assert!(
        l.claim_next("p1", "bilibili", &ClaimOptions::default())
          .unwrap()
          .is_none(),
        "foreign terminal state {state:?} must spend the exact item even without a touch"
      );
    }
  }

  /// 别的机器发现关了评论，本机不必再白跑一条腿去重新发现。
  #[test]
  fn blocked_content_discovered_elsewhere_is_not_handed_out_again() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();

    let mut remote = l.list_local().unwrap()[0].clone();
    remote.state = ProspectState::Blocked;
    write_remote_shard("device-b", &[remote]);

    assert!(l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .is_none());
  }

  /// 分片读不动时必须报错。当成「没有记录」等于静默失去跨机去重 ——
  /// 和把空台账当成空记录是同一类事故。
  #[test]
  fn an_unreadable_shard_is_an_error_not_an_empty_index() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let dir = crate::app_dirs::prospects_dir().join("remote");
    std::fs::create_dir_all(&dir).unwrap();

    std::fs::write(dir.join("broken.json"), b"{ not json").unwrap();
    assert!(matches!(
      l.claim_next("p1", "bilibili", &ClaimOptions::default()),
      Err(ProspectError::InvalidJson { .. })
    ));

    std::fs::write(dir.join("broken.json"), b"").unwrap();
    assert!(matches!(
      l.claim_next("p1", "bilibili", &ClaimOptions::default()),
      Err(ProspectError::EmptyLedger { .. })
    ));
  }

  #[test]
  fn a_read_dir_entry_error_is_not_silently_dropped() {
    let dir = PathBuf::from("remote-ledger-fixture");
    let source = std::io::Error::new(
      std::io::ErrorKind::PermissionDenied,
      "synthetic directory entry failure",
    );
    let err = ForeignIndex::load_paths(&dir, [Err(source)])
      .expect_err("one unreadable directory entry must make dedup fail closed");

    assert!(matches!(
      err,
      ProspectError::Read { path, source }
        if path == dir && source.kind() == std::io::ErrorKind::PermissionDenied
    ));
  }

  /// 还没同步过任何东西是合法状态，不能因此报错。
  #[test]
  fn no_remote_directory_means_no_foreign_history_not_an_error() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    assert!(l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .is_some());
  }

  /// 分片必须是规范形式：同样的事实必须产出同样的字节。
  ///
  /// 上传判据是「这些字节变了没有」，格式差异会被当成新数据，
  /// 两台机器就会互相推送、永不停止 —— 直接违反「没变化必须零 PUT」。
  #[test]
  fn a_shard_is_byte_stable_for_the_same_facts() {
    let (l, _g) = ledger();
    l.ingest(&[
      cand("bilibili", "BV2", "https://b/2"),
      cand("bilibili", "BV1", "https://b/1"),
    ])
    .unwrap();
    let a = l.shard_bytes().unwrap();
    let b = l.shard_bytes().unwrap();
    assert_eq!(a, b, "同样的台账必须产出同样的字节");
    assert!(!a.contains("\n  "), "必须是紧凑格式，不能是 pretty");
    // 按 key 排序，与 ingest 顺序无关。
    assert!(a.find("BV1").unwrap() < a.find("BV2").unwrap());
  }

  /// claim 是本机当下的事，不是关于内容的事实，不能进分片 ——
  /// 否则一个即将过期的租约在别的机器上会显得还活着。
  #[test]
  fn a_shard_carries_history_but_not_this_machines_claims() {
    let (l, _g) = ledger();
    l.ingest(&[cand("bilibili", "BV1", "https://b/1")]).unwrap();
    let claimed = l
      .claim_next("p1", "bilibili", &ClaimOptions::default())
      .unwrap()
      .unwrap();
    l.prepare_send(&claimed.key, "p1").unwrap();

    let shard = l.shard_bytes().unwrap();
    assert!(!shard.contains("\"claimed_by\":\"p1\""), "claim 不进分片");
    assert!(
      !shard.contains("\"send_started_at\":1"),
      "send_started_at 不进分片"
    );

    l.settle(&claimed.key, "p1", ProspectState::Posted).unwrap();
    let after = l.shard_bytes().unwrap();
    assert!(after.contains("posted"), "但已发生的历史必须在");
    assert!(after.contains("p1"));
  }
}
