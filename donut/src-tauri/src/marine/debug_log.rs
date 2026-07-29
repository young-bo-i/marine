//! Marine — a durable sink for the browser extension's own logs.
//!
//! # Why this exists
//!
//! The extension already logs everything it decides (`marineLog` in
//! `debug-panel.js`), but the only consumer is the side panel's debug tab. That
//! surface is live-only, scoped to the active tab, and human-eyes-only.
//!
//! Which makes it useless for the thing that actually needs debugging: the
//! discovery scheduler **closes the browser at the end of every leg**. By the
//! time anyone goes looking, the window — and every log line in it — is gone.
//! The only evidence left is whatever reached the prospect ledger, which is a
//! record of *outcomes*, not of *why*.
//!
//! That gap cost a full investigation once already: a leg that reported
//! "nothing settled" turned out to be Phase A succeeding and Phase B silently
//! declining to start, and the only way to see it was to infer it from claimed
//! records that had no touches. With this sink the extension simply says so.
//!
//! # Shape
//!
//! Append-only JSONL under [`crate::app_dirs::data_dir`]. Not a ring buffer in
//! memory: surviving an app restart is the entire point, since a crash is
//! exactly when the log matters most.
//!
//! # Bounded on purpose
//!
//! Extension logging is bursty — one page grab emits dozens of lines, and every
//! iframe on the page emits its own set. Left unbounded this file would grow
//! without limit on a machine that is running browsers all day. It is trimmed to
//! [`MAX_ENTRIES`] whenever it exceeds [`MAX_BYTES`], keeping the newest.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use utoipa::ToSchema;

const LOG_FILE: &str = "marine-debug.jsonl";

/// Trim once the file passes this. Generous enough that trimming is rare, small
/// enough that reading the tail stays instant.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// How many of the newest entries survive a trim.
const MAX_ENTRIES: usize = 4000;

/// One line as the extension emitted it, plus the context only the service
/// worker knows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct LogEntry {
  /// Wall-clock stamp the extension formatted (`HH:MM:SS.mmm`). Kept as the
  /// extension wrote it so a line here reads identically to the same line in
  /// the side panel.
  #[serde(default)]
  pub t: String,
  #[serde(default)]
  pub level: String,
  #[serde(default)]
  pub tag: String,
  #[serde(default)]
  pub msg: String,
  #[serde(default)]
  pub data: Option<String>,
  /// Which profile produced it. The extension cannot know this; the service
  /// worker stamps it from its runtime config.
  #[serde(default)]
  pub profile_id: Option<String>,
  /// Page the log came from. The single most useful field when reconstructing a
  /// leg after the fact — it distinguishes the search page from the target page
  /// without having to infer it from the message text.
  #[serde(default)]
  pub url: Option<String>,
  /// Server-side receipt time (unix seconds). The extension's `t` has no date,
  /// so without this a line from yesterday is indistinguishable from one a
  /// minute ago.
  #[serde(default)]
  pub at: u64,
}

pub struct DebugLog {
  lock: Mutex<()>,
}

impl Default for DebugLog {
  fn default() -> Self {
    Self::new()
  }
}

lazy_static::lazy_static! {
  pub static ref DEBUG_LOG: DebugLog = DebugLog::new();
}

impl DebugLog {
  pub fn new() -> Self {
    Self {
      lock: Mutex::new(()),
    }
  }

  fn path(&self) -> PathBuf {
    crate::app_dirs::data_dir().join(LOG_FILE)
  }

