//! Marine — the serial discovery scheduler.
//!
//! Drives the shape the operator asked for: **open one profile's browser once →
//! walk its platforms in order, navigating the same single tab → close the
//! browser → next profile**. Everything interesting about this module is a
//! restriction, not a capability.
//!
//! # One browser session per profile, one tab in it
//!
//! Platforms used to get a browser each (launch → work → close → next). They now
//! share one session and switch by navigating. Three things forced that shape,
//! and each of them is a trap if you go back:
//!
//! - Re-launching mid-session goes through `open_url_in_existing_browser`, whose
//!   failure path **falls back to starting a second instance on the same profile
//!   directory**. Two browsers on one account is the only way this system can
//!   genuinely double-comment.
//! - `check_browser_status` is not a query. With zero page targets it *kills the
//!   browser* (zero-window reaper). Session-time probes must be read-only:
//!   `list_page_targets` / `count_page_targets`.
//! - A tab left behind keeps running its own orchestration — claiming targets,
//!   fighting over the active tab, and crediting its late settle to whichever
//!   leg happens to be polling. Hence: navigate to `about:blank` to end a leg,
//!   and sweep down to one tab. Never sweep to zero; Chromium exits with the
//!   last tab and the rest of the session dies with it.
//!
//! There is **no pause between platforms** (operating decision). It used to be
//! 8–25s on anti-correlation grounds, but the cost was concrete: a leg ends by
//! navigating to `about:blank`, so the pause left the browser sitting on a blank
//! page doing nothing — indistinguishable from a hang, and misread as one in
//! practice. The pause between *profiles* stays: switching identity is the more
//! conspicuous transition.
//!
//! # It orchestrates browsers. It does not decide who may comment on what.
//!
//! Every dedup and eligibility decision already lives in
//! [`prospect`](super::prospect), inside the claim critical section. This module
//! must never re-derive any of it — an app-layer `if` that duplicates the
//! ledger's reasoning is exactly how two components drift and an account
//! double-comments. The scheduler's entire contribution is *when a browser is
//! open and pointed at which URL*.
//!
//! Concretely, this module does NOT: pick targets, enforce
//! `per_item_account_cap`, check whether a profile has already touched an item,
//! or decide the terminal state. It launches, waits, and closes.
//!
//! # Serial by design, not by simplicity
//!
//! Running five profiles at once would be faster and would also put five of our
//! accounts on one platform in the same minute from one machine. That
//! correlation is the thing multi-account operation is trying to avoid, so the
//! serialisation is a product requirement rather than an implementation
//! shortcut. The pause between profiles exists for the same reason.
//!
//! # The completion signal is the ledger, not a message from the page
//!
//! A leg is finished when the extension has *settled* something — which appends
//! an [`AccountTouch`](super::prospect::AccountTouch) for that profile. Polling
//! for that is deliberately chosen over a bespoke "I'm done" channel: the touch
//! is the durable fact we already depend on, and anything that reports done
//! without leaving a touch has not actually done the work.
//!
//! Legs that legitimately produce nothing (for example, a profile not logged in
//! or an empty candidate pool) have no ledger touch. The extension records an
//! explicit terminal status for those paths, and the scheduler correlates that
//! status by profile, platform, and leg start time so it can end promptly without
//! confusing a stale log from another leg for this one.
//!
//! # Failure is data
//!
//! A leg that times out or errors is reported and the run moves on. There is no
//! retry: per the operating decision, a failed attempt is recorded rather than
//! hammered at.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use utoipa::ToSchema;

use crate::profile::{BrowserProfile, ProfileManager};

/// How long one platform leg may run before the scheduler gives up on it.
///
/// 上限，不是常规等待时间。
///
/// 实测成功的腿是 **30–68 秒**（B站 33/43s、知乎 30s、小红书 33s、抖音 55/58/68s）
/// —— 它覆盖搜索页就绪后的选靶、打开评论区、流式生成加拟人节奏打字、发送和
/// 回执。冷启动/CDP/导航各自有独立的硬上限，不能挪用业务预算，也不能无限等。
///
/// 真正该省的不是这个数字，而是**没希望的腿别等满**：没登录、候选池空了、
/// 搜索页始终出不来结果 —— 这三种由 [`leg_is_hopeless`] 在几秒内结束，
/// 所以正常运行几乎碰不到这个上限。
const DEFAULT_LEG_TIMEOUT_SECS: u64 = 120;

/// Upper bound on the between-cycle rest, in minutes (7 days).
///
/// The number comes straight from a free-text field, and `minutes * 60` on a
/// `u64` overflows well inside what someone can type by leaning on a key —
/// which panics a debug build. Clamping is friendlier than rejecting: nobody
/// who types nineteen digits wanted a specific interval.
const MAX_CYCLE_GAP_MINUTES: u64 = 7 * 24 * 60;

/// How many cycles in a row may fail before the loop gives up.
///
/// A failing cycle is usually transient (a profile briefly unreadable while it
/// is written, a browser that would not start), so one failure must not end an
/// overnight run. A permanently broken plan — a profile that was deleted — would
/// otherwise retry forever, hence the cap.
const MAX_CONSECUTIVE_CYCLE_FAILURES: u32 = 3;

/// Ledger poll interval while waiting for a leg to settle.
///
/// Each tick re-reads the whole ledger, and a leg lasts minutes, so polling
/// faster buys no responsiveness the operator can perceive and costs a full
/// file parse every time.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Pause range between two profiles.
///
/// There is deliberately no counterpart for platforms: they follow each other
/// immediately within one profile's session. Switching *identity* is the
/// conspicuous transition and the only one worth pausing for.
const PROFILE_PAUSE_SECS: (u64, u64) = (25, 75);

/// 停完页面之后，最多等多久让渲染进程重新应答。
///
/// 上限而不是死等：等不到也要往下走，下一次导航自带超时，最坏只赔一条腿。
const IDLE_WAIT: Duration = Duration::from_secs(20);

/// How long to let a warm-up page settle before jumping to the search URL.
///
/// The point of the warm-up is the session state the platform sets up while its
/// own page loads; navigating away too early defeats it.
const WARMUP_SETTLE: Duration = Duration::from_secs(4);

/// `Page.navigate` being acknowledged does not mean the new document
/// committed.  A lost commit leaves the old renderer responsive and used to
/// make a leg look alive until its full timeout.
const NAVIGATION_COMMAND_WAIT: Duration = Duration::from_secs(10);
const NAVIGATION_COMMIT_WAIT: Duration = Duration::from_secs(12);

/// `Page.navigate` 超过 [`NAVIGATION_COMMAND_WAIT`] 没应答之后，再给这次导航
/// 多少时间「其实已经落地了」。
///
/// 命令没应答**不等于**导航没发生：应答走的是渲染进程，而 `/json` 里的 URL 由
/// 浏览器进程维护 —— 渲染进程卡住时前者不回、后者照常更新。所以超时之后先花很
/// 小一笔钱去看一眼页面到底跳没跳，再决定要不要走「等渲染进程 + 重发」那条
/// 三十多秒的阶梯。
///
/// 故意远小于 [`NAVIGATION_COMMIT_WAIT`]：这里赌的是「已经到了」，没到就该赶紧
/// 去走重试阶梯，而不是在这里再等一轮完整的提交窗口。
const NAVIGATION_LATE_COMMIT_WAIT: Duration = Duration::from_secs(3);

/// How long a freshly committed platform page gets to expose Marine's content
/// script readiness marker before one controlled reload is attempted.
const EXTENSION_READY_WAIT: Duration = Duration::from_secs(12);

/// Grace period after the browser is asked to close, before the next launch.
/// Launching into a profile directory the previous process has not finished
/// releasing is how profile corruption happens.
const CLOSE_SETTLE: Duration = Duration::from_secs(3);

/// Event name carrying [`RunProgress`] to the frontend.
pub const PROGRESS_EVENT: &str = "marine-discovery-progress";

/// One run's plan, as submitted by the UI.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct RunRequest {
  pub keyword: String,
  /// Override for [`DEFAULT_LEG_TIMEOUT_SECS`].
  #[serde(default)]
  pub leg_timeout_secs: Option<u64>,
  /// 两轮之间**歇多久**（分钟）。`None` = 只跑一轮。
  ///
  /// 从上一轮**全部结束**算起，不是从开始算 —— 所以实际周期是「一轮耗时 + 这个
  /// 间隔」，而不是固定的节拍。这样选是因为它在结构上就不可能叠加：等待从全部
  /// 结束之后才开始，两轮永远不会同时在跑。而两轮同时跑等于同一个账号被两个
  /// 浏览器驱动，那是这套系统里唯一能真正造成重复发送的形态。
  #[serde(default)]
  pub cycle_gap_minutes: Option<u64>,
}

/// What happened on one (profile, platform) leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LegOutcome {
  /// The platform confirmed that the comment was published.
  Posted,
  /// The publish action crossed the irreversible-send guard, but no
  /// authoritative platform receipt arrived.
  Unconfirmed,
  /// A draft was filled but was not submitted.
  Filled,
  /// The leg reached its deadline with nothing settled and no explanation.
  ///
  /// 只剩「真的等满了」这一种含义。以前它还兼着「没登录」和「候选池空了」，
  /// 于是 B 站 53 条腿全报 TimedOut、同时又写了 53 行「未登录」—— 两个数字互相
  /// 矛盾，看日志的人只能去查一个根本不存在的卡顿。那两类现在是 [`Self::NoWork`]。
  TimedOut,
  /// 这条腿没活可干：这个平台没登录，或者台账里已经没有该账号能碰的候选了。
  ///
  /// 不是失败，也不是超时 —— 扩展在几秒内就给出了明确结论（实测 B 站 6.1s、
  /// 知乎 4.5s），腿是**提前**结束的。单列出来，`TimedOut` 才重新等于「卡住了」。
  NoWork,
  /// The platform has no search slot (unsupported platform), so there was
  /// nothing to launch. Not an error.
  NoSlot,
  /// The profile was already running, so the leg was skipped rather than
  /// hijacking — and later closing — a window the operator opened themselves.
  AlreadyOpen,
  /// A precondition for running this leg was not met, so nothing was attempted.
  ///
  /// Deliberately separate from `TimedOut`, which already means three different
  /// things (not logged in / nothing eligible left / genuinely stuck). Folding a
  /// fourth in would bury the one outcome the operator can actually act on —
  /// e.g. another device holds this profile's lease, or a cross-device ledger
  /// shard could not be read. `error` carries the reason.
  Skipped,
  /// Launching or closing the browser failed.
  Failed,
  /// The run was cancelled before this leg finished.
  Cancelled,
}

/// A finished leg, kept for the run summary.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LegReport {
  pub profile_id: String,
  pub profile_name: String,
  pub platform: String,
  pub outcome: LegOutcome,
  /// Terminal touches this profile gained during the leg. This is normally one,
  /// but remains a count so an unexpected late/racing settlement is visible.
  pub settled_count: usize,
  #[serde(default)]
  pub error: Option<String>,
}

/// Progress pushed to the frontend as the run advances.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RunProgress {
  pub running: bool,
  /// 1-based index of the leg being worked, out of `total_legs`.
  pub leg_index: usize,
  pub total_legs: usize,
  #[serde(default)]
  pub current_profile_id: Option<String>,
  #[serde(default)]
  pub current_profile_name: Option<String>,
  #[serde(default)]
  pub current_platform: Option<String>,
  /// What the scheduler is doing right now.
  pub phase: RunPhase,
  pub finished: Vec<LegReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
  Idle,
  Launching,
  /// Browser is open; waiting for the extension to settle something.
  Working,
  Closing,
  /// Deliberate pause between legs or profiles.
  Pausing,
  Done,
  Cancelled,
}

/// Live run state. `None` means no run has happened since start-up.
struct SchedulerState {
  progress: Option<RunProgress>,
}

pub struct DiscoveryScheduler {
  state: Mutex<SchedulerState>,
  /// Set while a run is in flight. Also the mutual-exclusion token: a second
  /// run cannot start while this is true, because two runs would launch
  /// browsers on top of each other.
  running: AtomicBool,
  cancel: AtomicBool,
}

impl Default for DiscoveryScheduler {
  fn default() -> Self {
    Self::new()
  }
}

lazy_static::lazy_static! {
  pub static ref SCHEDULER: DiscoveryScheduler = DiscoveryScheduler::new();
}

impl DiscoveryScheduler {
  pub fn new() -> Self {
    Self {
      state: Mutex::new(SchedulerState { progress: None }),
      running: AtomicBool::new(false),
      cancel: AtomicBool::new(false),
    }
  }

  pub fn is_running(&self) -> bool {
    self.running.load(Ordering::SeqCst)
  }

  /// Current progress, or an idle snapshot when nothing has run yet.
  pub fn snapshot(&self) -> RunProgress {
    self
      .state
      .lock()
      .ok()
      .and_then(|s| s.progress.clone())
      .unwrap_or_else(idle_progress)
  }

  /// Ask the in-flight run to stop. The working leg first fences page-side
  /// automation by closing the browser or unloading it to `about:blank`, then
  /// resolves its owned claim to `Skipped`/`Unconfirmed`; the run claim is
  /// released only after that safety cleanup completes.
  pub fn request_cancel(&self) {
    self.cancel.store(true, Ordering::SeqCst);
  }

  fn publish(&self, progress: RunProgress) {
    if let Ok(mut s) = self.state.lock() {
      s.progress = Some(progress.clone());
    }
    if let Err(e) = crate::events::emit(PROGRESS_EVENT, &progress) {
      log::warn!("Failed to emit discovery progress: {e}");
    }
  }

  /// Re-publish the last progress as a finished one, keeping the leg counts and
  /// reports so the operator still sees what the run achieved.
  ///
  /// `running: false` is what unlocks the UI — the page hides Start (and
  /// disables every input) for as long as the last progress it saw says a run
  /// is in flight, and it re-reads that same stored progress on mount, so a
  /// missed terminal publish is not something a refresh can recover from.
  fn publish_terminal(&self) {
    let cancelled = self.cancel.load(Ordering::SeqCst);
    let mut progress = self.snapshot();
    progress.running = false;
    progress.current_profile_id = None;
    progress.current_profile_name = None;
    progress.current_platform = None;
    progress.phase = if cancelled {
      RunPhase::Cancelled
    } else {
      RunPhase::Done
    };
    self.publish(progress);
  }
}

/// Holds the run claim taken in [`run`] and gives it back on drop.
///
/// Releasing the claim and publishing the terminal progress have to be one
/// inseparable step. They used to be two, and only the release was on the exit
/// path shared by every `break`/`?`: stopping during the between-cycle rest left
/// `Pausing { running: true }` as the last thing the frontend ever heard, which
/// hid the Start button for the rest of the process's life. Doing both in `Drop`
/// covers the returns, the `?`s, and a panic inside the run.
struct RunClaim<'a> {
  scheduler: &'a DiscoveryScheduler,
}

impl Drop for RunClaim<'_> {
  fn drop(&mut self) {
    // Release before publishing: the frontend may act on the event the instant
    // it lands, and a Start that arrives between the two would be rejected with
    // `ALREADY_RUNNING` even though the UI had just been told the run was over.
    self.scheduler.running.store(false, Ordering::SeqCst);
    self.scheduler.publish_terminal();
  }
}

fn idle_progress() -> RunProgress {
  RunProgress {
    running: false,
    leg_index: 0,
    total_legs: 0,
    current_profile_id: None,
    current_profile_name: None,
    current_platform: None,
    phase: RunPhase::Idle,
    finished: Vec::new(),
  }
}

/// Whether a touch means "this leg is over".
///
/// Everything except [`Blocked`](super::prospect::ProspectState::Blocked) does.
/// `Blocked` records that the *content* has commenting switched off, after which
/// the extension immediately claims another target and navigates to it — the leg
/// is still very much running. Counting it would end the leg, close the browser,
/// and abort the hop a second after it started, which is precisely the wasted
/// leg the hop exists to avoid.
///
/// When the extension runs out of hops, its explicit `blocked_*` terminal status
/// ends the leg promptly; the intermediate `Blocked` touches remain non-terminal.
fn touch_ends_leg(state: super::prospect::ProspectState) -> bool {
  !matches!(state, super::prospect::ProspectState::Blocked)
}

/// Per-state completion snapshot for one `(profile, platform)` leg.
///
/// A scalar count used to tell us only that *something* reached a terminal
/// ledger state. That made `Failed`, `Filled`, `Skipped`, and `Unconfirmed`
/// indistinguishable from a confirmed post and even cleared the platform's
/// login warning. Keep the same durable ledger signal, but preserve its state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TerminalTouches {
  posted: usize,
  unconfirmed: usize,
  skipped: usize,
  filled: usize,
  failed: usize,
}

impl TerminalTouches {
  fn observe(&mut self, state: super::prospect::ProspectState) {
    use super::prospect::ProspectState;
    match state {
      ProspectState::Posted => self.posted += 1,
      ProspectState::Unconfirmed => self.unconfirmed += 1,
      ProspectState::Skipped => self.skipped += 1,
      ProspectState::Filled => self.filled += 1,
      ProspectState::Failed => self.failed += 1,
      ProspectState::Seen | ProspectState::Claimed | ProspectState::Blocked => {}
    }
  }

  fn total(self) -> usize {
    self.posted + self.unconfirmed + self.skipped + self.filled + self.failed
  }

  fn since(self, baseline: Self) -> Self {
    Self {
      posted: self.posted.saturating_sub(baseline.posted),
      unconfirmed: self.unconfirmed.saturating_sub(baseline.unconfirmed),
      skipped: self.skipped.saturating_sub(baseline.skipped),
      filled: self.filled.saturating_sub(baseline.filled),
      failed: self.failed.saturating_sub(baseline.failed),
    }
  }

  /// One leg is expected to produce one terminal touch. If a race produces
  /// several, prefer public/possibly-public outcomes, then an explicit failure,
  /// so reporting never paints an uncertain or failed send as success.
  fn outcome(self) -> Option<LegOutcome> {
    if self.unconfirmed > 0 {
      Some(LegOutcome::Unconfirmed)
    } else if self.posted > 0 {
      Some(LegOutcome::Posted)
    } else if self.failed > 0 {
      Some(LegOutcome::Failed)
    } else if self.filled > 0 {
      Some(LegOutcome::Filled)
    } else if self.skipped > 0 {
      Some(LegOutcome::Skipped)
    } else {
      None
    }
  }
}

/// Leg-ending touches belonging to `profile_id` across the whole ledger.
///
/// This is the completion signal. Counting touches rather than comparing record
/// states matters: two different items can settle during one leg, and a state
/// comparison would only notice the last one.
///
/// `spawn_blocking` is load-bearing: `list()` reads and parses the whole ledger
/// file, and this runs on a timer for the length of every leg. On the async
/// worker threads that would stall unrelated Tauri work — including the browser
/// launch this same run is about to perform.
///
/// 属于 (profile, platform) 的终态 touch 数。
///
/// **必须按平台过滤**，这是单会话编排引入的要求：一个浏览器连着跑多个平台时，
/// 上一个平台迟到的 settle 会落在下一条腿的观察窗口里。只按 profile 计数的话，
/// 下一条腿会把别人的成果当成自己的 —— 它会立刻「完成」、根本没去发那个平台的
/// 评论，而报表上是一条漂亮的 Settled。每条腿开关一次浏览器的年代没有这个问题，
/// 所以老代码不过滤是对的。
fn summarize_leg_touches(
  records: &[super::prospect::ProspectRecord],
  profile_id: &str,
  platform: &str,
) -> TerminalTouches {
  let mut summary = TerminalTouches::default();
  records
    .iter()
    .filter(|r| r.platform == platform)
    .flat_map(|r| r.touches.iter())
    .filter(|t| t.profile_id == profile_id && touch_ends_leg(t.state))
    .for_each(|touch| summary.observe(touch.state));
  summary
}

