//! OS-neutral login state for profiles that move between machines.
//!
//! # Why this exists
//!
//! Wayfern encrypts its cookie store with a passphrase kept in a plain
//! `os_crypt_key` file inside the profile. The derivation is not the same on
//! every platform (macOS: 24-byte key, 1003 PBKDF2 iterations, AES-128-CBC;
//! the Windows build writes 32 bytes under a scheme this code does not
//! implement), so a `Cookies` database is only meaningful on a machine whose
//! browser speaks the same convention.
//!
//! Syncing the ciphertext together with its key seemed to sidestep that, and it
//! is how this worked until 2026-08-05. It does not survive two machines using
//! the same profile: the second one writes its own key over the first one's,
//! and now neither store matches its key. Chromium does not report a cookie it
//! cannot decrypt — it **deletes** it — so the profile opens, looks completely
//! normal, and every account is logged out with nothing left to recover.
//!
//! # What this does instead
//!
//! Nothing encrypted ever crosses a machine boundary.
//!
//! - On browser exit, the local store is read with the local key (which always
//!   works — same machine that wrote it) and the values are written out as
//!   plain JSON, keyed to nothing.
//! - On launch, that JSON is pushed back in over CDP `Network.setCookies`, so
//!   the *receiving* browser re-encrypts every value under whatever key and
//!   scheme it natively uses.
//!
//! The point is that we never have to know what that scheme is. `os_crypt_key`
//! and `Cookies` are excluded from sync (see `DEVICE_LOCAL_PATTERNS` in
//! `sync/manifest.rs`) and stay on the machine that produced them.
//!
//! # Freshness is a revision number, never a clock
//!
//! Which side is newer is decided by [`PortableCookieStore::revision`], a counter
//! that every export bumps, compared against a device-local marker recording the
//! revision this machine last pushed into its browser.
//!
//! The first version of this compared the exporting machine's wall clock against
//! the local cookie database's mtime. Two machines never agree on the time, and
//! the failure was not a harmless skipped restore: the skew makes `decide()`
//! answer "local is current", the restore is skipped, and then the next export's
//! union merge writes the local machine's older value back out as the newest
//! revision — a login rolled backwards and synced to everyone. A counter has no
//! such failure mode.
//!
//! # Deletion
//!
//! A merge that only ever grows cannot express a logout. Exports therefore also
//! carry tombstones — but only when the browser shut down cleanly. Measured
//! against the real binary: cookies injected over CDP and then force-killed never
//! reach the database at all, so on an unclean exit "absent from the store" means
//! "not flushed", not "deleted", and treating it as deletion would log the user
//! out of everything on every crash.
//!
//! # On keeping session values in plaintext
//!
//! This file holds live session cookies. For an ordinary profile it is written in
//! the clear — the same exposure the pair it replaces already had, since
//! `os_crypt_key` sits next to the database it is the passphrase for. For a
//! password-protected profile that would be a real regression (the blob lives
//! outside the encrypted subtree), so there it is sealed with the profile's own
//! key. On upload the sync layer's E2E envelope applies to both. On Unix it is
//! written 0600.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Name of the blob inside `profiles/<id>/`.
///
/// Deliberately a sibling of the browser data directory rather than a file
/// inside it: Chromium must never see it, but sync must (the manifest scans
/// from `profiles/<id>/`).
pub const FILE_NAME: &str = "portable-cookies.json";

/// Device-local record of the blob this machine last injected, as
/// `<revision>:<device>`.
///
/// Lives under `.donut-sync/`, which sync excludes — that is the point. It
/// describes what THIS browser already has, so a copy of it arriving from
/// another machine would be a lie.
///
/// The device half is not decoration. Two machines that both export while
/// offline produce the same revision number from different content, and a
/// magnitude-only marker reads the peer's blob as "already applied": the restore
/// is skipped, and then the next clean exit diffs the live store against a blob
/// this browser never held and tombstones every cookie in it. Comparing identity
/// makes "have I applied exactly this?" the question being asked.
const APPLIED_MARKER: &str = ".donut-sync/portable-cookies.applied";

/// Which blob a machine has already pushed into its browser, and what the
/// browser refused.
///
/// `unconfirmed` exists because demanding a perfect injection is not a workable
/// bar. A single cookie the browser declines — oversized, a domain it will not
/// accept, a `__Host-` prefix violation — would otherwise stop the marker ever
/// advancing, which in turn keeps `export` permanently in its
/// carry-forward-only mode and silently disables logout propagation for good.
/// Recording exactly which keys did not land lets the marker advance while still
/// making those keys untombstonable: they are absent from the store because the
/// browser rejected them, not because the user logged out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AppliedMark {
  pub revision: u64,
  pub device: String,
  /// `(domain, name, path)` triples that were sent but never read back.
  #[serde(default)]
  pub unconfirmed: Vec<(String, String, String)>,
}

const FORMAT_VERSION: u32 = 2;

/// How many revisions a tombstone survives before it is dropped.
///
/// Long enough that a machine which has been offline for a while still learns
/// about the logout; short enough that the blob does not grow without bound.
const TOMBSTONE_HORIZON: u64 = 100;

/// One cookie, in terms every browser agrees on.
///
/// Field names match CDP's `Network.CookieParam` so restoring is a direct
/// serialization rather than a mapping that can drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortableCookie {
  pub name: String,
  pub value: String,
  pub domain: String,
  pub path: String,
  /// Seconds since the Unix epoch. Absent means a session cookie.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub expires: Option<f64>,
  pub secure: bool,
  #[serde(rename = "httpOnly")]
  pub http_only: bool,
  /// `"Strict"` / `"Lax"` / `"None"`, or absent for unspecified.
  ///
  /// Absent is a real, distinct value and not a synonym for `"None"`: Chromium
  /// treats unspecified as lax-with-exceptions. Collapsing the two is what
  /// broke the JSON/Netscape export path (477 of 541 cookies rejected), so the
  /// distinction is preserved end to end.
  #[serde(rename = "sameSite", default, skip_serializing_if = "Option::is_none")]
  pub same_site: Option<String>,
}

/// A cookie that was deliberately removed, and the revision it went at.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedCookie {
  pub name: String,
  pub domain: String,
  pub path: String,
  pub secure: bool,
  /// The revision that recorded the deletion. A machine applies a tombstone
  /// only when this exceeds its own applied marker, so re-logging-in on one
  /// machine is not undone by a stale tombstone on the next launch.
  pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortableCookieStore {
  pub version: u32,
  /// Monotonic across every machine sharing this profile. Each export writes
  /// `max(blob, local marker) + 1`, so it only ever moves forward regardless of
  /// which machine did the exporting or what its clock said.
  #[serde(default)]
  pub revision: u64,
  /// Which machine produced this revision. Informational — the revision decides.
  pub device: String,
  /// Unix seconds, for humans reading logs. Deliberately NOT a decision input.
  pub exported_at: u64,
  pub source_os: String,
  pub cookies: Vec<PortableCookie>,
  #[serde(default)]
  pub deleted: Vec<DeletedCookie>,
}

pub fn path_for(profile_id: &str, profiles_dir: &Path) -> PathBuf {
  profiles_dir.join(profile_id).join(FILE_NAME)
}

fn marker_path(profile_id: &str, profiles_dir: &Path) -> PathBuf {
  profiles_dir.join(profile_id).join(APPLIED_MARKER)
}

/// The blob this machine last pushed into its own browser, if any.
///
/// An unparsable marker — including the bare `<revision>` an earlier build
/// wrote — reads as "never applied". That is the safe direction and it
/// self-heals: the next launch re-injects (idempotent) and rewrites the marker
/// in the current format, and until then `export` stays in carry-forward mode
/// and cannot produce a tombstone.
pub fn applied_mark(profile_id: &str, profiles_dir: &Path) -> Option<AppliedMark> {
  let raw = std::fs::read(marker_path(profile_id, profiles_dir)).ok()?;
  serde_json::from_slice(&raw).ok()
}

fn set_applied_mark(profile_id: &str, profiles_dir: &Path, mark: &AppliedMark) {
  let path = marker_path(profile_id, profiles_dir);
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let Ok(body) = serde_json::to_vec(mark) else {
    return;
  };
  if let Err(e) = std::fs::write(&path, body) {
    // Losing the marker costs a redundant re-injection next launch, not
    // correctness — injecting the same blob twice is idempotent. It DOES cost
    // tombstone precision, which is why `export` treats a missing marker as
    // "never applied" and refuses to derive deletions from it.
    log::warn!("Could not record applied blob for {profile_id}: {e}");
  }
}

/// Has this machine's browser already been given exactly this blob?
fn already_applied(mark: Option<&AppliedMark>, store: &PortableCookieStore) -> bool {
  mark.is_some_and(|m| m.revision == store.revision && m.device == store.device)
}

fn now_secs() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

/// Chromium's `samesite` column → the CDP spelling.
fn same_site_label(samesite: i32) -> Option<&'static str> {
  match samesite {
    0 => Some("None"),
    1 => Some("Lax"),
    2 => Some("Strict"),
    // -1 (unspecified) and anything unrecognized: send no sameSite at all and
    // let the receiving browser apply its own default.
    _ => None,
  }
}

/// Identity of a cookie, in Chromium's terms: replacing any of these three
/// makes it a different cookie rather than an update to this one.
type CookieKey = (String, String, String);

