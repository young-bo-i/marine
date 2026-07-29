//! Marine — per-platform login detection.
//!
//! Nothing downstream works logged out: a logged-out account cannot comment,
//! and on Xiaohongshu and Douyin it cannot even search. So this runs first, and
//! its answer has to be trustworthy rather than merely cheap.
//!
//! # Where each stage runs, and why it is not a free choice
//!
//! 1. **Cookie probe — here, in Rust** (CDP `Network.getCookies`). Answers
//!    "definitely logged out" for free, with no network request. Conclusive in
//!    the negative direction only.
//! 2. **Authoritative check — in the extension, NOT here.** Measured, same
//!    profile and same endpoint:
//!    ```text
//!    in-page fetch      -> {"success":true,"data":{"guest":false,"nickname":"这是我"}}
//!    cookies from Rust  -> {"success":false}
//!    ```
//!    Xiaohongshu's edith API wants `x-s`/`x-t` and Douyin wants `a_bogus`;
//!    those signatures are computed by the page's own JS, so a request issued
//!    from outside the page is rejected — and that rejection is indistinguishable
//!    from being signed out. Zhihu happens not to sign, but splitting the logic
//!    per platform would just hide the rule. `marine-extension/src/platforms/login.js`
//!    owns stage 2 for all four; this module scores and stores what it reports.
//!
//! # "Signed out" and "could not tell" are different answers
//!
//! The first means "go log in", the second means "retry later". Collapsing them
//! turns a network blip into a permanently benched account, so [`LoginStatus`]
//! carries [`LoginEvidence`] and `logged_in` is an `Option`.
//!
//! # Why the cookie names are what they are
//!
//! Measured on real logged-in profiles, not taken from documentation:
//! Xiaohongshu's `a1` and `webId` are present when logged **out** too — they are
//! anonymous device ids. Treating them as a login signal reported all five local
//! profiles as signed in, including one that was not. Only `web_session` counts.
//!
//! A worked example of why stage 1 alone is not enough: on a local profile the
//! Bilibili `SESSDATA` cookie was present, and the browser itself still got
//! `code:-101 账号未登录` from `/x/web-interface/nav`. Cookie presence proves
//! nothing about session validity.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// What one platform needs in order to answer "is this profile signed in".
struct PlatformProbe {
  /// Any one of these present ⇒ worth asking the platform. None present ⇒
  /// definitely logged out, no request needed.
  session_cookies: &'static [&'static str],
  /// URL the cookie jar is read for.
  cookie_origin: &'static str,
}

fn probe_for(platform: &str) -> Option<PlatformProbe> {
  Some(match platform {
    "bilibili" => PlatformProbe {
      session_cookies: &["SESSDATA", "DedeUserID"],
      cookie_origin: "https://www.bilibili.com",
    },
    "zhihu" => PlatformProbe {
      session_cookies: &["z_c0"],
      cookie_origin: "https://www.zhihu.com",
    },
    "douyin" => PlatformProbe {
      session_cookies: &["sessionid", "sessionid_ss"],
      cookie_origin: "https://www.douyin.com",
    },
    // NOT a1 / webId: those exist while logged out.
    "xiaohongshu" => PlatformProbe {
      session_cookies: &["web_session"],
      cookie_origin: "https://www.xiaohongshu.com",
    },
    _ => return None,
  })
}