async fn read_touch_summary(profile_id: &str, platform: &str) -> Result<TerminalTouches, String> {
  let id = profile_id.to_string();
  let plat = platform.to_string();
  // `list_local`, deliberately: this counts *our* progress on the leg that is
  // running right now. A touch that arrived over sync belongs to another
  // machine's work, and counting it would end this leg without a comment having
  // been posted here — the same shape of bug the platform filter above fixes.
  let counted = tokio::task::spawn_blocking(move || {
    super::prospect::PROSPECTS
      .list_local()
      .map(|records| summarize_leg_touches(&records, &id, &plat))
  })
  .await;

  counted
    .map_err(|e| format!("prospect ledger read task failed: {e}"))?
    .map_err(|e| format!("could not read the prospect ledger: {e}"))
}

async fn initial_touch_summary(
  profile_id: &str,
  platform: &str,
) -> Result<TerminalTouches, String> {
  let mut last_error = "prospect ledger was not read".to_string();
  for delay in [
    Duration::ZERO,
    Duration::from_millis(100),
    Duration::from_millis(300),
  ] {
    if !delay.is_zero() {
      tokio::time::sleep(delay).await;
    }
    match read_touch_summary(profile_id, platform).await {
      Ok(count) => return Ok(count),
      Err(error) => last_error = error,
    }
  }
  Err(last_error)
}

/// Whether this leg reached any ledger work before its search-page bootstrap
/// failed. A browser restart is safe only while this is false: once an ingest,
/// claim, send guard, or terminal touch exists, retrying the same leg could
/// overlap the extension's durable handoff.
fn leg_has_activity_since(
  records: &[super::prospect::ProspectRecord],
  profile_id: &str,
  platform: &str,
  since: u64,
) -> bool {
  records
    .iter()
    .filter(|record| record.platform == platform)
    .any(|record| {
      // `resolved_at` is refreshed by ingest, including for an existing item.
      record.resolved_at >= since
        || (record.claimed_by.as_deref() == Some(profile_id)
          && record.claimed_at.is_some_and(|at| at >= since))
        || record
          .touches
          .iter()
          .any(|touch| touch.profile_id == profile_id && touch.at >= since)
    })
}

async fn bootstrap_retry_is_safe(profile_id: &str, platform: &str, since: u64) -> bool {
  let id = profile_id.to_string();
  let plat = platform.to_string();
  match tokio::task::spawn_blocking(move || {
    super::prospect::PROSPECTS
      .list_local()
      .map(|records| !leg_has_activity_since(&records, &id, &plat, since))
  })
  .await
  {
    Ok(Ok(safe)) => safe,
    Ok(Err(error)) => {
      log::warn!("Discovery could not verify whether bootstrap retry is safe: {error}");
      false
    }
    Err(error) => {
      log::warn!("Discovery bootstrap retry ledger task failed: {error}");
      false
    }
  }
}

fn pause_secs(range: (u64, u64)) -> u64 {
  use rand::RngExt as _;
  // Scoped so the non-`Send` ThreadRng is dropped before any await.
  let mut rng = rand::rng();
  rng.random_range(range.0..=range.1)
}

/// Engines the discovery pipeline can actually run in.
///
/// Not a capability check — a hard fact about where the code lives. The whole
/// discovery pipeline is the Marine MV3 extension, and
/// [`extension::ensure_for_profile`](super::extension) is only invoked on the
/// Wayfern launch path. A Camoufox (Firefox) profile launches without the
/// extension, so nothing ever ingests, claims or settles: the leg would sit out
/// its entire timeout and report "nothing settled" — indistinguishable from
/// "not logged in". Refusing up front turns a silent 4-minute stall into a
/// visible skip.
const DISCOVERY_ENGINES: [&str; 1] = ["wayfern"];

pub fn engine_supports_discovery(browser: &str) -> bool {
  DISCOVERY_ENGINES.contains(&browser)
}

/// Reject a plan the run could never carry out — before anything is spawned.
///
/// `marine_start_discovery` returns the moment the run is accepted, so whatever
/// is checked only *inside* the run reaches the operator as a log line and
/// nothing else: they press Start, get no toast, and no run happens. Resolving
/// the profiles is one directory read, cheap enough to do on the command's own
/// thread and get a translated error back out of the `invoke`.
pub fn validate_plan(request: &RunRequest) -> Result<(), String> {
  if request.keyword.trim().is_empty() {
    return Err(super::err("MARINE_DISCOVERY_EMPTY_KEYWORD"));
  }
  if resolve_profiles()?.is_empty() {
    return Err(super::err("MARINE_DISCOVERY_EMPTY_PLAN"));
  }
  Ok(())
}

/// One profile's independently configured slice of a run.
#[derive(Debug, Clone)]
struct ResolvedProfile {
  account_index: usize,
  profile: BrowserProfile,
  platforms: Vec<String>,
}

/// Resolve enabled profiles and pair each with its **stable** account index.
///
/// A profile participates only when its `marine_platforms` contains at least
/// one supported platform. Platform values are projected through the canonical
/// supported-platform list, which simultaneously filters unknown values,
/// deduplicates repeats, and gives every profile the same deterministic order.
///
/// The account index must not come from the enabled subset. Two things would
/// break if it did, and both were observed:
///
/// * `list_profiles()` returns raw `read_dir` order, which is not sorted and not
///   stable across machines or file operations.
/// * Enabling or disabling another profile would change a profile's position —
///   and therefore its search sort — if the index came from the enabled subset.
///
/// Either one defeats the point of slots: `search_slot` assigns a sort by
/// `account_index` precisely so one account keeps one browsing habit run after
/// run. An account that sorts by "most played" one day and "newest" the next
/// looks *less* like a person, not more.
///
/// So the index is this profile's position among **all** discovery-capable
/// profiles sorted by id — independent of platform configuration and directory
/// order.
fn resolve_profiles() -> Result<Vec<ResolvedProfile>, String> {
  let all = ProfileManager::instance().list_profiles().map_err(|e| {
    log::error!("Discovery could not list profiles: {e}");
    super::err("MARINE_DISCOVERY_PROFILE_NOT_FOUND")
  })?;
  Ok(resolve_from(&all))
}

/// The part of [`resolve_profiles`] that does not touch the filesystem.
fn resolve_from(all: &[BrowserProfile]) -> Vec<ResolvedProfile> {
  let mut universe: Vec<BrowserProfile> = all
    .iter()
    .filter(|p| engine_supports_discovery(&p.browser))
    .cloned()
    .collect();
  universe.sort_by_key(|profile| profile.id);

  universe
    .into_iter()
    .enumerate()
    .filter_map(|(account_index, profile)| {
      let platforms: Vec<String> = super::prospect::SUPPORTED_PLATFORMS
        .iter()
        .filter(|supported| {
          profile
            .marine_platforms
            .iter()
            .any(|configured| configured == *supported)
        })
        .map(|platform| (*platform).to_string())
        .collect();
      (!platforms.is_empty()).then_some(ResolvedProfile {
        account_index,
        profile,
        platforms,
      })
    })
    .collect()
}

fn total_legs(profiles: &[ResolvedProfile]) -> usize {
  profiles
    .iter()
    .map(|resolved| resolved.platforms.len())
    .sum()
}

fn report_for(
  profile: &BrowserProfile,
  platform: &str,
  outcome: LegOutcome,
  error: Option<String>,
) -> LegReport {
  LegReport {
    profile_id: profile.id.to_string(),
    profile_name: profile.name.clone(),
    platform: platform.to_string(),
    outcome,
    settled_count: 0,
    error,
  }
}

fn append_report_error(report: &mut LegReport, error: impl Into<String>) {
  let error = error.into();
  report.error = Some(match report.error.take() {
    Some(existing) if !existing.is_empty() => format!("{existing}; {error}"),
    _ => error,
  });
}

/// Materialise the unvisited tail of a plan when Stop is pressed.
///
/// `total_legs` is the full profile/platform plan. Leaving cancelled legs out
/// made a 3-platform profile finish as "0/2" and made progress disagree with
/// the plan shown at start. Explicit reports also tell the operator which work
/// was deliberately not attempted.
fn append_cancelled_profiles(profiles: &[ResolvedProfile], finished: &mut Vec<LegReport>) {
  let mut legs = 0usize;
  for resolved in profiles {
    for platform in &resolved.platforms {
      legs += 1;
      finished.push(report_for(
        &resolved.profile,
        platform,
        LegOutcome::Cancelled,
        None,
      ));
    }
  }
  if legs == 0 {
    return;
  }
  // 停止是人按的，但「按下去的那一刻还剩多少没跑」只有这里知道。少了这行，
  // 周期汇总里那一堆 Cancelled 在日志上没有出处，会被当成程序自己放弃的。
  log::info!(
    "Discovery: 收到停止，放弃剩余 {} 个 profile 的 {legs} 条腿 —— {}",
    profiles.len(),
    profiles
      .iter()
      .map(|p| p.profile.name.as_str())
      .collect::<Vec<_>>()
      .join("，"),
  );
}

/// Sleep, but notice a cancel request while doing it.
///
/// The pauses between legs and profiles are up to 75 s. A plain `sleep` makes
/// Stop look broken for that whole window, because the flag is only read before
/// the sleep begins.
async fn interruptible_pause(scheduler: &DiscoveryScheduler, total: Duration) {
  const SLICE: Duration = Duration::from_millis(500);
  let deadline = tokio::time::Instant::now() + total;
  while tokio::time::Instant::now() < deadline {
    if scheduler.cancel.load(Ordering::SeqCst) {
      return;
    }
    tokio::time::sleep(SLICE.min(deadline - tokio::time::Instant::now())).await;
  }
}

/// Run the whole plan. Returns when every leg has been attempted or the run was
/// cancelled.
///
/// The caller is expected to spawn this; it is long-running by nature.
pub async fn run(
  app_handle: tauri::AppHandle,
  request: RunRequest,
) -> Result<Vec<LegReport>, String> {
  let scheduler = &*SCHEDULER;

  // `compare_exchange` rather than `is_running() { return }` — the check and the
  // claim have to be one step, or two clicks land two runs.
  if scheduler
    .running
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_err()
  {
    return Err(super::err("MARINE_DISCOVERY_ALREADY_RUNNING"));
  }
  scheduler.cancel.store(false, Ordering::SeqCst);

  // From here on every exit publishes a terminal progress and gives the claim
  // back — see `RunClaim`.
  let _claim = RunClaim { scheduler };
  run_cycles(app_handle, request, scheduler).await
}

/// 一轮接一轮地跑，直到被取消。没有设间隔就只跑一轮。
///
/// 节奏是「跑完 → 歇 `cycle_gap_minutes` → 再跑」。等待从**全部结束**之后才开始，
/// 所以两轮在结构上不可能重叠 —— 不需要任何「上一轮没跑完就跳过」的补丁。
///
/// 返回**最后一轮**的报告：`RunProgress` 的 `finished` 每轮重置，累计几十轮的腿
/// 报告只会把界面淹掉，而每轮真正的成果已经落在台账和发布历史里了。
async fn run_cycles(
  app_handle: tauri::AppHandle,
  request: RunRequest,
  scheduler: &DiscoveryScheduler,
) -> Result<Vec<LegReport>, String> {
  let Some(gap) = cycle_gap(request.cycle_gap_minutes) else {
    return run_inner(app_handle, request, scheduler).await;
  };

  let mut last = Vec::new();
  let mut cycle = 0u64;
  let mut failures = 0u32;
  loop {
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    cycle += 1;
    let started = tokio::time::Instant::now();
    log::info!("Discovery cycle {cycle} starting");

    // 一轮跑挂了只是这一轮的事。以前这里是 `?`：夜里第二轮撞上一个正被改写的
    // profile，整晚剩下的轮次就全没了，而且界面永远停在上一次发布的
    // `Pausing { running: true }` 上。
    match run_inner(app_handle.clone(), request.clone(), scheduler).await {
      Ok(reports) => {
        last = reports;
        let posted = last
          .iter()
          .filter(|l| l.outcome == LegOutcome::Posted)
          .count();
        // 「7/20」这种写法骗过人一次：分母是**计划**的腿数，而其中一部分根本没跑
        // （profile 被租约占住、浏览器被操作员开着、没有搜索位……）。上一轮实测有
        // 57 条腿从未执行却被算进分母，于是 0/20 看着像全线崩溃，实际是压根没开工。
        //
        // 现在把分母拆开：真正尝试过的有多少、没开工的有多少，再按结局逐项列出。
        // 一行看完这一轮的钱花在哪了。
        let never_ran = last
          .iter()
          .filter(|l| {
            matches!(
              l.outcome,
              LegOutcome::AlreadyOpen | LegOutcome::Skipped | LegOutcome::Cancelled
            )
          })
          .count();
        let attempted = last.len().saturating_sub(never_ran);
        let breakdown = {
          let mut counts: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
          for leg in &last {
            *counts.entry(format!("{:?}", leg.outcome)).or_insert(0) += 1;
          }
          counts
            .iter()
            .map(|(k, n)| format!("{k}×{n}"))
            .collect::<Vec<_>>()
            .join("，")
        };
        let cancelled = scheduler.cancel.load(Ordering::SeqCst);
        let total_failure = cycle_is_total_failure(&last);
        failures = next_cycle_failure_count(failures, &last, cancelled);
        if cancelled {
          log::info!(
            "Discovery cycle {cycle} cancelled after {}s（发布 {posted}，尝试 {attempted}，未开工 {never_ran}，计划 {}）：{breakdown}",
            started.elapsed().as_secs(),
            last.len(),
          );
        } else if total_failure {
          log::error!(
            "Discovery cycle {cycle} produced only failed legs ({failures}/{MAX_CONSECUTIVE_CYCLE_FAILURES})（尝试 {attempted}，未开工 {never_ran}）：{breakdown}"
          );
          if failures >= MAX_CONSECUTIVE_CYCLE_FAILURES {
            return Err(format!(
              "all discovery legs failed for {failures} consecutive cycles"
            ));
          }
        } else {
          log::info!(
            "Discovery cycle {cycle} finished in {}s（发布 {posted}，尝试 {attempted}，未开工 {never_ran}，计划 {}）：{breakdown}；resting {} min",
            started.elapsed().as_secs(),
            last.len(),
            gap.as_secs() / 60,
          );
        }
      }
      Err(e) => {
        failures += 1;
        log::error!(
          "Discovery cycle {cycle} failed ({failures}/{MAX_CONSECUTIVE_CYCLE_FAILURES}): {e}"
        );
        if failures >= MAX_CONSECUTIVE_CYCLE_FAILURES {
          return Err(e);
        }
      }
    }

    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    let done = last.len();
    publish_phase(scheduler, RunPhase::Pausing, done, done, None, None, &last);
    // 可打断：取消不该等到歇完才生效。
    if !sleep_or_cancel(scheduler, gap).await {
      break;
    }
  }
  Ok(last)
}

/// A successfully-returned cycle can still be an operational failure: browser
/// and bootstrap errors are deliberately represented as per-leg data, so
/// `run_inner` returns `Ok` even when every leg failed. Count that shape toward
/// the same bounded retry budget as an `Err`, otherwise a broken overnight run
/// loops forever. Empty/cancelled/normal no-work cycles are not failures.
fn cycle_is_total_failure(reports: &[LegReport]) -> bool {
  !reports.is_empty()
    && reports
      .iter()
      .all(|report| report.outcome == LegOutcome::Failed)
}

fn next_cycle_failure_count(previous: u32, reports: &[LegReport], cancelled: bool) -> u32 {
  if !cancelled && cycle_is_total_failure(reports) {
    previous.saturating_add(1)
  } else {
    0
  }
}

/// 把「每轮之间歇几分钟」变成一个时长。`None` / `0` 表示只跑一轮。
///
/// 钳到 [`MAX_CYCLE_GAP_MINUTES`]：分钟数直接来自一个自由输入框，而 `m * 60`
/// 在 `u64` 上溢出所需的位数，按住数字键就能打出来 —— debug 构建会当场 panic。
fn cycle_gap(minutes: Option<u64>) -> Option<Duration> {
  minutes
    .filter(|m| *m > 0)
    .map(|m| Duration::from_secs(m.min(MAX_CYCLE_GAP_MINUTES) * 60))
}