fn key_of(c: &PortableCookie) -> CookieKey {
  (c.domain.clone(), c.name.clone(), c.path.clone())
}

fn key_of_deleted(d: &DeletedCookie) -> CookieKey {
  (d.domain.clone(), d.name.clone(), d.path.clone())
}

/// How the browser this export describes came to a stop.
///
/// The distinction is load-bearing, not cosmetic: it decides whether a cookie
/// missing from the store is a logout or an unflushed write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
  /// The browser shut down normally, so the store on disk is complete and
  /// absences are real deletions.
  Clean,
  /// Force-killed, crashed, or unknown. Absences prove nothing.
  Unclean,
}

/// Read the profile's own cookie store and write it out OS-neutrally.
///
/// Returns the number of cookies written, or `None` when there was nothing to
/// export (no store yet, or a store this host cannot read — the latter is
/// exactly the state a freshly synced cross-OS profile is in before its first
/// launch, and overwriting a good blob with an empty one there would destroy
/// the login state we are trying to carry).
pub fn export(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
  exit: ExitKind,
) -> Result<Option<usize>, String> {
  if profile.browser != "wayfern" {
    // Firefox/Camoufox keeps cookie values in the clear, so its store is
    // already portable and syncs as-is.
    return Ok(None);
  }
  if profile.ephemeral {
    // An ephemeral profile's whole contract is that it leaves nothing behind.
    // Writing its session cookies to a persistent file — and replaying them into
    // the next launch — would quietly turn it into an ordinary profile with a
    // worse story about where its data went.
    return Ok(None);
  }

  let (cookies, undecryptable) = match read_local_cookies(profile, profiles_dir) {
    Ok(v) => v,
    Err(e) => {
      log::warn!(
        "Profile {}: nothing to export to {FILE_NAME} ({e})",
        profile.name
      );
      return Ok(None);
    }
  };

  // A store we cannot decrypt yields the right names with empty values. Writing
  // that out would look like a successful export and silently replace real
  // sessions with placeholders on every other machine.
  // Every row the store holds, readable or not. A row whose value will not
  // decrypt is still evidence the cookie EXISTS — treating it as absent would
  // turn "this machine cannot read it" into "the user logged out", and sync that
  // deletion to machines that can read it perfectly well.
  let mut present: std::collections::HashSet<CookieKey> = cookies
    .iter()
    .map(|c| (c.domain.clone(), c.name.clone(), c.path.clone()))
    .collect();

  let usable: Vec<&crate::cookie_manager::UnifiedCookie> =
    cookies.iter().filter(|c| !c.value.is_empty()).collect();
  if usable.is_empty() {
    if !cookies.is_empty() {
      log::warn!(
        "Profile {}: {} cookie row(s) but no readable values ({undecryptable} failed to \
         decrypt) — leaving {FILE_NAME} untouched",
        profile.name,
        cookies.len()
      );
    }
    return Ok(None);
  }
  if undecryptable > 0 {
    log::warn!(
      "Profile {}: {undecryptable} cookie value(s) could not be decrypted and are omitted \
       from {FILE_NAME}",
      profile.name
    );
  }

  let now = now_secs() as i64;
  let fresh: Vec<PortableCookie> = usable
    .into_iter()
    // Expired cookies are dead weight the receiving browser would reject anyway.
    .filter(|c| c.expires <= 0 || c.expires > now)
    .map(|c| {
      let same_site = same_site_label(c.same_site).and_then(|s| {
        // Chromium rejects `SameSite=None` on a non-secure cookie outright. Send
        // it unspecified instead of losing the whole cookie to a failed set.
        if s == "None" && !c.is_secure {
          None
        } else {
          Some(s.to_string())
        }
      });
      PortableCookie {
        name: c.name.clone(),
        value: c.value.clone(),
        domain: c.domain.clone(),
        path: c.path.clone(),
        expires: (c.expires > 0).then_some(c.expires as f64),
        secure: c.is_secure,
        http_only: c.is_http_only,
        same_site,
      }
    })
    .collect();

  if fresh.is_empty() {
    return Ok(None);
  }

  let profile_id = profile.id.to_string();
  let previous = load(profile, profiles_dir).ok().flatten();
  let mark = applied_mark(&profile_id, profiles_dir);
  // Cookies the browser itself refused at restore time are missing from the
  // store for a reason that has nothing to do with the user. Treating them as
  // present keeps them out of the tombstone list, so a cookie one machine
  // cannot hold is not deleted on the machines that can.
  if let Some(m) = mark.as_ref() {
    present.extend(m.unconfirmed.iter().cloned());
  }
  let revision = previous
    .as_ref()
    .map(|p| p.revision)
    .unwrap_or(0)
    .max(mark.as_ref().map(|m| m.revision).unwrap_or(0))
    + 1;

  // Deletions may only be derived from a blob this browser actually holds.
  //
  // This is the single most dangerous line in the module. `reconcile` reads
  // "in the previous blob, absent from the store" as a logout — which is only
  // true if the store ever contained the blob. It may well not: `apply`
  // deliberately declines to record the marker when the injection could not be
  // verified, precisely so it retries, and the launch continues regardless. The
  // user then browses, closes the window, and a Clean export diffs a handful of
  // fresh cookies against a full blob it never received. Every account in it
  // becomes a tombstone, syncs, and gets deleted on every other machine —
  // stores that are device-local, with no backup on this path. One failed
  // restore would have wiped the fleet.
  let exit = match previous.as_ref() {
    Some(p) if exit == ExitKind::Clean && !already_applied(mark.as_ref(), p) => {
      log::warn!(
        "Profile {}: this machine never applied {FILE_NAME} revision {} (marker: {:?}) — \
         exporting as unclean so absent cookies are carried forward, not deleted",
        profile.name,
        p.revision,
        mark
          .as_ref()
          .map(|m| format!("{}:{}", m.revision, m.device)),
      );
      ExitKind::Unclean
    }
    _ => exit,
  };

  let honoured_previous = previous
    .as_ref()
    .is_some_and(|p| already_applied(mark.as_ref(), p));
  let Reconciled {
    cookies,
    deleted,
    carried,
    retained,
  } = reconcile(
    fresh,
    previous.as_ref(),
    exit,
    revision,
    &present,
    honoured_previous,
  );
  if retained > 0 {
    log::debug!(
      "Profile {}: kept {retained} cookie(s) the store holds unreadably or the browser refused",
      profile.name
    );
  }
  if carried > 0 {
    log::info!(
      "Profile {}: carried {carried} cookie(s) forward from the previous {FILE_NAME} — the \
       browser had not flushed them to disk",
      profile.name
    );
  }
  let new_tombstones = deleted.iter().filter(|d| d.revision == revision).count();
  if new_tombstones > 0 {
    log::info!(
      "Profile {}: recorded {new_tombstones} cookie deletion(s) at revision {revision}",
      profile.name
    );
  }

  let store = PortableCookieStore {
    version: FORMAT_VERSION,
    revision,
    device: crate::team_lock::device_id(),
    exported_at: now_secs(),
    source_os: crate::profile::types::get_host_os(),
    cookies,
    deleted,
  };

  write_store(profile, profiles_dir, &store)?;

  // Claim the blob as applied only when it is a pure snapshot of this browser.
  //
  // Recording it unconditionally quietly turned the whole "never tombstone a
  // blob you have not applied" guard into a one-shot. The sequence: a restore
  // fails to verify, so the marker is deliberately left behind for a retry; the
  // next export sees no marker, correctly downgrades to Unclean, and CARRIES the
  // unheld cookies forward — and then stamped the result as applied. The
  // promised retry never happened (the next launch saw the marker match and
  // skipped the restore), and the export after that passed the guard and
  // tombstoned exactly the cookies that were carried, deleting them everywhere.
  //
  // `retained` does not block the claim: those rows are in the store, or the
  // browser has already refused them. Only `carried` — writes the store never
  // captured — describes state this browser cannot be said to hold.
  if carried == 0 {
    set_applied_mark(
      &profile_id,
      profiles_dir,
      &AppliedMark {
        revision,
        device: store.device.clone(),
        unconfirmed: Vec::new(),
      },
    );
  } else {
    log::info!(
      "Profile {}: not claiming revision {revision} as applied — {carried} cookie(s) in it were \
       carried forward rather than read from this browser, so the next launch injects them",
      profile.name
    );
  }
  log::info!(
    "Profile {}: exported revision {revision} with {} cookie(s) to {FILE_NAME}",
    profile.name,
    store.cookies.len()
  );
  Ok(Some(store.cookies.len()))
}

