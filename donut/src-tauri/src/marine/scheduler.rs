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
  /// Which profiles to work. This is a *selection*, not an ordering: the
  /// search-slot `account_index` is derived in [`resolve_profiles`] from a
  /// stable global position, deliberately not from this list, so that ticking a
  /// different set of profiles cannot reshuffle an account's search sort.
  pub profile_ids: Vec<String>,
  /// Platforms to visit within each profile, in order.
  pub platforms: Vec<String>,
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
  /// The extension settled at least one item for this profile.
  Settled,
  /// Nothing was settled within the timeout. Also the normal outcome when the
  /// profile is not logged in on that platform, or when the ledger had nothing
  /// eligible left for it.
  TimedOut,
  /// The platform has no search slot (unsupported platform), so there was
  /// nothing to launch. Not an error.
  NoSlot,
  /// The profile was already running, so the leg was skipped rather than
  /// hijacking — and later closing — a window the operator opened themselves.
  AlreadyOpen,
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
  /// Touches this profile gained during the leg. Zero for every non-`Settled`
  /// outcome.
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

  /// Ask the in-flight run to stop after the current leg's browser is closed.
  ///
  /// Deliberately not a hard abort: killing mid-leg would leave a claimed item
  /// with no terminal touch, which the ledger would only release after its
  /// stale-claim TTL.
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
/// **必须按平台过滤**，这是单会话编排引入的要求：一个浏览器连着跑四个平台时，
/// 上一个平台迟到的 settle 会落在下一条腿的观察窗口里。只按 profile 计数的话，
/// 下一条腿会把别人的成果当成自己的 —— 它会立刻「完成」、根本没去发那个平台的
/// 评论，而报表上是一条漂亮的 Settled。每条腿开关一次浏览器的年代没有这个问题，
/// 所以老代码不过滤是对的。
fn count_leg_touches(
  records: &[super::prospect::ProspectRecord],
  profile_id: &str,
  platform: &str,
) -> usize {
  records
    .iter()
    .filter(|r| r.platform == platform)
    .flat_map(|r| r.touches.iter())
    .filter(|t| t.profile_id == profile_id && touch_ends_leg(t.state))
    .count()
}

async fn read_touch_count(profile_id: &str, platform: &str) -> Result<usize, String> {
  let id = profile_id.to_string();
  let plat = platform.to_string();
  let counted = tokio::task::spawn_blocking(move || {
    super::prospect::PROSPECTS
      .list()
      .map(|records| count_leg_touches(&records, &id, &plat))
  })
  .await;

  counted
    .map_err(|e| format!("prospect ledger read task failed: {e}"))?
    .map_err(|e| format!("could not read the prospect ledger: {e}"))
}

async fn initial_touch_count(profile_id: &str, platform: &str) -> Result<usize, String> {
  let mut last_error = "prospect ledger was not read".to_string();
  for delay in [
    Duration::ZERO,
    Duration::from_millis(100),
    Duration::from_millis(300),
  ] {
    if !delay.is_zero() {
      tokio::time::sleep(delay).await;
    }
    match read_touch_count(profile_id, platform).await {
      Ok(count) => return Ok(count),
      Err(error) => last_error = error,
    }
  }
  Err(last_error)
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
  if request.profile_ids.is_empty() || request.platforms.is_empty() {
    return Err(super::err("MARINE_DISCOVERY_EMPTY_PLAN"));
  }
  if request.keyword.trim().is_empty() {
    return Err(super::err("MARINE_DISCOVERY_EMPTY_KEYWORD"));
  }
  resolve_profiles(&request.profile_ids)?;
  Ok(())
}

/// Resolve the requested ids, and pair each with its **stable** account index.
///
/// The index must not come from the caller's list position. Two things would
/// break if it did, and both were observed:
///
/// * `list_profiles()` returns raw `read_dir` order, which is not sorted and not
///   stable across machines or file operations.
/// * A caller sends only the profiles the operator ticked, so a profile's
///   position — and therefore its search sort — would change depending on which
///   *other* profiles happened to be selected that run.
///
/// Either one defeats the point of slots: `search_slot` assigns a sort by
/// `account_index` precisely so one account keeps one browsing habit run after
/// run. An account that sorts by "most played" one day and "newest" the next
/// looks *less* like a person, not more.
///
/// So the index is this profile's position among **all** discovery-capable
/// profiles sorted by id — independent of selection and of directory order.
/// Errors are already `{ "code": … }` strings: the caller surfaces them to the
/// operator verbatim, and "this profile came from another OS" needs a different
/// remedy (make a new one here and log in again) than "this profile is gone".
fn resolve_profiles(ids: &[String]) -> Result<Vec<(usize, BrowserProfile)>, String> {
  let all = ProfileManager::instance().list_profiles().map_err(|e| {
    log::error!("Discovery could not list profiles: {e}");
    super::err("MARINE_DISCOVERY_PROFILE_NOT_FOUND")
  })?;
  resolve_from(&all, ids)
}

