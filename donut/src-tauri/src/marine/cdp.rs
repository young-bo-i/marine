//! Shared Chrome DevTools Protocol (CDP) driver for talking to a running
//! Wayfern/Camoufox instance.
//!
//! These helpers were factored out of `mcp_server.rs` so that both the MCP
//! server and the native Marine feature drive the launched browser through a
//! single implementation. `mcp_server`'s methods now delegate here and map the
//! `String` error into its `McpError` shape.

use crate::profile::{BrowserProfile, ProfileManager};

/// Resolve a profile by id, requiring it to be a supported browser that is
/// currently running (so a CDP port exists). Returns a human-readable error
/// message on failure — callers wrap it into their own error shape.
pub fn resolve_running_profile(profile_id: &str) -> Result<BrowserProfile, String> {
  let profiles = ProfileManager::instance()
    .list_profiles()
    .map_err(|e| format!("Failed to list profiles: {e}"))?;

  let profile = profiles
    .into_iter()
    .find(|p| p.id.to_string() == profile_id)
    .ok_or_else(|| format!("Profile not found: {profile_id}"))?;

  if profile.browser != "wayfern" && profile.browser != "camoufox" {
    return Err("Only Wayfern and Camoufox profiles support automation".to_string());
  }

  if profile.process_id.is_none() {
    return Err(format!("Profile '{}' is not running", profile.name));
  }

  Ok(profile)
}

/// Discover the CDP (remote debugging) port a running profile was launched with.
/// Retries a few times because the port mapping may not be persisted yet right
/// after launch.
pub async fn get_cdp_port_for_profile(profile: &BrowserProfile) -> Result<u16, String> {
  let profiles_dir = ProfileManager::instance().get_profiles_dir();
  let profile_path = profile.get_profile_data_path(&profiles_dir);
  let profile_path_str = profile_path.to_string_lossy();

  for attempt in 0..10 {
    if attempt > 0 {
      tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    let port = if profile.browser == "wayfern" {
      crate::wayfern_manager::WayfernManager::instance()
        .get_cdp_port(&profile_path_str)
        .await
    } else if profile.browser == "camoufox" {
      crate::camoufox_manager::CamoufoxManager::instance()
        .get_cdp_port(&profile_path_str)
        .await
    } else {
      None
    };
    if let Some(p) = port {
      return Ok(p);
    }
  }

  Err(format!(
    "No CDP connection available for profile '{}'. Make sure the browser is running.",
    profile.name
  ))
}

/// Resolve the WebSocket debugger URL for the first `page` target on `port`.
/// Retries while the browser is still starting up.
pub async fn get_cdp_ws_url(port: u16) -> Result<String, String> {
  let url = format!("http://127.0.0.1:{port}/json");
  let client = reqwest::Client::new();

  let max_attempts = 15;
  let mut last_err = String::new();
  for attempt in 0..max_attempts {
    if attempt > 0 {
      tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    match client
      .get(&url)
      .timeout(std::time::Duration::from_secs(3))
      .send()
      .await
    {
      Ok(resp) => match resp.json::<Vec<serde_json::Value>>().await {
        Ok(targets) => {
          if let Some(ws_url) = targets
            .iter()
            .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
            .and_then(|t| t.get("webSocketDebuggerUrl"))
            .and_then(|v| v.as_str())
          {
            return Ok(ws_url.to_string());
          }
          last_err = "No page target found in browser".to_string();
        }
        Err(e) => {
          last_err = format!("Failed to parse CDP targets: {e}");
        }
      },
      Err(e) => {
        last_err = format!("Failed to connect to browser CDP endpoint: {e}");
      }
    }
  }

  Err(last_err)
}

/// Send a single CDP command over a fresh WebSocket connection and return its
/// `result`. Waits for the response whose id matches the command.
pub async fn send_cdp(
  ws_url: &str,
  method: &str,
  params: serde_json::Value,
) -> Result<serde_json::Value, String> {
  use futures_util::sink::SinkExt;
  use futures_util::stream::StreamExt;
  use tokio_tungstenite::connect_async;
  use tokio_tungstenite::tungstenite::Message;

  let (mut ws_stream, _) = connect_async(ws_url)
    .await
    .map_err(|e| format!("Failed to connect to CDP WebSocket: {e}"))?;

  let command = serde_json::json!({
    "id": 1,
    "method": method,
    "params": params
  });

  ws_stream
    .send(Message::Text(command.to_string().into()))
    .await
    .map_err(|e| format!("Failed to send CDP command: {e}"))?;

  while let Some(msg) = ws_stream.next().await {
    let msg = msg.map_err(|e| format!("CDP WebSocket error: {e}"))?;
    if let Message::Text(text) = msg {
      let response: serde_json::Value = serde_json::from_str(text.as_str())
        .map_err(|e| format!("Failed to parse CDP response: {e}"))?;
      if response.get("id") == Some(&serde_json::json!(1)) {
        if let Some(error) = response.get("error") {
          return Err(format!("CDP error: {error}"));
        }
        return Ok(
          response
            .get("result")
            .cloned()
            .unwrap_or(serde_json::json!({})),
        );
      }
    }
  }

  Err("No response received from CDP".to_string())
}
