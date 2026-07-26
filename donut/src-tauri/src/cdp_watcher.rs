//! Event-driven browser-close detection — an accelerator for the 5s status poller.
//!
//! On macOS, closing the last Chromium window leaves the process RESIDENT with
//! zero page targets (verified against Wayfern 149: process alive, `/json`
//! empty, browser socket still writable). Liveness therefore has to be answered
//! by "does it still have page targets?", and polling that costs up to
//! 2 x FAST_INTERVAL_SECS before the UI catches up.
//!
//! This module keeps ONE persistent browser-level CDP WebSocket per windowed
//! instance and learns page-target lifecycle from push events instead
//! (measured: `Target.targetDestroyed` lands ~10ms after the window closes).
//!
//! THE WATCHER NEVER KILLS. It owns no teardown, no PID logic, no windowed
//! gate. It only nudges the status poller in `lib.rs`, which re-verifies over a
//! fresh `/json` and then runs the completely unchanged teardown. That keeps
//! `release_team_lock_if_needed` and `scheduler.mark_profile_stopped` — which
//! fire only on the poller's own `true -> false` transition — in their current
//! home, and means this change adds no second teardown caller.

use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

/// How long the page-target set must stay EMPTY before we wake the poller.
/// This is a noise filter, not the safety mechanism — the poller still
/// re-verifies over a fresh `/json`, and that is what gates the kill.
const ZERO_WINDOW_GRACE: Duration = Duration::from_millis(800);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
/// A connection that survived this long resets the backoff ladder.
const STABLE_RESET: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NudgeKind {
  /// The page-target set has been empty for `ZERO_WINDOW_GRACE`. Lets the
  /// poller treat its own fresh `/json` zero as sufficient instead of waiting
  /// for a second sample 5s later.
  ZeroWindowsConfirmed,
  /// The browser became unreachable (socket dropped / HTTP failed). Proves
  /// NOTHING — the poller just runs its ordinary PID check now instead of up
  /// to 5s from now.
  Unreachable,
}

pub struct Nudge {
  pub profile_id: String,
  pub kind: NudgeKind,
}

static NUDGE_TX: OnceLock<mpsc::Sender<Nudge>> = OnceLock::new();

/// Called ONCE from the status-poller setup in `lib.rs`; returns the receiver.
pub fn init_channel() -> mpsc::Receiver<Nudge> {
  let (tx, rx) = mpsc::channel(64);
  let _ = NUDGE_TX.set(tx);
  rx
}

fn nudge(profile_id: &str, kind: NudgeKind) {
  if let Some(tx) = NUDGE_TX.get() {
    // Bounded + try_send: a full queue means the poller is already about to
    // run. Dropping a nudge costs only the 5s fallback and can never wedge the
    // loop or grow without bound.
    let _ = tx.try_send(Nudge {
      profile_id: profile_id.to_string(),
      kind,
    });
  }
}

/// Cancels the watcher for one launch. Lives inside `WayfernInstance`, so every
/// path that ends an instance cancels it for free.
///
/// `Drop` MUST NOT block or await: it runs while `WayfernManager.inner` is
/// held, and the task may itself be waiting on `inner`.
pub struct WatcherHandle {
  cancel: CancellationToken,
}

impl std::fmt::Debug for WatcherHandle {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("WatcherHandle")
  }
}

impl Drop for WatcherHandle {
  fn drop(&mut self) {
    self.cancel.cancel();
  }
}

/// Callers MUST gate on positively-known windowed-ness — see the `windowed`
/// contract on `WayfernInstance`. A headless instance legitimately has zero
/// page targets and must never be reported.
pub fn spawn(profile_id: String, port: u16) -> WatcherHandle {
  let cancel = CancellationToken::new();
  let token = cancel.clone();
  tauri::async_runtime::spawn(run(profile_id, port, token));
  WatcherHandle { cancel }
}