  /// Append a batch.
  ///
  /// Errors are returned rather than swallowed, but the caller is expected to
  /// treat them as non-fatal: failing to log must never fail the thing being
  /// logged.
  pub fn append(&self, entries: &[LogEntry]) -> Result<usize, String> {
    if entries.is_empty() {
      return Ok(0);
    }
    let _guard = self.lock.lock().map_err(|_| "debug log mutex poisoned")?;
    let path = self.path();
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let mut buf = String::new();
    for entry in entries {
      match serde_json::to_string(entry) {
        Ok(line) => {
          buf.push_str(&line);
          buf.push('\n');
        }
        // One unserialisable entry must not drop the whole batch.
        Err(e) => log::warn!("Skipping unserialisable Marine log entry: {e}"),
      }
    }

    let mut file = OpenOptions::new()
      .create(true)
      .append(true)
      .open(&path)
      .map_err(|e| format!("open {}: {e}", path.display()))?;

    // 上一次写到一半就崩了的话，文件末尾是一条没有换行符的残行。直接往后写会把
    // 新的第一条**拼进那条残行里**，于是一条残行吃掉一条好日志 —— 而这个 sink
    // 的存在意义就是崩溃之后还能读到证据。补一个换行，让损失止于那一行。
    if !ends_with_newline(&path) {
      file
        .write_all(b"\n")
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    }

    file
      .write_all(buf.as_bytes())
      .map_err(|e| format!("write {}: {e}", path.display()))?;
    drop(file);

    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
      self.trim(&path);
    }
    Ok(entries.len())
  }

  /// 把文件压回**两个**上限之内：条数和字节。
  ///
  /// 失败只记日志不上抛：日志文件过大是麻烦，为它丢掉 append 路径等于把唯一的
  /// durable 记录也弄没了。
  ///
  /// 只裁条数是不够的 —— 那样 `MAX_BYTES` 形同虚设：4000 条各自很长的消息
  /// （抓取到的正文、整页 HTML 的片段）轻松就能把文件撑到几十 MB，而这个 sink
  /// 的存在意义是「浏览器被关掉之后证据还在」，不是「把磁盘吃光」。
  ///
  /// 两个方向都从**头部**丢：留下的必须是最新的那批，保留旧的等于把出事现场删了。
  fn trim(&self, path: &PathBuf) {
    let Ok(contents) = fs::read_to_string(path) else {
      return;
    };
    let lines: Vec<&str> = contents.lines().collect();
    let mut start = lines.len().saturating_sub(MAX_ENTRIES);
    // 再按字节收，一次砍一批而不是一行一行挪，免得在超大文件上退化成 O(n²)。
    let mut bytes: u64 = lines[start..].iter().map(|l| l.len() as u64 + 1).sum();
    while bytes > MAX_BYTES && start < lines.len() {
      let drop = ((lines.len() - start) / 8).max(1);
      let end = (start + drop).min(lines.len());
      bytes -= lines[start..end]
        .iter()
        .map(|l| l.len() as u64 + 1)
        .sum::<u64>();
      start = end;
    }
    if start == 0 {
      return;
    }
    let kept = lines[start..].join("\n");
    if let Err(e) = fs::write(path, kept + "\n") {
      log::warn!("Could not trim the Marine debug log: {e}");
    }
  }

  /// Newest `limit` entries, oldest first.
  ///
  /// Unparsable lines are skipped rather than failing the read — a torn write
  /// from a crash should cost one line, not the whole history.
  pub fn tail(&self, limit: usize) -> Result<Vec<LogEntry>, String> {
    let _guard = self.lock.lock().map_err(|_| "debug log mutex poisoned")?;
    let path = self.path();
    if !path.exists() {
      return Ok(Vec::new());
    }
    let contents =
      fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(limit);
    Ok(
      lines[start..]
        .iter()
        .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
        .collect(),
    )
  }
}