/// 睡 `how_long`，被取消就提前返回 `false`。
async fn sleep_or_cancel(scheduler: &DiscoveryScheduler, how_long: Duration) -> bool {
  let deadline = tokio::time::Instant::now() + how_long;
  while tokio::time::Instant::now() < deadline {
    if scheduler.cancel.load(Ordering::SeqCst) {
      return false;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
  }
  !scheduler.cancel.load(Ordering::SeqCst)
}

async fn run_inner(
  app_handle: tauri::AppHandle,
  request: RunRequest,
  scheduler: &DiscoveryScheduler,
) -> Result<Vec<LegReport>, String> {
  let profiles = resolve_profiles()?;
  if profiles.is_empty() {
    return Err(super::err("MARINE_DISCOVERY_EMPTY_PLAN"));
  }
  if request.keyword.trim().is_empty() {
    return Err(super::err("MARINE_DISCOVERY_EMPTY_KEYWORD"));
  }

  let leg_timeout = Duration::from_secs(
    request
      .leg_timeout_secs
      .filter(|s| *s > 0)
      .unwrap_or(DEFAULT_LEG_TIMEOUT_SECS),
  );
  let total_legs = total_legs(&profiles);

  // 把这一轮**实际要跑什么**写下来。
  //
  // 此前完全没人记录解析后的计划，于是「B 站整段日志里一条腿都没有」这种事无从
  // 解释：是它被从 marine_platforms 里去掉了、还是引擎不支持、还是根本没进计划？
  // 三者的下一步完全不同，而日志里都长成「没有 bilibili」。
  //
  // 一轮一行，成本可以忽略，但它是所有「为什么少了/多了」问题的第一站。
  log::info!(
    "Discovery plan: 关键词「{}」，{} 个 profile / {total_legs} 条腿 —— {}",
    request.keyword.trim(),
    profiles.len(),
    profiles
      .iter()
      .map(|p| format!("{}[{}]", p.profile.name, p.platforms.join("+")))
      .collect::<Vec<_>>()
      .join("，"),
  );
  // 指路。排查一条腿几乎总要用到**页面内视角**那份 JSONL，而它躺在 data 目录
  // 而不是 log 目录 —— 猜是猜不到的。把绝对路径印在每轮开头，谁拿到 Marine.log
  // 谁就知道另一半证据在哪，不用再回来问。
  log::info!(
    "Discovery plan: 页面内日志 → {}",
    crate::marine::debug_log::DEBUG_LOG.file_path().display(),
  );

  let mut finished: Vec<LegReport> = Vec::with_capacity(total_legs);
  let mut leg_index = 0usize;

  let last_profile = profiles.len() - 1;

  for (profile_position, resolved) in profiles.iter().enumerate() {
    if scheduler.cancel.load(Ordering::SeqCst) {
      append_cancelled_profiles(&profiles[profile_position..], &mut finished);
      leg_index = finished.len();
      break;
    }

    // 一个 profile = 一个浏览器会话，只跑这个 profile 自己配置的平台。
    let keep_going = run_profile_session(
      &app_handle,
      scheduler,
      &resolved.profile,
      &resolved.platforms,
      &request.keyword,
      resolved.account_index,
      leg_timeout,
      leg_index,
      total_legs,
      &mut finished,
    )
    .await;
    leg_index = finished.len();
    if !keep_going {
      append_cancelled_profiles(&profiles[profile_position + 1..], &mut finished);
      leg_index = finished.len();
      break;
    }

    if profile_position < last_profile && !scheduler.cancel.load(Ordering::SeqCst) {
      publish_phase(
        scheduler,
        RunPhase::Pausing,
        leg_index,
        total_legs,
        None,
        None,
        &finished,
      );
      interruptible_pause(
        scheduler,
        Duration::from_secs(pause_secs(PROFILE_PAUSE_SECS)),
      )
      .await;
    }
  }

  let cancelled = scheduler.cancel.load(Ordering::SeqCst);
  // Keep the run claim visible until `RunClaim::drop` releases the atomic flag.
  // Publishing `running: false` here made recurring runs briefly show an enabled
  // Start button between Done and Pausing; clicking it could only produce
  // ALREADY_RUNNING because the claim was still held.
  publish_phase(
    scheduler,
    if cancelled {
      RunPhase::Cancelled
    } else {
      RunPhase::Done
    },
    leg_index,
    total_legs,
    None,
    None,
    &finished,
  );
  Ok(finished)
}

/// 操作员是不是已经开着这个 profile 的浏览器。
///
/// 是的话整个 profile 都跳过，一个字节都不碰它。`launch_browser_profile` 在
/// profile 已在运行时**不会**起新实例 —— 它会把 URL 作为标签页开进那个活着的
/// 窗口，并把**已存在的**进程记录交回来。编排结束时按那份记录关浏览器，就把
/// 操作员正在做的事（多半是手动登录，那正是他开着窗口的理由）一起关掉了。
///
/// 「判断不了」按「被占用」处理：这个方向判错的代价是白跳过一轮，
/// 反方向判错的代价是毁掉操作员的窗口。
///
/// **每个 profile 只跑一次，且只在会话冷启动之前跑。**单会话编排下，第二条腿
/// 之后浏览器正是我们自己开的，再问一次必然答「已在运行」，后续平台会全部
/// 跳过；而且 `check_browser_status` 并不是只读的 —— 页签数为零时它会**杀掉
/// 浏览器**（零窗口收割），会话中途调用等于自己给自己埋雷。
async fn profile_is_occupied(
  app_handle: &tauri::AppHandle,
  profile: &BrowserProfile,
) -> Option<Option<String>> {
  match crate::browser_runner::BrowserRunner::instance()
    .check_browser_status(app_handle.clone(), profile)
    .await
  {
    Ok(true) => {
      log::warn!(
        "Discovery: profile {} is already running — skipping so its window is not closed",
        profile.name
      );
      Some(None)
    }
    Ok(false) => None,
    Err(e) => {
      log::warn!(
        "Discovery could not determine whether profile {} is running ({e}) — skipping",
        profile.name
      );
      Some(Some(e.to_string()))
    }
  }
}

/// 一个 profile 的完整会话：开一次浏览器，依次跑完所有平台，再关掉。
///
/// 返回 `false` 表示收到了取消请求，外层应该停止后续 profile。
#[allow(clippy::too_many_arguments)]
async fn run_profile_session(
  app_handle: &tauri::AppHandle,
  scheduler: &DiscoveryScheduler,
  profile: &BrowserProfile,
  platforms: &[String],
  keyword: &str,
  account_index: usize,
  leg_timeout: Duration,
  leg_base_index: usize,
  total_legs: usize,
  finished: &mut Vec<LegReport>,
) -> bool {
  let base = |platform: &str, outcome: LegOutcome, error: Option<String>| {
    report_for(profile, platform, outcome, error)
  };

  // 另一台设备正握着这个 profile 的租约 —— 不要碰它。
  //
  // 两台机器同时驱动同一个账号，是这套系统里唯一能真正造成重复发送的形态：
  // 台账的账号级闸门只看得见本机磁盘上那一份，对端的 touch 还没同步过来时它是
  // 瞎的。这里挡掉，比事后合并有意义 —— 已经公开的评论没有任何合并能撤销。
  if crate::team_lock::PROFILE_LOCK
    .is_locked_by_another(&profile.id.to_string())
    .await
  {
    let reason = "another device holds this profile's lease".to_string();
    log::warn!("Skipping {} — {reason}", profile.name);
    for platform in platforms {
      finished.push(base(platform, LegOutcome::Skipped, Some(reason.clone())));
    }
    // 整批放弃必须出声。这里一次跳掉这个 profile 的**全部**平台，而在此之前一行
    // 日志都没有 —— 于是「这个号这一轮怎么一条腿都没跑」在 Marine.log 里查不到，
    // 而周期汇总还把它们算进分母，0/20 因此虚高。
    log::warn!(
      "Discovery: 跳过 profile {} 的全部 {} 个平台 —— {reason}",
      profile.name,
      platforms.len(),
    );
    return !scheduler.cancel.load(Ordering::SeqCst);
  }

  // 会话级：只问一次「操作员是不是已经开着这个 profile」。
  if let Some(err) = profile_is_occupied(app_handle, profile).await {
    // 每个平台都要有一条报告，否则前端的 leg_index/total_legs 对不上 ——
    // total_legs 是按每个 profile 各自的平台数之和预先算好的。
    for platform in platforms {
      finished.push(base(platform, LegOutcome::AlreadyOpen, err.clone()));
    }
    // 同上：操作员自己开着这个 profile 时，整批腿被记成 AlreadyOpen 却零日志。
    log::warn!(
      "Discovery: profile {} 的全部 {} 个平台跳过 —— 浏览器已被占用：{}",
      profile.name,
      platforms.len(),
      err.clone().unwrap_or_else(|| "未知原因".to_string()),
    );
    return !scheduler.cancel.load(Ordering::SeqCst);
  }

  let mut session: Option<BrowserProfile> = None;
  let mut driven_tab: Option<String> = None;
  // 会话失效重开一次的预算。**不是腿失败的重试** —— 那条运营决定没变（失败只
  // 记录、不重试）。这管的是「浏览器整个没了」：不给预算的话，一次意外会让
  // 后面三个平台全部静默不执行；给一次，最坏也只是退化回「每平台重开一次」，
  // 也就是今天的行为。
  let mut restarts_left: u8 = 1;
  let mut cancelled = false;
  // If cancellation could not initially fence the page, keep enough context
  // to settle its claim after a later close attempt succeeds. The report index
  // lets the final profile close replace the provisional Failed result.
  let mut pending_cancel_cleanup: Option<(usize, PendingCancelledCleanup)> = None;

  let mut platform_index = 0usize;
  while platform_index < platforms.len() {
    let platform = &platforms[platform_index];
    let leg_index = leg_base_index + platform_index + 1;

    if scheduler.cancel.load(Ordering::SeqCst) {
      log::info!(
        "Discovery: 停止到达，profile {} 剩余 {} 个平台不再开工：{}",
        profile.name,
        platforms.len() - platform_index,
        platforms[platform_index..].join("+"),
      );
      for rest in &platforms[platform_index..] {
        finished.push(base(rest, LegOutcome::Cancelled, None));
      }
      cancelled = true;
      break;
    }

    // 会话还在不在？只用只读探针。
    if session.is_some() && !session_alive(profile).await {
      log::warn!(
        "Discovery: browser session for profile {} is gone",
        profile.name
      );
      if let Err(close_error) =
        retire_owned_session(app_handle, &mut session, &mut driven_tab).await
      {
        let reason = format!(
          "lost session could not be retired safely; remaining platforms were not launched: {close_error}"
        );
        log::error!("Discovery {}: {reason}", profile.name);
        for rest in &platforms[platform_index..] {
          finished.push(base(rest, LegOutcome::Failed, Some(reason.clone())));
        }
        // One last best effort is allowed, but failure must never transition
        // this profile back to `session = None` and launch a second process.
        let _ = retire_owned_session(app_handle, &mut session, &mut driven_tab).await;
        return !scheduler.cancel.load(Ordering::SeqCst);
      }
      if restarts_left == 0 {
        let stopping = scheduler.cancel.load(Ordering::SeqCst);
        // 重启额度用光是这条 profile 当轮的死因，而且它发生在 run_leg 之前 ——
        // 没有这行，剩下那几条腿在日志里根本不存在，只在汇总的计数里冒出来。
        log::warn!(
          "Discovery: profile {} 的会话连丢两次，重启额度用尽，剩余 {} 个平台放弃：{}",
          profile.name,
          platforms.len() - platform_index,
          platforms[platform_index..].join("+"),
        );
        for rest in &platforms[platform_index..] {
          finished.push(base(
            rest,
            if stopping {
              LegOutcome::Cancelled
            } else {
              LegOutcome::Failed
            },
            (!stopping).then(|| "session lost twice".to_string()),
          ));
        }
        return !scheduler.cancel.load(Ordering::SeqCst);
      }
      restarts_left -= 1;
    }

    // Stop can arrive while the liveness probe or a previous-session close is
    // awaiting I/O.  Re-check at the last boundary before `run_leg`: otherwise
    // this iteration can cold-launch and navigate a profile *after* Stop was
    // accepted, even though the loop-top check ran earlier.
    if scheduler.cancel.load(Ordering::SeqCst) {
      log::info!(
        "Discovery: 停止在开工前一刻到达，profile {} 剩余 {} 个平台不再开工：{}",
        profile.name,
        platforms.len() - platform_index,
        platforms[platform_index..].join("+"),
      );
      for rest in &platforms[platform_index..] {
        finished.push(base(rest, LegOutcome::Cancelled, None));
      }
      cancelled = true;
      break;
    }

    let mut execution = run_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      keyword,
      account_index,
      leg_timeout,
      leg_index,
      total_legs,
      finished,
      &mut session,
      &mut driven_tab,
    )
    .await;

    // A freshly installed/upgraded MV3 worker can miss registration on the
    // first browser cold start. A page reload cannot register a missing worker,
    // but a clean browser restart does. This is the sole same-leg retry: it is
    // offered only by the search-page bootstrap path after proving that the
    // extension did not ingest, claim, or settle anything, and it consumes the
    // profile's one session-restart budget. Business failures with a terminal
    // touch are never retried.
    if should_retry_on_fresh_session(
      &execution,
      restarts_left,
      scheduler.cancel.load(Ordering::SeqCst),
    ) {
      log::warn!(
        "Discovery: restarting profile {} and retrying the same {platform} leg after a pre-work extension bootstrap failure",
        profile.name
      );
      match retire_owned_session(app_handle, &mut session, &mut driven_tab).await {
        Ok(()) if !scheduler.cancel.load(Ordering::SeqCst) => {
          restarts_left -= 1;
          continue;
        }
        Ok(()) => {
          finished.push(execution.report);
          for rest in &platforms[platform_index + 1..] {
            finished.push(base(rest, LegOutcome::Cancelled, None));
          }
          return false;
        }
        Err(close_error) => {
          let reason = format!(
            "bootstrap session could not be retired safely; retry and remaining platforms were aborted: {close_error}"
          );
          append_report_error(&mut execution.report, reason.clone());
          finished.push(execution.report);
          for rest in &platforms[platform_index + 1..] {
            finished.push(base(rest, LegOutcome::Failed, Some(reason.clone())));
          }
          // Preserve ownership for one last close attempt, but never cold-start
          // another browser into this profile after a failed kill.
          let _ = retire_owned_session(app_handle, &mut session, &mut driven_tab).await;
          return !scheduler.cancel.load(Ordering::SeqCst);
        }
      }
    }

    let session_unusable = execution.session_unusable;
    let session_poisoned = execution.session_poisoned;

    // A CDP page target can survive while its renderer/navigation channel is
    // wedged.  `session_alive` intentionally treats that as alive because it
    // is only a cheap occupancy probe; `run_leg` has stronger evidence from
    // bounded navigation/readiness/parking operations.  Retire that poisoned
    // session now so it cannot make every remaining platform spend another
    // minute failing against the same visible-but-dead window.
    let mut retire_error: Option<String> = None;
    if session_unusable {
      log::warn!(
        "Discovery: retiring unusable browser session for profile {} after {platform}",
        profile.name
      );
      match retire_owned_session(app_handle, &mut session, &mut driven_tab).await {
        Ok(()) => {
          if let Some(pending) = execution.pending_cancel_cleanup.take() {
            complete_pending_cancel_cleanup(profile, platform, pending, &mut execution.report)
              .await;
          }
        }
        Err(error) => {
          let reason = format!(
            "unusable session could not be retired safely; remaining platforms were not launched: {error}"
          );
          append_report_error(&mut execution.report, reason.clone());
          retire_error = Some(reason);
        }
      }
    }

    let pending = execution.pending_cancel_cleanup.take();
    let report_index = finished.len();
    finished.push(execution.report);

    if let Some(reason) = retire_error {
      if let Some(pending) = pending {
        pending_cancel_cleanup = Some((report_index, pending));
      }
      for rest in &platforms[platform_index + 1..] {
        finished.push(base(rest, LegOutcome::Failed, Some(reason.clone())));
      }
      cancelled = scheduler.cancel.load(Ordering::SeqCst);
      break;
    }

    debug_assert!(
      pending.is_none(),
      "pending claim cleanup requires a failed session retirement"
    );

    // 只有中毒才计入预算。一条只是 park 失败的腿已经退役了会话，下一条腿会冷启动
    // 一个干净的浏览器 —— 那是安全路径（走 retire_owned_session 先关干净，不是
    // `open_url_in_existing_browser` 那条可能开出第二个实例的路），代价只是慢。
    // 让它消耗预算，等于让「发布成功」这件事去害死后面的平台。
    if consumes_session_restart(
      session_poisoned,
      platforms.len() - (platform_index + 1),
      scheduler.cancel.load(Ordering::SeqCst),
    ) {
      if restarts_left == 0 {
        for rest in &platforms[platform_index + 1..] {
          finished.push(base(
            rest,
            LegOutcome::Failed,
            Some("session became unusable twice".to_string()),
          ));
        }
        return true;
      }
      restarts_left -= 1;
    }

    platform_index += 1;

    // 平台之间不停顿（运营决定）。
    //
    // 曾经停 8~25 秒，理由是「同一账号短时间连发多个平台」是可识别的节奏。
    // 但代价是实打实的：腿一结束页面就被导航到 about:blank，停顿期间浏览器就
    // 是一个空白页干等 —— 从外面看和卡死完全一样，实际观察中被误判过。
    // 账号之间的停顿保留（换身份是更显眼的转换，见 PROFILE_PAUSE_SECS）。
  }

  publish_phase(
    scheduler,
    RunPhase::Closing,
    finished.len().min(total_legs),
    total_legs,
    Some(profile),
    None,
    finished,
  );
  match retire_owned_session(app_handle, &mut session, &mut driven_tab).await {
    Ok(()) => {
      if let Some((report_index, pending)) = pending_cancel_cleanup.take() {
        let platform = finished[report_index].platform.clone();
        let mut report = finished[report_index].clone();
        complete_pending_cancel_cleanup(profile, &platform, pending, &mut report).await;
        finished[report_index] = report;
        // These rows were provisionally Failed only because the first close
        // could not prove the page was fenced. Once final shutdown succeeds,
        // they are ordinary unvisited work from an operator-cancelled run.
        if scheduler.cancel.load(Ordering::SeqCst) {
          for tail in &mut finished[report_index + 1..] {
            if tail.profile_id == profile.id.to_string()
              && tail.settled_count == 0
              && tail.outcome == LegOutcome::Failed
            {
              tail.outcome = LegOutcome::Cancelled;
              tail.error = None;
            }
          }
        }
      }
    }
    Err(error) => {
      log::error!(
        "Discovery could not release the final browser session for {}: {error}",
        profile.name
      );
      if let Some((report_index, _)) = pending_cancel_cleanup {
        append_report_error(
          &mut finished[report_index],
          format!("final browser shutdown also failed: {error}"),
        );
      } else if let Some(report) = finished
        .iter_mut()
        .rev()
        .find(|report| report.profile_id == profile.id.to_string())
      {
        append_report_error(report, format!("final browser shutdown failed: {error}"));
        if report.settled_count == 0 {
          report.outcome = LegOutcome::Failed;
        }
      }
    }
  }
  !cancelled && !scheduler.cancel.load(Ordering::SeqCst)
}

/// 会话还活着吗。全部用**只读**探针。
///
/// `None`（判断不了）按「还活着」处理：把一次 CDP 抖动判成会话失效，代价是
/// 白重启一次浏览器；反过来轻信则会在浏览器还好好的时候去 kill 它。
async fn session_alive(profile: &BrowserProfile) -> bool {
  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  match wayfern.list_page_targets(&path).await {
    // 页签被关光 = 用户把窗口关了。不抢救：抢在收割器前面开一个空白页是竞态，
    // 而且会和「用户想关掉它」直接打架。
    Some(t) => !t.is_empty(),
    None => {
      tokio::time::sleep(Duration::from_secs(1)).await;
      wayfern
        .list_page_targets(&path)
        .await
        .map(|t| !t.is_empty())
        .unwrap_or(true)
    }
  }
}

/// 关掉会话的浏览器。用 launch 返回的那份记录 —— 它带着这次启动真正产生的 pid，
/// 用启动前的副本会去杀一个早于本次会话的进程号。
async fn close_session(
  app_handle: &tauri::AppHandle,
  session: Option<BrowserProfile>,
) -> Result<(), String> {
  let Some(launched) = session else {
    return Ok(());
  };
  let result = crate::browser_runner::kill_browser_profile(app_handle.clone(), launched).await;
  if let Err(e) = &result {
    log::warn!("Discovery could not close the browser session: {e}");
  }
  // A confirmed kill gets a short process/lock settle period before reuse. On
  // failure the page is still live: delaying here gives its content script an
  // avoidable window to claim or send before cancellation can park it. Return
  // immediately so `quiesce_cancelled_automation` can attempt `about:blank`.
  if close_needs_settle_delay(&result) {
    tokio::time::sleep(CLOSE_SETTLE).await;
  }
  result
}

fn close_needs_settle_delay(result: &Result<(), String>) -> bool {
  result.is_ok()
}

/// Close a scheduler-owned browser without ever losing its launch record on a
/// failed kill. Clearing `session` before success permits the next iteration to
/// cold-launch a second process into the same profile directory — the one
/// session shape that can bypass the local at-most-once ledger.
async fn retire_owned_session(
  app_handle: &tauri::AppHandle,
  session: &mut Option<BrowserProfile>,
  driven_tab: &mut Option<String>,
) -> Result<(), String> {
  let result = close_session(app_handle, session.as_ref().cloned()).await;
  apply_session_close_result(session, driven_tab, result.is_ok());
  result
}

fn apply_session_close_result(
  session: &mut Option<BrowserProfile>,
  driven_tab: &mut Option<String>,
  closed: bool,
) {
  if closed {
    *session = None;
    *driven_tab = None;
  }
}

/// profile 的浏览器数据目录 —— CDP 的实例查找就是按这个路径做键的。
///
/// 必须和 `browser_runner` 启动时用的判据完全一致，也就是 **effective** 路径：
/// `ephemeral` / `password_protected` 的 profile 跑在另一个目录里，按名义路径
/// 去查实例一个页签都找不到，那个 profile 的每条腿都会白跑。
fn profile_data_path(profile: &BrowserProfile) -> String {
  let dir = ProfileManager::instance().get_profiles_dir();
  crate::ephemeral_dirs::get_effective_profile_path(profile, &dir)
    .to_string_lossy()
    .to_string()
}