/// The whole correctness core of this module, extracted so it can be tested
/// without a socket. Two verified protocol facts drive its shape:
///
/// 1. `Target.targetDestroyed` carries ONLY `{"targetId":"..."}` — no `type`,
///    no `targetInfo`. Destroy events therefore cannot be classified; the only
///    way to know whether a destroyed target was a page is to have recorded it
///    as one. Removing an unknown id is a harmless no-op, which is exactly what
///    makes iframe / service-worker / background-page destroys unable to move
///    the page count. (Observed: closing one page emitted TWO destroys.)
/// 2. A target can CHANGE TYPE in place (observed `other` -> `background_page`
///    57ms later), so `targetInfoChanged` must maintain the set in BOTH
///    directions. Handling only `targetCreated` would leave stale ids that pin
///    the count above zero and silently disable teardown forever.
#[derive(Default, Debug)]
struct PageTargetSet {
  ids: HashSet<String>,
  /// Whether a page target has ever been seen. A watcher that attaches
  /// mid-launch legitimately starts empty, and must not report that as a close.
  armed: bool,
}

impl PageTargetSet {
  /// `Target.targetCreated` / `Target.targetInfoChanged` — both carry the full
  /// `targetInfo`, so both maintain the set.
  fn on_target_info(&mut self, id: &str, target_type: &str) {
    if target_type == "page" {
      self.ids.insert(id.to_string());
      self.armed = true;
    } else {
      self.ids.remove(id);
    }
  }

  /// `Target.targetDestroyed` — id only.
  fn on_destroyed(&mut self, id: &str) {
    self.ids.remove(id);
  }

  fn is_empty(&self) -> bool {
    self.ids.is_empty()
  }

  /// Only a set that once held a page and is now empty means "the user closed
  /// the last window".
  fn signals_close(&self) -> bool {
    self.armed && self.ids.is_empty()
  }
}

/// Deterministic per-port spread so N profiles whose sockets all died at once
/// (macOS sleep/wake) don't reconnect in lockstep. Avoids a `rand` dependency.
fn next_backoff(cur: Duration, port: u16) -> Duration {
  let base = if cur.is_zero() {
    Duration::from_millis(250)
  } else {
    cur.saturating_mul(2)
  }
  .min(MAX_BACKOFF);
  base.mul_f64(0.88 + f64::from(port % 25) * 0.01)
}