/// Snapshot the profile's login state straight out of the running browser.
///
/// This is the primary export path, and the reason it exists is that the other
/// one requires knowing how the browser encrypts its store. Injection has always
/// let the browser do that work; reading it back did not, and the asymmetry was
/// the whole bug: a machine whose Wayfern build uses a key derivation this code
/// does not implement can be given login state perfectly well and can never
/// hand any back. Measured across a real pair — every blob on the macOS side
/// originated on macOS, thirteen hours after the Windows machine had logged in
/// and closed.
///
/// A CDP snapshot is also strictly better evidence than the database:
///
/// * It is the LIVE state, so it does not depend on Chromium having flushed.
/// * Because it is live, an absence really is an absence — which makes it
///   authoritative for deletions in a way a post-exit database read can never
///   be. Callers get [`ExitKind::Clean`] semantics without having to guess how
///   the browser stopped.
///
/// Returns the number of cookies written, or `None` when the browser could not
/// be reached (the caller should then fall back to [`export`]).
pub async fn export_from_browser(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
) -> Option<usize> {
  if profile.browser != "wayfern" || profile.ephemeral {
    return None;
  }
  let profile_path = effective_data_path(profile, profiles_dir)
    .to_string_lossy()
    .to_string();
  // A snapshot says "this is everything, absences are deletions". That is only
  // safe once this browser is known to hold the blob — otherwise a store that
  // Chromium wiped at startup, or one whose restore has not run yet, would be
  // captured as a mass logout and synced out as tombstones.
  let profile_id = profile.id.to_string();
  match load(profile, profiles_dir) {
    Ok(Some(blob)) => {
      if !already_applied(applied_mark(&profile_id, profiles_dir).as_ref(), &blob) {
        log::debug!(
          "Profile {}: not snapshotting — this browser has not been confirmed to hold \
           {FILE_NAME} revision {}",
          profile.name,
          blob.revision
        );
        return None;
      }
    }
    // No blob yet: nothing to contradict, so whatever the browser has is the
    // truth by definition.
    Ok(None) => {}
    Err(e) => {
      log::warn!("Profile {}: not snapshotting — {e}", profile.name);
      return None;
    }
  }

  let raw = crate::wayfern_manager::WayfernManager::instance()
    .get_all_cookies(&profile_path)
    .await?;

  let now = now_secs() as f64;
  let cookies: Vec<PortableCookie> = raw
    .iter()
    .filter_map(|c| {
      // CDP reports a session cookie as `session: true` with `expires: -1`.
      let expires = c.get("expires").and_then(|v| v.as_f64()).unwrap_or(-1.0);
      let session = c
        .get("session")
        .and_then(|v| v.as_bool())
        .unwrap_or(expires <= 0.0);
      if !session && expires <= now {
        return None;
      }
      let secure = c.get("secure").and_then(|v| v.as_bool()).unwrap_or(false);
      let same_site = c
        .get("sameSite")
        .and_then(|v| v.as_str())
        // Chromium refuses `SameSite=None` on a non-secure cookie, so sending it
        // back that way would lose the whole entry rather than one attribute.
        .filter(|s| *s != "None" || secure)
        .map(str::to_string);
      Some(PortableCookie {
        name: c.get("name")?.as_str()?.to_string(),
        value: c.get("value")?.as_str()?.to_string(),
        domain: c.get("domain")?.as_str()?.to_string(),
        path: c.get("path")?.as_str()?.to_string(),
        expires: (!session).then_some(expires),
        secure,
        http_only: c.get("httpOnly").and_then(|v| v.as_bool()).unwrap_or(false),
        same_site,
      })
    })
    .collect();

  if cookies.is_empty() {
    log::debug!(
      "Profile {}: the browser reports no cookies; leaving {FILE_NAME} untouched",
      profile.name
    );
    return None;
  }

  match write_snapshot(profile, profiles_dir, cookies) {
    Ok(n) => Some(n),
    Err(e) => {
      log::warn!("Profile {}: could not write {FILE_NAME}: {e}", profile.name);
      None
    }
  }
}

/// Persist an authoritative snapshot: everything the browser holds, nothing else.
///
/// Absences are real, so this derives tombstones unconditionally — no
/// [`ExitKind`] involved. Nothing is carried forward either, which is safe here
/// and only here: a live read cannot be missing something the browser has.
fn write_snapshot(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
  cookies: Vec<PortableCookie>,
) -> Result<usize, String> {
  let profile_id = profile.id.to_string();
  let previous = load(profile, profiles_dir).ok().flatten();
  let mark = applied_mark(&profile_id, profiles_dir);
  let revision = previous
    .as_ref()
    .map(|p| p.revision)
    .unwrap_or(0)
    .max(mark.as_ref().map(|m| m.revision).unwrap_or(0))
    + 1;

  let honoured_previous = previous
    .as_ref()
    .is_some_and(|p| already_applied(mark.as_ref(), p));
  let present: std::collections::HashSet<CookieKey> = cookies.iter().map(key_of).collect();
  let Reconciled {
    cookies,
    deleted,
    carried,
    ..
  } = reconcile(
    cookies,
    previous.as_ref(),
    ExitKind::Clean,
    revision,
    &present,
    honoured_previous,
  );
  debug_assert_eq!(carried, 0, "a live read never needs carrying");

  // Nothing changed? Do not write.
  //
  // The snapshot loop runs every couple of minutes for as long as a browser is
  // open. Writing an identical blob with a new revision each time would make the
  // file diff perpetually non-empty and put this profile into a permanent upload
  // loop — the exact failure the "an unchanged sync must issue zero PUTs" rule
  // exists to prevent.
  if let Some(prev) = previous.as_ref() {
    if !deleted.is_empty() {
      // fall through: a logout is always worth publishing
    } else if same_cookie_set(&prev.cookies, &cookies) {
      log::debug!(
        "Profile {}: login state unchanged since revision {}, not rewriting {FILE_NAME}",
        profile.name,
        prev.revision
      );
      return Ok(cookies.len());
    }
  }

  let store = PortableCookieStore {
    version: FORMAT_VERSION,
    revision,
    device: crate::team_lock::device_id(),
    exported_at: now_secs(),
    source_os: crate::profile::types::get_host_os(),
    cookies,
    deleted,
  };
  write_store(profile, profiles_dir, &store)?;
  // The browser is where these came from, so it holds them by definition.
  set_applied_mark(
    &profile_id,
    profiles_dir,
    &AppliedMark {
      revision,
      device: store.device.clone(),
      unconfirmed: Vec::new(),
    },
  );
  log::info!(
    "Profile {}: snapshotted revision {revision} from the running browser — {} cookie(s), {} \
     tombstone(s)",
    profile.name,
    store.cookies.len(),
    store.deleted.len()
  );
  Ok(store.cookies.len())
}

/// Do two cookie sets carry identical state? Compares values too — a refreshed
/// session token keeps the same key and absolutely must be published.
fn same_cookie_set(a: &[PortableCookie], b: &[PortableCookie]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  let index: std::collections::HashMap<CookieKey, &str> =
    a.iter().map(|c| (key_of(c), c.value.as_str())).collect();
  b.iter()
    .all(|c| index.get(&key_of(c)).is_some_and(|v| *v == c.value))
}

