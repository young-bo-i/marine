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
//! Legs that legitimately produce nothing (profile not logged in — the extension
//! stops with zero API calls by design) therefore end on the timeout path. That
//! is correct: it is indistinguishable from "no work available" from out here,
//! and the ledger stays the single record of what happened.
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
/// —— 它要覆盖冷启动、搜索页加载、选靶、打开评论区、流式生成加拟人节奏打字、
/// 发送和回执。再往下压就开始误杀能成的腿；20 秒会一条都发不出去。
///
/// 真正该省的不是这个数字，而是**没希望的腿别等满**：没登录、候选池空了、
/// 搜索页始终出不来结果 —— 这三种由 [`leg_is_hopeless`] 在几秒内结束，
/// 所以正常运行几乎碰不到这个上限。
const DEFAULT_LEG_TIMEOUT_SECS: u64 = 120;

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
/// The cost of excluding it: when the extension runs out of hops (several closed
/// items in a row) the leg has only `Blocked` touches and ends on the timeout
/// path instead of promptly. Rare, and the ledger still records every finding.
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
/// A read error yields the baseline unchanged rather than 0. Returning 0 from a
/// transient failure would make the count appear to *drop*, and the caller's
/// `now > baseline` comparison would then never fire again for that leg.
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

async fn touch_count(profile_id: &str, platform: &str, fallback: usize) -> usize {
  let id = profile_id.to_string();
  let plat = platform.to_string();
  let counted = tokio::task::spawn_blocking(move || {
    super::prospect::PROSPECTS
      .list()
      .map(|records| count_leg_touches(&records, &id, &plat))
  })
  .await;

  match counted {
    Ok(Ok(n)) => n,
    Ok(Err(e)) => {
      log::warn!("Discovery scheduler could not read the prospect ledger: {e}");
      fallback
    }
    Err(e) => {
      log::warn!("Discovery scheduler ledger read task failed: {e}");
      fallback
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
fn resolve_profiles(ids: &[String]) -> Result<Vec<(usize, BrowserProfile)>, String> {
  let all = ProfileManager::instance()
    .list_profiles()
    .map_err(|e| format!("failed to list profiles: {e}"))?;

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
        .ok_or_else(|| format!("profile not found: {id}"))?;
      if !engine_supports_discovery(&profile.browser) {
        return Err(format!(
          "profile {} runs {}, which cannot host the discovery extension",
          profile.name, profile.browser
        ));
      }
      let account_index = universe
        .iter()
        .position(|u| u == id)
        .ok_or_else(|| format!("profile not indexable: {id}"))?;
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

  let result = run_cycles(app_handle, request, scheduler).await;
  scheduler.running.store(false, Ordering::SeqCst);
  result
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
  let Some(gap) = request
    .cycle_gap_minutes
    .filter(|m| *m > 0)
    .map(|m| Duration::from_secs(m * 60))
  else {
    return run_inner(app_handle, request, scheduler).await;
  };

  let mut last = Vec::new();
  let mut cycle = 0u64;
  loop {
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    cycle += 1;
    let started = tokio::time::Instant::now();
    log::info!("Discovery cycle {cycle} starting");
    last = run_inner(app_handle.clone(), request.clone(), scheduler).await?;
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

    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    publish_phase(scheduler, RunPhase::Pausing, 0, 0, None, None, &last);
    // 可打断：取消不该等到歇完才生效。
    if !sleep_or_cancel(scheduler, gap).await {
      break;
    }
  }
  Ok(last)
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
  let profiles = resolve_profiles(&request.profile_ids).map_err(|e| {
    log::error!("Discovery run rejected: {e}");
    super::err("MARINE_DISCOVERY_PROFILE_NOT_FOUND")
  })?;
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

    let report = run_leg(
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
    finished.push(report);

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
fn profile_data_path(profile: &BrowserProfile) -> String {
  let dir = ProfileManager::instance().get_profiles_dir();
  profile
    .get_profile_data_path(&dir)
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

/// 扩展是不是已经明确说了「这条腿没戏」。
///
/// 有两种确定性的收场，而且扩展在搜索页上几秒钟就知道：
///   · `not_logged_in`    —— 这个账号在这个平台没登录
///   · `nothing_to_claim` —— 这个账号的候选池空了（碰过的靶子被永久排除）
///
/// 调度器原本看不见它们：完成信号只认台账里的 touch，而这两种情况**不产生
/// touch**，于是白等满整个腿超时。一个 profile 没登录四个平台，就是 16 分钟纯
/// 空转 —— 跑 20 个 profile 时这是最大的一块浪费。
///
/// 用日志 sink 而不是新开一条通道：它就在同一个进程里，而且这两个状态本来就
/// 已经写进去了。这不违反「完成信号是台账」那条原则 —— 这里判定的不是「干完了」
/// 而是「不可能干成」，台账仍然是唯一记录成果的地方。
fn leg_is_hopeless(profile_id: &str, since: u64) -> Option<&'static str> {
  const HOPELESS: [(&str, &str); 2] = [
    (
      "\"status\":\"not_logged_in\"",
      "not logged in on this platform",
    ),
    (
      "\"status\":\"nothing_to_claim\"",
      "no eligible targets left for this account",
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
    for (needle, reason) in HOPELESS {
      if entry.msg.contains(needle) {
        return Some(reason);
      }
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
  match wayfern_navigate(profile, driven_tab, url).await {
    Ok(()) => Ok(()),
    Err(first) => {
      log::warn!(
        "Discovery navigation failed ({first}); waiting for the renderer and retrying once"
      );
      wait_until_idle(profile, driven_tab.as_deref()).await;
      wayfern_navigate(profile, driven_tab, url).await
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
) -> LegReport {
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
    return base;
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
  // this leg's work. A read failure here yields 0, which is the safe direction:
  // the leg then reports whatever it observes as its own rather than silently
  // crediting itself with earlier work.
  let baseline = touch_count(&profile_id, platform, 0).await;

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
    // 需要预热的平台，浏览器**开在预热页**上，随后再导航到搜索页。
    // 直接开在搜索页上和「从 about:blank 冷跳」是同一件事，一样会卡死渲染进程。
    let first_url = slot.warmup_url.clone().unwrap_or_else(|| slot.url.clone());
    match crate::browser_runner::launch_browser_profile(
      app_handle.clone(),
      profile.clone(),
      Some(first_url),
    )
    .await
    {
      Ok(p) => *session = Some(p),
      Err(e) => {
        log::error!(
          "Discovery leg failed to launch profile {}: {e}",
          profile.name
        );
        return LegReport {
          outcome: LegOutcome::Failed,
          error: Some(e),
          ..base
        };
      }
    }
    // 冷启动之后立刻收页签：`--restore-last-session` 会把上一次的标签页恢复
    // 出来，每一个都会各自跑起内容脚本、各自 claim 一条靶子并抢活动标签页。
    *driven_tab = sweep_tabs(profile, driven_tab.as_deref()).await;
    if slot.warmup_url.is_some() {
      tokio::time::sleep(WARMUP_SETTLE).await;
      if let Err(e) = wayfern_navigate(profile, driven_tab, &slot.url).await {
        log::warn!("Discovery leg could not leave the warm-up page for {platform}: {e}");
        return LegReport {
          outcome: LegOutcome::Failed,
          error: Some(format!("warm-up navigation failed: {e}")),
          ..base
        };
      }
    }
  } else if let Err(e) = navigate_with_warmup(profile, driven_tab, &slot).await {
    log::warn!(
      "Discovery leg could not navigate profile {} to {platform}: {e}",
      profile.name
    );
    return LegReport {
      outcome: LegOutcome::Failed,
      error: Some(format!("session lost: {e}")),
      ..base
    };
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
  crate::wayfern_manager::WayfernManager::instance()
    .bring_to_front(&profile_data_path(profile), driven_tab.as_deref())
    .await;

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
  let leg_started_at = crate::proxy_manager::now_secs();
  loop {
    if scheduler.cancel.load(Ordering::SeqCst) {
      break;
    }
    let now = touch_count(&profile_id, platform, baseline).await;
    if now > baseline {
      settled = now - baseline;
      break;
    }
    if tokio::time::Instant::now() >= deadline {
      break;
    }
    if let Some(reason) = leg_is_hopeless(&profile_id, leg_started_at) {
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
  let close_error = match wayfern_navigate(profile, driven_tab, "about:blank").await {
    Ok(()) => {
      // 等渲染进程真的空下来再交给下一条腿。
      //
      // `Page.navigate` **在导航开始时就返回**，不等页面拆完。而 B 站/抖音 那种
      // 重型 SPA 加上我们注入的那套东西，拆卸会把渲染进程占住好一会儿 —— 下一条
      // 腿的导航于是撞上一个不应答的渲染进程，30 秒后以超时告终。
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
  let close_error = wedge_error
    .or_else(|| hopeless.map(|r| r.to_string()))
    .or(close_error);

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

  LegReport {
    outcome,
    settled_count: settled,
    error: close_error,
    ..base
  }
}

#[allow(clippy::too_many_arguments)]
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
}