/// Why we believe what we believe. Kept in the result because "logged out" and
/// "could not tell" must not be collapsed — the first means "go log in", the
/// second means "retry later", and treating a network blip as a logout would
/// strand an otherwise healthy account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LoginEvidence {
  /// No session cookie at all. Cheap and conclusive.
  NoSessionCookie,
  /// Platform confirmed an identity.
  PlatformConfirmed,
  /// Platform explicitly said not signed in (cookie present but dead).
  PlatformRejected,
  /// Cookie present, platform unreachable or unparsable. Status unknown.
  VerifyFailed,
  /// Decided from page markers (avatar vs login button) because the
  /// authoritative endpoint was unavailable. Weaker than a platform answer but
  /// survives API changes.
  DomMarker,
  /// Cookie present; nobody has reported an authoritative answer yet.
  AwaitingPageCheck,
  /// Platform has no probe configured.
  UnsupportedPlatform,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct LoginStatus {
  pub platform: String,
  /// `None` means "could not tell", which callers MUST NOT treat as `Some(false)`.
  /// Never inferred from cookie presence alone.
  pub logged_in: Option<bool>,
  pub evidence: LoginEvidence,
  /// Display name when the platform returned one.
  #[serde(default)]
  pub account_name: Option<String>,
  /// Platform-side user id when available; useful for spotting "this profile is
  /// signed into a different account than expected".
  #[serde(default)]
  pub account_id: Option<String>,
  /// Session cookie names actually found, for diagnosis.
  #[serde(default)]
  pub cookies_found: Vec<String>,
}

impl LoginStatus {
  fn logged_out(platform: &str, evidence: LoginEvidence, cookies_found: Vec<String>) -> Self {
    Self {
      platform: platform.to_string(),
      logged_in: Some(false),
      evidence,
      account_name: None,
      account_id: None,
      cookies_found,
    }
  }
}

// 响应形状的解析（"我是谁" 接口返回什么算已登录）**故意不放在这里**：
// 发起权威请求的是扩展（只有页内能算签名），解析也就该跟着走，否则同一套
// 形状要在两处维护、迟早对不上。见 marine-extension/src/platforms/login.js
// 的 readApi，以及 tests/login-status-smoke.mjs 里按真实抓包写的用例。

