//! Marine —— 每个 profile 在每个平台上的登录态。
//!
//! # 为什么不能从外面探
//!
//! 最省事的做法是让 Rust 带着 cookie 去请求各平台的「我是谁」接口，一次把四个
//! 平台都问清楚。**那条路是死的**：小红书的 edith 接口要 `x-s`/`x-t` 签名、抖音
//! 要 `a_bogus`，只有页面自己的 JS 能算。实测同一个 profile、同一个接口，浏览器
//! 内返回已登录，从外面带 cookie 发返回失败 —— 而那个失败和「未登录」长得一模
//! 一样（详见 `marine-extension/src/platforms/login.js` 开头）。
//!
//! 所以判定只能在页内做，这个模块只负责**存扩展报上来的结果**。
//!
//! # 数据是编排顺路产出的，不额外跑一趟
//!
//! 编排每一轮本来就会落到四个平台的搜索页，并且已经调了 `marineLogin.status()`
//! 决定要不要往下走 —— 结果算出来了却用完就扔。这里把它接住。代价为零，新鲜度
//! 等于「上一轮跑到那个平台的时刻」。
//!
//! # 三态，不是两态
//!
//! `logged_in` 是 `Option<bool>`：
//!   · `Some(true)`  已登录
//!   · `Some(false)` 确认登出 —— 去补登录
//!   · `None`        判断不了（接口超时、改版、DOM 兜底也没说清）—— 稍后再看
//!
//! 把 `None` 显示成「登出」会平白废掉一个健康账号：运营看到红点就去重新登录，
//! 而实际上那只是一次网络抖动。这个区分是 login.js 的核心设计，存储层不能把它
//! 压平。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use utoipa::ToSchema;

const STORE_FILE: &str = "login-status.json";

/// 一次判定 + 它是什么时候做的。
///
/// 判定本身**复用** [`crate::marine::login::LoginStatus`]，不另起一套：那个类型
/// 已经把三态、判据来源、账号身份都定义好了，再定义一份就是「同一判据散落两处」，
/// 这个项目为这类事付过好几次代价。这里只加时间戳 —— 陈旧的「已登录」和新鲜的
/// 「已登录」不是一回事。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RecordedLogin {
  #[serde(flatten)]
  pub status: crate::marine::login::LoginStatus,
  /// unix 秒。
  pub checked_at: u64,
}

/// 一个 profile 的全部平台状态。
pub type ProfileLogins = HashMap<String, RecordedLogin>;

pub struct LoginStatusStore {
  lock: Mutex<()>,
}

impl Default for LoginStatusStore {
  fn default() -> Self {
    Self::new()
  }
}

lazy_static::lazy_static! {
  pub static ref LOGIN_STATUS: LoginStatusStore = LoginStatusStore::new();
}

impl LoginStatusStore {
  pub fn new() -> Self {
    Self {
      lock: Mutex::new(()),
    }
  }

  fn path(&self) -> PathBuf {
    crate::app_dirs::data_dir().join(STORE_FILE)
  }

  fn read_unlocked(path: &PathBuf) -> HashMap<String, ProfileLogins> {
    let Ok(text) = fs::read_to_string(path) else {
      return HashMap::new();
    };
    // 读坏了当成空：这是**观测数据**，重跑一轮就有了。为它让调用方失败
    // （进而让整个 profile 列表加载不出来）是本末倒置。
    serde_json::from_str(&text).unwrap_or_default()
  }

  /// 全部 profile 的状态。
  pub fn all(&self) -> Result<HashMap<String, ProfileLogins>, String> {
    let _guard = self
      .lock
      .lock()
      .map_err(|_| "login status mutex poisoned")?;
    Ok(Self::read_unlocked(&self.path()))
  }

