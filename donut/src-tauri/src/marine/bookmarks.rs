//! Marine — seed a fixed set of default bookmarks into a Wayfern (Chromium)
//! profile's bookmark bar. Called once per profile at launch (guarded by
//! `BrowserProfile::default_bookmarks_seeded`), so both freshly created and
//! historical profiles get them exactly once.

use std::collections::HashSet;
use std::path::Path;

/// The four default sites Marine seeds into the bookmark bar, in bar order.
/// `(name, url)`.
const DEFAULT_BOOKMARKS: &[(&str, &str)] = &[
  ("B站", "https://www.bilibili.com/"),
  ("小红书", "https://www.xiaohongshu.com/"),
  ("知乎", "https://www.zhihu.com/"),
  ("抖音", "https://www.douyin.com/"),
];

/// Ensure the four default Marine bookmarks exist in the Wayfern profile's
/// `<profile_data_path>/Default/Bookmarks` (Chromium bookmarks JSON).
///
/// - Missing file → write a fresh file with all four in `bookmark_bar`.
/// - Existing file → parse it and append only the URLs not already present as a
///   url node anywhere in the tree, preserving every existing bookmark.
/// - Malformed existing file → leave it untouched (log a warning) so we never
///   destroy the user's bookmarks.
///
/// The `checksum` field is intentionally omitted: Chromium recomputes it on
/// load, and a stale/wrong checksum is worse than an absent one.
pub fn ensure_default_bookmarks(profile_data_path: &Path) -> std::io::Result<()> {
  let default_dir = profile_data_path.join("Default");
  std::fs::create_dir_all(&default_dir)?;
  let bookmarks_path = default_dir.join("Bookmarks");

  let mut root = if bookmarks_path.exists() {
    let content = std::fs::read_to_string(&bookmarks_path)?;
    match serde_json::from_str::<serde_json::Value>(&content) {
      Ok(value) => value,
      Err(e) => {
        log::warn!(
          "Marine: existing Bookmarks at {} is malformed ({e}); not seeding defaults to avoid destroying user bookmarks",
          bookmarks_path.display()
        );
        return Ok(());
      }
    }
  } else {
    empty_bookmarks_root()
  };

  // URLs already present anywhere in the tree — don't re-add those.
  let mut existing_urls = HashSet::new();
  collect_urls(&root, &mut existing_urls);

  // Mint node ids above the current max so they never collide with the folder
  // ids (1/2/3) or any existing url node.
  let mut next_id = max_numeric_id(&root) + 1;

  let Some(bar_children) = root
    .get_mut("roots")
    .and_then(|roots| roots.get_mut("bookmark_bar"))
    .and_then(|bar| bar.get_mut("children"))
    .and_then(serde_json::Value::as_array_mut)
  else {
    log::warn!(
      "Marine: Bookmarks at {} has no roots.bookmark_bar.children array; skipping default seed",
      bookmarks_path.display()
    );
    return Ok(());
  };

  let mut added = false;
  for (name, url) in DEFAULT_BOOKMARKS {
    if existing_urls.insert((*url).to_string()) {
      bar_children.push(url_node(name, url, next_id));
      next_id += 1;
      added = true;
    }
  }

  if added {
    let json = serde_json::to_string_pretty(&root)?;
    std::fs::write(&bookmarks_path, json)?;
  }

  Ok(())
}

/// A bare Chromium bookmarks tree with empty roots.
fn empty_bookmarks_root() -> serde_json::Value {
  serde_json::json!({
    "roots": {
      "bookmark_bar": {
        "children": [],
        "date_added": "0",
        "date_modified": "0",
        "guid": new_guid(),
        "id": "1",
        "name": "Bookmarks bar",
        "type": "folder"
      },
      "other": {
        "children": [],
        "date_added": "0",
        "guid": new_guid(),
        "id": "2",
        "name": "Other bookmarks",
        "type": "folder"
      },
      "synced": {
        "children": [],
        "date_added": "0",
        "guid": new_guid(),
        "id": "3",
        "name": "Mobile bookmarks",
        "type": "folder"
      }
    },
    "version": 1
  })
}

/// A single url-type bookmark node.
fn url_node(name: &str, url: &str, id: i64) -> serde_json::Value {
  serde_json::json!({
    "date_added": "0",
    "guid": new_guid(),
    "id": id.to_string(),
    "name": name,
    "type": "url",
    "url": url
  })
}

/// Lowercase UUIDv4 guid (Chromium expects lowercase hyphenated form).
fn new_guid() -> String {
  uuid::Uuid::new_v4().to_string()
}

/// Collect the `url` of every url-type node anywhere in the tree.
fn collect_urls(value: &serde_json::Value, out: &mut HashSet<String>) {
  match value {
    serde_json::Value::Object(map) => {
      if map.get("type").and_then(serde_json::Value::as_str) == Some("url") {
        if let Some(url) = map.get("url").and_then(serde_json::Value::as_str) {
          out.insert(url.to_string());
        }
      }
      for child in map.values() {
        collect_urls(child, out);
      }
    }
    serde_json::Value::Array(items) => {
      for child in items {
        collect_urls(child, out);
      }
    }
    _ => {}
  }
}