/// Keep snapshotting the profile's login state for as long as its browser runs.
///
/// The snapshot has to happen while CDP is alive, and there is no hook for "the
/// user is about to close this window" — by the time the status checker notices,
/// the process is gone and the only thing left is a store this machine may not
/// be able to read. Polling is what covers the case that actually matters to a
/// human: log in, browse, close the window.
///
/// Cheap: one CDP round trip per tick, and `write_snapshot` is skipped entirely
/// unless the cookie set actually changed.
pub fn spawn_snapshot_loop(profile: crate::profile::BrowserProfile, profiles_dir: PathBuf) {
  if profile.browser != "wayfern" || profile.ephemeral {
    return;
  }
  tauri::async_runtime::spawn(async move {
    let mut ticker = tokio::time::interval(SNAPSHOT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await; // the restore has only just finished
    loop {
      ticker.tick().await;
      // The browser going away ends the loop; the stop path takes the last
      // snapshot itself, while CDP is still up.
      let path = effective_data_path(&profile, &profiles_dir)
        .to_string_lossy()
        .to_string();
      if crate::wayfern_manager::WayfernManager::instance()
        .get_cdp_port(&path)
        .await
        .is_none()
      {
        log::debug!(
          "Profile {}: browser gone, stopping the snapshot loop",
          profile.name
        );
        return;
      }
      export_from_browser(&profile, &profiles_dir).await;
    }
  });
}

/// How often a running browser's login state is captured.
///
/// A compromise: short enough that closing a window loses at most this much of a
/// session, long enough that a browser left open all day is not writing a file
/// and queueing a sync every few seconds.
const SNAPSHOT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(120);

/// Combine a fresh read with the previous blob.
///
/// Returns `(cookies, tombstones, carried_forward_count)`.
///
/// On an unclean exit this is a union with fresh winning: an export is a
/// snapshot of what Chromium last *flushed*, which is not what the browser had.
/// Measured against the real binary — cookies injected over CDP and then
/// force-killed never reach the database, while a clean `Browser.close` writes
/// all of them — so a straight overwrite after a crash would push a shortfall to
/// every other machine.
///
/// On a clean exit the store IS authoritative, so a cookie that was in the
/// previous blob and is not in the store now was deleted, and gets a tombstone.
/// Without that distinction a logout can never propagate: the union resurrects it
/// on the very machine that performed it, forever.
fn reconcile(
  fresh: Vec<PortableCookie>,
  previous: Option<&PortableCookieStore>,
  exit: ExitKind,
  revision: u64,
  present: &std::collections::HashSet<CookieKey>,
  honoured_previous: bool,
) -> Reconciled {
  let Some(previous) = previous else {
    return Reconciled {
      cookies: fresh,
      deleted: Vec::new(),
      carried: 0,
      retained: 0,
    };
  };

  let now = now_secs() as f64;
  // Two different questions. `have` is "did we read a usable value for it" and
  // decides what to carry; `present` is "does the row exist at all" and decides
  // what may be called a deletion. A row we cannot decrypt answers no to the
  // first and yes to the second.
  let have: std::collections::HashSet<CookieKey> = fresh.iter().map(key_of).collect();

  let mut cookies = fresh;
  let mut carried = 0usize;
  let mut retained = 0usize;
  let mut deleted: Vec<DeletedCookie> = Vec::new();

  for c in &previous.cookies {
    if have.contains(&key_of(c)) {
      continue;
    }
    // A session cookie (no expiry) has no stated lifetime to have run out of,
    // and it is the kind most likely to be the actual login.
    if c.expires.is_some_and(|e| e <= now) {
      continue;
    }
    if present.contains(&key_of(c)) {
      // Either the row is in the store but would not decrypt, or the browser
      // refused it at restore time. Neither is a logout — and neither may be
      // DROPPED either, which is what a bare `continue` did here: the local
      // ciphertext is unreadable or the value was never accepted, so the
      // previous blob holds the only copy of it that still exists anywhere.
      // Losing it silently is the same outcome as the bug this module exists to
      // fix, arrived at from the other direction.
      //
      // Counted apart from `carried`: the browser demonstrably has this row (or
      // demonstrably will not take it), so it is not a reason to withhold the
      // applied marker.
      cookies.push(c.clone());
      retained += 1;
      continue;
    }
    match exit {
      ExitKind::Clean => deleted.push(DeletedCookie {
        name: c.name.clone(),
        domain: c.domain.clone(),
        path: c.path.clone(),
        secure: c.secure,
        revision,
      }),
      ExitKind::Unclean => {
        cookies.push(c.clone());
        carried += 1;
      }
    }
  }

  // Carry the previous tombstones, minus any whose cookie is present again (a
  // fresh login supersedes the logout) and minus any that have aged out.
  let floor = revision.saturating_sub(TOMBSTONE_HORIZON);
  for d in &previous.deleted {
    if d.revision < floor {
      continue;
    }
    // "The cookie is back, so the logout is spent" is only true if this browser
    // ever carried the logout out. When the blob was never applied here, the
    // cookie being present just means this machine still has the session the
    // OTHER machine deleted — retiring the tombstone on that basis destroys the
    // logout and republishes the cookie to everyone.
    if honoured_previous && have.contains(&key_of_deleted(d)) {
      continue;
    }
    deleted.push(d.clone());
  }

  Reconciled {
    cookies,
    deleted,
    carried,
    retained,
  }
}

/// What an export decided to write, and why the caller may or may not claim it.
struct Reconciled {
  cookies: Vec<PortableCookie>,
  deleted: Vec<DeletedCookie>,
  /// Cookies the store did not have and the browser may still have held —
  /// unflushed writes. Their presence means this blob describes more than this
  /// browser demonstrably contains, so it must NOT be marked as applied.
  carried: usize,
  /// Cookies kept because the store has them unreadably, or because the browser
  /// refused them. Neither blocks the marker.
  retained: usize,
}

/// Where this machine's copy of the cookie store actually lives right now.
///
/// Not always `profiles/<id>/profile`: an ephemeral or password-protected
/// profile runs from a separate directory, and for the password-protected case
/// that directory holds the only plaintext there is — the on-disk copy is a flat
/// tree of HMAC-named ciphertext with no `Default/Cookies` in it at all. Reading
/// the nominal path for those profiles returned "no cookie store" every time,
/// which combined with the store being device-local meant their login state
/// could not cross machines at all.
fn effective_data_path(profile: &crate::profile::BrowserProfile, profiles_dir: &Path) -> PathBuf {
  crate::ephemeral_dirs::get_effective_profile_path(profile, profiles_dir)
}

fn read_local_cookies(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
) -> Result<(Vec<crate::cookie_manager::UnifiedCookie>, usize), String> {
  crate::cookie_manager::CookieManager::read_all_cookies_at(
    profile,
    &effective_data_path(profile, profiles_dir),
  )
}

fn local_cookie_db(profile: &crate::profile::BrowserProfile, profiles_dir: &Path) -> PathBuf {
  crate::cookie_manager::CookieManager::chromium_cookie_db_path_at(&effective_data_path(
    profile,
    profiles_dir,
  ))
}

// ── at-rest storage ─────────────────────────────────────────────────────────

fn write_store(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
  store: &PortableCookieStore,
) -> Result<(), String> {
  let path = path_for(&profile.id.to_string(), profiles_dir);
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| format!("failed to create {FILE_NAME} dir: {e}"))?;
  }
  let json =
    serde_json::to_vec(store).map_err(|e| format!("failed to serialize {FILE_NAME}: {e}"))?;
  let bytes = seal_if_password_protected(profile, json)?;

  // Write via a temp file so a crash mid-write cannot leave a truncated blob
  // where a complete one used to be — that would read as "this profile has no
  // sessions" on every other machine.
  let tmp = path.with_extension("json.tmp");
  std::fs::write(&tmp, &bytes).map_err(|e| format!("failed to write {FILE_NAME}: {e}"))?;
  restrict_permissions(&tmp);
  std::fs::rename(&tmp, &path).map_err(|e| format!("failed to replace {FILE_NAME}: {e}"))?;
  Ok(())
}

/// Envelope marking a blob encrypted under the profile's own password key.
///
/// The blob sits at `profiles/<id>/portable-cookies.json`, one level above the
/// `profile/` subtree that password protection encrypts — so without this a
/// password-protected profile's sessions would sit in the clear next to the
/// ciphertext they were extracted from, which defeats the feature entirely.
#[derive(Serialize, Deserialize)]
struct SealedBlob {
  /// Present only on sealed blobs; its absence is how a plaintext blob is
  /// recognized without guessing.
  sealed: bool,
  data: String,
}

fn seal_if_password_protected(
  profile: &crate::profile::BrowserProfile,
  json: Vec<u8>,
) -> Result<Vec<u8>, String> {
  if !profile.password_protected {
    return Ok(json);
  }
  let key = crate::profile::encryption::get_cached_key(&profile.id).ok_or_else(|| {
    // Only reachable while the profile is locked, and export only runs right
    // after a session, so the key is cached. Refusing beats writing plaintext.
    format!(
      "profile {} is password-protected and its key is not unlocked; refusing to write \
       {FILE_NAME} in the clear",
      profile.name
    )
  })?;
  let ct = crate::sync::encryption::encrypt_bytes(&key, &json)
    .map_err(|e| format!("failed to seal {FILE_NAME}: {e}"))?;
  use base64::Engine;
  let envelope = SealedBlob {
    sealed: true,
    data: base64::engine::general_purpose::STANDARD.encode(&ct),
  };
  serde_json::to_vec(&envelope).map_err(|e| format!("failed to serialize {FILE_NAME}: {e}"))
}

fn unseal_if_needed(
  profile: &crate::profile::BrowserProfile,
  raw: Vec<u8>,
) -> Result<Vec<u8>, String> {
  let Ok(envelope) = serde_json::from_slice::<SealedBlob>(&raw) else {
    return Ok(raw);
  };
  if !envelope.sealed {
    return Ok(raw);
  }
  let key = crate::profile::encryption::get_cached_key(&profile.id).ok_or_else(|| {
    format!(
      "{FILE_NAME} is sealed and profile {} is locked",
      profile.name
    )
  })?;
  use base64::Engine;
  let ct = base64::engine::general_purpose::STANDARD
    .decode(&envelope.data)
    .map_err(|e| format!("invalid sealed {FILE_NAME}: {e}"))?;
  crate::sync::encryption::decrypt_bytes(&key, &ct)
    .map_err(|e| format!("failed to unseal {FILE_NAME}: {e}"))
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
  use std::os::unix::fs::PermissionsExt;
  if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
    log::warn!("Failed to restrict permissions on {}: {e}", path.display());
  }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {
  // Windows inherits the parent ACL, which for %LOCALAPPDATA% is already
  // per-user. The portable-install caveat is the same one that applies to every
  // other file under the data directory.
}

pub fn load(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
) -> Result<Option<PortableCookieStore>, String> {
  let path = path_for(&profile.id.to_string(), profiles_dir);
  if !path.exists() {
    return Ok(None);
  }
  let raw = std::fs::read(&path).map_err(|e| format!("failed to read {FILE_NAME}: {e}"))?;
  let plain = unseal_if_needed(profile, raw)?;
  let store: PortableCookieStore =
    serde_json::from_slice(&plain).map_err(|e| format!("failed to parse {FILE_NAME}: {e}"))?;
  if store.version > FORMAT_VERSION {
    return Err(format!(
      "{FILE_NAME} was written by a newer build (format v{}, this build reads v{FORMAT_VERSION})",
      store.version
    ));
  }
  Ok(Some(store))
}

/// One-line human summary for logs, or `None` when the file is absent.
///
/// Never returns cookie names or values — the point of a log line here is
/// "did login state arrive and how old is it", not what the sessions are.
pub fn describe(path: &Path) -> Option<String> {
  let raw = std::fs::read(path).ok()?;
  match serde_json::from_slice::<PortableCookieStore>(&raw) {
    Ok(s) => Some(format!(
      "{FILE_NAME} present: revision {}, {} cookie(s), {} tombstone(s), exported {}s ago on {} \
       by device {}",
      s.revision,
      s.cookies.len(),
      s.deleted.len(),
      now_secs().saturating_sub(s.exported_at),
      s.source_os,
      &s.device.chars().take(8).collect::<String>(),
    )),
    Err(_) => Some(format!("{FILE_NAME} present ({} bytes, sealed)", raw.len())),
  }
}

