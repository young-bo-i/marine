//! Shared page-automation service over CDP.
//!
//! Factored out of `mcp_server.rs` so the MCP server, the local REST API, and
//! the native Marine UI all drive a running Wayfern/Camoufox page through one
//! implementation. Everything here returns `Result<_, String>`; callers map the
//! message into their own error shape (MCP `McpError`, REST status, or the UI
//! `{code}` convention).
//!
//! Invariant: this module NEVER clicks a submit/send button. `fill` focuses an
//! element and human-types into it; posting is always a manual human action.
//! That is the technical anchor of the "human posts every comment" mandate.

use crate::human_typing::{MarkovTyper, TypingAction};
use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// How a character reaches the focused element.
///
/// Both are browser-level trusted input; they differ in which events the page
/// sees, and editors disagree about which one they accept. Measured against the
/// live sites (each on a fresh page load, comment box focused, CJK text):
///
/// | site      | `KeyEvents`        | `InsertText` |
/// |-----------|--------------------|--------------|
/// | 抖音      | verified in prod   | untested     |
/// | 知乎      | writes **nothing** | clean        |
/// | B 站      | works              | works        |
///
/// Zhihu's editor is Draft.js, which builds its content from `beforeinput`;
/// synthesised key events never produce one for CJK, so all three key-event
/// spellings (`keyDown`+`text`, `char`, `rawKeyDown`+`char`+`keyUp`) left the
/// box empty. That is why this is a choice and not a constant — and why Douyin
/// stays on `KeyEvents`: it is the one that was verified there, and its editor
/// actively fights back at anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
  /// `Input.dispatchKeyEvent` per character.
  KeyEvents,
  /// `Input.insertText` per character. Still one call per character, so the
  /// Markov cadence below is preserved — this is not a paste.
  InsertText,
}

impl InputMode {
  pub fn parse(value: Option<&str>) -> Result<Self, String> {
    match value.unwrap_or("keys") {
      "keys" => Ok(Self::KeyEvents),
      "insert" => Ok(Self::InsertText),
      other => Err(format!("unknown input mode: {other}")),
    }
  }
}

/// Type `text` into whatever element currently has focus, using human-like
/// (Markov-timed) keystrokes over a fresh WebSocket. Drains the response after
/// every key event to keep the keystroke stream in sync.
pub async fn send_human_keystrokes(
  ws_url: &str,
  text: &str,
  wpm: Option<f64>,
) -> Result<(), String> {
  send_human_input(ws_url, text, wpm, InputMode::KeyEvents).await
}

/// The CDP messages that deliver one character, in order.
///
/// Split out so the wire format is testable without a browser: which method a
/// mode emits is the whole point of the mode, and getting it wrong is silent —
/// Zhihu accepted every key event we sent and wrote nothing.
fn char_messages(ch: char, mode: InputMode, cmd_id: &mut u64) -> Vec<serde_json::Value> {
  let text = ch.to_string();
  let mut next = || {
    let id = *cmd_id;
    *cmd_id += 1;
    id
  };
  match mode {
    InputMode::InsertText => vec![serde_json::json!({
      "id": next(),
      "method": "Input.insertText",
      "params": { "text": text }
    })],
    InputMode::KeyEvents => vec![
      serde_json::json!({
        "id": next(),
        "method": "Input.dispatchKeyEvent",
        "params": {
          "type": "keyDown",
          "text": text,
          "key": text,
          "unmodifiedText": text,
        }
      }),
      serde_json::json!({
        "id": next(),
        "method": "Input.dispatchKeyEvent",
        "params": { "type": "keyUp", "key": text }
      }),
    ],
  }
}

pub async fn send_human_input(
  ws_url: &str,
  text: &str,
  wpm: Option<f64>,
  mode: InputMode,
) -> Result<(), String> {
  let events = MarkovTyper::new(text, wpm).run();

  let (mut ws_stream, _) = connect_async(ws_url)
    .await
    .map_err(|e| format!("Failed to connect to CDP WebSocket: {e}"))?;

  let mut cmd_id = 1u64;
  let mut last_time = 0.0;

  for event in &events {
    let delay = event.time - last_time;
    if delay > 0.0 {
      tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await;
    }
    last_time = event.time;

    match &event.action {
      TypingAction::Char(ch) => {
        for message in char_messages(*ch, mode, &mut cmd_id) {
          ws_stream
            .send(Message::Text(message.to_string().into()))
            .await
            .map_err(|e| format!("Failed to send input event: {e}"))?;
          // Drain response — keeps the input stream from desyncing.
          let _ = ws_stream.next().await;
        }
      }
      TypingAction::Backspace => {
        let down = serde_json::json!({
          "id": cmd_id,
          "method": "Input.dispatchKeyEvent",
          "params": {
            "type": "keyDown",
            "key": "Backspace",
            "code": "Backspace",
            "windowsVirtualKeyCode": 8,
            "nativeVirtualKeyCode": 8,
          }
        });
        cmd_id += 1;
        ws_stream
          .send(Message::Text(down.to_string().into()))
          .await
          .map_err(|e| format!("Failed to send key event: {e}"))?;
        let _ = ws_stream.next().await;

        let up = serde_json::json!({
          "id": cmd_id,
          "method": "Input.dispatchKeyEvent",
          "params": {
            "type": "keyUp",
            "key": "Backspace",
            "code": "Backspace",
            "windowsVirtualKeyCode": 8,
            "nativeVirtualKeyCode": 8,
          }
        });
        cmd_id += 1;
        ws_stream
          .send(Message::Text(up.to_string().into()))
          .await
          .map_err(|e| format!("Failed to send key event: {e}"))?;
        let _ = ws_stream.next().await;
      }
    }
  }

  Ok(())
}