/// Largest numeric `id` anywhere in the tree (0 if none), so new nodes can take
/// unique ids above it. Chromium ids are stringified integers.
fn max_numeric_id(value: &serde_json::Value) -> i64 {
  let mut max = 0i64;
  fn walk(value: &serde_json::Value, max: &mut i64) {
    match value {
      serde_json::Value::Object(map) => {
        if let Some(id) = map
          .get("id")
          .and_then(serde_json::Value::as_str)
          .and_then(|s| s.parse::<i64>().ok())
        {
          *max = (*max).max(id);
        }
        for child in map.values() {
          walk(child, max);
        }
      }
      serde_json::Value::Array(items) => {
        for child in items {
          walk(child, max);
        }
      }
      _ => {}
    }
  }
  walk(value, &mut max);
  max
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  fn read_bar_urls(dir: &Path) -> Vec<String> {
    let content = std::fs::read_to_string(dir.join("Default").join("Bookmarks")).unwrap();
    let root: serde_json::Value = serde_json::from_str(&content).unwrap();
    root["roots"]["bookmark_bar"]["children"]
      .as_array()
      .unwrap()
      .iter()
      .map(|n| n["url"].as_str().unwrap().to_string())
      .collect()
  }

  #[test]
  fn creates_fresh_file_with_four_bookmarks() {
    let dir = TempDir::new().unwrap();
    ensure_default_bookmarks(dir.path()).unwrap();

    let urls = read_bar_urls(dir.path());
    assert_eq!(
      urls,
      vec![
        "https://www.bilibili.com/",
        "https://www.xiaohongshu.com/",
        "https://www.zhihu.com/",
        "https://www.douyin.com/",
      ]
    );

    // Ids are unique and don't collide with the folder ids 1/2/3.
    let content = std::fs::read_to_string(dir.path().join("Default").join("Bookmarks")).unwrap();
    let root: serde_json::Value = serde_json::from_str(&content).unwrap();
    let ids: Vec<&str> = root["roots"]["bookmark_bar"]["children"]
      .as_array()
      .unwrap()
      .iter()
      .map(|n| n["id"].as_str().unwrap())
      .collect();
    let unique: HashSet<&&str> = ids.iter().collect();
    assert_eq!(ids.len(), unique.len());
    assert!(ids.iter().all(|id| !["1", "2", "3"].contains(id)));
    // No checksum emitted.
    assert!(root.get("checksum").is_none());
  }

  #[test]
  fn merges_without_duplicating_and_preserves_existing() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    std::fs::create_dir_all(&default_dir).unwrap();
    // Existing file already has zhihu (in Other bookmarks) plus a user bookmark.
    let existing = serde_json::json!({
      "roots": {
        "bookmark_bar": {
          "children": [
            {"date_added":"0","guid":"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa","id":"7","name":"Mine","type":"url","url":"https://example.com/"}
          ],
          "date_added":"0","date_modified":"0","guid":"11111111-1111-4111-1111-111111111111","id":"1","name":"Bookmarks bar","type":"folder"
        },
        "other": {
          "children": [
            {"date_added":"0","guid":"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb","id":"9","name":"知乎","type":"url","url":"https://www.zhihu.com/"}
          ],
          "date_added":"0","guid":"22222222-2222-4222-2222-222222222222","id":"2","name":"Other bookmarks","type":"folder"
        },
        "synced": {"children":[],"date_added":"0","guid":"33333333-3333-4333-3333-333333333333","id":"3","name":"Mobile bookmarks","type":"folder"}
      },
      "version": 1
    });
    std::fs::write(
      default_dir.join("Bookmarks"),
      serde_json::to_string(&existing).unwrap(),
    )
    .unwrap();

    ensure_default_bookmarks(dir.path()).unwrap();

    let urls = read_bar_urls(dir.path());
    // Existing user bookmark kept; zhihu NOT re-added (already in Other); the
    // other three appended in order.
    assert_eq!(
      urls,
      vec![
        "https://example.com/",
        "https://www.bilibili.com/",
        "https://www.xiaohongshu.com/",
        "https://www.douyin.com/",
      ]
    );
  }

  #[test]
  fn idempotent_second_call_adds_nothing() {
    let dir = TempDir::new().unwrap();
    ensure_default_bookmarks(dir.path()).unwrap();
    ensure_default_bookmarks(dir.path()).unwrap();
    assert_eq!(read_bar_urls(dir.path()).len(), 4);
  }

  #[test]
  fn malformed_file_is_left_untouched() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    std::fs::create_dir_all(&default_dir).unwrap();
    let garbage = "{ this is not valid json";
    std::fs::write(default_dir.join("Bookmarks"), garbage).unwrap();

    ensure_default_bookmarks(dir.path()).unwrap();

    let after = std::fs::read_to_string(default_dir.join("Bookmarks")).unwrap();
    assert_eq!(after, garbage);
  }
}