/// Why a launch should (or should not) push the portable blob back in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreDecision {
  /// No blob, or nothing in it.
  Nothing,
  /// This machine's browser already holds this revision.
  LocalIsCurrent,
  /// Push it in. The reason is carried for the log line.
  Restore(&'static str),
}

/// Decide whether the blob should be injected.
///
/// `applied` is the revision this machine last injected; `host_can_read_local` is
/// whether this machine's browser can still decrypt its own store.
///
/// No clock is consulted, deliberately. See the module header.
pub fn decide(
  store: &PortableCookieStore,
  applied: Option<&AppliedMark>,
  local_store_exists: bool,
  host_can_read_local: bool,
) -> RestoreDecision {
  if store.cookies.is_empty() && store.deleted.is_empty() {
    return RestoreDecision::Nothing;
  }
  if !local_store_exists {
    return RestoreDecision::Restore("this machine has no cookie store yet");
  }
  if !host_can_read_local {
    return RestoreDecision::Restore("this machine cannot read the local cookie store");
  }
  // Identity, not magnitude. `revision > applied` reads a peer's same-numbered
  // blob as already applied, skips the restore, and then lets the next export
  // treat that never-applied blob as the deletion baseline. Injecting is
  // idempotent, so erring towards restoring costs nothing.
  if !already_applied(applied, store) {
    return RestoreDecision::Restore("this machine has not applied this blob");
  }
  // A session cookie is never still there to be "already applied".
  //
  // Chromium deletes every non-persistent row from the store at STARTUP unless
  // the startup pref says restore-last-session — which only the
  // `--restore-last-session` switch sets, and automation and headless launches
  // deliberately omit it. Measured on Wayfern 150.0.7871.102: seed a session
  // cookie, close cleanly, relaunch without the switch, and it is gone from
  // `Default/Cookies` before CDP even exists; relaunch with the switch and it
  // survives.
  //
  // Skipping the restore here is what made that invisible: the browser came up
  // wiped, the clean stop then read those absences as logouts, and the tombstones
  // deleted the same sessions on every other machine. Re-injecting is idempotent,
  // so the cost of always restoring is a few hundred CDP entries per launch.
  if store.cookies.iter().any(|c| c.expires.is_none()) {
    return RestoreDecision::Restore("the browser drops session cookies at startup");
  }
  RestoreDecision::LocalIsCurrent
}

/// Export any profile whose portable state is missing or behind its own store.
///
/// Two jobs, both of which the on-exit export cannot do:
///
/// * **Migration.** Every profile that existed before this mechanism has its
///   login state only in the encrypted store. Waiting for each one to be opened
///   and closed once would mean a fleet where some profiles carry their
///   sessions and some silently do not, and the ones that do not are exactly
///   the ones nobody has touched recently.
/// * **Crashes.** The on-exit hooks run when the browser is stopped or observed
///   to have exited. A hard kill, a power loss, or an app crash skips both.
///
/// Treated as an [`ExitKind::Unclean`] exit throughout: this runs at startup with
/// no knowledge of how the last session ended, so absences must not be read as
/// deletions.
///
/// Skips profiles whose browser is running: their store is being written to
/// right now, and a snapshot taken mid-session is not better than the one from
/// the last clean exit.
pub fn backfill_all() {
  let manager = crate::profile::ProfileManager::instance();
  let profiles_dir = manager.get_profiles_dir();
  let profiles = match manager.list_profiles() {
    Ok(p) => p,
    Err(e) => {
      log::warn!("Could not list profiles to backfill {FILE_NAME}: {e}");
      return;
    }
  };

  let mut exported = 0usize;
  for profile in profiles.iter().filter(|p| p.browser == "wayfern") {
    if profile.process_id.is_some() || profile.ephemeral {
      continue;
    }
    // A password-protected profile at rest has no readable store — its plaintext
    // only exists in the ephemeral dir while it runs, and it is not running.
    if profile.password_protected
      && crate::profile::encryption::get_cached_key(&profile.id).is_none()
    {
      continue;
    }
    if !local_cookie_db(profile, &profiles_dir).exists() {
      continue;
    }

    let profile_id = profile.id.to_string();
    match load(profile, &profiles_dir) {
      // Skip when the blob is at least as new as anything this machine has, AND
      // the browser has not written cookies since it was made.
      //
      // The revision half alone was tautological: a normal export records its
      // own revision in the marker, so `blob.revision >= applied` held on every
      // healthy profile and the crash-recovery case this function exists for
      // never ran once.
      //
      // The second half compares two LOCAL file mtimes — the cookie database
      // against the blob — so no other machine's clock is involved. That was the
      // flaw in the original design and it is not being reintroduced: this only
      // asks "did my own browser write after my own export", which one
      // filesystem can answer.
      Ok(Some(s))
        if s.revision > 0
          && s.revision
            >= applied_mark(&profile_id, &profiles_dir)
              .map(|m| m.revision)
              .unwrap_or(0)
          && !local_store_written_since_blob(profile, &profiles_dir) =>
      {
        continue
      }
      // A blob this build cannot read is not a blob to overwrite: it may have
      // been written by a newer format, and replacing it would lose whatever it
      // holds on every other machine too.
      Err(e) => {
        log::warn!("Profile {}: not backfilling — {e}", profile.name);
        continue;
      }
      _ => {}
    }

    match export(profile, &profiles_dir, ExitKind::Unclean) {
      Ok(Some(_)) => exported += 1,
      Ok(None) => {}
      Err(e) => log::warn!("Profile {}: backfill failed: {e}", profile.name),
    }
  }
  if exported > 0 {
    log::info!("Backfilled {FILE_NAME} for {exported} profile(s)");
  }
}

/// How Chromium itself says the last session ended.
///
/// `profile.exit_type` in `Default/Preferences` is Chromium's own crash marker:
/// it is set to `"Crashed"` at startup and rewritten to `"Normal"` only during
/// an orderly shutdown, which is exactly the flush that decides whether the
/// cookie store on disk is complete.
///
/// This exists because the status checker cannot tell the difference on its own.
/// It observes "the tracked process is gone", which is identical for the user
/// closing the window, a renderer crash, an OOM kill, and the app's own reaper —
/// and asserting `Clean` there turned every one of those into a fleet-wide
/// logout. Defaults to `Unclean`: absent, unreadable, or unrecognized all mean
/// "no evidence".
pub fn observed_exit_kind(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
) -> ExitKind {
  let prefs = effective_data_path(profile, profiles_dir)
    .join("Default")
    .join("Preferences");

  // The "Normal" has to have been written by THIS session.
  //
  // Chromium stamps `exit_type: "Crashed"` at startup but only flushes
  // Preferences periodically, so a browser that dies early still has the
  // PREVIOUS clean shutdown's "Normal" on disk. Believing it would let a crash
  // right after a restore be read as an orderly exit, and a clean exit is
  // exactly what licenses tombstoning every cookie the crash failed to flush.
  //
  // The sentinel is touched at launch, so requiring Preferences to be newer
  // compares two files on one filesystem — no clock from another machine, and
  // nothing to get wrong about time zones.
  let sentinel =
    marker_path(&profile.id.to_string(), profiles_dir).with_file_name("portable-cookies.launched");
  let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
  match (mtime(&prefs), mtime(&sentinel)) {
    (Some(p), Some(l)) if p > l => {}
    (_, None) => {
      // No sentinel: either a build that predates it, or a browser this app
      // never launched. Nothing to compare against, so no evidence.
      log::debug!(
        "Profile {}: no launch sentinel; treating the exit as unclean",
        profile.name
      );
      return ExitKind::Unclean;
    }
    _ => {
      log::debug!(
        "Profile {}: Preferences was not rewritten during this session; its exit_type describes \
         an earlier run, so this exit counts as unclean",
        profile.name
      );
      return ExitKind::Unclean;
    }
  }

  let Ok(raw) = std::fs::read(&prefs) else {
    return ExitKind::Unclean;
  };
  let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else {
    return ExitKind::Unclean;
  };
  match v
    .get("profile")
    .and_then(|p| p.get("exit_type"))
    .and_then(|e| e.as_str())
  {
    Some("Normal") => ExitKind::Clean,
    other => {
      log::debug!(
        "Profile {}: Chromium reports exit_type {:?}; treating the export as unclean",
        profile.name,
        other
      );
      ExitKind::Unclean
    }
  }
}

/// Mark the start of a browser session, for [`observed_exit_kind`] to compare
/// Chromium's own shutdown marker against.
pub fn note_launch(profile_id: &str, profiles_dir: &Path) {
  let path = marker_path(profile_id, profiles_dir).with_file_name("portable-cookies.launched");
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  // Content is irrelevant; only the mtime is read.
  if let Err(e) = std::fs::write(&path, b"") {
    log::debug!("Could not write the launch sentinel for {profile_id}: {e}");
  }
}