/// 把这个 profile 的标签页导航到 `url`，并记住驱动的是哪个页签。
async fn wayfern_navigate(
  profile: &BrowserProfile,
  driven_tab: &mut Option<String>,
  url: &str,
) -> Result<(), String> {
  let path = profile_data_path(profile);
  let id = crate::wayfern_manager::WayfernManager::instance()
    .navigate_in_tab(&path, driven_tab.as_deref(), url)
    .await
    .map_err(|e| e.to_string())?;
  *driven_tab = Some(id);
  Ok(())
}

/// Compare the stable part of two navigation destinations.
///
/// Query ordering and tracking parameters are platform-controlled, so the
/// origin/path is authoritative. Search parameters that select the keyword or
/// per-account result slot are still required when present, preventing a
/// restored tab for another campaign/slot from satisfying the readiness check.
fn navigation_reached(expected: &str, actual: &str) -> bool {
  if expected == actual {
    return true;
  }
  let (Ok(expected), Ok(actual)) = (url::Url::parse(expected), url::Url::parse(actual)) else {
    return false;
  };
  if expected.scheme() != actual.scheme()
    || expected.host_str() != actual.host_str()
    || expected.port_or_known_default() != actual.port_or_known_default()
    || expected.path().trim_end_matches('/') != actual.path().trim_end_matches('/')
  {
    return false;
  }
  // These parameters select the campaign/slot rather than merely decorating
  // it.  In particular, `order` and `sort` deliberately spread accounts over
  // different result pools; accepting a restored tab with the same keyword but
  // another slot defeats that isolation.
  for key in ["keyword", "q", "order", "sort", "type"] {
    let wanted = expected
      .query_pairs()
      .find(|(k, _)| k == key)
      .map(|(_, v)| v);
    if let Some(wanted) = wanted {
      let got = actual.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v);
      if got.as_deref() != Some(wanted.as_ref()) {
        return false;
      }
    }
  }
  true
}

/// 「这次导航提交了吗」—— 比 [`navigation_reached`] 宽，只在**预热页**上宽。
///
/// 两个判定的契约不一样，用同一个是这套调度器最贵的一个 bug：
/// 预热 URL 是站点首页（`https://www.xiaohongshu.com/`），而小红书会把首页重定向
/// 到 `/explore`。[`navigation_reached`] 要求路径完全相等，`"" != "/explore"`，
/// 于是**每一条小红书腿**的预热都要白等满两个 `NAVIGATION_COMMIT_WAIT` 才报
/// 「accepted but did not commit」—— 页面其实早就好了。10 天的日志里 53/53 条小红
/// 书腿都是这个形态，而其它三个平台一次都没有：它们的搜索 URL 自带路径。
///
/// 所以放宽只对「没指定路径」的 URL 生效：一个只说了 origin 的 URL，本来就该允许
/// 站点把你送到它自己的落地页；而任何搜索 URL（`/all`、`/search`、`/search/<kw>`、
/// `/search_result`）路径非空，判定和以前逐字节一样严 —— 包括那条防「恢复出来的
/// 旧标签页刚好同关键词、不同 sort」的 keyword/order/sort 检查。
/// 跨 origin 的弹转（登录页、验证码域名）照样是 false。
fn navigation_committed(expected: &str, actual: &str) -> bool {
  if navigation_reached(expected, actual) {
    return true;
  }
  let (Ok(want), Ok(got)) = (url::Url::parse(expected), url::Url::parse(actual)) else {
    return false;
  };
  // 带路径或带查询参数的 URL 说明调用方要的是某一页，不是「这个站」。
  if !want.path().trim_end_matches('/').is_empty() || want.query().is_some() {
    return false;
  }
  want.scheme() == got.scheme()
    && want.host_str() == got.host_str()
    && want.port_or_known_default() == got.port_or_known_default()
}

/// 轮询时判断：标签页是不是已经离开搜索页、跳到 claim 下来的那个靶子上了。
///
/// 三个否定条件缺一不可，最容易漏的是第一个：`/json` 对一个刚创建、还没开始
/// 导航的 target 会报**空 URL**。空串既不是 `about:blank`，`navigation_reached`
/// 对它也必然 false（`Url::parse("")` 直接报错），取反之后就被当成「已经在靶子
/// 页上」—— 接着这条腿会拿这个空串去 `navigate_retrying`，连赔两次导航失败，
/// 最后把整个浏览器会话判成不可用。一个短暂的空 URL 不该有这个后果。
fn is_target_page(search_url: &str, current_url: &str) -> bool {
  !current_url.is_empty()
    && current_url != "about:blank"
    && !navigation_reached(search_url, current_url)
}

/// 轮询到导航提交为止。`budget` 由调用方给：正常路径是
/// [`NAVIGATION_COMMIT_WAIT`]，命令超时后的补看一眼是
/// [`NAVIGATION_LATE_COMMIT_WAIT`]。
async fn wait_for_navigation_commit(
  profile: &BrowserProfile,
  driven_tab: Option<&str>,
  expected: &str,
  budget: Duration,
  cancel: Option<&AtomicBool>,
) -> bool {
  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let deadline = tokio::time::Instant::now() + budget;
  loop {
    if cancellation_requested(cancel) {
      return false;
    }
    let targets = tokio::select! {
      targets = wayfern.list_page_targets(&path) => targets,
      _ = cancellation_signal(cancel) => return false,
    };
    if let Some(targets) = targets {
      let target = driven_tab
        .and_then(|id| targets.iter().find(|t| t.id == id))
        .or_else(|| targets.first());
      if target.is_some_and(|t| navigation_committed(expected, &t.url)) {
        return true;
      }
    }
    if tokio::time::Instant::now() >= deadline {
      return false;
    }
    tokio::select! {
      _ = tokio::time::sleep(Duration::from_millis(200)) => {}
      _ = cancellation_signal(cancel) => return false,
    }
  }
}

async fn driven_tab_url(profile: &BrowserProfile, driven_tab: Option<&str>) -> Option<String> {
  let path = profile_data_path(profile);
  let targets = crate::wayfern_manager::WayfernManager::instance()
    .list_page_targets(&path)
    .await?;
  driven_tab
    .and_then(|id| targets.iter().find(|target| target.id == id))
    .or_else(|| targets.first())
    .map(|target| target.url.clone())
}

async fn navigate_and_wait(
  profile: &BrowserProfile,
  driven_tab: &mut Option<String>,
  url: &str,
  cancel: Option<&AtomicBool>,
) -> Result<(), String> {
  reject_cancelled_navigation(cancel, url)?;
  let command = tokio::time::timeout(
    NAVIGATION_COMMAND_WAIT,
    wayfern_navigate(profile, driven_tab, url),
  );
  let command_result = tokio::select! {
    result = command => result,
    _ = cancellation_signal(cancel) => {
      return Err(format!("navigation cancelled while loading {url}"));
    }
  };
  match command_result {
    Ok(inner) => inner?,
    Err(_) => {
      // 命令没应答 ≠ 导航没发生。
      //
      // `Page.navigate` 的应答要经渲染进程，渲染进程一忙就不回；而 `/json` 里的
      // URL 是浏览器进程维护的，照常更新。直接判失败等于把一次**可能已经成功**
      // 的导航扔掉，然后去走「等渲染进程 20s + 重发 + 再等一个提交窗口」那条
      // 三十多秒的阶梯 —— 实测每条小红书腿都在这里赔掉 37 秒，人看到的就是标签
      // 页停在 about:blank 不动。
      //
      // 所以先花 [`NAVIGATION_LATE_COMMIT_WAIT`] 看一眼页面到底跳没跳。跳了就
      // 直接算成功；没跳再照旧报错，交给 [`navigate_retrying`] 的阶梯。赌输了
      // 只多赔 3 秒，赌赢了省下整条阶梯。
      if wait_for_navigation_commit(
        profile,
        driven_tab.as_deref(),
        url,
        NAVIGATION_LATE_COMMIT_WAIT,
        cancel,
      )
      .await
      {
        log::info!(
          "Discovery: navigation command did not answer within {}s for {url}, but the page had already committed",
          NAVIGATION_COMMAND_WAIT.as_secs()
        );
        return Ok(());
      }
      reject_cancelled_navigation(cancel, url)?;
      return Err(format!(
        "navigation command did not answer within {}s for {url}",
        NAVIGATION_COMMAND_WAIT.as_secs()
      ));
    }
  }
  if wait_for_navigation_commit(
    profile,
    driven_tab.as_deref(),
    url,
    NAVIGATION_COMMIT_WAIT,
    cancel,
  )
  .await
  {
    Ok(())
  } else {
    reject_cancelled_navigation(cancel, url)?;
    Err(format!(
      "navigation was accepted but did not commit to {url}"
    ))
  }
}

async fn wait_for_extension_ready(
  profile: &BrowserProfile,
  driven_tab: Option<&str>,
  cancel: Option<&AtomicBool>,
) -> Result<(), String> {
  use crate::wayfern_manager::MarineAutomationReadiness;

  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let deadline = tokio::time::Instant::now() + EXTENSION_READY_WAIT;
  loop {
    if cancellation_requested(cancel) {
      return Err("extension readiness cancelled".to_string());
    }
    let now = tokio::time::Instant::now();
    if now >= deadline {
      return Err(format!(
        "Marine discovery bridge did not become ready within {}s",
        EXTENSION_READY_WAIT.as_secs()
      ));
    }
    let budget = deadline
      .saturating_duration_since(now)
      .min(Duration::from_secs(3));
    let readiness = tokio::select! {
      result = tokio::time::timeout(
      budget,
      wayfern.marine_automation_readiness(&path, driven_tab),
      ) => result,
      _ = cancellation_signal(cancel) => {
        return Err("extension readiness cancelled".to_string());
      }
    };
    match readiness {
      Ok(MarineAutomationReadiness::Ready) => return Ok(()),
      Ok(MarineAutomationReadiness::Failed(reason)) => {
        return Err(format!(
          "Marine discovery bridge reported bootstrap failure: {reason}"
        ));
      }
      Ok(MarineAutomationReadiness::Pending) | Err(_) => {}
    }
    tokio::select! {
      _ = tokio::time::sleep(Duration::from_millis(300)) => {}
      _ = cancellation_signal(cancel) => {
        return Err("extension readiness cancelled".to_string());
      }
    }
  }
}

fn debug_entry_matches_leg(
  entry: &super::debug_log::LogEntry,
  profile_id: &str,
  platform: &str,
  since: u64,
) -> bool {
  if entry.at < since || entry.profile_id.as_deref() != Some(profile_id) {
    return false;
  }
  entry.url.as_deref().is_some_and(|url| match platform {
    "bilibili" => url.contains("bilibili.com"),
    "zhihu" => url.contains("zhihu.com"),
    "douyin" => url.contains("douyin.com"),
    "xiaohongshu" => url.contains("xiaohongshu.com") || url.contains("xhslink.com"),
    _ => true,
  })
}

/// Preserve the extension's actionable reason for a failed/uncertain terminal
/// touch. The durable ledger intentionally stores the state, not the adapter's
/// selector-level error; the debug sink is the evidence source for that detail.
fn terminal_touch_error(
  profile_id: &str,
  platform: &str,
  since: u64,
  outcome: LegOutcome,
) -> Option<String> {
  if !matches!(outcome, LegOutcome::Failed | LegOutcome::Unconfirmed) {
    return None;
  }

  if let Ok(entries) = super::debug_log::DEBUG_LOG.tail(400) {
    for entry in entries.iter().rev() {
      if entry.at < since {
        break;
      }
      if !debug_entry_matches_leg(entry, profile_id, platform, since) {
        continue;
      }
      let Some(json_start) = entry.msg.find('{') else {
        continue;
      };
      let Ok(value) = serde_json::from_str::<serde_json::Value>(&entry.msg[json_start..]) else {
        continue;
      };
      let status = value.get("status").and_then(|v| v.as_str()).unwrap_or("");
      let state = value.get("state").and_then(|v| v.as_str()).unwrap_or("");
      let matches_outcome = match outcome {
        LegOutcome::Failed => {
          state == "failed"
            || matches!(
              status,
              "fill_failed" | "send_failed" | "prepare_send_failed" | "target_changed_before_send"
            )
        }
        LegOutcome::Unconfirmed => state == "unconfirmed" || status == "send_unconfirmed",
        _ => false,
      };
      if !matches_outcome {
        continue;
      }
      if let Some(error) = value
        .get("error")
        .and_then(|v| v.as_str())
        .filter(|error| !error.trim().is_empty())
      {
        return Some(error.to_string());
      }
      return Some(
        match status {
          "fill_failed" => "the comment editor could not be filled",
          "send_failed" => "the platform submit action failed before a confirmed click",
          "prepare_send_failed" => "the ledger send guard could not be established",
          "target_changed_before_send" => "the active page changed before submit",
          "send_unconfirmed" => "send was attempted, but the platform receipt was not confirmed",
          _ if outcome == LegOutcome::Unconfirmed => {
            "send was attempted, but the platform receipt was not confirmed"
          }
          _ => "the extension recorded a failed terminal outcome",
        }
        .to_string(),
      );
    }
  }

  Some(
    if outcome == LegOutcome::Unconfirmed {
      "send was attempted, but the platform receipt was not confirmed"
    } else {
      "the extension recorded a failed terminal outcome"
    }
    .to_string(),
  )
}

/// 扩展是不是已经明确说了「这条腿没戏」。
///
/// 扩展已经给出不产生终态 touch 的明确失败/空转状态时，在这里提前收场。
/// 既包括搜索页立刻知道的未登录、候选池为空，也包括交接存储、导航纠偏和
/// settle 明确失败。后几类如果不识别，页面逻辑已经退出，调度器却仍会白等满超时。
///
/// 调度器原本看不见它们：完成信号只认台账里的 touch，而这些状态**不产生
/// touch**，于是白等满整个腿超时。一个 profile 没登录多个平台，就会连续空转；
/// 跑 20 个 profile 时这是最大的一块浪费。
///
/// 用日志 sink 而不是新开一条通道：它就在同一个进程里，而且这些状态本来就
/// 已经写进去了。这不违反「完成信号是台账」那条原则 —— 这里判定的不是「干完了」
/// 而是「不可能干成」，台账仍然是唯一记录成果的地方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HopelessKind {
  /// An expected account/content condition: the leg had nothing legitimate to
  /// do, but the automation stack itself is healthy.
  NoWork,
  /// An adapter, navigation, persistence, or bootstrap failure. If every leg
  /// has one of these, the recurring-run fuse must eventually stop the job.
  SystemFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HopelessReason {
  message: &'static str,
  kind: HopelessKind,
}

impl HopelessReason {
  fn outcome(self) -> LegOutcome {
    match self.kind {
      HopelessKind::NoWork => LegOutcome::NoWork,
      HopelessKind::SystemFailure => LegOutcome::Failed,
    }
  }
}

fn classify_hopeless_message(message: &str) -> Option<HopelessReason> {
  use HopelessKind::{NoWork, SystemFailure};

  const HOPELESS: [(&str, &str, HopelessKind); 20] = [
    (
      "\"status\":\"not_logged_in\"",
      "not logged in on this platform",
      NoWork,
    ),
    (
      "\"status\":\"nothing_to_claim\"",
      "no eligible targets left for this account",
      NoWork,
    ),
    (
      "\"status\":\"no_profile_id\"",
      "extension could not resolve the active profile",
      SystemFailure,
    ),
    (
      "\"status\":\"handoff_write_failed\"",
      "extension could not persist the target handoff",
      SystemFailure,
    ),
    (
      "\"status\":\"handoff_in_progress\"",
      "an unresolved handoff already owns this browser tab",
      SystemFailure,
    ),
    (
      "\"status\":\"target_navigation_stalled\"",
      "the old page stayed alive after two exact target navigation attempts",
      SystemFailure,
    ),
    (
      "\"status\":\"handoff_url_mismatch\"",
      "target navigation did not reach the claimed item",
      SystemFailure,
    ),
    (
      "\"status\":\"aborted_no_context\"",
      "target page could not obtain a generation context",
      SystemFailure,
    ),
    (
      "\"status\":\"blocked_hop_limit\"",
      "target replacement limit reached",
      NoWork,
    ),
    (
      "\"status\":\"blocked_no_hop\"",
      "target replacement is unavailable",
      SystemFailure,
    ),
    (
      "\"status\":\"blocked_hop_failed\"",
      "target replacement failed",
      SystemFailure,
    ),
    (
      "\"status\":\"blocked_nothing_left\"",
      "no replacement target remains",
      NoWork,
    ),
    (
      "\"status\":\"handoff_read_failed\"",
      "extension handoff storage did not become ready",
      SystemFailure,
    ),
    (
      "\"status\":\"handoff_expired\"",
      "the pre-send target handoff expired before it could run",
      SystemFailure,
    ),
    (
      "\"status\":\"handoff_redirect_persist_failed\"",
      "extension could not persist the target navigation repair",
      SystemFailure,
    ),
    (
      "\"status\":\"send_guard_persist_failed\"",
      "extension could not persist the at-most-once send guard",
      SystemFailure,
    ),
    (
      "\"status\":\"send_already_started\"",
      "extension refused to repeat an already-started send",
      SystemFailure,
    ),
    (
      "\"status\":\"target_changed_before_send\"",
      "the active SPA target changed before the guarded send",
      SystemFailure,
    ),
    (
      "\"status\":\"prospect_bootstrap_failed\"",
      "the search-page automation dependencies did not become ready",
      SystemFailure,
    ),
    (
      "\"status\":\"target_bootstrap_failed\"",
      "the target-page automation dependencies did not become ready",
      SystemFailure,
    ),
  ];
  for (needle, reason, kind) in HOPELESS {
    if message.contains(needle) {
      return Some(HopelessReason {
        message: reason,
        kind,
      });
    }
  }

  // A recoverable settlement failure owns a persistent, at-most-once handoff
  // and keeps retrying settlement without generating or clicking again.
  // Parking that document immediately destroys its recovery loop. Only an
  // explicitly non-recoverable failure can end the leg here.
  if message.contains("\"status\":\"settle_failed\"") && message.contains("\"recoverable\":false") {
    return Some(HopelessReason {
      message: "extension could not safely recover the terminal ledger state",
      kind: SystemFailure,
    });
  }

  // 重试阶梯跑完了还没能开工 —— 搜索页始终解析不出结果。
  //
  // **这就是验证墙的真实表现**。不要去检测「页面上有没有验证码元素」：抖音会
  // 预加载 `rc-verifycenter` 组件，实测一条带着那个 iframe 的腿照样发成功了，
  // 按元素判会误杀能成的腿。而阶梯（6 次退避重试、约 30 秒）跑完仍然不成，
  // 意思是「渲染完了也没有结果卡片」—— 页面塌陷、被验证墙顶掉、或者搜索被拦，
  // 三种都一样没戏，再等两分钟不会变。这是整条自动化链路不可用，不是正常空池。
  if message.contains("[6/6]") && !message.contains("\"status\":\"claimed\"") {
    return Some(HopelessReason {
      message:
        "search page never yielded results (collapsed, blocked, or behind a verification wall)",
      kind: SystemFailure,
    });
  }
  None
}

fn leg_is_hopeless(profile_id: &str, platform: &str, since: u64) -> Option<HopelessReason> {
  let entries = super::debug_log::DEBUG_LOG.tail(400).ok()?;
  for entry in entries.iter().rev() {
    if entry.at < since {
      break;
    }
    if !debug_entry_matches_leg(entry, profile_id, platform, since) {
      continue;
    }
    if let Some(reason) = classify_hopeless_message(&entry.msg) {
      return Some(reason);
    }
  }
  None
}

