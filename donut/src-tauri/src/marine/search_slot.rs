//! Marine — per-account search slots.
//!
//! With ~5 accounts per platform all searching the same keyword, handing every
//! one of them the same result page means they all fight over the same top
//! results. The [`ProspectLedger`](super::prospect) would still keep them from
//! colliding, but it would do so by starving accounts 2..N — they would claim
//! nothing because everything eligible was already taken.
//!
//! A slot is a different sort order (and sometimes a different time window) per
//! account, so their candidate pools overlap less to begin with. This is an
//! optimisation that improves *supply*; it is emphatically NOT dedup. Popular
//! content ranks under several sorts at once, so slots reduce collisions and the
//! ledger prevents them. Removing the ledger and keeping slots would be unsafe.
//!
//! Slot assignment is deterministic on `(platform, account_index)` so a given
//! account keeps the same browsing habit run after run — an account that sorts
//! by "most played" one day and "newest" the next looks less like a person than
//! one that consistently does either.
//!
//! Parameters below are the ones observed on the live search pages; where a
//! platform's web UI does not expose a stable query parameter for a sort, the
//! slot carries no parameter rather than a guessed one.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SearchSlot {
  pub platform: String,
  /// Human-readable name of the sort this slot uses.
  pub label: String,
  /// Fully-formed search URL for this keyword under this slot.
  pub url: String,
  /// Page to load *before* `url`, for platforms that refuse a cold jump.
  ///
  /// Xiaohongshu is the one that needs it, and the failure it prevents is
  /// vicious: navigating straight from `about:blank` to `search_result?...`
  /// **hangs the renderer** — the navigation never commits, the tab sits on the
  /// old URL with a spinner, and `/json` still lists the target as if all were
  /// well. Going through the home page first makes the same search URL load
  /// normally. Isolated experiment, one variable, reproduced both ways.
  ///
  /// Lives here rather than in the scheduler on purpose: "what does this
  /// platform need" has been scattered across files before in this codebase and
  /// it cost real debugging every time.
  pub warmup_url: Option<String>,
}

fn enc(s: &str) -> String {
  // Percent-encode everything outside the unreserved set. Keyword text is
  // Chinese in practice, so a naive replace of spaces would not be enough.
  s.bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        (b as char).to_string()
      }
      _ => format!("%{b:02X}"),
    })
    .collect()
}

/// Sorts available per platform, in assignment order.
///
/// Bilibili's are query parameters observed on `search.bilibili.com`. Zhihu's
/// `sort` likewise. Douyin and Xiaohongshu drive their sort from in-page state
/// rather than a stable URL parameter, so those slots differ only in label —
/// they exist so the caller can still spread accounts across *pages* (page 1
/// vs deeper) without pretending a URL parameter works when it does not.
fn sorts_for(platform: &str) -> &'static [(&'static str, Option<&'static str>)] {
  match platform {
    "bilibili" => &[
      ("综合排序", None),
      ("最多播放", Some("order=click")),
      ("最新发布", Some("order=pubdate")),
      ("最多弹幕", Some("order=dm")),
      ("最多收藏", Some("order=stow")),
    ],
    "zhihu" => &[
      ("综合", None),
      ("最新", Some("sort=upvoted_count")),
      ("时间", Some("sort=created_time")),
    ],
    // No stable URL sort parameter was observed for these two; label-only.
    "douyin" => &[("综合", None), ("最新", None), ("最多点赞", None)],
    "xiaohongshu" => &[
      ("综合", None),
      ("最新", None),
      ("最多点赞", None),
      ("最多评论", None),
    ],
    _ => &[],
  }
}

fn base_url(platform: &str, keyword: &str) -> Option<String> {
  Some(match platform {
    "bilibili" => format!("https://search.bilibili.com/all?keyword={}", enc(keyword)),
    "zhihu" => format!(
      "https://www.zhihu.com/search?type=content&q={}",
      enc(keyword)
    ),
    "douyin" => format!("https://www.douyin.com/search/{}", enc(keyword)),
    "xiaohongshu" => format!(
      "https://www.xiaohongshu.com/search_result?keyword={}",
      enc(keyword)
    ),
    _ => return None,
  })
}

/// The slot for one account.
///
/// `account_index` is that account's position among the accounts operating this
/// platform (0-based). It wraps, so more accounts than sorts is fine — those
/// accounts share a sort and rely entirely on the ledger, which is correct if
/// less efficient.
/// 冷跳会卡住的平台，先去哪一页把会话热起来。
fn warmup_for(platform: &str) -> Option<String> {
  match platform {
    "xiaohongshu" => Some("https://www.xiaohongshu.com/".to_string()),
    _ => None,
  }
}

pub fn slot_for(platform: &str, keyword: &str, account_index: usize) -> Option<SearchSlot> {
  let sorts = sorts_for(platform);
  if sorts.is_empty() {
    return None;
  }
  let base = base_url(platform, keyword)?;
  let (label, param) = sorts[account_index % sorts.len()];
  let url = match param {
    Some(p) => format!("{base}&{p}"),
    None => base,
  };
  Some(SearchSlot {
    warmup_url: warmup_for(platform),
    platform: platform.to_string(),
    label: label.to_string(),
    url,
  })
}