/// Has the browser written cookies since the blob was last produced?
///
/// Both paths are on this machine, so this compares one filesystem's clock with
/// itself. It answers the only question `backfill_all` needs: is there a session
/// in the local store that no export has captured — which is exactly what a
/// crash leaves behind.
fn local_store_written_since_blob(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
) -> bool {
  let mtime = |p: PathBuf| {
    std::fs::metadata(p)
      .and_then(|m| m.modified())
      .ok()
      .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
      .map(|d| d.as_secs())
  };
  let Some(store) = mtime(local_cookie_db(profile, profiles_dir)) else {
    return false;
  };
  let Some(blob) = mtime(path_for(&profile.id.to_string(), profiles_dir)) else {
    return true;
  };
  store > blob
}

/// Decide, **before the browser starts**, whether its sessions need putting
/// back — and hand back the blob to put back if so.
///
/// Reading the local store's state before launch rather than after is not
/// incidental: Chromium rewrites the cookie database as part of starting up, so
/// a post-launch "does this machine have a store" check answers yes for a
/// profile that arrived with nothing. The injection itself still has to wait for
/// CDP — see [`apply`].
pub fn plan_restore(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
  host_can_read: bool,
) -> Option<PortableCookieStore> {
  if profile.browser != "wayfern" || profile.ephemeral {
    return None;
  }
  let store = match load(profile, profiles_dir) {
    Ok(Some(s)) => s,
    Ok(None) => return None,
    Err(e) => {
      log::warn!("Profile {}: {e}", profile.name);
      return None;
    }
  };

  let profile_id = profile.id.to_string();
  let mark = applied_mark(&profile_id, profiles_dir);
  let exists = local_cookie_db(profile, profiles_dir).exists();

  match decide(&store, mark.as_ref(), exists, host_can_read) {
    RestoreDecision::Nothing => None,
    RestoreDecision::LocalIsCurrent => {
      log::info!(
        "Profile {}: browser already holds revision {} of {FILE_NAME}, not re-injecting",
        profile.name,
        store.revision
      );
      None
    }
    RestoreDecision::Restore(reason) => {
      log::info!(
        "Profile {}: will restore revision {} from device {} ({} cookie(s), {} tombstone(s)) \
         after launch — {reason}",
        profile.name,
        store.revision,
        &store.device.chars().take(8).collect::<String>(),
        store.cookies.len(),
        store.deleted.len()
      );
      Some(store)
    }
  }
}