  /// 记一次判定。同一个 (profile, platform) 覆盖旧值。
  pub fn record(&self, profile_id: &str, state: RecordedLogin) -> Result<(), String> {
    if profile_id.trim().is_empty() || state.status.platform.trim().is_empty() {
      return Err("login status needs both a profile and a platform".to_string());
    }
    let _guard = self
      .lock
      .lock()
      .map_err(|_| "login status mutex poisoned")?;
    let path = self.path();
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut all = Self::read_unlocked(&path);
    all
      .entry(profile_id.to_string())
      .or_default()
      .insert(state.status.platform.clone(), state);
    let text =
      serde_json::to_string_pretty(&all).map_err(|e| format!("serialise login status: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
  }

  /// 清掉某个 (profile, platform) 的标记。
  ///
  /// 调用时机是**那条腿真把评论发出去了** —— 那比任何探测都更能证明登录有效。
  /// 没有这一步的话，只报失败会让标记变成永久的：账号补登录之后界面还是红的，
  /// 而一个永远不会消失的告警等于没有告警。
  pub fn clear_platform(&self, profile_id: &str, platform: &str) -> Result<(), String> {
    let _guard = self
      .lock
      .lock()
      .map_err(|_| "login status mutex poisoned")?;
    let path = self.path();
    let mut all = Self::read_unlocked(&path);
    let Some(logins) = all.get_mut(profile_id) else {
      return Ok(());
    };
    if logins.remove(platform).is_none() {
      return Ok(());
    }
    if logins.is_empty() {
      all.remove(profile_id);
    }
    let text =
      serde_json::to_string_pretty(&all).map_err(|e| format!("serialise login status: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
  }

  /// profile 删掉时一并清掉，别留孤儿条目。
  pub fn forget(&self, profile_id: &str) -> Result<(), String> {
    let _guard = self
      .lock
      .lock()
      .map_err(|_| "login status mutex poisoned")?;
    let path = self.path();
    let mut all = Self::read_unlocked(&path);
    if all.remove(profile_id).is_none() {
      return Ok(());
    }
    let text =
      serde_json::to_string_pretty(&all).map_err(|e| format!("serialise login status: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn store() -> (LoginStatusStore, crate::app_dirs::TestDirGuard) {
    let dir = tempfile::tempdir().expect("tempdir");
    let guard = crate::app_dirs::set_test_data_dir(dir.keep());
    (LoginStatusStore::new(), guard)
  }

  fn state(platform: &str, logged_in: Option<bool>) -> RecordedLogin {
    RecordedLogin {
      status: crate::marine::login::LoginStatus {
        platform: platform.to_string(),
        logged_in,
        evidence: crate::marine::login::LoginEvidence::PlatformConfirmed,
        account_name: Some("测试".to_string()),
        account_id: Some("1".to_string()),
        cookies_found: Vec::new(),
      },
      checked_at: 1_700_000_000,
    }
  }

  #[test]
  fn unknown_is_not_the_same_as_logged_out() {
    // 这是整个模块的要点。把「判断不了」压成「登出」，运营会去重新登录一个
    // 其实健康的账号，而真正的问题（接口改版 / 网络抖动）被藏起来了。
    let (s, _g) = store();
    s.record("p1", state("zhihu", None)).unwrap();
    s.record("p1", state("bilibili", Some(false))).unwrap();
    let all = s.all().unwrap();
    let p1 = &all["p1"];
    assert_eq!(p1["zhihu"].status.logged_in, None);
    assert_eq!(p1["bilibili"].status.logged_in, Some(false));
    assert_ne!(
      p1["zhihu"].status.logged_in,
      p1["bilibili"].status.logged_in
    );
  }

  #[test]
  fn a_later_check_replaces_the_earlier_one() {
    let (s, _g) = store();
    s.record("p1", state("zhihu", Some(false))).unwrap();
    let mut fresh = state("zhihu", Some(true));
    fresh.checked_at = 1_700_000_500;
    s.record("p1", fresh).unwrap();
    let all = s.all().unwrap();
    assert_eq!(all["p1"]["zhihu"].status.logged_in, Some(true));
    assert_eq!(all["p1"]["zhihu"].checked_at, 1_700_000_500);
    assert_eq!(all["p1"].len(), 1, "同一个平台不该留下两条");
  }

  #[test]
  fn profiles_do_not_bleed_into_each_other() {
    let (s, _g) = store();
    s.record("p1", state("zhihu", Some(true))).unwrap();
    s.record("p2", state("zhihu", Some(false))).unwrap();
    let all = s.all().unwrap();
    assert_eq!(all["p1"]["zhihu"].status.logged_in, Some(true));
    assert_eq!(all["p2"]["zhihu"].status.logged_in, Some(false));
  }

  #[test]
  fn a_corrupt_store_reads_as_empty_rather_than_failing() {
    // 这是观测数据。读坏了就当没有 —— 跑一轮就重新有了。为它让整个 profile
    // 列表加载失败是本末倒置。
    let (s, _g) = store();
    fs::create_dir_all(s.path().parent().unwrap()).unwrap();
    fs::write(s.path(), b"{ not json").unwrap();
    assert!(s.all().unwrap().is_empty());
    // 而且还能继续写
    s.record("p1", state("zhihu", Some(true))).unwrap();
    assert_eq!(s.all().unwrap()["p1"]["zhihu"].status.logged_in, Some(true));
  }

  #[test]
  fn a_successful_post_clears_that_platform_only() {
    // 只报失败的设计里，这是标记唯一的出口。没有它，账号补登录之后界面永远
    // 是红的 —— 一个不会消失的告警等于没有告警。
    let (s, _g) = store();
    s.record("p1", state("zhihu", Some(false))).unwrap();
    s.record("p1", state("douyin", Some(false))).unwrap();
    s.clear_platform("p1", "zhihu").unwrap();
    let all = s.all().unwrap();
    assert!(!all["p1"].contains_key("zhihu"));
    assert!(all["p1"].contains_key("douyin"), "别的平台不该被连累");
    // 清完最后一个平台，profile 条目本身也该消失，别留空壳
    s.clear_platform("p1", "douyin").unwrap();
    assert!(!s.all().unwrap().contains_key("p1"));
    // 清不存在的不该报错
    s.clear_platform("p1", "zhihu").unwrap();
    s.clear_platform("nope", "zhihu").unwrap();
  }

  #[test]
  fn forgetting_a_profile_leaves_the_others_alone() {
    let (s, _g) = store();
    s.record("p1", state("zhihu", Some(true))).unwrap();
    s.record("p2", state("zhihu", Some(true))).unwrap();
    s.forget("p1").unwrap();
    let all = s.all().unwrap();
    assert!(!all.contains_key("p1"));
    assert!(all.contains_key("p2"));
    // 不存在的 profile 不该报错
    s.forget("nope").unwrap();
  }

  #[test]
  fn a_record_needs_both_a_profile_and_a_platform() {
    let (s, _g) = store();
    assert!(s.record("", state("zhihu", Some(true))).is_err());
    assert!(s.record("p1", state("", Some(true))).is_err());
  }
}