/// Send a CDP command and wait for the page to finish loading. Uses a single
/// WebSocket to: enable Page events, send the command, wait for the command
/// response, then wait for `Page.loadEventFired`.
pub async fn send_cdp_and_wait_for_load(
  ws_url: &str,
  method: &str,
  params: serde_json::Value,
  timeout_secs: u64,
) -> Result<serde_json::Value, String> {
  let (mut ws_stream, _) = connect_async(ws_url)
    .await
    .map_err(|e| format!("Failed to connect to CDP WebSocket: {e}"))?;

  let enable_cmd = serde_json::json!({ "id": 1, "method": "Page.enable", "params": {} });
  ws_stream
    .send(Message::Text(enable_cmd.to_string().into()))
    .await
    .map_err(|e| format!("Failed to send Page.enable: {e}"))?;

  // Wait for Page.enable response
  loop {
    let msg = ws_stream
      .next()
      .await
      .ok_or_else(|| "WebSocket closed waiting for Page.enable response".to_string())?
      .map_err(|e| format!("CDP WebSocket error: {e}"))?;
    if let Message::Text(text) = msg {
      let resp: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
      if resp.get("id") == Some(&serde_json::json!(1)) {
        break;
      }
    }
  }

  let command = serde_json::json!({ "id": 2, "method": method, "params": params });
  ws_stream
    .send(Message::Text(command.to_string().into()))
    .await
    .map_err(|e| format!("Failed to send CDP command: {e}"))?;

  let mut command_result = None;
  let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(timeout_secs);

  loop {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
      break;
    }

    let msg = match tokio::time::timeout(remaining, ws_stream.next()).await {
      Ok(Some(Ok(msg))) => msg,
      Ok(Some(Err(e))) => return Err(format!("CDP WebSocket error: {e}")),
      Ok(None) => break,
      Err(_) => break,
    };

    if let Message::Text(text) = msg {
      let response: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();

      if response.get("id") == Some(&serde_json::json!(2)) {
        if let Some(error) = response.get("error") {
          return Err(format!("CDP error: {error}"));
        }
        command_result = Some(
          response
            .get("result")
            .cloned()
            .unwrap_or(serde_json::json!({})),
        );
      }

      if response.get("method") == Some(&serde_json::json!("Page.loadEventFired")) {
        break;
      }
    }
  }

  let disable_cmd = serde_json::json!({ "id": 3, "method": "Page.disable", "params": {} });
  let _ = ws_stream
    .send(Message::Text(disable_cmd.to_string().into()))
    .await;

  command_result.ok_or_else(|| "No response received from CDP".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Zhihu's Draft.js writes nothing for a synthesised key event but accepts
  /// `Input.insertText`; Douyin is the reverse case that must not be "unified"
  /// away. So the mode has to reach the wire — a mode that silently emitted the
  /// other method would look identical from here and fail only on the site.
  #[test]
  fn each_mode_emits_its_own_cdp_method() {
    let mut id = 1;
    let insert = char_messages('好', InputMode::InsertText, &mut id);
    assert_eq!(insert.len(), 1);
    assert_eq!(insert[0]["method"], "Input.insertText");
    assert_eq!(insert[0]["params"]["text"], "好");

    let keys = char_messages('好', InputMode::KeyEvents, &mut id);
    assert_eq!(keys.len(), 2, "a keystroke is keyDown + keyUp");
    assert_eq!(keys[0]["method"], "Input.dispatchKeyEvent");
    assert_eq!(keys[0]["params"]["type"], "keyDown");
    assert_eq!(keys[0]["params"]["text"], "好");
    assert_eq!(keys[1]["params"]["type"], "keyUp");
  }

  /// Every message needs its own id or the drain below pairs replies with the
  /// wrong request and the stream desyncs mid-word.
  #[test]
  fn command_ids_advance_across_characters() {
    let mut id = 1;
    let mut seen = Vec::new();
    for ch in "你好".chars() {
      for message in char_messages(ch, InputMode::KeyEvents, &mut id) {
        seen.push(message["id"].as_u64().unwrap());
      }
    }
    assert_eq!(seen, vec![1, 2, 3, 4]);
    assert_eq!(id, 5);
  }

  #[test]
  fn the_default_mode_is_the_one_douyin_was_verified_on() {
    assert_eq!(InputMode::parse(None).unwrap(), InputMode::KeyEvents);
    assert_eq!(
      InputMode::parse(Some("keys")).unwrap(),
      InputMode::KeyEvents
    );
    assert_eq!(
      InputMode::parse(Some("insert")).unwrap(),
      InputMode::InsertText
    );
    assert!(InputMode::parse(Some("paste")).is_err());
  }
}