/// 等渲染进程重新开始应答，最多等 [`IDLE_WAIT`]。
///
/// 等不到也照常往下走：下一次导航自带上限，最坏是那条腿失败，
/// 而不是在这里把整轮拖死。
///
/// `IDLE_WAIT` 是**硬上限**，所以每次探针都要按剩余预算裁一刀。
/// [`crate::wayfern_manager::WayfernManager::renderer_responds`] 自带 8 秒超时，
/// 循环条件却只在**进入下一轮之前**看时钟：t=18s 时还能再起一次探针，于是 20 秒
/// 的预算实测跑成 27 秒（3×(8s 探针 + 1s 间歇)）。日志里那 40 次「renderer still
/// busy」全是 27.0–27.1 秒，一秒不差。
///
/// `reason` 由调用方给：这行警告过去写死「after parking」，可它 41 次里有 40 次
/// 其实来自**导航重试**，把每一次从这条日志出发的排查都带偏了。
async fn wait_until_idle(
  profile: &BrowserProfile,
  driven_tab: Option<&str>,
  reason: &str,
  cancel: Option<&AtomicBool>,
) {
  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let deadline = tokio::time::Instant::now() + IDLE_WAIT;
  loop {
    if cancellation_requested(cancel) {
      return;
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
      break;
    }
    let responds = tokio::select! {
      responds = tokio::time::timeout(remaining, wayfern.renderer_responds(&path, driven_tab))
        => matches!(responds, Ok(true)),
      _ = cancellation_signal(cancel) => return,
    };
    if responds {
      return;
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
      break;
    }
    tokio::select! {
      _ = tokio::time::sleep(remaining.min(Duration::from_secs(1))) => {}
      _ = cancellation_signal(cancel) => return,
    }
  }
  log::warn!(
    "Discovery: renderer still busy after {}s ({reason}) on profile {}",
    IDLE_WAIT.as_secs(),
    profile.name
  );
}

/// 导航到这条腿的搜索页，必要时先过一趟预热页。
///
/// 小红书**不能从 `about:blank` 冷跳到搜索页** —— 那样渲染进程会卡死：导航从不
/// 提交，标签页停在旧 URL 转圈，而 `/json` 里 target 一切正常，从外面完全看不出
/// 出事了。先加载首页再跳同一个搜索 URL 就一切正常（隔离实验，只改这一个变量，
/// 两个方向各复现一次）。
///
/// 预热失败不致命：直接试搜索页，最坏退回到今天的失败形态，而不是凭空多一种。
async fn navigate_with_warmup(
  scheduler: &DiscoveryScheduler,
  profile: &BrowserProfile,
  driven_tab: &mut Option<String>,
  slot: &super::search_slot::SearchSlot,
) -> Result<(), String> {
  if let Some(warmup) = slot.warmup_url.as_deref() {
    match navigate_retrying(profile, driven_tab, warmup, Some(&scheduler.cancel)).await {
      Ok(()) => {
        if !sleep_or_cancel(scheduler, WARMUP_SETTLE).await {
          return Err("navigation cancelled during search-page warm-up".to_string());
        }
      }
      Err(e) => {
        log::warn!("Discovery warm-up navigation failed ({e}); trying the search page anyway")
      }
    }
  }
  navigate_retrying(profile, driven_tab, &slot.url, Some(&scheduler.cancel)).await
}

/// 导航，超时就等渲染进程空下来再试一次。
///
/// `wait_until_idle` 已经把根因解决了（腿结束后等页面真的拆完再走），实测四条腿
/// 一次没超时。这里是第二道：**一次瞬时无应答不该直接废掉一条腿**，而废掉一条腿
/// 的代价是那条候选按「失败不重试」永久作废。
///
/// 重试前必须先等渲染进程 —— 直接重发只会撞上同一个忙着的渲染进程，白赔第二个
/// 30 秒超时。
async fn navigate_retrying(
  profile: &BrowserProfile,
  driven_tab: &mut Option<String>,
  url: &str,
  cancel: Option<&AtomicBool>,
) -> Result<(), String> {
  reject_cancelled_navigation(cancel, url)?;
  match navigate_and_wait(profile, driven_tab, url, cancel).await {
    Ok(()) => Ok(()),
    Err(first) => {
      reject_cancelled_navigation(cancel, url)?;
      log::warn!(
        "Discovery navigation failed ({first}); waiting for the renderer and retrying once"
      );
      wait_until_idle(
        profile,
        driven_tab.as_deref(),
        &format!("waiting to retry the navigation to {url}"),
        cancel,
      )
      .await;
      // A failed navigation followed by the idle wait is a wide cancellation
      // window. Never start its retry after Stop. Cancellation's deliberate
      // `about:blank` fence calls this helper with `cancel = None`; normal leg
      // parking remains interruptible.
      reject_cancelled_navigation(cancel, url)?;
      navigate_and_wait(profile, driven_tab, url, cancel).await
    }
  }
}

fn reject_cancelled_navigation(cancel: Option<&AtomicBool>, url: &str) -> Result<(), String> {
  if cancellation_requested(cancel) {
    Err(format!("navigation cancelled before loading {url}"))
  } else {
    Ok(())
  }
}

fn cancellation_requested(cancel: Option<&AtomicBool>) -> bool {
  cancel.is_some_and(|flag| flag.load(Ordering::SeqCst))
}