/// Push a planned restore into the running browser over CDP.
///
/// Returns the number of cookies the browser confirmed holding afterwards.
/// Never fatal to a launch: a browser that came up logged out is still a browser
/// the user can log into, whereas refusing to start helps nobody.
///
/// The applied marker is recorded ONLY when the browser confirms every cookie
/// went in and every tombstone took effect. Recording it optimistically is what
/// makes a partial injection dangerous: the next clean exit would diff the live
/// store against a blob the browser only partly holds and tombstone the
/// difference, turning cookies the browser rejected into logouts on machines
/// where they were perfectly valid.
pub async fn apply(
  profile: &crate::profile::BrowserProfile,
  profiles_dir: &Path,
  store: &PortableCookieStore,
) -> Option<usize> {
  // Address the browser by the directory it is ACTUALLY running from. For an
  // ephemeral or password-protected profile that is not the on-disk path, and
  // using the latter meant the CDP instance lookup missed and every restore
  // failed for exactly the profiles whose login state is hardest to replace.
  let profile_path = effective_data_path(profile, profiles_dir)
    .to_string_lossy()
    .to_string();
  let profile_id = profile.id.to_string();
  let manager = crate::wayfern_manager::WayfernManager::instance();

  // Deletions first: a tombstone and a set for the same cookie in one batch
  // would otherwise race, and a logout must not be undone by the same call that
  // is meant to carry it.
  // Every tombstone in the blob, not just the ones numbered above our marker.
  //
  // Reaching `apply` at all means `decide` found this blob unapplied here, so
  // none of its tombstones have been honoured by this browser. Filtering by
  // revision magnitude dropped a peer's logout whenever our own counter had
  // moved further — and then the marker was recorded anyway, so it was never
  // retried. Deleting a cookie that is not there is a no-op, which is what makes
  // applying the whole set safe.
  let pending: Vec<&DeletedCookie> = store.deleted.iter().collect();
  if !pending.is_empty() {
    let payload: Vec<serde_json::Value> = pending
      .iter()
      .map(|d| serde_json::json!({ "name": d.name, "domain": d.domain, "path": d.path }))
      .collect();
    match manager.delete_cookies(&profile_path, &payload).await {
      Ok(n) => log::info!(
        "Profile {}: applied {n} cookie deletion(s) from {FILE_NAME}",
        profile.name
      ),
      Err(e) => log::warn!("Profile {}: could not apply deletions: {e}", profile.name),
    }
  }

  let payload: Vec<serde_json::Value> = store
    .cookies
    .iter()
    .filter_map(|c| serde_json::to_value(c).ok())
    .collect();

  if !payload.is_empty() {
    if let Err(e) = manager.set_cookies(&profile_path, &payload).await {
      log::error!(
        "Profile {}: failed to restore login state: {e}",
        profile.name
      );
      return None;
    }
  }

  // Read back rather than trusting the call count.
  //
  // A CDP command returning without an error says the browser accepted the
  // MESSAGE, not that it accepted every cookie in it — a single malformed entry
  // is dropped silently. And the whole failure mode here is invisible: a browser
  // that opens logged out looks exactly like a profile that was never logged in.
  let Some(live) = manager.live_cookie_keys(&profile_path).await else {
    // Could not verify. Do NOT record the mark — an unverified injection must be
    // retried next launch, and (more importantly) must never become the baseline
    // a future export derives deletions from.
    log::warn!(
      "Profile {}: sent {} cookie(s) but could not read them back to confirm",
      profile.name,
      store.cookies.len()
    );
    manager.reload_all_pages(&profile_path).await;
    return None;
  };

  let wanted: Vec<CookieKey> = store.cookies.iter().map(key_of).collect();
  let missing: Vec<&CookieKey> = wanted.iter().filter(|k| !live.contains(*k)).collect();
  let undeleted = pending
    .iter()
    .filter(|d| live.contains(&(d.domain.clone(), d.name.clone(), d.path.clone())))
    .count();
  let confirmed = wanted.len() - missing.len();

  if undeleted > 0 {
    // A tombstone that did not take is the one failure worth retrying whole: the
    // blob says this session is gone and this browser still has it. Leaving the
    // marker unset means the next launch tries the deletion again, and (via the
    // `already_applied` check in `export`) that this browser will not meanwhile
    // start deriving its own deletions from a blob it has not fully honoured.
    log::warn!(
      "Profile {}: {undeleted} deletion(s) from revision {} did not take — not recording it as \
       applied; it will be retried next launch",
      profile.name,
      store.revision
    );
  } else {
    if missing.is_empty() {
      log::info!(
        "Profile {}: browser confirmed all {confirmed} restored cookie(s)",
        profile.name
      );
    } else {
      // Recorded anyway, with the shortfall written down.
      //
      // Refusing to record until every last cookie lands sounds safer and is
      // not: one oversized or malformed entry out of a few hundred would freeze
      // the marker permanently, and a frozen marker keeps `export` in
      // carry-forward-only mode forever, which quietly turns logout propagation
      // off for good. Naming the keys instead lets the marker advance while
      // making exactly those keys untombstonable.
      log::warn!(
        "Profile {}: browser holds {confirmed} of {} cookie(s) from revision {}; the {} it \
         rejected are recorded so they are never mistaken for logouts",
        profile.name,
        wanted.len(),
        store.revision,
        missing.len()
      );
    }
    set_applied_mark(
      &profile_id,
      profiles_dir,
      &AppliedMark {
        revision: store.revision,
        device: store.device.clone(),
        unconfirmed: missing.iter().map(|k| (*k).clone()).collect(),
      },
    );
  }

  // Anything already loaded was fetched without these cookies. Reloading is
  // cheaper and more reliable than trying to guarantee nothing navigated first:
  // `--restore-last-session` reopens tabs at process spawn and a start URL is
  // navigated inside the launch, both before CDP hands control back here.
  manager.reload_all_pages(&profile_path).await;
  Some(confirmed)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;

  fn cookie(name: &str, domain: &str, expires: Option<f64>) -> PortableCookie {
    PortableCookie {
      name: name.into(),
      value: "v".into(),
      domain: domain.into(),
      path: "/".into(),
      expires,
      secure: true,
      http_only: true,
      same_site: None,
    }
  }

  fn store_from(revision: u64, device: &str, cookies: Vec<PortableCookie>) -> PortableCookieStore {
    PortableCookieStore {
      version: FORMAT_VERSION,
      revision,
      device: device.into(),
      exported_at: 0,
      source_os: "macos".into(),
      cookies,
      deleted: Vec::new(),
    }
  }

  fn store(revision: u64, cookies: Vec<PortableCookie>) -> PortableCookieStore {
    store_from(revision, "dev", cookies)
  }

  fn mark(revision: u64, device: &str) -> AppliedMark {
    AppliedMark {
      revision,
      device: device.into(),
      unconfirmed: Vec::new(),
    }
  }

  fn keys(cs: &[PortableCookie]) -> HashSet<CookieKey> {
    cs.iter().map(key_of).collect()
  }

  // ── freshness ─────────────────────────────────────────────────────────────

  #[test]
  fn empty_blob_is_never_restored() {
    assert_eq!(
      decide(&store(3, vec![]), None, true, true),
      RestoreDecision::Nothing
    );
  }

  #[test]
  fn missing_or_unreadable_local_store_always_restores() {
    let s = store(1, vec![cookie("a", ".x.com", None)]);
    let m = mark(1, "dev");
    assert!(matches!(
      decide(&s, Some(&m), false, true),
      RestoreDecision::Restore(_)
    ));
    assert!(matches!(
      decide(&s, Some(&m), true, false),
      RestoreDecision::Restore(_)
    ));
  }

  #[test]
  fn a_machine_does_not_re_inject_a_blob_it_already_applied() {
    // Persistent on purpose: a blob holding session cookies always restores,
    // because Chromium wipes them at startup (see `decide`).
    let s = store_from(7, "A", vec![cookie("a", ".x.com", Some(4e9))]);
    assert_eq!(
      decide(&s, Some(&mark(7, "A")), true, true),
      RestoreDecision::LocalIsCurrent
    );
    assert!(matches!(
      decide(&s, Some(&mark(6, "A")), true, true),
      RestoreDecision::Restore(_)
    ));
    assert!(matches!(
      decide(&s, None, true, true),
      RestoreDecision::Restore(_)
    ));
  }

  /// Two machines exporting while partitioned both reach the same revision from
  /// different content. Comparing magnitudes reads the peer's blob as already
  /// applied, skips the restore, and then lets the next clean exit tombstone
  /// every cookie in a blob this browser never held.
  #[test]
  fn an_equal_revision_from_another_device_is_not_already_applied() {
    let theirs = store_from(5, "B", vec![cookie("a", ".x.com", None)]);
    assert!(
      matches!(
        decide(&theirs, Some(&mark(5, "A")), true, true),
        RestoreDecision::Restore(_)
      ),
      "same number, different origin — must still be applied"
    );
  }

  /// No clock anywhere in the decision, by construction.
  #[test]
  fn decision_ignores_exported_at_entirely() {
    let mut ancient = store_from(9, "A", vec![cookie("a", ".x.com", Some(4e9))]);
    ancient.exported_at = 0;
    let mut futuristic = ancient.clone();
    futuristic.exported_at = u64::MAX;
    for m in [Some(mark(8, "A")), Some(mark(9, "A")), None] {
      assert_eq!(
        decide(&ancient, m.as_ref(), true, true),
        decide(&futuristic, m.as_ref(), true, true)
      );
    }
  }

  #[test]
  fn applied_marker_round_trips_and_defaults_to_none() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(applied_mark("p", dir.path()), None);
    let m = AppliedMark {
      revision: 42,
      device: "device-x".into(),
      unconfirmed: vec![(".a.com".into(), "rejected".into(), "/".into())],
    };
    set_applied_mark("p", dir.path(), &m);
    assert_eq!(
      applied_mark("p", dir.path()),
      Some(m),
      "the rejected keys must survive a round trip — they are what keeps a \
       cookie the browser refused from being exported as a logout"
    );
    // Device-local: it must live where sync does not look.
    assert!(marker_path("p", dir.path())
      .to_string_lossy()
      .contains(".donut-sync"));
  }

  // ── reconcile ─────────────────────────────────────────────────────────────

  #[test]
  fn unclean_exit_carries_forward_and_records_no_deletions() {
    let previous = store(
      4,
      vec![
        cookie("SESSDATA", ".bilibili.com", None),
        cookie(
          "web_session",
          ".xiaohongshu.com",
          Some(now_secs() as f64 + 9999.0),
        ),
        cookie("dead", ".zhihu.com", Some(1.0)),
      ],
    );
    let fresh = vec![cookie("SESSDATA", ".bilibili.com", None)];
    let present = keys(&fresh);

    let Reconciled {
      cookies,
      deleted,
      carried,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Unclean, 5, &present, true);
    assert_eq!(carried, 1, "the expired one is dropped, not carried");
    assert!(deleted.is_empty(), "a crash proves nothing about deletion");
    let names: Vec<&str> = cookies.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"web_session"));
    assert!(!names.contains(&"dead"));
  }

  #[test]
  fn clean_exit_turns_absences_into_tombstones() {
    let previous = store(
      4,
      vec![
        cookie("SESSDATA", ".bilibili.com", None),
        cookie("web_session", ".xiaohongshu.com", None),
      ],
    );
    let fresh = vec![cookie("SESSDATA", ".bilibili.com", None)];
    let present = keys(&fresh);

    let Reconciled {
      cookies,
      deleted,
      carried,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Clean, 5, &present, true);
    assert_eq!(carried, 0);
    assert_eq!(cookies.len(), 1);
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].name, "web_session");
    assert_eq!(deleted[0].revision, 5);
  }

  /// A row that exists but will not decrypt is evidence the cookie is THERE.
  /// Calling it a deletion exports "this machine cannot read it" as "the user
  /// logged out" — to machines that read it perfectly well.
  #[test]
  fn an_undecryptable_row_is_not_a_deletion() {
    let previous = store(
      4,
      vec![
        cookie("SESSDATA", ".bilibili.com", None),
        cookie("web_session", ".xiaohongshu.com", None),
      ],
    );
    let fresh = vec![cookie("SESSDATA", ".bilibili.com", None)];
    // The store still holds the row; its value just did not decrypt.
    let mut present = keys(&fresh);
    present.insert((".xiaohongshu.com".into(), "web_session".into(), "/".into()));

    let Reconciled {
      cookies,
      deleted,
      carried,
      retained,
    } = reconcile(fresh, Some(&previous), ExitKind::Clean, 5, &present, true);
    assert!(deleted.is_empty(), "present-but-unreadable is not a logout");
    assert_eq!(retained, 1);
    assert_eq!(
      carried, 0,
      "the row is in the store, so it does not block claiming the blob"
    );
    assert!(
      cookies.iter().any(|c| c.name == "web_session"),
      "it must stay IN the blob: the local ciphertext will not decrypt, so the \
       previous blob holds the only readable copy left anywhere"
    );
  }

  /// A tombstone from a blob this machine never applied must survive the export
  /// even though the cookie is still here — the cookie being present is the
  /// whole point (the other machine logged out, we have not yet).
  #[test]
  fn an_unhonoured_tombstone_is_not_retired_by_the_cookie_still_being_here() {
    let mut previous = store(5, vec![]);
    previous.deleted = vec![DeletedCookie {
      name: "web_session".into(),
      domain: ".xiaohongshu.com".into(),
      path: "/".into(),
      secure: true,
      revision: 5,
    }];
    let fresh = vec![cookie("web_session", ".xiaohongshu.com", None)];
    let present = keys(&fresh);

    let Reconciled { deleted, .. } = reconcile(
      fresh.clone(),
      Some(&previous),
      ExitKind::Clean,
      6,
      &present,
      false,
    );
    assert_eq!(
      deleted.len(),
      1,
      "not applied here — the logout must survive"
    );

    let Reconciled { deleted, .. } =
      reconcile(fresh, Some(&previous), ExitKind::Clean, 6, &present, true);
    assert!(
      deleted.is_empty(),
      "applied here — a fresh login retires it"
    );
  }

  #[test]
  fn a_returning_cookie_drops_its_tombstone() {
    let mut previous = store(5, vec![]);
    previous.deleted = vec![DeletedCookie {
      name: "web_session".into(),
      domain: ".xiaohongshu.com".into(),
      path: "/".into(),
      secure: true,
      revision: 5,
    }];
    let fresh = vec![cookie("web_session", ".xiaohongshu.com", None)];
    let present = keys(&fresh);

    let Reconciled {
      cookies,
      deleted,
      carried: _,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Clean, 6, &present, true);
    assert_eq!(cookies.len(), 1);
    assert!(deleted.is_empty(), "the fresh login supersedes the logout");
  }

  #[test]
  fn tombstones_age_out_instead_of_growing_forever() {
    let mut previous = store(500, vec![]);
    previous.deleted = vec![
      DeletedCookie {
        name: "old".into(),
        domain: ".a.com".into(),
        path: "/".into(),
        secure: true,
        revision: 1,
      },
      DeletedCookie {
        name: "recent".into(),
        domain: ".b.com".into(),
        path: "/".into(),
        secure: true,
        revision: 500,
      },
    ];
    let fresh = vec![cookie("x", ".c.com", None)];
    let present = keys(&fresh);
    let Reconciled {
      cookies: _,
      deleted,
      carried: _,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Clean, 501, &present, true);
    let names: Vec<&str> = deleted.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, vec!["recent"]);
  }

  #[test]
  fn reconcile_keys_on_domain_name_and_path() {
    let previous = store(1, vec![cookie("sid", ".a.com", None)]);
    let fresh = vec![cookie("sid", ".b.com", None)];
    let present = keys(&fresh);
    let Reconciled {
      cookies,
      deleted,
      carried,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Unclean, 2, &present, true);
    assert_eq!(carried, 1);
    assert_eq!(cookies.len(), 2);
    assert!(deleted.is_empty());
  }

  #[test]
  fn fresh_value_wins_over_the_carried_one() {
    let previous = store(1, vec![cookie("sid", ".a.com", None)]);
    let mut fresh = cookie("sid", ".a.com", None);
    fresh.value = "refreshed".into();
    let fresh = vec![fresh];
    let present = keys(&fresh);
    let Reconciled {
      cookies,
      deleted: _,
      carried,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Unclean, 2, &present, true);
    assert_eq!(carried, 0);
    assert_eq!(cookies.len(), 1);
    assert_eq!(cookies[0].value, "refreshed");
  }

  // ── serialization ─────────────────────────────────────────────────────────

  #[test]
  fn same_site_labels_match_chromium_column() {
    assert_eq!(same_site_label(-1), None);
    assert_eq!(same_site_label(0), Some("None"));
    assert_eq!(same_site_label(1), Some("Lax"));
    assert_eq!(same_site_label(2), Some("Strict"));
    assert_eq!(same_site_label(7), None);
  }

  #[test]
  fn unspecified_same_site_is_absent_not_null() {
    let mut s = store(1, vec![cookie("a", ".x.com", None)]);
    s.cookies[0].same_site = None;
    s.cookies.push(PortableCookie {
      name: "lax".into(),
      value: "y".into(),
      domain: "example.com".into(),
      path: "/".into(),
      expires: Some(1.0),
      secure: false,
      http_only: false,
      same_site: Some("Lax".into()),
    });
    let v: serde_json::Value = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
    assert!(
      v["cookies"][0].get("sameSite").is_none(),
      "unspecified must be absent, not null or \"None\" — Chromium treats \
       unspecified as lax-with-exceptions and rejects None on insecure cookies"
    );
    assert!(v["cookies"][0].get("expires").is_none());
    assert_eq!(v["cookies"][1]["sameSite"], "Lax");
  }

  #[test]
  fn a_v1_blob_still_parses_as_revision_zero() {
    let raw = br#"{"version":1,"exported_at":123,"device":"d","source_os":"macos",
      "cookies":[{"name":"a","value":"b","domain":".x.com","path":"/","secure":true,"httpOnly":true}]}"#;
    let s: PortableCookieStore = serde_json::from_slice(raw).unwrap();
    assert_eq!(s.revision, 0);
    assert!(s.deleted.is_empty());
    assert_eq!(s.cookies.len(), 1);
  }

  // ── exit classification ───────────────────────────────────────────────────

  pub fn test_profile() -> crate::profile::types::BrowserProfile {
    crate::profile::types::BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "t".to_string(),
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
      host_os: None,
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

  /// `Clean` must never be assumed. The status checker cannot tell a user
  /// closing the window from a crash or the app's own reaper, and a wrong
  /// `Clean` turns every not-yet-flushed cookie into a synced logout.
  #[test]
  fn exit_kind_needs_positive_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let profile = test_profile();
    let profiles_dir = dir.path();
    let data = profiles_dir.join(profile.id.to_string()).join("profile");
    std::fs::create_dir_all(data.join("Default")).unwrap();
    let prefs = data.join("Default").join("Preferences");

    // No sentinel and no Preferences — no evidence.
    assert_eq!(
      observed_exit_kind(&profile, profiles_dir),
      ExitKind::Unclean
    );
    note_launch(&profile.id.to_string(), profiles_dir);
    // Sentinel but no Preferences — still nothing.
    assert_eq!(
      observed_exit_kind(&profile, profiles_dir),
      ExitKind::Unclean
    );
    // Chromium's crash marker.
    std::fs::write(&prefs, br#"{"profile":{"exit_type":"Crashed"}}"#).unwrap();
    assert_eq!(
      observed_exit_kind(&profile, profiles_dir),
      ExitKind::Unclean
    );
    // Unparsable.
    std::fs::write(&prefs, b"not json").unwrap();
    assert_eq!(
      observed_exit_kind(&profile, profiles_dir),
      ExitKind::Unclean
    );
    // The one case that counts: "Normal", written after this session started.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(&prefs, br#"{"profile":{"exit_type":"Normal"}}"#).unwrap();
    assert_eq!(observed_exit_kind(&profile, profiles_dir), ExitKind::Clean);

    // A "Normal" left over from a PREVIOUS run is not evidence about this one.
    // Chromium stamps "Crashed" at startup but only flushes Preferences
    // periodically, so a browser that dies early still has the last clean
    // shutdown's value on disk — and believing it licenses tombstoning every
    // cookie the crash failed to flush.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    note_launch(&profile.id.to_string(), profiles_dir);
    assert_eq!(
      observed_exit_kind(&profile, profiles_dir),
      ExitKind::Unclean,
      "Preferences predates this session's launch"
    );
  }
}