async fn run(profile_id: String, port: u16, cancel: CancellationToken) {
  let http = match reqwest::Client::builder()
    .timeout(Duration::from_secs(2))
    .build()
  {
    Ok(c) => c,
    Err(e) => {
      log::warn!("cdp_watcher: cannot build http client for profile {profile_id}: {e}");
      return;
    }
  };

  let mut backoff = Duration::ZERO;
  let mut pinned_browser_id: Option<String> = None;
  let mut reported_unreachable = false;

  loop {
    if !backoff.is_zero() {
      tokio::select! {
        _ = cancel.cancelled() => return,
        _ = tokio::time::sleep(backoff) => {}
      }
    }
    if cancel.is_cancelled() {
      return;
    }

    // 1. Browser-level socket URL. Same endpoint `wait_for_cdp_ready` already
    //    polls; we just read the `webSocketDebuggerUrl` out of the body it
    //    discards.
    let ws_url = match http
      .get(format!("http://127.0.0.1:{port}/json/version"))
      .send()
      .await
    {
      Ok(r) => r.json::<serde_json::Value>().await.ok().and_then(|v| {
        v.get("webSocketDebuggerUrl")
          .and_then(|s| s.as_str())
          .map(str::to_owned)
      }),
      Err(_) => None,
    };

    let Some(ws_url) = ws_url else {
      // Unreachable. Conclude NOTHING; just let the poller look now. Nudge only
      // on the transition so a genuinely dead port doesn't nudge forever.
      if !reported_unreachable {
        reported_unreachable = true;
        nudge(&profile_id, NudgeKind::Unreachable);
      }
      backoff = next_backoff(backoff, port);
      continue;
    };

    // 2. Port-recycling guard. `find_free_port` binds then DROPS the listener,
    //    so the OS can hand this port to an unrelated process. The
    //    `/devtools/browser/<uuid>` suffix identifies the browser instance; if
    //    it changes we are looking at a stranger and must detach rather than
    //    report on someone else's process.
    let browser_id = ws_url.rsplit('/').next().unwrap_or_default().to_string();
    match &pinned_browser_id {
      None => pinned_browser_id = Some(browser_id.clone()),
      Some(p) if *p != browser_id => {
        log::warn!(
          "cdp_watcher: browser id on port {port} changed ({p} -> {browser_id}) for profile \
           {profile_id}; detaching rather than reporting on another process"
        );
        return;
      }
      _ => {}
    }

    let (mut ws, _) = match connect_async(&ws_url).await {
      Ok(x) => x,
      Err(e) => {
        // A 403 here means an `Origin` header leaked into the handshake
        // (Chromium rejects those outright). Logged loudly because it would
        // silently disable the accelerator for every profile.
        log::warn!("cdp_watcher: connect to {ws_url} failed for profile {profile_id}: {e}");
        backoff = next_backoff(backoff, port);
        continue;
      }
    };
    let connected_at = Instant::now();
    reported_unreachable = false;

    // 3. Subscribe. `discover:true` replays every EXISTING target as
    //    targetCreated before returning its result, so subscribe doubles as the
    //    initial snapshot with no gap. No `filter` param: it is pure noise
    //    reduction, and the page set below is correct without it.
    let sub = serde_json::json!({
      "id": 1,
      "method": "Target.setDiscoverTargets",
      "params": { "discover": true }
    });
    if ws
      .send(Message::Text(sub.to_string().into()))
      .await
      .is_err()
    {
      backoff = next_backoff(backoff, port);
      continue;
    }

    let mut pages = PageTargetSet::default();
    let mut zero_since: Option<Instant> = None;

    loop {
      // Snapshot the deadline as a plain value: an `async` block that read
      // `zero_since` directly would borrow it for the whole select, and the
      // arms below must be free to reassign it.
      let deadline = zero_since.map(|t| t + ZERO_WINDOW_GRACE);
      let grace = async move {
        match deadline {
          Some(d) => tokio::time::sleep_until(d).await,
          None => std::future::pending::<()>().await,
        }
      };
      tokio::pin!(grace);

      tokio::select! {
        _ = cancel.cancelled() => return,

        _ = &mut grace => {
          if pages.signals_close() {
            log::info!(
              "cdp_watcher: profile {profile_id} has had zero page targets for \
               {ZERO_WINDOW_GRACE:?} — waking the status poller"
            );
            nudge(&profile_id, NudgeKind::ZeroWindowsConfirmed);
          }
          zero_since = None; // one nudge per zero-crossing
        }

        msg = ws.next() => {
          // A clean Close frame and an abrupt reset both land here. NEVER a
          // kill signal on its own: reconnect and let the poller judge.
          let Some(Ok(msg)) = msg else { break };
          let Message::Text(text) = msg else { continue };
          let Ok(v) = serde_json::from_str::<serde_json::Value>(text.as_str()) else { continue };

          if v.get("id") == Some(&serde_json::json!(1)) {
            if let Some(err) = v.get("error") {
              log::warn!(
                "cdp_watcher: Target.setDiscoverTargets rejected for profile {profile_id} \
                 ({err}); falling back to the 5s poller"
              );
              return;
            }
            // Without this line the log cannot distinguish "the accelerator is
            // working" from "it silently never attached and the 5s poller did
            // everything" — the reaper line looks identical either way.
            log::info!(
              "cdp_watcher: attached to profile {profile_id} on port {port} \
               ({} page target(s) at subscribe)",
              pages.ids.len()
            );
            continue;
          }

          match v.get("method").and_then(|m| m.as_str()) {
            // Both carry the full targetInfo. A target can be born `other` and
            // later BECOME a page (observed: 57ms apart), so targetInfoChanged
            // must maintain the set too — handling only targetCreated leaves
            // stale ids that pin the count above zero and silently disable
            // teardown forever.
            Some("Target.targetCreated") | Some("Target.targetInfoChanged") => {
              let ti = &v["params"]["targetInfo"];
              let (Some(id), Some(ty)) = (ti["targetId"].as_str(), ti["type"].as_str())
                else { continue };
              pages.on_target_info(id, ty);
            }
            // VERIFIED payload: {"targetId":"..."} — no `type`, no targetInfo.
            // That is exactly why `pages` exists: removing an unknown id is a
            // no-op, so iframe / service-worker / background-page destroys can
            // never move the page count.
            Some("Target.targetDestroyed") => {
              let Some(id) = v["params"]["targetId"].as_str() else { continue };
              pages.on_destroyed(id);
            }
            _ => continue,
          }

          if pages.is_empty() {
            zero_since.get_or_insert_with(Instant::now);
          } else {
            zero_since = None;
          }
        }
      }
    }

    // Socket dropped. If the process really is gone the poller should hear
    // about it now rather than up to 5s from now — nudge without confirming.
    if !reported_unreachable {
      reported_unreachable = true;
      nudge(&profile_id, NudgeKind::Unreachable);
    }
    backoff = if connected_at.elapsed() >= STABLE_RESET {
      Duration::ZERO
    } else {
      next_backoff(backoff, port)
    };
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A watcher that attaches mid-launch legitimately sees an empty set. Firing
  /// there would tear down the browser being launched.
  #[test]
  fn never_signals_before_any_page_was_seen() {
    let mut set = PageTargetSet::default();
    assert!(set.is_empty());
    assert!(!set.signals_close(), "empty-but-unarmed must not signal");

    // Non-page traffic during startup must not arm it either.
    set.on_target_info("sw1", "service_worker");
    set.on_target_info("bg1", "background_page");
    assert!(!set.signals_close());
  }

  /// VERIFIED against the real browser: closing ONE page emitted TWO
  /// `targetDestroyed` events, and the payload has no `type`. An implementation
  /// that tried to classify the destroy would tear down on a service-worker
  /// teardown; recording page ids makes unknown destroys a no-op by construction.
  #[test]
  fn destroy_of_an_untracked_id_is_a_no_op() {
    let mut set = PageTargetSet::default();
    set.on_target_info("page1", "page");

    set.on_destroyed("service-worker-we-never-tracked");
    set.on_destroyed("iframe-we-never-tracked");
    assert!(
      !set.is_empty(),
      "unknown destroys must not move the page count"
    );
    assert!(!set.signals_close());

    // And a duplicate destroy of the real page stays idempotent.
    set.on_destroyed("page1");
    set.on_destroyed("page1");
    assert!(set.signals_close());
  }

  #[test]
  fn only_the_last_window_closing_signals() {
    let mut set = PageTargetSet::default();
    set.on_target_info("a", "page");
    set.on_target_info("b", "page");

    set.on_destroyed("a");
    assert!(!set.signals_close(), "2 -> 1 windows must not signal");

    set.on_destroyed("b");
    assert!(set.signals_close(), "1 -> 0 windows must signal");
  }

  /// Observed live: a target arrived as `other` and became `background_page`
  /// 57ms later. Tracking only `targetCreated` would leave a stale id pinning
  /// the count above zero, silently disabling teardown forever.
  #[test]
  fn a_target_changing_type_updates_the_set_in_both_directions() {
    let mut set = PageTargetSet::default();

    // other -> page
    set.on_target_info("x", "other");
    assert!(set.is_empty());
    set.on_target_info("x", "page");
    assert!(!set.is_empty());

    // page -> other (demoted, e.g. becomes a background page)
    set.on_target_info("x", "other");
    assert!(set.is_empty());
    assert!(set.signals_close(), "armed and now empty");
  }

  /// The reconnect ladder must stay bounded and be spread per port so a
  /// sleep/wake storm doesn't reconnect every profile in lockstep.
  #[test]
  fn backoff_is_bounded_and_port_spread() {
    let mut d = Duration::ZERO;
    for _ in 0..20 {
      d = next_backoff(d, 40_000);
      assert!(
        d <= MAX_BACKOFF.mul_f64(1.13),
        "backoff escaped its cap: {d:?}"
      );
    }
    // Two ports must not land on the same schedule.
    assert_ne!(
      next_backoff(Duration::ZERO, 40_001),
      next_backoff(Duration::ZERO, 40_002)
    );
  }
}