/// 文件是不是以换行结尾（不存在或为空都算「是」，那时不需要补）。
///
/// 只读最后一个字节，不把整个文件拉进内存 —— 这个 sink 上限 4MB，而 append
/// 在每一批日志上都会调用它。
fn ends_with_newline(path: &std::path::Path) -> bool {
  use std::io::{Read, Seek, SeekFrom};
  let Ok(mut f) = fs::File::open(path) else {
    return true;
  };
  let Ok(len) = f.metadata().map(|m| m.len()) else {
    return true;
  };
  if len == 0 {
    return true;
  }
  if f.seek(SeekFrom::End(-1)).is_err() {
    return true;
  }
  let mut last = [0u8; 1];
  match f.read_exact(&mut last) {
    Ok(()) => last[0] == b'\n',
    Err(_) => true,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn logged(msg: &str) -> LogEntry {
    LogEntry {
      t: "10:00:00.000".into(),
      level: "info".into(),
      tag: "iso".into(),
      msg: msg.into(),
      data: None,
      profile_id: Some("p1".into()),
      url: Some("https://search.bilibili.com/all".into()),
      at: 1,
    }
  }

  /// Each test gets its own data dir; the sink writes to a real file.
  fn sink() -> (DebugLog, crate::app_dirs::TestDirGuard) {
    let dir = tempfile::tempdir().expect("tempdir");
    let guard = crate::app_dirs::set_test_data_dir(dir.keep());
    (DebugLog::new(), guard)
  }

  #[test]
  fn appends_and_reads_back_in_order() {
    let (l, _g) = sink();
    l.append(&[logged("first"), logged("second")]).unwrap();
    l.append(&[logged("third")]).unwrap();
    let got = l.tail(10).unwrap();
    assert_eq!(
      got.iter().map(|e| e.msg.as_str()).collect::<Vec<_>>(),
      ["first", "second", "third"],
      "尾部读取必须是「最旧在前」，否则拼时间线要反着读"
    );
  }

  #[test]
  fn tail_returns_the_newest_not_the_oldest() {
    // 这是这个文件存在的理由：出事时要看的是最后几行，不是开头几行。
    let (l, _g) = sink();
    let batch: Vec<LogEntry> = (0..50).map(|i| logged(&format!("line{i}"))).collect();
    l.append(&batch).unwrap();
    let got = l.tail(3).unwrap();
    assert_eq!(
      got.iter().map(|e| e.msg.as_str()).collect::<Vec<_>>(),
      ["line47", "line48", "line49"]
    );
  }

  #[test]
  fn reading_before_anything_was_written_is_not_an_error() {
    let (l, _g) = sink();
    assert!(l.tail(10).unwrap().is_empty());
  }

  #[test]
  fn an_empty_batch_writes_nothing() {
    // 扩展的合批器可能在没有日志时也触发一次 flush。
    let (l, _g) = sink();
    assert_eq!(l.append(&[]).unwrap(), 0);
    assert!(!l.path().exists(), "空批次不该凭空建出文件");
  }

  #[test]
  fn a_torn_line_costs_one_line_not_the_whole_history() {
    let (l, _g) = sink();
    l.append(&[logged("good1"), logged("good2")]).unwrap();
    // 模拟崩溃留下的半行
    let mut f = OpenOptions::new().append(true).open(l.path()).unwrap();
    f.write_all(b"{\"msg\":\"tor").unwrap();
    drop(f);
    l.append(&[logged("good3")]).unwrap();
    let msgs: Vec<String> = l.tail(10).unwrap().into_iter().map(|e| e.msg).collect();
    assert!(msgs.contains(&"good1".to_string()));
    assert!(
      msgs.contains(&"good3".to_string()),
      "坏行不能挡住后面的好行"
    );
  }

  #[test]
  fn the_file_is_bounded() {
    let (l, _g) = sink();
    // 一次写超过 MAX_ENTRIES，逼出一次裁剪
    let big: Vec<LogEntry> = (0..MAX_ENTRIES + 500)
      .map(|i| logged(&format!("m{i}")))
      .collect();
    l.append(&big).unwrap();
    // 再用超长消息去撞**字节**上限。
    //
    // 这里曾经是 `while 文件大小 <= MAX_BYTES { 继续写 }` —— 一个永不退出的循环：
    // append 超限就裁剪、裁剪把大小压回上限以下、循环条件于是永远成立。
    // 整个测试套件因此从来跑不完，而症状看起来只是「cargo test 很慢」。
    // 用固定轮数，然后断言上限**真的**被守住。
    for round in 0..12 {
      let filler: Vec<LogEntry> = (0..500)
        .map(|i| logged(&format!("{round}-{i}-{}", "y".repeat(2000))))
        .collect();
      l.append(&filler).unwrap();
    }
    let bytes = fs::metadata(l.path()).map(|m| m.len()).unwrap_or(0);
    assert!(
      bytes <= MAX_BYTES,
      "字节上限必须真的生效 —— 只按条数裁剪的话，几千条超长消息能把这个 sink 撑到几十 MB（实测过），\
       而它的意义是崩溃后还能读到证据，不是吃光磁盘。实际 {bytes} > {MAX_BYTES}"
    );
    let count = l.tail(usize::MAX).unwrap().len();
    assert!(
      count <= MAX_ENTRIES,
      "裁剪后不该超过 {MAX_ENTRIES} 条，实际 {count}"
    );
    // 裁剪保留的必须是**新的**那批 —— 保留旧的等于把出事现场删了
    let last = l.tail(1).unwrap();
    assert_eq!(last.len(), 1);
  }

  #[test]
  fn entries_survive_a_round_trip_with_every_field() {
    let (l, _g) = sink();
    let mut e = logged("full");
    e.data = Some("{\"k\":1}".into());
    l.append(&[e.clone()]).unwrap();
    assert_eq!(l.tail(1).unwrap()[0], e);
  }

  #[test]
  fn missing_optional_fields_deserialise() {
    // 扩展只发 {t,level,tag,msg,data}；其余由服务端补。旧格式必须还能读回来。
    let e: LogEntry =
      serde_json::from_str(r#"{"t":"10:00:00.000","level":"info","tag":"iso","msg":"hi"}"#)
        .unwrap();
    assert_eq!(e.msg, "hi");
    assert_eq!(e.profile_id, None);
    assert_eq!(e.at, 0);
  }
}