#[cfg(test)]
mod marker_shortfall_tests {
  use super::tests_support::*;
  use super::*;

  /// The browser refused a cookie at restore time. That absence must never be
  /// exported as a logout — the user did not do it, and the machines that CAN
  /// hold that cookie would have it deleted.
  #[test]
  fn a_rejected_cookie_is_never_tombstoned() {
    let previous = st(
      4,
      "A",
      vec![ck("SESSDATA", ".bilibili.com"), ck("huge", ".x.com")],
    );
    let fresh = vec![ck("SESSDATA", ".bilibili.com")];

    // The store legitimately lacks `huge` — the browser would not take it.
    let mut present: std::collections::HashSet<CookieKey> = fresh.iter().map(key_of).collect();
    let rejected = (".x.com".to_string(), "huge".to_string(), "/".to_string());
    present.insert(rejected);

    let Reconciled {
      cookies: _,
      deleted,
      carried: _,
      ..
    } = reconcile(fresh, Some(&previous), ExitKind::Clean, 5, &present, true);
    assert!(
      deleted.is_empty(),
      "a cookie this browser rejected is not a logout"
    );
  }
}

#[cfg(test)]
mod tests_support {
  use super::*;
  pub fn ck(name: &str, domain: &str) -> PortableCookie {
    PortableCookie {
      name: name.into(),
      value: "v".into(),
      domain: domain.into(),
      path: "/".into(),
      expires: None,
      secure: true,
      http_only: true,
      same_site: None,
    }
  }
  pub fn st(revision: u64, device: &str, cookies: Vec<PortableCookie>) -> PortableCookieStore {
    PortableCookieStore {
      version: FORMAT_VERSION,
      revision,
      device: device.into(),
      exported_at: 0,
      source_os: "macos".into(),
      cookies,
      deleted: Vec::new(),
    }
  }
}

#[cfg(test)]
mod snapshot_tests {
  use super::tests_support::*;
  use super::*;

  /// The snapshot loop runs every couple of minutes for as long as a browser is
  /// open. If an unchanged capture still bumped the revision, the file diff
  /// would never be empty and the profile would upload forever — the failure the
  /// "an unchanged sync issues zero PUTs" rule exists to prevent.
  #[test]
  fn an_unchanged_snapshot_does_not_rewrite_the_blob() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path();
    let profile = super::tests::test_profile();
    let id = profile.id.to_string();
    std::fs::create_dir_all(profiles.join(&id)).unwrap();

    let first = vec![ck("SESSDATA", ".bilibili.com"), ck("sid", ".zhihu.com")];
    assert_eq!(
      write_snapshot(&profile, profiles, first.clone()).unwrap(),
      2
    );
    let after_first = load(&profile, profiles).unwrap().unwrap();
    assert_eq!(after_first.revision, 1);

    // Same set again: no write, so the revision must not move.
    write_snapshot(&profile, profiles, first).unwrap();
    let again = load(&profile, profiles).unwrap().unwrap();
    assert_eq!(again.revision, 1, "an identical capture must not bump");
    assert_eq!(again.exported_at, after_first.exported_at);
  }

  /// A refreshed session token keeps its (domain, name, path) but is the entire
  /// point of syncing — comparing keys alone would drop it.
  #[test]
  fn a_changed_value_still_publishes() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path();
    let profile = super::tests::test_profile();
    std::fs::create_dir_all(profiles.join(profile.id.to_string())).unwrap();

    write_snapshot(&profile, profiles, vec![ck("SESSDATA", ".bilibili.com")]).unwrap();
    let mut refreshed = ck("SESSDATA", ".bilibili.com");
    refreshed.value = "rotated".into();
    write_snapshot(&profile, profiles, vec![refreshed]).unwrap();

    let out = load(&profile, profiles).unwrap().unwrap();
    assert_eq!(out.revision, 2);
    assert_eq!(out.cookies[0].value, "rotated");
  }

  /// A live read is authoritative, so an absence really is a logout — this is
  /// the one export path that may tombstone without asking how the browser died.
  #[test]
  fn a_snapshot_tombstones_what_the_browser_no_longer_has() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path();
    let profile = super::tests::test_profile();
    std::fs::create_dir_all(profiles.join(profile.id.to_string())).unwrap();

    write_snapshot(
      &profile,
      profiles,
      vec![
        ck("SESSDATA", ".bilibili.com"),
        ck("web_session", ".xiaohongshu.com"),
      ],
    )
    .unwrap();
    write_snapshot(&profile, profiles, vec![ck("SESSDATA", ".bilibili.com")]).unwrap();

    let out = load(&profile, profiles).unwrap().unwrap();
    assert_eq!(out.cookies.len(), 1);
    assert_eq!(out.deleted.len(), 1);
    assert_eq!(out.deleted[0].name, "web_session");
  }
}