/// Every slot for a platform, for previewing the spread.
pub fn all_slots(platform: &str, keyword: &str) -> Vec<SearchSlot> {
  (0..sorts_for(platform).len())
    .filter_map(|i| slot_for(platform, keyword, i))
    .collect()
}

#[cfg(test)]
mod tests {

  // 小红书从 about:blank 冷跳到搜索页会**卡死渲染进程**：导航从不提交、标签页
  // 停在旧 URL 转圈，而 `/json` 里 target 一切正常 —— 从外面完全看不出出事了，
  // 表现成「浏览器又卡住了」。先过一趟首页就正常（隔离实验，两个方向各复现一次）。
  // 判据放在这里而不是调度器里：这个项目吃过太多次「同一判据散落多处」的亏。
  #[test]
  fn xiaohongshu_is_the_platform_that_cannot_be_cold_jumped() {
    let xhs = slot_for("xiaohongshu", "文献综述", 0).expect("xiaohongshu has slots");
    assert_eq!(
      xhs.warmup_url.as_deref(),
      Some("https://www.xiaohongshu.com/"),
      "小红书必须先过首页再跳搜索页"
    );
    for p in ["bilibili", "zhihu", "douyin"] {
      let slot = slot_for(p, "文献综述", 0).expect("platform has slots");
      assert!(
        slot.warmup_url.is_none(),
        "{p} 实测可以直接跳搜索页 —— 多一次导航就是多一次可能出错的往返"
      );
    }
  }

  use super::*;

  #[test]
  fn chinese_keywords_are_percent_encoded() {
    let s = slot_for("bilibili", "科研工具", 1).unwrap();
    assert!(
      s.url
        .contains("keyword=%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7"),
      "got {}",
      s.url
    );
    assert!(
      !s.url.contains('科'),
      "raw CJK must not survive into the URL"
    );
  }

  #[test]
  fn accounts_get_different_sorts_so_they_do_not_all_fight_over_page_one() {
    let a = slot_for("bilibili", "科研工具", 0).unwrap();
    let b = slot_for("bilibili", "科研工具", 1).unwrap();
    let c = slot_for("bilibili", "科研工具", 2).unwrap();
    assert_ne!(a.url, b.url);
    assert_ne!(b.url, c.url);
    assert!(b.url.contains("order=click"));
    assert!(c.url.contains("order=pubdate"));
  }

  #[test]
  fn assignment_is_stable_across_runs() {
    // An account that sorts by "most played" today and "newest" tomorrow reads
    // less like a person than one with a consistent habit.
    for _ in 0..3 {
      assert_eq!(
        slot_for("bilibili", "科研工具", 3).unwrap().url,
        slot_for("bilibili", "科研工具", 3).unwrap().url
      );
    }
  }

  #[test]
  fn more_accounts_than_sorts_wraps_instead_of_failing() {
    let n = sorts_for("bilibili").len();
    let first = slot_for("bilibili", "kw", 0).unwrap();
    let wrapped = slot_for("bilibili", "kw", n).unwrap();
    assert_eq!(
      first.url, wrapped.url,
      "wrapping is expected; the ledger still protects correctness"
    );
  }

  #[test]
  fn platforms_without_a_url_sort_parameter_do_not_invent_one() {
    // Douyin and Xiaohongshu drive sort from in-page state. Emitting a guessed
    // parameter would silently produce a URL the platform ignores, making the
    // slots look distinct while returning identical results.
    for p in ["douyin", "xiaohongshu"] {
      let urls: Vec<_> = all_slots(p, "kw").into_iter().map(|s| s.url).collect();
      assert!(
        urls.windows(2).all(|w| w[0] == w[1]),
        "{p}: slots must not carry invented query parameters"
      );
    }
  }

  #[test]
  fn every_supported_platform_yields_a_slot() {
    for p in ["bilibili", "zhihu", "douyin", "xiaohongshu"] {
      assert!(slot_for(p, "科研工具", 0).is_some(), "{p}");
    }
    assert!(slot_for("weibo", "kw", 0).is_none());
  }

  #[test]
  fn urls_point_at_the_search_endpoints_actually_observed() {
    assert!(slot_for("bilibili", "k", 0)
      .unwrap()
      .url
      .starts_with("https://search.bilibili.com/all?keyword="));
    assert!(slot_for("zhihu", "k", 0)
      .unwrap()
      .url
      .starts_with("https://www.zhihu.com/search?type=content&q="));
    assert!(slot_for("douyin", "k", 0)
      .unwrap()
      .url
      .starts_with("https://www.douyin.com/search/"));
    assert!(slot_for("xiaohongshu", "k", 0)
      .unwrap()
      .url
      .starts_with("https://www.xiaohongshu.com/search_result?keyword="));
  }
}