/// Async edge for `tokio::select!` around CDP calls. Atomic cancellation has no
/// notifier, so sample it frequently; 100ms is short relative to the humanized
/// typing/send pipeline and keeps Stop responsive without a hot loop.
async fn cancellation_signal(cancel: Option<&AtomicBool>) {
  let Some(cancel) = cancel else {
    std::future::pending::<()>().await;
    return;
  };
  loop {
    if cancel.load(Ordering::SeqCst) {
      return;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
}

/// 把标签页收敛到一个，返回保留下来的那个的 id。
///
/// 失败一律只记 warn：换平台靠的是「原地导航」，清页签只是收拾残留。
/// 清不掉最多是脏，清错了（把最后一个也关掉）才是灾难 —— 后者由
/// `close_extra_page_targets` 自己的下限保证，这里不重复判断。
async fn sweep_tabs(profile: &BrowserProfile, prefer: Option<&str>) -> Option<String> {
  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let targets = wayfern.list_page_targets(&path).await?;
  let ids: Vec<String> = targets.iter().map(|t| t.id.clone()).collect();
  let (keep, close) = plan_sweep(&ids, prefer)?;
  if !close.is_empty() {
    // 带上 URL：光说「关了 3 个」看不出 sweep 有没有误伤 —— 而它误伤的方式
    // 恰恰是把正在干活的那个页签当成残留关掉。
    let doomed: Vec<&str> = targets
      .iter()
      .filter(|t| close.contains(&t.id))
      .map(|t| t.url.as_str())
      .collect();
    match wayfern.close_extra_page_targets(&path, &keep).await {
      Ok(n) if n > 0 => log::info!("Discovery: closed {n} leftover tab(s): {doomed:?}"),
      Ok(_) => {}
      Err(e) => log::warn!("Discovery could not sweep tabs: {e}"),
    }
  }
  Some(keep)
}

/// 会话里现在该驱动哪个页签、该关掉哪些。
///
/// 抽成纯函数是为了能钉住那条不能违反的不变量：**只剩一个页签时绝不产生关闭
/// 动作**。Chromium 关掉最后一个标签页会退出整个浏览器，而浏览器一没，这个
/// 会话后面的平台全废 —— 这是「清页签」这件事唯一真正危险的失败模式。
fn plan_sweep(target_ids: &[String], prefer: Option<&str>) -> Option<(String, Vec<String>)> {
  let keep = prefer
    .filter(|id| target_ids.iter().any(|t| t == id))
    .map(|id| id.to_string())
    .or_else(|| target_ids.first().cloned())?;
  let close = if target_ids.len() < 2 {
    Vec::new()
  } else {
    target_ids
      .iter()
      .filter(|id| **id != keep)
      .cloned()
      .collect()
  };
  Some((keep, close))
}

struct LegExecution {
  report: LegReport,
  /// Strong evidence that the current browser session must not be reused for
  /// another platform, even when `/json` still exposes a page target.
  session_unusable: bool,
  /// The renderer itself stopped answering — the session is not merely stale,
  /// this profile is in a state worth being afraid of.
  ///
  /// 和 `session_unusable` 分开，是因为它们的代价差着一个量级。「不能复用」的补救
  /// 是退役 + 冷启动，那正是每个 profile 第一条腿的正常状态，代价只是慢一点；
  /// 「渲染进程死了」才值得动用重启预算、并在第二次发生时放弃整个 profile。
  ///
  /// 混在一起会产生一个恶性回路：park 到 about:blank 就是「下一次导航」，而本文件
  /// 自己的实测注释写着「上一条腿**真发出去了** → 下一次导航必超时」。于是发布成功
  /// 恰恰是最容易 park 失败的条件，而 park 失败被记成会话中毒 —— **干成活的腿反而
  /// 最可能害死后面所有平台**。
  session_poisoned: bool,
  /// A search-page extension bootstrap failed before any ledger work. This is
  /// the only failure allowed to retry the same platform on a fresh session.
  retry_on_fresh_session: bool,
  /// Stop was requested, but the page could not yet be fenced. Claims must not
  /// be settled until a later close attempt succeeds.
  pending_cancel_cleanup: Option<PendingCancelledCleanup>,
}

#[derive(Debug, Clone, Copy)]
struct PendingCancelledCleanup {
  leg_started_at: u64,
  baseline: TerminalTouches,
}

impl LegExecution {
  fn healthy(report: LegReport) -> Self {
    Self {
      report,
      session_unusable: false,
      session_poisoned: false,
      retry_on_fresh_session: false,
      pending_cancel_cleanup: None,
    }
  }

  /// 用于渲染进程/导航真的不应答的那些路径。
  fn unusable(report: LegReport) -> Self {
    Self {
      report,
      session_unusable: true,
      session_poisoned: true,
      retry_on_fresh_session: false,
      pending_cancel_cleanup: None,
    }
  }

  fn bootstrap_failure(report: LegReport, retry_is_safe: bool) -> Self {
    Self {
      report,
      session_unusable: true,
      session_poisoned: true,
      retry_on_fresh_session: retry_is_safe,
      pending_cancel_cleanup: None,
    }
  }
}

/// 这条腿的麻烦，值不值得花掉这个 profile 唯一的一次会话重启 —— 以及第二次发生时
/// 放弃它还没跑到的所有平台？
///
/// 只有**中毒**算数：渲染进程不再应答。park 到 about:blank 失败只说明这个会话不该
/// 再复用，补救是退役 + 冷启动，而那正是每个 profile 第一条腿的正常形态，代价只是慢。
///
/// 分开的理由是一个恶性回路：park 就是「下一次导航」，而本文件自己的实测注释写着
/// 「上一条腿**真发出去了** → 下一次导航必超时」。两者混为一谈时，发布成功恰恰是最
/// 容易 park 失败的条件，于是**干成活的腿反而害死后面所有平台** —— 用户看到的正是
/// 「知乎发出去了，浏览器却关了，后面的平台一个都没跑」。
fn consumes_session_restart(session_poisoned: bool, remaining: usize, cancelled: bool) -> bool {
  session_poisoned && remaining > 0 && !cancelled
}

fn should_retry_on_fresh_session(
  execution: &LegExecution,
  restarts_left: u8,
  cancelled: bool,
) -> bool {
  execution.retry_on_fresh_session && restarts_left > 0 && !cancelled
}

/// Stop page-side automation before releasing this leg's claims.
///
/// Killing the owned browser is the strongest fence: after it succeeds no
/// content script can claim another target or cross the send guard.  If the
/// process manager cannot kill it, parking the driven document on
/// `about:blank` is an acceptable fallback because committing that navigation
/// destroys the document and its timers.  A final kill retry covers the case
/// where both the first process lookup and CDP briefly raced shutdown.
async fn quiesce_cancelled_automation(
  app_handle: &tauri::AppHandle,
  profile: &BrowserProfile,
  session: &mut Option<BrowserProfile>,
  driven_tab: &mut Option<String>,
) -> Result<(), String> {
  if session.is_none() {
    // `driven_tab` is meaningful only inside an owned session. There is no
    // scheduler-started page left that could create a new claim.
    *driven_tab = None;
    return Ok(());
  }

  match retire_owned_session(app_handle, session, driven_tab).await {
    Ok(()) => Ok(()),
    Err(first_kill_error) => {
      log::warn!(
        "Discovery stop could not kill {} immediately ({first_kill_error}); parking its page before claim cleanup",
        profile.name
      );

      if navigate_retrying(profile, driven_tab, "about:blank", None)
        .await
        .is_ok()
      {
        return Ok(());
      }

      // Do not settle while a target document might still be alive. One final
      // process-level attempt is safer than manufacturing Skipped/Unconfirmed
      // and then allowing the page to claim or send again behind the ledger.
      match retire_owned_session(app_handle, session, driven_tab).await {
        Ok(()) => Ok(()),
        Err(second_kill_error) => Err(format!(
          "could not stop page automation before cancelled-claim cleanup: first kill failed ({first_kill_error}); parking failed; final kill failed ({second_kill_error})"
        )),
      }
    }
  }
}

/// Settle claims only after the caller has established a page-automation
/// fence, then read back the durable result. The prospect layer preserves the
/// irreversible boundary: pre-send claims become Skipped; `send_started`
/// claims become Unconfirmed.
async fn settle_cancelled_leg_after_quiescence(
  profile: &BrowserProfile,
  profile_id: &str,
  platform: &str,
  leg_started_at: u64,
  baseline: TerminalTouches,
) -> (TerminalTouches, Vec<String>) {
  let mut errors = Vec::new();
  let mut cleanup_fallback = TerminalTouches::default();
  let cancelled_profile = profile_id.to_string();
  let cancelled_platform = platform.to_string();
  match tokio::task::spawn_blocking(move || {
    super::prospect::PROSPECTS.settle_cancelled_claims(
      &cancelled_profile,
      &cancelled_platform,
      leg_started_at,
    )
  })
  .await
  {
    Ok(Ok(report)) => {
      cleanup_fallback.skipped = report.skipped;
      cleanup_fallback.unconfirmed = report.unconfirmed;
      if report.total() > 0 {
        log::info!(
          "Discovery cancellation resolved {} claim(s) for {} on {platform}: {} skipped, {} unconfirmed",
          report.total(),
          profile.name,
          report.skipped,
          report.unconfirmed,
        );
      }
    }
    Ok(Err(error)) => {
      let error = format!("could not safely settle this leg's claim while stopping: {error}");
      log::warn!(
        "Discovery cancellation could not resolve {} on {platform}: {error}",
        profile.name
      );
      errors.push(error);
    }
    Err(error) => {
      let error = format!("cancelled-claim cleanup task failed while stopping: {error}");
      log::warn!(
        "Discovery cancellation cleanup task failed for {} on {platform}: {error}",
        profile.name
      );
      errors.push(error);
    }
  }

  // Re-read instead of manufacturing a state from the cleanup report: the
  // extension may have settled concurrently just before it was quiesced. Its
  // real touch (especially Posted/Unconfirmed) must win.
  let terminal_touches = match read_touch_summary(profile_id, platform).await {
    Ok(now) => now.since(baseline),
    Err(error) if cleanup_fallback.total() > 0 => {
      errors.push(format!(
        "cancelled claims were resolved, but their terminal state could not be re-read: {error}"
      ));
      cleanup_fallback
    }
    Err(error) => {
      errors.push(format!(
        "could not verify the ledger while stopping this leg: {error}"
      ));
      TerminalTouches::default()
    }
  };
  (terminal_touches, errors)
}

async fn complete_pending_cancel_cleanup(
  profile: &BrowserProfile,
  platform: &str,
  pending: PendingCancelledCleanup,
  report: &mut LegReport,
) {
  let (terminal_touches, errors) = settle_cancelled_leg_after_quiescence(
    profile,
    &report.profile_id,
    platform,
    pending.leg_started_at,
    pending.baseline,
  )
  .await;
  let outcome = terminal_touches.outcome().unwrap_or(LegOutcome::Cancelled);
  report.outcome = outcome;
  report.settled_count = terminal_touches.total();
  report.error = if errors.is_empty() {
    terminal_touch_error(
      &report.profile_id,
      platform,
      pending.leg_started_at,
      outcome,
    )
  } else {
    Some(errors.join("; "))
  };

  if outcome == LegOutcome::Posted {
    if let Err(error) =
      super::login_status::LOGIN_STATUS.clear_platform(&report.profile_id, platform)
    {
      log::warn!("Could not clear Marine login flag: {error}");
    }
  }
}

/// Finalize one operator-cancelled leg.  Ordering is the safety contract:
/// quiesce the browser document first, then settle owned claims, then read the
/// durable terminal state used by the report.  Reversing the first two steps
/// leaves a window where the live page can claim again after cleanup.
#[allow(clippy::too_many_arguments)]
async fn finish_cancelled_leg(
  app_handle: &tauri::AppHandle,
  scheduler: &DiscoveryScheduler,
  profile: &BrowserProfile,
  platform: &str,
  leg_index: usize,
  total_legs: usize,
  finished: &[LegReport],
  profile_id: &str,
  leg_started_at: u64,
  baseline: TerminalTouches,
  base: LegReport,
  session: &mut Option<BrowserProfile>,
  driven_tab: &mut Option<String>,
) -> LegExecution {
  publish_leg(
    scheduler,
    RunPhase::Closing,
    leg_index,
    total_legs,
    profile,
    platform,
    finished,
  );

  let quiesce_result = quiesce_cancelled_automation(app_handle, profile, session, driven_tab).await;
  let session_unusable = quiesce_result.is_err();
  let (terminal_touches, errors) = if let Err(error) = quiesce_result {
    // Crucially, do not release claims while page automation may still be
    // running. Their TTL is preferable to a false terminal state followed by
    // a late send. The caller will make another best-effort session close.
    log::error!(
      "Discovery cancellation could not quiesce {} on {platform}: {error}",
      profile.name
    );
    let mut errors = vec![error];
    let terminal_touches = match read_touch_summary(profile_id, platform).await {
      Ok(now) => now.since(baseline),
      Err(error) => {
        errors.push(format!(
          "could not verify the ledger while stopping this leg: {error}"
        ));
        TerminalTouches::default()
      }
    };
    (terminal_touches, errors)
  } else {
    settle_cancelled_leg_after_quiescence(profile, profile_id, platform, leg_started_at, baseline)
      .await
  };

  let outcome = terminal_touches.outcome().unwrap_or(if session_unusable {
    LegOutcome::Failed
  } else {
    LegOutcome::Cancelled
  });
  let error = if errors.is_empty() {
    terminal_touch_error(profile_id, platform, leg_started_at, outcome)
  } else {
    Some(errors.join("; "))
  };

  if outcome == LegOutcome::Posted {
    if let Err(error) = super::login_status::LOGIN_STATUS.clear_platform(profile_id, platform) {
      log::warn!("Could not clear Marine login flag: {error}");
    }
  }

  log::info!(
    "Discovery leg {leg_index}/{total_legs} stopped: {} on {platform} → {outcome:?} ({} terminal touch(es))",
    profile.name,
    terminal_touches.total(),
  );

  LegExecution {
    report: LegReport {
      outcome,
      settled_count: terminal_touches.total(),
      error,
      ..base
    },
    session_unusable,
    // 取消路径不放宽。这里的 `session_unusable` 来自 quiesce 失败，而 quiesce 的
    // 第一个动作就是 retire_owned_session —— 它失败意味着会话**关都关不掉**，
    // 那是比 park 超时强得多的证据，保持原样。
    session_poisoned: session_unusable,
    retry_on_fresh_session: false,
    pending_cancel_cleanup: session_unusable.then_some(PendingCancelledCleanup {
      leg_started_at,
      baseline,
    }),
  }
}

#[allow(clippy::too_many_arguments)]
async fn run_leg(
  app_handle: &tauri::AppHandle,
  scheduler: &DiscoveryScheduler,
  profile: &BrowserProfile,
  platform: &str,
  keyword: &str,
  account_index: usize,
  leg_timeout: Duration,
  leg_index: usize,
  total_legs: usize,
  finished: &[LegReport],
  // `session`：这个 profile 的浏览器会话。`None` = 还没开，本条腿负责冷启动；
  // 之后的腿共用它，只导航不重启。里面存的是 launch 返回的记录 —— 关闭时必须
  // 用它，因为它带着这次启动真正产生的 pid。
  // `driven_tab`：会话里被驱动的那个标签页。全程只应该有它一个。
  session: &mut Option<BrowserProfile>,
  driven_tab: &mut Option<String>,
) -> LegExecution {
  let profile_id = profile.id.to_string();
  let base = LegReport {
    profile_id: profile_id.clone(),
    profile_name: profile.name.clone(),
    platform: platform.to_string(),
    outcome: LegOutcome::NoSlot,
    settled_count: 0,
    error: None,
  };

  // Defensive boundary in addition to the caller's pre-leg check. No work for
  // this leg has started yet, so there is no owned claim to settle.
  if scheduler.cancel.load(Ordering::SeqCst) {
    return LegExecution::healthy(LegReport {
      outcome: LegOutcome::Cancelled,
      ..base
    });
  }

  let Some(slot) = super::search_slot::slot_for(platform, keyword, account_index) else {
    log::info!("Discovery: no search slot for platform {platform}, skipping");
    return LegExecution::healthy(base);
  };

  publish_leg(
    scheduler,
    RunPhase::Launching,
    leg_index,
    total_legs,
    profile,
    platform,
    finished,
  );

  // Baseline BEFORE the browser opens. Anything appended after this point is
  // this leg's work. Never invent a zero baseline: if this profile/platform has
  // historical touches, a later successful read would credit all of them to
  // this leg and falsely report a new terminal outcome without doing any work.
  let baseline = match initial_touch_summary(&profile_id, platform).await {
    Ok(count) => count,
    Err(error) => {
      // 这条出口在「浏览器已打开」那行日志**之前**，所以在此之前它是完全隐形的：
      // 腿被记成 Failed，Marine.log 里却连它存在过都看不出来。
      log::error!(
        "Discovery leg {leg_index}/{total_legs}: {} on {platform} 读不到台账基线，未开工即结束：{error}",
        profile.name,
      );
      return LegExecution::healthy(LegReport {
        outcome: LegOutcome::Failed,
        error: Some(format!(
          "could not establish prospect ledger baseline: {error}"
        )),
        ..base
      });
    }
  };
  // The extension can finish a fast terminal path while generic browser launch
  // is still applying CDP setup.  Correlating only from Working onward misses
  // that evidence and turns a known no-op into a full leg timeout.
  let leg_started_at = crate::proxy_manager::now_secs();

  if scheduler.cancel.load(Ordering::SeqCst) {
    return LegExecution::healthy(LegReport {
      outcome: LegOutcome::Cancelled,
      ..base
    });
  }

  log::info!(
    "Discovery leg {leg_index}/{total_legs}: profile {} on {platform} → {} ({})",
    profile.name,
    slot.url,
    slot.label
  );

  // 冷启动，还是原地换页？
  //
  // 一个 profile 配置的平台跑在**同一个浏览器会话**里：第一条腿冷启动，之后
  // 只把同一个标签页导航到下一个平台的搜索页。扩展那边不需要任何新通道 ——
  // 它本来就是「落到搜索页就开工」（内容脚本在每次文档加载时启动编排）。
  //
  // 后续平台**绝不能**走 `launch_browser_profile`：profile 已在运行时它会转到
  // `open_url_in_existing_browser`，而那条路失败会**回落去起第二个浏览器实例**。
  // 同一个 profile 目录两个浏览器是这套系统里唯一能造成同账号并发发送的路径。
  if session.is_none() {
    // 自动任务从一个干净页签启动，不恢复历史会话。通用启动器过去会先恢复 N
    // 个旧页，再逐页串行跑 CDP 设置，窗口虽然开了，scheduler 却可能几分钟都
    // 拿不回控制权。更重要的是：启动器的初始 Page.navigate 失败只记日志，不能
    // 作为编排的就绪契约。因此 URL 一律在 launch 返回、页签身份确定后由这里驱动。
    let launch_result = crate::browser_runner::launch_browser_profile_for_automation(
      app_handle.clone(),
      profile.clone(),
    )
    .await;
    match launch_result {
      Ok(p) => *session = Some(p),
      Err(e) => {
        if scheduler.cancel.load(Ordering::SeqCst) {
          return LegExecution::healthy(LegReport {
            outcome: LegOutcome::Cancelled,
            ..base
          });
        }
        log::error!(
          "Discovery leg failed to launch profile {}: {e}",
          profile.name
        );
        return LegExecution::unusable(LegReport {
          outcome: LegOutcome::Failed,
          error: Some(e),
          ..base
        });
      }
    }

    if scheduler.cancel.load(Ordering::SeqCst) {
      return finish_cancelled_leg(
        app_handle,
        scheduler,
        profile,
        platform,
        leg_index,
        total_legs,
        finished,
        &profile_id,
        leg_started_at,
        baseline,
        base,
        session,
        driven_tab,
      )
      .await;
    }

    // 防御性收敛：策略上不再恢复会话，但平台/浏览器仍可能自己产生额外页签。
    *driven_tab = sweep_tabs(profile, driven_tab.as_deref()).await;
  }

  if scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }

  let navigation_result = navigate_with_warmup(scheduler, profile, driven_tab, &slot).await;
  if scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }
  if let Err(e) = navigation_result {
    log::warn!(
      "Discovery leg could not navigate profile {} to {platform}: {e}",
      profile.name
    );
    return LegExecution::unusable(LegReport {
      outcome: LegOutcome::Failed,
      error: Some(format!("session lost: {e}")),
      ..base
    });
  }

  // Business readiness, not just renderer liveness.  `DOM.getDocument` can
  // happily answer on an old/restored page; the marker proves this document's
  // Marine content script actually bootstrapped.  One exact reload heals a
  // transient injection/navigation race.  A second miss fails in ~24s instead
  // of looking frozen for the full leg timeout.
  let first_readiness =
    wait_for_extension_ready(profile, driven_tab.as_deref(), Some(&scheduler.cancel)).await;
  if scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }
  if let Err(first_error) = first_readiness {
    log::warn!(
      "Discovery: Marine extension did not become ready on {platform} ({first_error}); reloading the search page once"
    );
    let reload_result =
      navigate_retrying(profile, driven_tab, &slot.url, Some(&scheduler.cancel)).await;
    if scheduler.cancel.load(Ordering::SeqCst) {
      return finish_cancelled_leg(
        app_handle,
        scheduler,
        profile,
        platform,
        leg_index,
        total_legs,
        finished,
        &profile_id,
        leg_started_at,
        baseline,
        base,
        session,
        driven_tab,
      )
      .await;
    }
    if let Err(e) = reload_result {
      return LegExecution::unusable(LegReport {
        outcome: LegOutcome::Failed,
        error: Some(format!("extension bootstrap reload failed: {e}")),
        ..base
      });
    }
    let second_readiness =
      wait_for_extension_ready(profile, driven_tab.as_deref(), Some(&scheduler.cancel)).await;
    if scheduler.cancel.load(Ordering::SeqCst) {
      return finish_cancelled_leg(
        app_handle,
        scheduler,
        profile,
        platform,
        leg_index,
        total_legs,
        finished,
        &profile_id,
        leg_started_at,
        baseline,
        base,
        session,
        driven_tab,
      )
      .await;
    }
    if let Err(second_error) = second_readiness {
      let retry_is_safe = tokio::select! {
        safe = bootstrap_retry_is_safe(&profile_id, platform, leg_started_at) => Some(safe),
        _ = cancellation_signal(Some(&scheduler.cancel)) => None,
      };
      let Some(retry_is_safe) = retry_is_safe else {
        return finish_cancelled_leg(
          app_handle,
          scheduler,
          profile,
          platform,
          leg_index,
          total_legs,
          finished,
          &profile_id,
          leg_started_at,
          baseline,
          base,
          session,
          driven_tab,
        )
        .await;
      };
      return LegExecution::bootstrap_failure(
        LegReport {
          outcome: LegOutcome::Failed,
          error: Some(format!(
            "Marine extension bootstrap failed after one reload: {second_error}"
          )),
          ..base
        },
        retry_is_safe,
      );
    }
  }

  // 把窗口带到前台。**扩展做不到这件事** —— `chrome.windows.update({focused:true})`
  // 在 macOS 上抢不到系统焦点（系统不允许后台应用自行抢占）。而 B 站的评论框在
  // 窗口没有系统焦点时只渲染成一条紧凑条：既没有真正的输入框也没有发布按钮，
  // 整条腿会以「未能定位到直评输入框」告终（实测两次两中）。
  //
  // 只有 B 站需要 —— 知乎实测在 `hasFocus() === false` 时照样发出成功。但这里不
  // 按平台开关：真要按平台分叉，就得在这里再写一份「哪些平台需要焦点」的判据，
  // 而这套系统已经吃过「同一判据散落多处」的亏。统一带到前台，代价是每条腿打断
  // 用户一次，这是知情的取舍。
  // 结果不能丢。Windows 有**前台锁**：后台进程不允许自行抢占前台，系统只会让
  // 任务栏图标闪一下 —— 而 `Page.bringToFront` 照样返回 ok，因为 CDP 的 ack 只
  // 说明命令被收下了，不代表操作系统真把窗口放到了前台。
  //
  // 于是 B 站那条腿会以「未能定位到直评输入框」告终：那是一条**环境**失败，长得
  // 却和内容失败一模一样，候选就这么被白烧掉。这里先把它记下来，别让它继续伪装
  // 成内容问题。真正的解法（AllowSetForegroundWindow / AttachThreadInput 提权序列
  // + GetForegroundWindow 实测校验）要在 Windows 上写和验，不能在这里盲写。
  let focus_profile_path = profile_data_path(profile);
  let focused = tokio::select! {
    focused = crate::wayfern_manager::WayfernManager::instance()
      .bring_to_front(&focus_profile_path, driven_tab.as_deref()) => Some(focused),
    _ = cancellation_signal(Some(&scheduler.cancel)) => None,
  };
  if focused.is_none() || scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }
  let focused = focused.unwrap_or(false);
  if !focused {
    log::warn!(
      "Could not bring {}'s window to the front for {platform}. On Windows this is expected \
       whenever the operator is using another app (foreground lock); Bilibili needs real system \
       focus and its comment box will not render without it.",
      profile.name
    );
  }

  publish_leg(
    scheduler,
    RunPhase::Working,
    leg_index,
    total_legs,
    profile,
    platform,
    finished,
  );

  let deadline = tokio::time::Instant::now() + leg_timeout;
  let mut terminal_touches = TerminalTouches::default();
  // 渲染进程卡死是个**真实且可复现**的形态（实测：小红书搜索页会稳定把它搞死，
  // 两次两中）。它的阴险之处在于从外面看什么都正常 —— `/json` 里 target 还在，
  // `Page.navigate` 也照常返回，因为那些是浏览器进程处理的。没有探针的话这条腿
  // 要白等满 240 秒，而人看到的就是「卡住了」。
  //
  // 卡死**不等于**会话没了：实测导航到 about:blank 就能把渲染进程救回来，而那
  // 正是每条腿收尾要做的事。所以这里只提前结束当前这条腿，不动浏览器。
  // 连续两次不应答才算数 —— 一次可能只是页面正忙。
  let mut wedged = 0u8;
  let mut wedge_error: Option<String> = None;
  let mut hopeless: Option<HopelessReason> = None;
  let mut target_bridge_pending_since: Option<tokio::time::Instant> = None;
  let mut target_bridge_reloaded = false;
  let mut target_bridge_url: Option<String> = None;
  loop {
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    let touch_summary = tokio::select! {
      summary = read_touch_summary(&profile_id, platform) => Some(summary),
      _ = cancellation_signal(Some(&scheduler.cancel)) => None,
    };
    let Some(touch_summary) = touch_summary else {
      break;
    };
    match touch_summary {
      Ok(now) if now.since(baseline).total() > 0 => {
        terminal_touches = now.since(baseline);
        break;
      }
      Ok(_) => {}
      Err(error) => {
        // Poll failures are observations of nothing, not a new count. Keep the
        // immutable baseline and try again on the next tick.
        log::warn!("Discovery scheduler {error}");
      }
    }
    if tokio::time::Instant::now() >= deadline {
      break;
    }

    // Search-page readiness does not carry across the Phase-A navigation: the
    // target is a new (often cross-origin) document with a fresh content-script
    // injection and MV3/API handshake.  A missed target injection otherwise
    // leaves a healthy renderer with no logs or touch until the full leg
    // timeout.  Give that document the same bounded one-reload contract while
    // retaining the tab-scoped handoff in the service worker.
    let current_url = tokio::select! {
      url = driven_tab_url(profile, driven_tab.as_deref()) => Some(url),
      _ = cancellation_signal(Some(&scheduler.cancel)) => None,
    };
    let Some(current_url) = current_url else {
      break;
    };
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    if let Some(current_url) = current_url {
      let on_target = is_target_page(&slot.url, &current_url);
      if on_target {
        // A blocked item can hop to another target in the same leg.  Each new
        // document gets its own one-reload bootstrap budget; carrying the bool
        // from target A to target B would turn B's first injection miss into an
        // immediate hard failure.
        if target_bridge_url.as_deref() != Some(current_url.as_str()) {
          target_bridge_url = Some(current_url.clone());
          target_bridge_pending_since = None;
          target_bridge_reloaded = false;
        }
        use crate::wayfern_manager::MarineAutomationReadiness;
        let readiness_profile_path = profile_data_path(profile);
        let readiness = tokio::select! {
          result = tokio::time::timeout(
            Duration::from_secs(3),
            crate::wayfern_manager::WayfernManager::instance()
              .marine_automation_readiness(&readiness_profile_path, driven_tab.as_deref()),
          ) => Some(result.unwrap_or(MarineAutomationReadiness::Pending)),
          _ = cancellation_signal(Some(&scheduler.cancel)) => None,
        };
        let Some(readiness) = readiness else {
          break;
        };
        if scheduler.cancel.load(Ordering::SeqCst) {
          break;
        }
        match readiness {
          MarineAutomationReadiness::Ready => target_bridge_pending_since = None,
          MarineAutomationReadiness::Failed(reason) => {
            wedge_error = Some(format!(
              "target Marine extension bootstrap reported failure: {reason}"
            ));
            break;
          }
          MarineAutomationReadiness::Pending => {
            let pending_since =
              *target_bridge_pending_since.get_or_insert_with(tokio::time::Instant::now);
            if pending_since.elapsed() >= EXTENSION_READY_WAIT {
              if target_bridge_reloaded {
                wedge_error = Some(format!(
                  "target Marine discovery bridge did not become ready within {}s after one reload",
                  EXTENSION_READY_WAIT.as_secs()
                ));
                break;
              }
              log::warn!(
                "Discovery: target Marine bridge did not become ready on {platform}; reloading the target once"
              );
              if let Err(error) =
                navigate_retrying(profile, driven_tab, &current_url, Some(&scheduler.cancel)).await
              {
                wedge_error = Some(format!("target extension bootstrap reload failed: {error}"));
                break;
              }
              target_bridge_reloaded = true;
              target_bridge_pending_since = Some(tokio::time::Instant::now());
              continue;
            }
          }
        }
      } else {
        target_bridge_url = None;
        target_bridge_pending_since = None;
        target_bridge_reloaded = false;
      }
    }
    if let Some(reason) = leg_is_hopeless(&profile_id, platform, leg_started_at) {
      log::info!(
        "Discovery leg {leg_index}/{total_legs}: {platform} cannot continue ({}); ending early",
        reason.message,
      );
      hopeless = Some(reason);
      break;
    }
    let renderer_profile_path = profile_data_path(profile);
    let renderer_responds = tokio::select! {
      responds = crate::wayfern_manager::WayfernManager::instance()
        .renderer_responds(&renderer_profile_path, driven_tab.as_deref()) => Some(responds),
      _ = cancellation_signal(Some(&scheduler.cancel)) => None,
    };
    let Some(renderer_responds) = renderer_responds else {
      break;
    };
    if renderer_responds {
      wedged = 0;
    } else {
      wedged += 1;
      if wedged >= 2 {
        log::warn!(
          "Discovery leg {leg_index}/{total_legs}: renderer stopped responding on {platform}"
        );
        wedge_error = Some("renderer wedged".to_string());
        break;
      }
    }
    tokio::select! {
      _ = tokio::time::sleep(POLL_INTERVAL) => {}
      _ = cancellation_signal(Some(&scheduler.cancel)) => break,
    }
  }

  if scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }

  publish_leg(
    scheduler,
    RunPhase::Closing,
    leg_index,
    total_legs,
    profile,
    platform,
    finished,
  );

  // `publish_leg` is synchronous but still emits through the desktop event
  // layer. Close the tiny loop-check → park gap: if Stop landed there, enter
  // the kill/blank fence directly instead of beginning a normal bounded park.
  if scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }

  // 腿结束 = 把页面停掉，不是把浏览器关掉。
  //
  // 导航到 about:blank 才算真的收尾：页面留在原地的话，它的编排重试阶梯还在跑
  // （最长十几秒），Phase B 更久 —— 那些迟到的动作会 claim 新靶子、抢活动标签页，
  // 还会把 settle 记到下一条腿头上。about:blank 一到，整个文档连同它的定时器
  // 一起消失，效果等价于以前那次 kill，但浏览器活着给下一个平台用。
  //
  // 顺手再收一次页签：平台自己可能开过新标签页（外链、播放页）。
  let close_error =
    match navigate_retrying(profile, driven_tab, "about:blank", Some(&scheduler.cancel)).await {
      Ok(()) => {
        // 等渲染进程真的空下来再交给下一条腿。
        //
        // 上面的 commit 校验只证明 URL 已经切到 about:blank，不代表旧的重型 SPA
        // 已经完成拆卸。B 站/抖音 加上注入脚本，卸载会继续占住渲染进程一会儿 ——
        // 下一条腿若立刻导航，仍可能撞上一个不应答的 renderer。
        //
        // 实测规律干净得没有歧义：上一条腿**真发出去了**（B站、抖音）→ 下一次导航
        // 必超时；上一条腿立刻失败、根本没干活（知乎那次）→ 下一次导航正常。
        if !scheduler.cancel.load(Ordering::SeqCst) {
          wait_until_idle(
            profile,
            driven_tab.as_deref(),
            "after parking the page",
            Some(&scheduler.cancel),
          )
          .await;
          *driven_tab = sweep_tabs(profile, driven_tab.as_deref()).await;
        }
        None
      }
      Err(e) => {
        log::warn!("Discovery leg could not park profile {}: {e}", profile.name);
        Some(e)
      }
    };

  // Stop may land while the bounded about:blank navigation / idle wait is in
  // flight. The document is already parked if that succeeded, but any claim it
  // owned still needs the same conservative Skipped/Unconfirmed settlement.
  if scheduler.cancel.load(Ordering::SeqCst) {
    return finish_cancelled_leg(
      app_handle,
      scheduler,
      profile,
      platform,
      leg_index,
      total_legs,
      finished,
      &profile_id,
      leg_started_at,
      baseline,
      base,
      session,
      driven_tab,
    )
    .await;
  }

  let outcome = if let Some(outcome) = terminal_touches.outcome() {
    outcome
  } else if let Some(reason) = hopeless {
    reason.outcome()
  } else if wedge_error.is_some() {
    // 卡死和「没找到可发的靶子」是两回事，别混成同一个 TimedOut ——
    // 后者是正常的，前者是页面出事了，混在一起就看不出该去查什么。
    LegOutcome::Failed
  } else {
    LegOutcome::TimedOut
  };
  // park 失败只说明这个会话不该再用，不说明这个 profile 不能碰 —— 补救是退役 +
  // 冷启动，而那本来就是每个 profile 第一条腿的形态。只有渲染进程不应答
  // (`wedge_error`) 才算中毒，才该动用重启预算。
  let session_unusable = wedge_error.is_some() || close_error.is_some();
  let session_poisoned = wedge_error.is_some();
  let report_error = wedge_error
    .or_else(|| hopeless.map(|r| r.message.to_string()))
    .or(close_error)
    .or_else(|| terminal_touch_error(&profile_id, platform, leg_started_at, outcome))
    // 最低优先级：只有在没有任何其它解释、而且这条腿确实什么都没做成时才写。
    // 否则「窗口没到前台」会盖掉真正的原因。
    .or_else(|| focus_hint(focused, terminal_touches.total()));

  // 发出去了就等于登录有效 —— 比任何探测都硬。顺手把这个平台的掉登录标记清掉，
  // 否则「只报失败」的设计会让标记变成永久的：人补了登录，界面还是红的。
  if outcome == LegOutcome::Posted {
    if let Err(e) = super::login_status::LOGIN_STATUS.clear_platform(&profile_id, platform) {
      log::warn!("Could not clear Marine login flag: {e}");
    }
  }

  // 把 `report_error` 一起写出来。
  //
  // 它是这条腿**唯一可行动的**那句话（扩展报上来的真实失败原因、没登录、窗口没到
  // 前台……），此前只塞进上报结构给界面看，从不落盘。结果就是运维在 Marine.log 里
  // 只能看到 `→ Failed`，得去界面里逐条悬停才知道为什么 —— 而界面只显示最近一轮。
  //
  // 实测一次 7 小时的运行有 332 条腿结束，其中 141 条没有任何可解释的痕迹。
  log::info!(
    "Discovery leg {leg_index}/{total_legs} finished: {} on {platform} → {outcome:?} ({} terminal touch(es)){}",
    profile.name,
    terminal_touches.total(),
    report_error
      .as_deref()
      .map(|reason| format!("：{reason}"))
      .unwrap_or_default(),
  );

  LegExecution {
    report: LegReport {
      outcome,
      settled_count: terminal_touches.total(),
      error: report_error,
      ..base
    },
    session_unusable,
    session_poisoned,
    retry_on_fresh_session: false,
    pending_cancel_cleanup: None,
  }
}