/// Stage 1 only: what the cookie jar can prove about a running profile.
///
/// Deliberately does NOT call the platform. See the module docs — a request
/// issued from here lacks the page-computed signature and gets rejected in a
/// way that is indistinguishable from being signed out, which would report
/// healthy accounts as logged out.
///
/// Returns `Some(false)` when there is no session cookie (conclusive) and
/// `None` otherwise, with [`LoginEvidence::AwaitingPageCheck`] — the caller is
/// expected to obtain stage 2 from the extension and merge via [`merge`].
pub async fn cookie_probe(platform: &str, ws_url: &str) -> Result<LoginStatus, String> {
  let Some(probe) = probe_for(platform) else {
    let mut s = LoginStatus::logged_out(platform, LoginEvidence::UnsupportedPlatform, Vec::new());
    s.logged_in = None;
    return Ok(s);
  };

  let jar = super::cdp::send_cdp(
    ws_url,
    "Network.getCookies",
    serde_json::json!({ "urls": [probe.cookie_origin] }),
  )
  .await?;

  let found: Vec<String> = jar["cookies"]
    .as_array()
    .map(|arr| {
      arr
        .iter()
        .filter_map(|c| c["name"].as_str())
        .filter(|n| probe.session_cookies.contains(n))
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default();

  if found.is_empty() {
    // The one thing cookies can settle on their own.
    return Ok(LoginStatus::logged_out(
      platform,
      LoginEvidence::NoSessionCookie,
      found,
    ));
  }

  let mut pending = LoginStatus::logged_out(platform, LoginEvidence::AwaitingPageCheck, found);
  pending.logged_in = None;
  Ok(pending)
}

/// Combine the cookie probe with whatever the page reported.
///
/// The page wins whenever it reached a conclusion, because it is the only side
/// that can produce a signed request. The cookie probe still wins over a page
/// result of "unknown", since `NoSessionCookie` is conclusive.
pub fn merge(cookie_stage: LoginStatus, page_stage: Option<LoginStatus>) -> LoginStatus {
  if cookie_stage.evidence == LoginEvidence::NoSessionCookie {
    return cookie_stage;
  }
  match page_stage {
    Some(page) if page.logged_in.is_some() => LoginStatus {
      cookies_found: cookie_stage.cookies_found,
      ..page
    },
    _ => cookie_stage,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn xiaohongshu_anonymous_device_cookies_are_not_a_login_signal() {
    // Measured: all five local profiles carry a1/webId, including one that is
    // signed out. Only web_session may appear in the probe.
    let p = probe_for("xiaohongshu").unwrap();
    assert_eq!(p.session_cookies, &["web_session"]);
    assert!(!p.session_cookies.contains(&"a1"));
    assert!(!p.session_cookies.contains(&"webId"));
  }

  #[test]
  fn unknown_platform_has_no_probe() {
    assert!(probe_for("weibo").is_none());
  }

  #[test]
  fn every_supported_platform_has_a_probe() {
    for p in ["bilibili", "zhihu", "douyin", "xiaohongshu"] {
      assert!(probe_for(p).is_some(), "{p} must be probeable");
    }
  }

  #[test]
  fn verify_failure_is_distinct_from_logged_out() {
    // A network blip must not be reported as "go log in again" — that would
    // strand a healthy account.
    let s = LoginStatus::logged_out(
      "bilibili",
      LoginEvidence::VerifyFailed,
      vec!["SESSDATA".into()],
    );
    assert_eq!(s.logged_in, Some(false));
    assert_eq!(s.evidence, LoginEvidence::VerifyFailed);
    assert_ne!(s.evidence, LoginEvidence::NoSessionCookie);
  }

  fn stage(evidence: LoginEvidence, logged_in: Option<bool>, cookies: &[&str]) -> LoginStatus {
    LoginStatus {
      platform: "xiaohongshu".into(),
      logged_in,
      evidence,
      account_name: None,
      account_id: None,
      cookies_found: cookies.iter().map(|s| s.to_string()).collect(),
    }
  }

  #[test]
  fn no_session_cookie_beats_anything_the_page_says() {
    // Cookie absence is conclusive; a page that somehow claims otherwise is
    // reporting about a different session.
    let merged = merge(
      stage(LoginEvidence::NoSessionCookie, Some(false), &[]),
      Some(stage(LoginEvidence::PlatformConfirmed, Some(true), &[])),
    );
    assert_eq!(merged.logged_in, Some(false));
    assert_eq!(merged.evidence, LoginEvidence::NoSessionCookie);
  }

  #[test]
  fn page_verdict_wins_over_a_pending_cookie_probe() {
    let merged = merge(
      stage(LoginEvidence::AwaitingPageCheck, None, &["web_session"]),
      Some(stage(LoginEvidence::PlatformConfirmed, Some(true), &[])),
    );
    assert_eq!(merged.logged_in, Some(true));
    assert_eq!(merged.evidence, LoginEvidence::PlatformConfirmed);
    // 合并后仍要带上 cookie 证据，排查时要知道当时 jar 里有什么
    assert_eq!(merged.cookies_found, vec!["web_session".to_string()]);
  }

  #[test]
  fn an_inconclusive_page_result_does_not_erase_the_pending_state() {
    // 页内两路都没说清 -> 仍然是「未知」，绝不能塌成「登出」
    let merged = merge(
      stage(LoginEvidence::AwaitingPageCheck, None, &["z_c0"]),
      Some(stage(LoginEvidence::VerifyFailed, None, &[])),
    );
    assert_eq!(
      merged.logged_in, None,
      "unknown must never collapse to logged-out"
    );
  }

  #[test]
  fn missing_page_result_leaves_status_unknown_not_logged_out() {
    let merged = merge(
      stage(LoginEvidence::AwaitingPageCheck, None, &["z_c0"]),
      None,
    );
    assert_eq!(merged.logged_in, None);
    assert_eq!(merged.evidence, LoginEvidence::AwaitingPageCheck);
  }

  #[test]
  fn dom_fallback_is_accepted_as_a_verdict() {
    let merged = merge(
      stage(LoginEvidence::AwaitingPageCheck, None, &["SESSDATA"]),
      Some(stage(LoginEvidence::DomMarker, Some(true), &[])),
    );
    assert_eq!(merged.logged_in, Some(true));
    assert_eq!(merged.evidence, LoginEvidence::DomMarker);
  }
}
