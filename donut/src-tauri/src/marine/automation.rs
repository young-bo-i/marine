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

/// Type `text` into whatever element currently has focus, using human-like
/// (Markov-timed) keystrokes over a fresh WebSocket. Drains the response after
/// every key event to keep the keystroke stream in sync.
pub async fn send_human_keystrokes(
  ws_url: &str,
  text: &str,
  wpm: Option<f64>,
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
        let text_str = ch.to_string();
        let down = serde_json::json!({
          "id": cmd_id,
          "method": "Input.dispatchKeyEvent",
          "params": {
            "type": "keyDown",
            "text": text_str,
            "key": text_str,
            "unmodifiedText": text_str,
          }
        });
        cmd_id += 1;
        ws_stream
          .send(Message::Text(down.to_string().into()))
          .await
          .map_err(|e| format!("Failed to send key event: {e}"))?;
        // Drain response — keeps the keystroke stream from desyncing.
        let _ = ws_stream.next().await;

        let up = serde_json::json!({
          "id": cmd_id,
          "method": "Input.dispatchKeyEvent",
          "params": {
            "type": "keyUp",
            "key": text_str,
          }
        });
        cmd_id += 1;
        ws_stream
          .send(Message::Text(up.to_string().into()))
          .await
          .map_err(|e| format!("Failed to send key event: {e}"))?;
        let _ = ws_stream.next().await;
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