#[allow(clippy::too_many_arguments)]
/// Why a leg that settled nothing may have been doomed before it started.
///
/// Only speaks up when the window never reached the foreground *and* the leg
/// achieved nothing — otherwise it would bury the real reason. Bilibili is the
/// platform that actually needs system focus, but the hint is not filtered by
/// platform: "which platforms need focus" is exactly the kind of predicate this
/// codebase has already been bitten by spreading across several places.
fn focus_hint(focused: bool, settled: usize) -> Option<String> {
  (!focused && settled == 0).then(|| {
    "window never reached the foreground (OS refused focus); on Bilibili the comment box does \
     not render without it"
      .to_string()
  })
}

fn publish_leg(
  scheduler: &DiscoveryScheduler,
  phase: RunPhase,
  leg_index: usize,
  total_legs: usize,
  profile: &BrowserProfile,
  platform: &str,
  finished: &[LegReport],
) {
  scheduler.publish(RunProgress {
    running: true,
    leg_index,
    total_legs,
    current_profile_id: Some(profile.id.to_string()),
    current_profile_name: Some(profile.name.clone()),
    current_platform: Some(platform.to_string()),
    phase,
    finished: finished.to_vec(),
  });
}

fn publish_phase(
  scheduler: &DiscoveryScheduler,
  phase: RunPhase,
  leg_index: usize,
  total_legs: usize,
  profile: Option<&BrowserProfile>,
  platform: Option<&str>,
  finished: &[LegReport],
) {
  scheduler.publish(RunProgress {
    running: true,
    leg_index,
    total_legs,
    current_profile_id: profile.map(|p| p.id.to_string()),
    current_profile_name: profile.map(|p| p.name.clone()),
    current_platform: platform.map(|s| s.to_string()),
    phase,
    finished: finished.to_vec(),
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rec(
    platform: &str,
    touches: &[(&str, super::super::prospect::ProspectState)],
  ) -> super::super::prospect::ProspectRecord {
    super::super::prospect::ProspectRecord {
      key: format!("{platform}:x"),
      platform: platform.to_string(),
      item_id: "x".to_string(),
      thread_hint: None,
      title: String::new(),
      open_url: "https://example.test/x".to_string(),
      open_url_durability: super::super::prospect::Durability::Permanent,
      resolved_at: 0,
      first_seen_at: 0,
      keywords: Vec::new(),
      state: super::super::prospect::ProspectState::Seen,
      claimed_by: None,
      claimed_at: None,
      send_started_at: None,
      touches: touches
        .iter()
        .map(|(pid, st)| super::super::prospect::AccountTouch {
          profile_id: pid.to_string(),
          state: *st,
          at: 0,
          pre_send: false,
        })
        .collect(),
    }
  }

  // 多个平台跑在同一个浏览器会话里之后，上一个平台迟到的 settle 会落进下一条腿
  // 的观察窗口。不按平台过滤的话，下一条腿会把别人的成果当成自己的：它立刻
  // 「完成」、根本没去发那个平台，而报表上是一条漂亮的 Settled。
  #[test]
  fn touches_are_counted_per_platform_not_just_per_profile() {
    use super::super::prospect::ProspectState;
    let records = vec![
      rec("bilibili", &[("p1", ProspectState::Posted)]),
      rec("zhihu", &[("p1", ProspectState::Posted)]),
      rec("xiaohongshu", &[]),
    ];
    assert_eq!(summarize_leg_touches(&records, "p1", "bilibili").posted, 1);
    assert_eq!(summarize_leg_touches(&records, "p1", "zhihu").posted, 1);
    assert_eq!(
      summarize_leg_touches(&records, "p1", "xiaohongshu").total(),
      0,
      "小红书这条腿一个 touch 都没有 —— B站和知乎的成果绝不能算到它头上"
    );
    assert_eq!(
      summarize_leg_touches(&records, "p2", "bilibili").total(),
      0,
      "别的账号的 touch 不算"
    );
  }

  // Blocked 不结束腿：扩展会立刻换一条靶子继续跑（见 touch_ends_leg）。
  #[test]
  fn blocked_touches_do_not_end_a_leg() {
    use super::super::prospect::ProspectState;
    let records = vec![rec("bilibili", &[("p1", ProspectState::Blocked)])];
    assert_eq!(summarize_leg_touches(&records, "p1", "bilibili").total(), 0);
  }

  #[test]
  fn terminal_touch_states_are_not_collapsed_into_success() {
    use super::super::prospect::ProspectState as S;
    for (state, outcome) in [
      (S::Posted, LegOutcome::Posted),
      (S::Unconfirmed, LegOutcome::Unconfirmed),
      (S::Filled, LegOutcome::Filled),
      (S::Failed, LegOutcome::Failed),
      (S::Skipped, LegOutcome::Skipped),
    ] {
      let records = vec![rec("zhihu", &[("p1", state)])];
      let summary = summarize_leg_touches(&records, "p1", "zhihu");
      assert_eq!(summary.total(), 1);
      assert_eq!(summary.outcome(), Some(outcome));
    }

    let records = vec![rec("zhihu", &[("p1", S::Failed), ("p1", S::Posted)])];
    assert_eq!(
      summarize_leg_touches(&records, "p1", "zhihu").outcome(),
      Some(LegOutcome::Posted),
      "a confirmed post must win over a racing failure touch"
    );

    let records = vec![rec("zhihu", &[("p1", S::Posted), ("p1", S::Unconfirmed)])];
    assert_eq!(
      summarize_leg_touches(&records, "p1", "zhihu").outcome(),
      Some(LegOutcome::Unconfirmed),
      "an uncertain public action is the safest state to surface"
    );
  }

  #[test]
  fn bootstrap_retry_requires_zero_ingest_claim_or_touch_activity() {
    use super::super::prospect::ProspectState as S;
    let since = 100;

    let untouched = vec![rec("zhihu", &[])];
    assert!(!leg_has_activity_since(&untouched, "p1", "zhihu", since));

    let mut ingested = rec("zhihu", &[]);
    ingested.resolved_at = since;
    assert!(leg_has_activity_since(&[ingested], "p1", "zhihu", since));

    let mut claimed = rec("zhihu", &[]);
    claimed.state = S::Claimed;
    claimed.claimed_by = Some("p1".to_string());
    claimed.claimed_at = Some(since + 1);
    assert!(leg_has_activity_since(&[claimed], "p1", "zhihu", since));

    let mut touched = rec("zhihu", &[("p1", S::Failed)]);
    touched.touches[0].at = since + 1;
    assert!(leg_has_activity_since(&[touched], "p1", "zhihu", since));

    let mut another_profile = rec("zhihu", &[("p2", S::Failed)]);
    another_profile.touches[0].at = since + 1;
    assert!(!leg_has_activity_since(
      &[another_profile],
      "p1",
      "zhihu",
      since
    ));
  }

  #[test]
  fn only_pre_work_bootstrap_failure_retries_the_same_platform() {
    let profile = wayfern_profile("one", None);
    let report = report_for(&profile, "zhihu", LegOutcome::Failed, None);
    let bootstrap = LegExecution::bootstrap_failure(report.clone(), true);
    // park 失败退役会话就够了，不该动用预算 —— 否则一条**发布成功**的腿会害死
    // 它后面的所有平台，这正是用户报的那个现象。
    assert!(!consumes_session_restart(false, 3, false));
    // 渲染进程不应答才算中毒。
    assert!(consumes_session_restart(true, 3, false));
    // 最后一个平台之后没有东西可救，不必花预算。
    assert!(!consumes_session_restart(true, 0, false));
    // 已经在停机，别再重启浏览器。
    assert!(!consumes_session_restart(true, 3, true));

    assert!(should_retry_on_fresh_session(&bootstrap, 1, false));
    assert!(!should_retry_on_fresh_session(&bootstrap, 0, false));
    assert!(!should_retry_on_fresh_session(&bootstrap, 1, true));

    let unsafe_bootstrap = LegExecution::bootstrap_failure(report.clone(), false);
    assert!(!should_retry_on_fresh_session(&unsafe_bootstrap, 1, false));
    let business_or_navigation_failure = LegExecution::unusable(report);
    assert!(!should_retry_on_fresh_session(
      &business_or_navigation_failure,
      1,
      false
    ));
  }

  #[test]
  fn failed_close_keeps_the_owned_session_and_blocks_a_second_launch() {
    let original = wayfern_profile("owned", None);
    let original_id = original.id;
    let mut session = Some(original);
    let mut driven_tab = Some("tab-1".to_string());

    apply_session_close_result(&mut session, &mut driven_tab, false);
    assert_eq!(
      session.as_ref().map(|profile| profile.id),
      Some(original_id)
    );
    assert_eq!(driven_tab.as_deref(), Some("tab-1"));

    apply_session_close_result(&mut session, &mut driven_tab, true);
    assert!(session.is_none());
    assert!(driven_tab.is_none());
  }

  #[test]
  fn failed_close_skips_the_settle_delay_so_cancellation_can_park_immediately() {
    assert!(close_needs_settle_delay(&Ok(())));
    assert!(!close_needs_settle_delay(&Err("still running".to_string())));
  }

  #[test]
  fn only_explicit_quiescence_can_navigate_after_stop() {
    let cancel = AtomicBool::new(true);
    assert!(
      reject_cancelled_navigation(Some(&cancel), "https://www.zhihu.com/search?q=marine").is_err()
    );
    assert!(reject_cancelled_navigation(Some(&cancel), "about:blank").is_err());
    assert!(reject_cancelled_navigation(None, "about:blank").is_ok());
    assert!(reject_cancelled_navigation(None, "https://example.test").is_ok());
  }

  // 这条是整个「清页签」里唯一真正危险的失败模式：Chromium 关掉最后一个标签页
  // 会退出整个浏览器，而浏览器一没，这个会话后面的平台全废。
  #[test]
  fn sweeping_never_closes_the_last_tab() {
    let one = vec!["t1".to_string()];
    let (keep, close) = plan_sweep(&one, None).unwrap();
    assert_eq!(keep, "t1");
    assert!(close.is_empty(), "只剩一个页签时绝不能产生关闭动作");

    let (keep, close) = plan_sweep(&one, Some("t1")).unwrap();
    assert_eq!(keep, "t1");
    assert!(close.is_empty());
  }

  #[test]
  fn sweeping_keeps_the_driven_tab_and_closes_the_rest() {
    let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let (keep, mut close) = plan_sweep(&ids, Some("b")).unwrap();
    close.sort();
    assert_eq!(keep, "b");
    assert_eq!(close, vec!["a".to_string(), "c".to_string()]);
  }

  // 用户手动关掉了我们驱动的那个页签 —— 换第一个继续，不该判会话失效。
  #[test]
  fn sweeping_falls_back_when_the_driven_tab_is_gone() {
    let ids = vec!["a".to_string(), "b".to_string()];
    let (keep, close) = plan_sweep(&ids, Some("vanished")).unwrap();
    assert_eq!(keep, "a");
    assert_eq!(close, vec!["b".to_string()]);
  }

  #[test]
  fn sweeping_a_browser_with_no_tabs_plans_nothing() {
    assert!(plan_sweep(&[], Some("a")).is_none());
  }

  #[test]
  fn navigation_commit_ignores_tracking_but_not_the_campaign_keyword() {
    assert!(navigation_reached(
      "https://search.bilibili.com/all?keyword=%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7",
      "https://search.bilibili.com/all?from_source=webtop_search&keyword=%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7",
    ));
    assert!(!navigation_reached(
      "https://www.zhihu.com/search?q=marine&type=content",
      "https://www.zhihu.com/search?q=other&type=content",
    ));
    assert!(!navigation_reached(
      "https://search.bilibili.com/all?keyword=marine&order=click",
      "https://search.bilibili.com/all?keyword=marine&order=pubdate",
    ));
    assert!(!navigation_reached(
      "https://www.zhihu.com/search?q=marine&type=content&sort=created_time",
      "https://www.zhihu.com/search?q=marine&type=content&sort=upvoted_count",
    ));
    assert!(!navigation_reached(
      "https://www.douyin.com/search/marine",
      "https://www.douyin.com/jingxuan",
    ));
    assert!(navigation_reached("about:blank", "about:blank"));
  }

  /// 这条腿的实际形态：预热 URL 只写了 origin，小红书把首页重定向到 `/explore`。
  /// `navigation_reached` 判 false 是**对的**（它是「到没到这一页」），
  /// 错的是拿它去当提交判定 —— 于是 53/53 条小红书腿白等两个提交窗口。
  #[test]
  fn warm_up_commit_accepts_the_platform_landing_page() {
    let warm_up = super::super::search_slot::slot_for("xiaohongshu", "科研工具", 0)
      .expect("xiaohongshu has slots")
      .warmup_url
      .expect("xiaohongshu has a warm-up page");
    assert_eq!(warm_up, "https://www.xiaohongshu.com/");

    // 今天的形态：严格判定说没到，提交判定说到了。
    assert!(!navigation_reached(
      &warm_up,
      "https://www.xiaohongshu.com/explore"
    ));
    assert!(navigation_committed(
      &warm_up,
      "https://www.xiaohongshu.com/explore"
    ));
    assert!(navigation_committed(
      &warm_up,
      "https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend"
    ));
    // 落地页哪天再搬家也不用改代码 —— 这正是不写死 `/explore` 的原因。
    assert!(navigation_committed(
      &warm_up,
      "https://www.xiaohongshu.com/some/new/home"
    ));
  }

  /// 放宽只对「没指定路径」的 URL 生效。搜索页的判定必须一个字节都没松。
  #[test]
  fn warm_up_relaxation_never_loosens_a_search_url() {
    for (expected, actual) in [
      // 别的平台的搜索页 —— 路径非空，照旧严格。
      (
        "https://www.douyin.com/search/marine",
        "https://www.douyin.com/jingxuan",
      ),
      (
        "https://search.bilibili.com/all?keyword=marine&order=click",
        "https://search.bilibili.com/all?keyword=marine&order=pubdate",
      ),
      (
        "https://www.zhihu.com/search?q=marine&type=content",
        "https://www.zhihu.com/search?q=other&type=content",
      ),
      (
        "https://www.zhihu.com/search?q=marine&type=content&sort=created_time",
        "https://www.zhihu.com/search?q=marine&type=content&sort=upvoted_count",
      ),
      (
        "https://www.xiaohongshu.com/search_result?keyword=marine",
        "https://www.xiaohongshu.com/explore",
      ),
      // 跨 origin 的弹转（登录墙、验证码域名）不算提交。
      (
        "https://www.xiaohongshu.com/",
        "https://passport.xiaohongshu.com/login",
      ),
      (
        "https://www.bilibili.com/",
        "https://passport.bilibili.com/login",
      ),
      // 空白页不是任何平台页；空 URL / 解析不了的 URL 也不是。
      ("https://www.xiaohongshu.com/", "about:blank"),
      ("https://www.xiaohongshu.com/", ""),
      ("about:blank", "https://www.xiaohongshu.com/"),
      // 只有 origin 但带了查询参数，说明调用方要的是具体一页。
      (
        "https://www.example.com/?tab=x",
        "https://www.example.com/other",
      ),
    ] {
      assert!(
        !navigation_committed(expected, actual),
        "{expected} must not be considered committed at {actual}"
      );
    }
  }

  /// 四个平台的真实搜索 URL 都必须能被自己精确命中，也都必须自带路径 ——
  /// 后者正是「放宽只影响预热页」这个结论的前提。
  #[test]
  fn every_search_slot_url_carries_a_path() {
    for platform in ["bilibili", "zhihu", "douyin", "xiaohongshu"] {
      let slot = super::super::search_slot::slot_for(platform, "科研工具", 0)
        .unwrap_or_else(|| panic!("{platform} has slots"));
      let parsed = url::Url::parse(&slot.url).expect("slot url parses");
      assert!(
        !parsed.path().trim_end_matches('/').is_empty(),
        "{platform}: {} 没有路径，放宽会把它一起放松",
        slot.url
      );
      assert!(navigation_committed(&slot.url, &slot.url));
    }
  }

  /// `/json` 对一个刚建好的 target 会报空 URL。它不该被当成「已经在靶子页上」——
  /// 那条路会拿空串去导航，两次失败之后把整个会话判成不可用。
  #[test]
  fn a_blank_or_empty_tab_is_not_the_claimed_target() {
    let search = "https://www.xiaohongshu.com/search_result?keyword=marine";
    assert!(!is_target_page(search, ""));
    assert!(!is_target_page(search, "about:blank"));
    assert!(!is_target_page(search, search));
    // 真的跳到笔记详情页了才算。
    assert!(is_target_page(
      search,
      "https://www.xiaohongshu.com/explore/68b0c0ff000000001b0212ab"
    ));
  }

  #[test]
  fn profile_pause_stays_inside_its_range() {
    for _ in 0..200 {
      let prof = pause_secs(PROFILE_PAUSE_SECS);
      assert!((PROFILE_PAUSE_SECS.0..=PROFILE_PAUSE_SECS.1).contains(&prof));
    }
  }

  #[test]
  fn a_second_run_cannot_start_while_one_is_in_flight() {
    let s = DiscoveryScheduler::new();
    assert!(!s.is_running());
    assert!(s
      .running
      .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
      .is_ok());
    assert!(s
      .running
      .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
      .is_err());
    s.running.store(false, Ordering::SeqCst);
    assert!(s
      .running
      .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
      .is_ok());
  }

  #[test]
  fn idle_snapshot_before_any_run() {
    let s = DiscoveryScheduler::new();
    let p = s.snapshot();
    assert!(!p.running);
    assert_eq!(p.phase, RunPhase::Idle);
    assert!(p.finished.is_empty());
  }

  /// 歇轮期按 Stop 曾经会把界面锁死：最后发出去的进度是 `Pausing { running: true }`，
  /// 而它同时也是快照，所以刷新页面都救不回来，只能重启应用。
  #[test]
  fn stopping_during_the_between_cycle_rest_unlocks_the_ui() {
    let s = DiscoveryScheduler::new();
    publish_phase(&s, RunPhase::Pausing, 4, 4, None, None, &[]);
    assert!(s.snapshot().running);

    s.request_cancel();
    drop(RunClaim { scheduler: &s });

    let p = s.snapshot();
    assert!(!p.running);
    assert_eq!(p.phase, RunPhase::Cancelled);
  }

  #[test]
  fn a_run_that_ends_on_its_own_reports_done() {
    let s = DiscoveryScheduler::new();
    publish_phase(&s, RunPhase::Pausing, 4, 4, None, None, &[]);
    drop(RunClaim { scheduler: &s });

    let p = s.snapshot();
    assert!(!p.running);
    assert_eq!(p.phase, RunPhase::Done);
  }

  #[test]
  fn cycle_done_does_not_unlock_start_before_the_run_claim_is_released() {
    let s = DiscoveryScheduler::new();
    s.running.store(true, Ordering::SeqCst);
    publish_phase(&s, RunPhase::Done, 1, 1, None, None, &[]);
    assert!(s.snapshot().running);
    assert!(s.is_running());

    drop(RunClaim { scheduler: &s });
    assert!(!s.snapshot().running);
    assert!(!s.is_running());
  }

  /// 终态进度得保住这一轮的成果，否则界面在收尾时把刚跑完的腿全抹掉。
  #[test]
  fn the_terminal_progress_keeps_the_leg_reports() {
    let s = DiscoveryScheduler::new();
    let reports = vec![LegReport {
      profile_id: "p1".to_string(),
      profile_name: "one".to_string(),
      platform: "bilibili".to_string(),
      outcome: LegOutcome::Posted,
      settled_count: 1,
      error: None,
    }];
    publish_phase(&s, RunPhase::Pausing, 1, 1, None, None, &reports);

    drop(RunClaim { scheduler: &s });

    let p = s.snapshot();
    assert_eq!(p.finished.len(), 1);
    assert_eq!(p.total_legs, 1);
    assert!(p.current_profile_id.is_none());
  }

  /// 释放认领和发终态是一件事：中间任何一个窗口都会让下一次 Start 撞上
  /// `ALREADY_RUNNING`，而界面此时已经把 Start 按钮放出来了。
  #[test]
  fn the_claim_is_released_even_if_the_run_panics() {
    let s = DiscoveryScheduler::new();
    s.running.store(true, Ordering::SeqCst);

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
      let _claim = RunClaim { scheduler: &s };
      panic!("leg exploded");
    }));

    assert!(outcome.is_err());
    assert!(!s.is_running());
    assert!(!s.snapshot().running);
  }

  #[test]
  fn a_cycle_gap_too_large_to_multiply_is_clamped_instead_of_overflowing() {
    assert_eq!(cycle_gap(None), None);
    assert_eq!(cycle_gap(Some(0)), None);
    assert_eq!(cycle_gap(Some(30)), Some(Duration::from_secs(1800)));
    assert_eq!(
      cycle_gap(Some(u64::MAX)),
      Some(Duration::from_secs(MAX_CYCLE_GAP_MINUTES * 60))
    );
  }

  #[test]
  fn all_failed_cycles_reach_the_cutoff_but_normal_or_cancelled_cycles_reset_it() {
    let profile = wayfern_profile("one", None);
    let all_failed = vec![
      report_for(&profile, "zhihu", LegOutcome::Failed, Some("boom".into())),
      report_for(&profile, "douyin", LegOutcome::Failed, Some("boom".into())),
    ];
    let mut failures = 0;
    for expected in 1..=MAX_CONSECUTIVE_CYCLE_FAILURES {
      failures = next_cycle_failure_count(failures, &all_failed, false);
      assert_eq!(failures, expected);
    }
    assert_eq!(failures, MAX_CONSECUTIVE_CYCLE_FAILURES);

    let normal = vec![report_for(&profile, "zhihu", LegOutcome::TimedOut, None)];
    assert_eq!(next_cycle_failure_count(failures, &normal, false), 0);
    assert_eq!(next_cycle_failure_count(failures, &all_failed, true), 0);
    assert_eq!(next_cycle_failure_count(failures, &[], false), 0);
  }

  #[test]
  fn hopeless_statuses_distinguish_normal_no_work_from_system_failure() {
    for status in [
      "not_logged_in",
      "nothing_to_claim",
      "blocked_nothing_left",
      "blocked_hop_limit",
    ] {
      let message = format!(r#"{{"status":"{status}"}}"#);
      let reason = classify_hopeless_message(&message).unwrap();
      assert_eq!(reason.kind, HopelessKind::NoWork, "{status}");
      assert_eq!(reason.outcome(), LegOutcome::NoWork, "{status}");
    }

    for status in [
      "no_profile_id",
      "handoff_write_failed",
      "handoff_in_progress",
      "target_navigation_stalled",
      "handoff_url_mismatch",
      "aborted_no_context",
      "blocked_no_hop",
      "blocked_hop_failed",
      "handoff_read_failed",
      "handoff_expired",
      "handoff_redirect_persist_failed",
      "send_guard_persist_failed",
      "send_already_started",
      "target_changed_before_send",
      "prospect_bootstrap_failed",
      "target_bootstrap_failed",
    ] {
      let message = format!(r#"{{"status":"{status}"}}"#);
      let reason = classify_hopeless_message(&message).unwrap();
      assert_eq!(reason.kind, HopelessKind::SystemFailure, "{status}");
      assert_eq!(reason.outcome(), LegOutcome::Failed, "{status}");
    }

    assert_eq!(
      classify_hopeless_message(r#"{"status":"settle_failed","recoverable":false}"#)
        .unwrap()
        .kind,
      HopelessKind::SystemFailure
    );
    assert!(
      classify_hopeless_message(r#"{"status":"settle_failed","recoverable":true}"#).is_none()
    );
    assert_eq!(
      classify_hopeless_message(r#"Marine retry [6/6] {"status":"empty"}"#)
        .unwrap()
        .kind,
      HopelessKind::SystemFailure
    );
  }

  #[test]
  fn cancel_is_sticky_until_the_next_run_clears_it() {
    let s = DiscoveryScheduler::new();
    assert!(!s.cancel.load(Ordering::SeqCst));
    s.request_cancel();
    assert!(s.cancel.load(Ordering::SeqCst));
  }

  /// The rule `resolve_profiles` implements: index by position in the sorted
  /// set of ALL discovery-capable profiles.
  ///
  /// Reproduced here rather than exercised through `resolve_profiles`, which
  /// reads the real profile directory. The property under test is that the
  /// index does not depend on directory order. The enabled-subset property is
  /// exercised through `resolve_from` below.
  fn stable_index(universe_unsorted: &[&str], id: &str) -> Option<usize> {
    let mut sorted: Vec<&str> = universe_unsorted.to_vec();
    sorted.sort_unstable();
    sorted.iter().position(|u| *u == id)
  }

  #[test]
  fn account_index_ignores_directory_order() {
    // `list_profiles()` returns raw read_dir order. Two machines enumerating the
    // same profiles in different orders must still agree on the slot.
    let one = ["ccc", "aaa", "bbb"];
    let other = ["bbb", "ccc", "aaa"];
    for id in ["aaa", "bbb", "ccc"] {
      assert_eq!(stable_index(&one, id), stable_index(&other, id));
    }
    assert_eq!(stable_index(&one, "aaa"), Some(0));
    assert_eq!(stable_index(&one, "ccc"), Some(2));
  }

  #[test]
  fn account_index_ignores_which_other_profiles_are_enabled() {
    // The regression this pins: indexing only the enabled subset would make a
    // profile change search sort whenever another profile gained or lost its
    // platform configuration.
    let mut first = wayfern_profile("first", None);
    first.id = uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
    let mut middle = wayfern_profile("middle", None);
    middle.id = uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap();
    let mut last = with_platforms(wayfern_profile("last", None), &["bilibili"]);
    last.id = uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap();

    let alone = resolve_from(&[last.clone(), first.clone(), middle.clone()]);
    let alone_index = alone
      .iter()
      .find(|item| item.profile.id == last.id)
      .unwrap()
      .account_index;
    assert_eq!(alone_index, 2);

    first.marine_platforms = vec!["zhihu".to_string()];
    let together = resolve_from(&[middle, last.clone(), first]);
    let together_index = together
      .iter()
      .find(|item| item.profile.id == last.id)
      .unwrap()
      .account_index;
    assert_eq!(together_index, 2);

    let idx = together_index;
    let alone = super::super::search_slot::slot_for("bilibili", "科研工具", idx).unwrap();
    let together = super::super::search_slot::slot_for("bilibili", "科研工具", idx).unwrap();
    assert_eq!(alone.url, together.url);
    // Sanity: distinct indices really do produce distinct sorts, or the
    // stability guarantee above would be vacuous.
    let other = super::super::search_slot::slot_for("bilibili", "科研工具", 0).unwrap();
    assert_ne!(alone.url, other.url);
  }

  #[test]
  fn a_blocked_touch_does_not_end_the_leg() {
    use super::super::prospect::ProspectState as S;
    // Blocked 之后扩展会立刻换一条靶子继续跑。把它算成完成，浏览器会在换靶子
    // 后一秒被关掉 —— 正好毁掉换靶子要挽回的那条腿。
    assert!(!touch_ends_leg(S::Blocked));
    for s in [S::Posted, S::Filled, S::Failed, S::Skipped] {
      assert!(touch_ends_leg(s), "{s:?} 是终局，应该结束这条腿");
    }
  }

  #[test]
  fn only_wayfern_can_host_the_discovery_extension() {
    // The discovery pipeline IS the MV3 extension, and the extension is only
    // stamped into Wayfern profiles. Letting a Camoufox profile into a run
    // produced a leg that idled out its whole timeout and reported "nothing
    // settled" — indistinguishable from "not logged in".
    assert!(engine_supports_discovery("wayfern"));
    assert!(!engine_supports_discovery("camoufox"));
    assert!(!engine_supports_discovery("firefox"));
    assert!(!engine_supports_discovery("chromium"));
  }

  #[tokio::test]
  async fn a_pause_gives_up_promptly_once_cancel_is_set() {
    // A plain sleep made Stop look dead for up to 75 s.
    let s = DiscoveryScheduler::new();
    s.request_cancel();
    let start = tokio::time::Instant::now();
    interruptible_pause(&s, Duration::from_secs(60)).await;
    assert!(
      start.elapsed() < Duration::from_secs(2),
      "cancel should cut the pause short, took {:?}",
      start.elapsed()
    );
  }

  #[tokio::test]
  async fn a_pause_without_cancel_runs_its_full_length() {
    let s = DiscoveryScheduler::new();
    let start = tokio::time::Instant::now();
    interruptible_pause(&s, Duration::from_millis(1200)).await;
    assert!(
      start.elapsed() >= Duration::from_millis(1100),
      "pause ended early at {:?}",
      start.elapsed()
    );
  }

  #[test]
  fn unsupported_platform_yields_no_slot_rather_than_a_guess() {
    assert!(super::super::search_slot::slot_for("weibo", "科研工具", 0).is_none());
  }

  #[test]
  fn run_request_deserialises_without_the_optional_timeout() {
    let r: RunRequest = serde_json::from_str(r#"{"keyword":"科研工具"}"#).unwrap();
    assert_eq!(r.leg_timeout_secs, None);
    assert_eq!(r.cycle_gap_minutes, None);
    assert_eq!(r.keyword, "科研工具");
  }

  #[test]
  fn leg_outcomes_serialise_as_snake_case() {
    // These strings are the UI's lookup keys (marine.prospects.outcome.*), so a
    // rename here silently renders a raw key path to the operator.
    for (value, expected) in [
      (LegOutcome::Posted, "\"posted\""),
      (LegOutcome::Unconfirmed, "\"unconfirmed\""),
      (LegOutcome::Filled, "\"filled\""),
      (LegOutcome::TimedOut, "\"timed_out\""),
      (LegOutcome::NoWork, "\"no_work\""),
      (LegOutcome::NoSlot, "\"no_slot\""),
      (LegOutcome::AlreadyOpen, "\"already_open\""),
      (LegOutcome::Skipped, "\"skipped\""),
      (LegOutcome::Failed, "\"failed\""),
      (LegOutcome::Cancelled, "\"cancelled\""),
    ] {
      assert_eq!(serde_json::to_string(&value).unwrap(), expected);
    }
    for (value, expected) in [
      (RunPhase::Idle, "\"idle\""),
      (RunPhase::Launching, "\"launching\""),
      (RunPhase::Working, "\"working\""),
      (RunPhase::Closing, "\"closing\""),
      (RunPhase::Pausing, "\"pausing\""),
      (RunPhase::Done, "\"done\""),
      (RunPhase::Cancelled, "\"cancelled\""),
    ] {
      assert_eq!(serde_json::to_string(&value).unwrap(), expected);
    }
  }

  fn wayfern_profile(name: &str, host_os: Option<&str>) -> BrowserProfile {
    BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: name.to_string(),
      browser: "wayfern".to_string(),
      version: "1.0".to_string(),
      proxy_id: None,
      vpn_id: None,
      launch_hook: None,
      process_id: None,
      last_launch: None,
      release_type: "stable".to_string(),
      camoufox_config: None,
      wayfern_config: None,
      group_id: None,
      tags: Vec::new(),
      note: None,
      sync_mode: crate::profile::types::SyncMode::Disabled,
      encryption_salt: None,
      last_sync: None,
      host_os: host_os.map(str::to_string),
      ephemeral: false,
      extension_group_id: None,
      brand_id: None,
      marine_platforms: Vec::new(),
      proxy_bypass_rules: Vec::new(),
      created_by_id: None,
      created_by_email: None,
      dns_blocklist: None,
      password_protected: false,
      created_at: None,
      updated_at: None,
      default_bookmarks_seeded: false,
    }
  }

  fn with_platforms(mut profile: BrowserProfile, platforms: &[&str]) -> BrowserProfile {
    profile.marine_platforms = platforms
      .iter()
      .map(|platform| (*platform).to_string())
      .collect();
    profile
  }

  /// 一个必然与当前宿主不同的 OS 名 —— 写死 "macos" 的话，在 macOS 上跑
  /// 这条测试就什么都测不到。
  fn a_foreign_os() -> &'static str {
    if crate::profile::types::get_host_os() == "windows" {
      "macos"
    } else {
      "windows"
    }
  }

  /// 跨 OS 的 profile 现在是**可以**进计划的 —— 启动时会接管到本机。
  ///
  /// 这条以前是硬拒。留着这个测试是为了守住反向：谁要是把那道闸门加回来，
  /// 等于把一批能正常跑的账号永久挡在自动化外面，而且报的还是「不支持」。
  #[test]
  fn a_profile_from_another_os_is_accepted_and_adopted_at_launch() {
    let foreign = with_platforms(
      wayfern_profile("from-elsewhere", Some(a_foreign_os())),
      &["bilibili"],
    );
    let native = with_platforms(wayfern_profile("local", None), &["zhihu"]);
    let all = vec![foreign.clone(), native.clone()];

    let resolved = resolve_from(&all);
    assert_eq!(resolved.len(), 2);
    assert!(resolved.iter().any(|item| item.profile.id == foreign.id));
    assert!(resolved.iter().any(|item| item.profile.id == native.id));
  }

  #[test]
  fn profiles_without_supported_platforms_are_not_resolved() {
    let empty = wayfern_profile("empty", None);
    let unknown = with_platforms(wayfern_profile("unknown", None), &["weibo"]);
    let enabled = with_platforms(wayfern_profile("enabled", None), &["douyin"]);
    let mut wrong_engine = with_platforms(wayfern_profile("firefox", None), &["bilibili"]);
    wrong_engine.browser = "camoufox".to_string();

    let resolved = resolve_from(&[empty, unknown, enabled.clone(), wrong_engine]);
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].profile.id, enabled.id);
    assert_eq!(resolved[0].platforms, vec!["douyin"]);
  }

  #[test]
  fn cancelling_materialises_every_unvisited_profile_platform_leg() {
    let first = with_platforms(
      wayfern_profile("first", None),
      &["zhihu", "douyin", "xiaohongshu"],
    );
    let second = with_platforms(wayfern_profile("second", None), &["zhihu", "douyin"]);
    let plan = resolve_from(&[first, second]);
    assert_eq!(total_legs(&plan), 5);

    let mut reports = Vec::new();
    append_cancelled_profiles(&plan, &mut reports);
    assert_eq!(reports.len(), 5);
    assert!(reports
      .iter()
      .all(|report| report.outcome == LegOutcome::Cancelled));
    assert!(reports.iter().all(|report| report.settled_count == 0));
    assert_eq!(
      reports
        .iter()
        .map(|report| report.platform.as_str())
        .collect::<Vec<_>>(),
      plan
        .iter()
        .flat_map(|resolved| resolved.platforms.iter().map(String::as_str))
        .collect::<Vec<_>>()
    );
  }

  #[test]
  fn each_profile_keeps_its_own_canonical_platform_plan() {
    let one = with_platforms(wayfern_profile("one", None), &["zhihu"]);
    let two = with_platforms(
      wayfern_profile("two", None),
      &["xiaohongshu", "bilibili", "weibo", "bilibili"],
    );

    let resolved = resolve_from(&[two.clone(), one.clone()]);
    assert_eq!(resolved.len(), 2);
    assert_eq!(total_legs(&resolved), 3);

    let one_plan = resolved
      .iter()
      .find(|item| item.profile.id == one.id)
      .unwrap();
    assert_eq!(one_plan.platforms, vec!["zhihu"]);

    let two_plan = resolved
      .iter()
      .find(|item| item.profile.id == two.id)
      .unwrap();
    assert_eq!(
      two_plan.platforms,
      vec!["bilibili".to_string(), "xiaohongshu".to_string()]
    );
  }

  /// 「窗口没到前台」只在**没有别的解释**时才说话，否则会盖掉真正的原因。
  #[test]
  fn the_focus_hint_never_buries_a_real_reason() {
    // 拿到焦点 —— 不管有没有成果都不该有提示。
    assert!(focus_hint(true, 0).is_none());
    assert!(focus_hint(true, 3).is_none());
    // 没拿到焦点但确实发出去了 —— 焦点显然不是问题。
    assert!(focus_hint(false, 1).is_none());
    // 没拿到焦点且颗粒无收 —— 这才是那条被伪装成「找不到输入框」的环境失败。
    let hint = focus_hint(false, 0).expect("应当给出提示");
    assert!(hint.contains("foreground"));
    assert!(hint.contains("Bilibili"));
  }
}