/// The part of [`resolve_profiles`] that does not touch the filesystem.
fn resolve_from(
  all: &[BrowserProfile],
  ids: &[String],
) -> Result<Vec<(usize, BrowserProfile)>, String> {
  let mut universe: Vec<String> = all
    .iter()
    .filter(|p| engine_supports_discovery(&p.browser))
    .map(|p| p.id.to_string())
    .collect();
  universe.sort();

  ids
    .iter()
    .map(|id| {
      let profile = all
        .iter()
        .find(|p| p.id.to_string() == *id)
        .cloned()
        .ok_or_else(|| {
          log::error!("Discovery plan names a profile that no longer exists: {id}");
          super::err("MARINE_DISCOVERY_PROFILE_NOT_FOUND")
        })?;
      if !engine_supports_discovery(&profile.browser) {
        log::error!(
          "Discovery plan names profile {} running {}, which cannot host the extension",
          profile.name,
          profile.browser
        );
        return Err(super::err("MARINE_DISCOVERY_PROFILE_NOT_FOUND"));
      }
      // A profile synced from another OS cannot launch here — `launch_browser`
      // refuses it. Caught up front because the run would otherwise accept the
      // plan and fail every single leg: `run_profile_session` reports a failed
      // leg as `Ok`, so the consecutive-failure cap never trips and a cycling
      // run spins all night producing nothing but burnt candidates.
      if profile.is_cross_os() {
        log::error!(
          "Discovery plan names profile {}, created on another OS; it cannot launch here",
          profile.name
        );
        return Err(super::err_with(
          "MARINE_DISCOVERY_PROFILE_CROSS_OS",
          profile.name.clone(),
        ));
      }
      let account_index = universe.iter().position(|u| u == id).ok_or_else(|| {
        log::error!("Discovery plan names a profile that is not indexable: {id}");
        super::err("MARINE_DISCOVERY_PROFILE_NOT_FOUND")
      })?;
      Ok((account_index, profile))
    })
    .collect()
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
        failures = 0;
        last = reports;
        let posted = last
          .iter()
          .filter(|l| l.outcome == LegOutcome::Settled)
          .count();
        log::info!(
          "Discovery cycle {cycle} finished in {}s ({posted}/{} legs settled); resting {} min",
          started.elapsed().as_secs(),
          last.len(),
          gap.as_secs() / 60,
        );
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
  let profiles = resolve_profiles(&request.profile_ids)?;
  if profiles.is_empty() || request.platforms.is_empty() {
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
  let total_legs = profiles.len() * request.platforms.len();
  let mut finished: Vec<LegReport> = Vec::with_capacity(total_legs);
  let mut leg_index = 0usize;

  let last_profile = profiles.len() - 1;

  for (profile_position, (account_index, profile)) in profiles.iter().enumerate() {
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }

    // 一个 profile = 一个浏览器会话，四个平台跑在里面。
    let keep_going = run_profile_session(
      &app_handle,
      scheduler,
      profile,
      &request.platforms,
      &request.keyword,
      *account_index,
      leg_timeout,
      leg_index,
      total_legs,
      &mut finished,
    )
    .await;
    leg_index += request.platforms.len();
    if !keep_going {
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
  scheduler.publish(RunProgress {
    running: false,
    leg_index,
    total_legs,
    current_profile_id: None,
    current_profile_name: None,
    current_platform: None,
    phase: if cancelled {
      RunPhase::Cancelled
    } else {
      RunPhase::Done
    },
    finished: finished.clone(),
  });
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
/// 之后浏览器正是我们自己开的，再问一次必然答「已在运行」，四个平台会全部
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
  let base = |platform: &str, outcome: LegOutcome, error: Option<String>| LegReport {
    profile_id: profile.id.to_string(),
    profile_name: profile.name.clone(),
    platform: platform.to_string(),
    outcome,
    settled_count: 0,
    error,
  };

  // 会话级：只问一次「操作员是不是已经开着这个 profile」。
  if let Some(err) = profile_is_occupied(app_handle, profile).await {
    // 每个平台都要有一条报告，否则前端的 leg_index/total_legs 对不上 ——
    // total_legs 是按 profiles × platforms 预先算好的。
    for platform in platforms {
      finished.push(base(platform, LegOutcome::AlreadyOpen, err.clone()));
    }
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

  for (platform_index, platform) in platforms.iter().enumerate() {
    let leg_index = leg_base_index + platform_index + 1;

    if scheduler.cancel.load(Ordering::SeqCst) {
      finished.push(base(platform, LegOutcome::Cancelled, None));
      cancelled = true;
      break;
    }

    // 会话还在不在？只用只读探针。
    if session.is_some() && !session_alive(profile).await {
      log::warn!(
        "Discovery: browser session for profile {} is gone",
        profile.name
      );
      close_session(app_handle, session.take()).await;
      driven_tab = None;
      if restarts_left == 0 {
        for rest in &platforms[platform_index..] {
          finished.push(base(
            rest,
            LegOutcome::Failed,
            Some("session lost twice".to_string()),
          ));
        }
        return !scheduler.cancel.load(Ordering::SeqCst);
      }
      restarts_left -= 1;
    }

    let execution = run_leg(
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
    finished.push(execution.report);

    // A CDP page target can survive while its renderer/navigation channel is
    // wedged.  `session_alive` intentionally treats that as alive because it
    // is only a cheap occupancy probe; `run_leg` has stronger evidence from
    // bounded navigation/readiness/parking operations.  Retire that poisoned
    // session now so it cannot make every remaining platform spend another
    // minute failing against the same visible-but-dead window.
    if execution.session_unusable {
      log::warn!(
        "Discovery: retiring unusable browser session for profile {} after {platform}",
        profile.name
      );
      close_session(app_handle, session.take()).await;
      driven_tab = None;
      if platform_index + 1 < platforms.len() {
        if restarts_left == 0 {
          for rest in &platforms[platform_index + 1..] {
            finished.push(base(
              rest,
              LegOutcome::Failed,
              Some("session became unusable twice".to_string()),
            ));
          }
          return !scheduler.cancel.load(Ordering::SeqCst);
        }
        restarts_left -= 1;
      }
    }

    // 平台之间不停顿（运营决定）。
    //
    // 曾经停 8~25 秒，理由是「同一账号短时间连发四个平台」是可识别的节奏。
    // 但代价是实打实的：腿一结束页面就被导航到 about:blank，停顿期间浏览器就
    // 是一个空白页干等 —— 从外面看和卡死完全一样，实际观察中被误判过。
    // 账号之间的停顿保留（换身份是更显眼的转换，见 PROFILE_PAUSE_SECS）。
  }

  publish_phase(
    scheduler,
    RunPhase::Closing,
    leg_base_index + platforms.len(),
    total_legs,
    Some(profile),
    None,
    finished,
  );
  close_session(app_handle, session).await;
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
async fn close_session(app_handle: &tauri::AppHandle, session: Option<BrowserProfile>) {
  let Some(launched) = session else { return };
  if let Err(e) = crate::browser_runner::kill_browser_profile(app_handle.clone(), launched).await {
    log::warn!("Discovery could not close the browser session: {e}");
  }
  tokio::time::sleep(CLOSE_SETTLE).await;
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

async fn wait_for_navigation_commit(
  profile: &BrowserProfile,
  driven_tab: Option<&str>,
  expected: &str,
) -> bool {
  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let deadline = tokio::time::Instant::now() + NAVIGATION_COMMIT_WAIT;
  loop {
    if let Some(targets) = wayfern.list_page_targets(&path).await {
      let target = driven_tab
        .and_then(|id| targets.iter().find(|t| t.id == id))
        .or_else(|| targets.first());
      if target.is_some_and(|t| navigation_reached(expected, &t.url)) {
        return true;
      }
    }
    if tokio::time::Instant::now() >= deadline {
      return false;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
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
) -> Result<(), String> {
  tokio::time::timeout(
    NAVIGATION_COMMAND_WAIT,
    wayfern_navigate(profile, driven_tab, url),
  )
  .await
  .map_err(|_| {
    format!(
      "navigation command did not answer within {}s for {url}",
      NAVIGATION_COMMAND_WAIT.as_secs()
    )
  })??;
  if wait_for_navigation_commit(profile, driven_tab.as_deref(), url).await {
    Ok(())
  } else {
    Err(format!(
      "navigation was accepted but did not commit to {url}"
    ))
  }
}

async fn wait_for_extension_ready(
  profile: &BrowserProfile,
  driven_tab: Option<&str>,
) -> Result<(), String> {
  use crate::wayfern_manager::MarineAutomationReadiness;

  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let deadline = tokio::time::Instant::now() + EXTENSION_READY_WAIT;
  loop {
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
    match tokio::time::timeout(
      budget,
      wayfern.marine_automation_readiness(&path, driven_tab),
    )
    .await
    {
      Ok(MarineAutomationReadiness::Ready) => return Ok(()),
      Ok(MarineAutomationReadiness::Failed(reason)) => {
        return Err(format!(
          "Marine discovery bridge reported bootstrap failure: {reason}"
        ));
      }
      Ok(MarineAutomationReadiness::Pending) | Err(_) => {}
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
  }
}

/// 扩展是不是已经明确说了「这条腿没戏」。
///
/// 扩展已经给出不产生终态 touch 的明确失败/空转状态时，在这里提前收场。
/// 既包括搜索页立刻知道的未登录、候选池为空，也包括交接存储、导航纠偏和
/// settle 明确失败。后几类如果不识别，页面逻辑已经退出，调度器却仍会白等满超时。
///
/// 调度器原本看不见它们：完成信号只认台账里的 touch，而这些状态**不产生
/// touch**，于是白等满整个腿超时。一个 profile 没登录四个平台，就是 16 分钟纯
/// 空转 —— 跑 20 个 profile 时这是最大的一块浪费。
///
/// 用日志 sink 而不是新开一条通道：它就在同一个进程里，而且这些状态本来就
/// 已经写进去了。这不违反「完成信号是台账」那条原则 —— 这里判定的不是「干完了」
/// 而是「不可能干成」，台账仍然是唯一记录成果的地方。
fn leg_is_hopeless(profile_id: &str, platform: &str, since: u64) -> Option<&'static str> {
  const HOPELESS: [(&str, &str); 20] = [
    (
      "\"status\":\"not_logged_in\"",
      "not logged in on this platform",
    ),
    (
      "\"status\":\"nothing_to_claim\"",
      "no eligible targets left for this account",
    ),
    (
      "\"status\":\"no_profile_id\"",
      "extension could not resolve the active profile",
    ),
    (
      "\"status\":\"handoff_write_failed\"",
      "extension could not persist the target handoff",
    ),
    (
      "\"status\":\"handoff_in_progress\"",
      "an unresolved handoff already owns this browser tab",
    ),
    (
      "\"status\":\"target_navigation_stalled\"",
      "the old page stayed alive after two exact target navigation attempts",
    ),
    (
      "\"status\":\"handoff_url_mismatch\"",
      "target navigation did not reach the claimed item",
    ),
    (
      "\"status\":\"aborted_no_context\"",
      "target page could not obtain a generation context",
    ),
    (
      "\"status\":\"blocked_hop_limit\"",
      "target replacement limit reached",
    ),
    (
      "\"status\":\"blocked_no_hop\"",
      "target replacement is unavailable",
    ),
    (
      "\"status\":\"blocked_hop_failed\"",
      "target replacement failed",
    ),
    (
      "\"status\":\"blocked_nothing_left\"",
      "no replacement target remains",
    ),
    (
      "\"status\":\"handoff_read_failed\"",
      "extension handoff storage did not become ready",
    ),
    (
      "\"status\":\"handoff_expired\"",
      "the pre-send target handoff expired before it could run",
    ),
    (
      "\"status\":\"handoff_redirect_persist_failed\"",
      "extension could not persist the target navigation repair",
    ),
    (
      "\"status\":\"send_guard_persist_failed\"",
      "extension could not persist the at-most-once send guard",
    ),
    (
      "\"status\":\"send_already_started\"",
      "extension refused to repeat an already-started send",
    ),
    (
      "\"status\":\"target_changed_before_send\"",
      "the active SPA target changed before the guarded send",
    ),
    (
      "\"status\":\"prospect_bootstrap_failed\"",
      "the search-page automation dependencies did not become ready",
    ),
    (
      "\"status\":\"target_bootstrap_failed\"",
      "the target-page automation dependencies did not become ready",
    ),
  ];
  let entries = super::debug_log::DEBUG_LOG.tail(400).ok()?;
  for entry in entries.iter().rev() {
    if entry.at < since {
      break;
    }
    if entry.profile_id.as_deref() != Some(profile_id) {
      continue;
    }
    let matches_platform = entry.url.as_deref().is_some_and(|url| match platform {
      "bilibili" => url.contains("bilibili.com"),
      "zhihu" => url.contains("zhihu.com"),
      "douyin" => url.contains("douyin.com"),
      "xiaohongshu" => url.contains("xiaohongshu.com") || url.contains("xhslink.com"),
      _ => true,
    });
    if !matches_platform {
      continue;
    }
    for (needle, reason) in HOPELESS {
      if entry.msg.contains(needle) {
        return Some(reason);
      }
    }
    // A recoverable settlement failure owns a persistent, at-most-once
    // handoff and keeps retrying settlement without generating or clicking
    // again.  Parking that document immediately destroys its recovery loop.
    // Only an explicitly non-recoverable failure can end the leg here.
    if entry.msg.contains("\"status\":\"settle_failed\"")
      && entry.msg.contains("\"recoverable\":false")
    {
      return Some("extension could not safely recover the terminal ledger state");
    }
    // 重试阶梯跑完了还没能开工 —— 搜索页始终解析不出结果。
    //
    // **这就是验证墙的真实表现**。不要去检测「页面上有没有验证码元素」：抖音会
    // 预加载 `rc-verifycenter` 组件，实测一条带着那个 iframe 的腿照样发成功了，
    // 按元素判会误杀能成的腿。而阶梯（6 次退避重试、约 30 秒）跑完仍然不成，
    // 意思是「渲染完了也没有结果卡片」—— 页面塌陷、被验证墙顶掉、或者搜索被拦，
    // 三种都一样没戏，再等两分钟不会变。
    if entry.msg.contains("[6/6]") && !entry.msg.contains("\"status\":\"claimed\"") {
      return Some(
        "search page never yielded results (collapsed, blocked, or behind a verification wall)",
      );
    }
  }
  None
}

/// 等渲染进程重新开始应答，最多等 `IDLE_WAIT`。
///
/// 等不到也照常往下走：下一次导航自带 30 秒上限，最坏是那条腿失败，
/// 而不是在这里把整轮拖死。
async fn wait_until_idle(profile: &BrowserProfile, driven_tab: Option<&str>) {
  let path = profile_data_path(profile);
  let wayfern = crate::wayfern_manager::WayfernManager::instance();
  let deadline = tokio::time::Instant::now() + IDLE_WAIT;
  while tokio::time::Instant::now() < deadline {
    if wayfern.renderer_responds(&path, driven_tab).await {
      return;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
  }
  log::warn!(
    "Discovery: renderer still busy after parking profile {}",
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
  profile: &BrowserProfile,
  driven_tab: &mut Option<String>,
  slot: &super::search_slot::SearchSlot,
) -> Result<(), String> {
  if let Some(warmup) = slot.warmup_url.as_deref() {
    match navigate_retrying(profile, driven_tab, warmup).await {
      Ok(()) => tokio::time::sleep(WARMUP_SETTLE).await,
      Err(e) => {
        log::warn!("Discovery warm-up navigation failed ({e}); trying the search page anyway")
      }
    }
  }
  navigate_retrying(profile, driven_tab, &slot.url).await
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
) -> Result<(), String> {
  match navigate_and_wait(profile, driven_tab, url).await {
    Ok(()) => Ok(()),
    Err(first) => {
      log::warn!(
        "Discovery navigation failed ({first}); waiting for the renderer and retrying once"
      );
      wait_until_idle(profile, driven_tab.as_deref()).await;
      navigate_and_wait(profile, driven_tab, url).await
    }
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
}

impl LegExecution {
  fn healthy(report: LegReport) -> Self {
    Self {
      report,
      session_unusable: false,
    }
  }

  fn unusable(report: LegReport) -> Self {
    Self {
      report,
      session_unusable: true,
    }
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
  // this leg and falsely report Settled without doing any work.
  let baseline = match initial_touch_count(&profile_id, platform).await {
    Ok(count) => count,
    Err(error) => {
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

  log::info!(
    "Discovery leg {leg_index}/{total_legs}: profile {} on {platform} → {} ({})",
    profile.name,
    slot.url,
    slot.label
  );

  // 冷启动，还是原地换页？
  //
  // 一个 profile 的四个平台跑在**同一个浏览器会话**里：第一条腿冷启动，之后
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
    match crate::browser_runner::launch_browser_profile_for_automation(
      app_handle.clone(),
      profile.clone(),
    )
    .await
    {
      Ok(p) => *session = Some(p),
      Err(e) => {
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
    // 防御性收敛：策略上不再恢复会话，但平台/浏览器仍可能自己产生额外页签。
    *driven_tab = sweep_tabs(profile, driven_tab.as_deref()).await;
  }

  if let Err(e) = navigate_with_warmup(profile, driven_tab, &slot).await {
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
  if let Err(first_error) = wait_for_extension_ready(profile, driven_tab.as_deref()).await {
    log::warn!(
      "Discovery: Marine extension did not become ready on {platform} ({first_error}); reloading the search page once"
    );
    if let Err(e) = navigate_retrying(profile, driven_tab, &slot.url).await {
      return LegExecution::unusable(LegReport {
        outcome: LegOutcome::Failed,
        error: Some(format!("extension bootstrap reload failed: {e}")),
        ..base
      });
    }
    if let Err(second_error) = wait_for_extension_ready(profile, driven_tab.as_deref()).await {
      return LegExecution::unusable(LegReport {
        outcome: LegOutcome::Failed,
        error: Some(format!(
          "Marine extension bootstrap failed after one reload: {second_error}"
        )),
        ..base
      });
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
  let focused = crate::wayfern_manager::WayfernManager::instance()
    .bring_to_front(&profile_data_path(profile), driven_tab.as_deref())
    .await;
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
  let mut settled = 0usize;
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
  let mut hopeless: Option<&'static str> = None;
  let mut target_bridge_pending_since: Option<tokio::time::Instant> = None;
  let mut target_bridge_reloaded = false;
  let mut target_bridge_url: Option<String> = None;
  loop {
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    match read_touch_count(&profile_id, platform).await {
      Ok(now) if now > baseline => {
        settled = now - baseline;
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
    if let Some(current_url) = driven_tab_url(profile, driven_tab.as_deref()).await {
      let on_target = current_url != "about:blank" && !navigation_reached(&slot.url, &current_url);
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
        let readiness = tokio::time::timeout(
          Duration::from_secs(3),
          crate::wayfern_manager::WayfernManager::instance()
            .marine_automation_readiness(&profile_data_path(profile), driven_tab.as_deref()),
        )
        .await
        .unwrap_or(MarineAutomationReadiness::Pending);
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
              if let Err(error) = navigate_retrying(profile, driven_tab, &current_url).await {
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
        "Discovery leg {leg_index}/{total_legs}: {platform} has nothing to do ({reason}); ending early"
      );
      hopeless = Some(reason);
      break;
    }
    if crate::wayfern_manager::WayfernManager::instance()
      .renderer_responds(&profile_data_path(profile), driven_tab.as_deref())
      .await
    {
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
    tokio::time::sleep(POLL_INTERVAL).await;
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

  // 腿结束 = 把页面停掉，不是把浏览器关掉。
  //
  // 导航到 about:blank 才算真的收尾：页面留在原地的话，它的编排重试阶梯还在跑
  // （最长十几秒），Phase B 更久 —— 那些迟到的动作会 claim 新靶子、抢活动标签页，
  // 还会把 settle 记到下一条腿头上。about:blank 一到，整个文档连同它的定时器
  // 一起消失，效果等价于以前那次 kill，但浏览器活着给下一个平台用。
  //
  // 顺手再收一次页签：平台自己可能开过新标签页（外链、播放页）。
  let close_error = match navigate_retrying(profile, driven_tab, "about:blank").await {
    Ok(()) => {
      // 等渲染进程真的空下来再交给下一条腿。
      //
      // 上面的 commit 校验只证明 URL 已经切到 about:blank，不代表旧的重型 SPA
      // 已经完成拆卸。B 站/抖音 加上注入脚本，卸载会继续占住渲染进程一会儿 ——
      // 下一条腿若立刻导航，仍可能撞上一个不应答的 renderer。
      //
      // 实测规律干净得没有歧义：上一条腿**真发出去了**（B站、抖音）→ 下一次导航
      // 必超时；上一条腿立刻失败、根本没干活（知乎那次）→ 下一次导航正常。
      wait_until_idle(profile, driven_tab.as_deref()).await;
      *driven_tab = sweep_tabs(profile, driven_tab.as_deref()).await;
      None
    }
    Err(e) => {
      log::warn!("Discovery leg could not park profile {}: {e}", profile.name);
      Some(e)
    }
  };

  let outcome = if scheduler.cancel.load(Ordering::SeqCst) && settled == 0 {
    LegOutcome::Cancelled
  } else if settled > 0 {
    LegOutcome::Settled
  } else if hopeless.is_some() {
    // 和「超时」分开表达不了 —— 没有专门的 outcome 变体，加一个要连带改前端
    // union、颜色表和九个 locale。但 `error` 里写明原因，跑 20 个 profile 时
    // 「哪几个账号没登录」一眼就能看出来，这才是运营真正要的信息。
    LegOutcome::TimedOut
  } else if wedge_error.is_some() {
    // 卡死和「没找到可发的靶子」是两回事，别混成同一个 TimedOut ——
    // 后者是正常的，前者是页面出事了，混在一起就看不出该去查什么。
    LegOutcome::Failed
  } else {
    LegOutcome::TimedOut
  };
  let session_unusable = wedge_error.is_some() || close_error.is_some();
  let close_error = wedge_error
    .or_else(|| hopeless.map(|r| r.to_string()))
    .or(close_error)
    // 最低优先级：只有在没有任何其它解释、而且这条腿确实什么都没做成时才写。
    // 否则「窗口没到前台」会盖掉真正的原因。
    .or_else(|| focus_hint(focused, settled));

  // 发出去了就等于登录有效 —— 比任何探测都硬。顺手把这个平台的掉登录标记清掉，
  // 否则「只报失败」的设计会让标记变成永久的：人补了登录，界面还是红的。
  if outcome == LegOutcome::Settled {
    if let Err(e) = super::login_status::LOGIN_STATUS.clear_platform(&profile_id, platform) {
      log::warn!("Could not clear Marine login flag: {e}");
    }
  }

  log::info!(
    "Discovery leg {leg_index}/{total_legs} finished: {} on {platform} → {outcome:?} ({settled} settled)",
    profile.name
  );

  LegExecution {
    report: LegReport {
      outcome,
      settled_count: settled,
      error: close_error,
      ..base
    },
    session_unusable,
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
        })
        .collect(),
    }
  }

  // 四个平台跑在同一个浏览器会话里之后，上一个平台迟到的 settle 会落进下一条腿
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
    assert_eq!(count_leg_touches(&records, "p1", "bilibili"), 1);
    assert_eq!(count_leg_touches(&records, "p1", "zhihu"), 1);
    assert_eq!(
      count_leg_touches(&records, "p1", "xiaohongshu"),
      0,
      "小红书这条腿一个 touch 都没有 —— B站和知乎的成果绝不能算到它头上"
    );
    assert_eq!(
      count_leg_touches(&records, "p2", "bilibili"),
      0,
      "别的账号的 touch 不算"
    );
  }

  // Blocked 不结束腿：扩展会立刻换一条靶子继续跑（见 touch_ends_leg）。
  #[test]
  fn blocked_touches_do_not_end_a_leg() {
    use super::super::prospect::ProspectState;
    let records = vec![rec("bilibili", &[("p1", ProspectState::Blocked)])];
    assert_eq!(count_leg_touches(&records, "p1", "bilibili"), 0);
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

  /// 终态进度得保住这一轮的成果，否则界面在收尾时把刚跑完的腿全抹掉。
  #[test]
  fn the_terminal_progress_keeps_the_leg_reports() {
    let s = DiscoveryScheduler::new();
    let reports = vec![LegReport {
      profile_id: "p1".to_string(),
      profile_name: "one".to_string(),
      platform: "bilibili".to_string(),
      outcome: LegOutcome::Settled,
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
  /// index depends on neither directory order nor which profiles were selected
  /// — both of which produced reshuffled search sorts before this was fixed.
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
  fn account_index_ignores_which_other_profiles_were_selected() {
    // The regression this pins: indexing the *selected* subset meant ticking a
    // different set of profiles silently changed an account's search sort.
    let universe = ["aaa", "bbb", "ccc"];
    // "ccc" alone, and "ccc" alongside others, must land on the same slot.
    assert_eq!(stable_index(&universe, "ccc"), Some(2));
    let idx = stable_index(&universe, "ccc").unwrap();
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
    let r: RunRequest = serde_json::from_str(
      r#"{"profile_ids":["a"],"platforms":["bilibili"],"keyword":"科研工具"}"#,
    )
    .unwrap();
    assert_eq!(r.leg_timeout_secs, None);
    assert_eq!(r.keyword, "科研工具");
  }

  #[test]
  fn leg_outcomes_serialise_as_snake_case() {
    // These strings are the UI's lookup keys (marine.prospects.outcome.*), so a
    // rename here silently renders a raw key path to the operator.
    for (value, expected) in [
      (LegOutcome::Settled, "\"settled\""),
      (LegOutcome::TimedOut, "\"timed_out\""),
      (LegOutcome::NoSlot, "\"no_slot\""),
      (LegOutcome::AlreadyOpen, "\"already_open\""),
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

  /// 一个必然与当前宿主不同的 OS 名 —— 写死 "macos" 的话，在 macOS 上跑
  /// 这条测试就什么都测不到。
  fn a_foreign_os() -> &'static str {
    if crate::profile::types::get_host_os() == "windows" {
      "macos"
    } else {
      "windows"
    }
  }

  fn code_of(err: &str) -> String {
    serde_json::from_str::<serde_json::Value>(err)
      .ok()
      .and_then(|v| v["code"].as_str().map(str::to_string))
      .unwrap_or_else(|| format!("<not a coded error: {err}>"))
  }

  /// 从别的操作系统同步过来的 profile 在本机起不来，必须在**接受计划之前**挡下。
  ///
  /// 放进去的后果不是「这条腿失败」而是无限空转：`run_profile_session` 把失败
  /// 的腿当 `Ok` 返回，`run_cycles` 的连续失败计数只认 `Err`，所以永远不会触顶。
  #[test]
  fn a_profile_from_another_os_is_rejected_before_the_run_starts() {
    let foreign = wayfern_profile("from-elsewhere", Some(a_foreign_os()));
    let native = wayfern_profile("local", None);
    let all = vec![foreign.clone(), native.clone()];

    let err =
      resolve_from(&all, &[foreign.id.to_string()]).expect_err("跨 OS 的 profile 必须被拒绝");
    assert_eq!(code_of(&err), "MARINE_DISCOVERY_PROFILE_CROSS_OS");
    // 错误里要带上是哪个 profile，否则勾了一堆时无从下手。
    assert!(err.contains("from-elsewhere"));

    // 本机 profile 不受影响。
    let ok = resolve_from(&all, &[native.id.to_string()]).expect("本机 profile 应当通过");
    assert_eq!(ok.len(), 1);
  }

  /// 同一批里只要有一个跨 OS，整个计划就得拒 —— 半个计划跑起来更难排查。
  #[test]
  fn one_foreign_profile_rejects_the_whole_plan() {
    let foreign = wayfern_profile("from-elsewhere", Some(a_foreign_os()));
    let native = wayfern_profile("local", None);
    let all = vec![foreign.clone(), native.clone()];

    let err = resolve_from(&all, &[native.id.to_string(), foreign.id.to_string()])
      .expect_err("混着跨 OS 的计划也要拒");
    assert_eq!(code_of(&err), "MARINE_DISCOVERY_PROFILE_CROSS_OS");
  }

  /// 错误必须是结构化错误码 —— 裸英文会原样漏到界面上。
  #[test]
  fn a_missing_profile_reports_a_translatable_code() {
    let all = vec![wayfern_profile("local", None)];
    let err =
      resolve_from(&all, &[uuid::Uuid::new_v4().to_string()]).expect_err("不存在的 profile 要报错");
    assert_eq!(code_of(&err), "MARINE_DISCOVERY_PROFILE_NOT_FOUND");
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
