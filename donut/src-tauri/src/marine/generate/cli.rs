//! Local-CLI generation providers + local-agent auto-detection.
//!
//! Providers drive a `codex` / `claude` binary already installed and
//! authenticated on this machine (no API key — they use the CLI's own login),
//! mirroring how the Pencil app connects: `CodexProvider` spawns
//! `codex exec --experimental-json`, feeds the prompt on stdin, and reads the
//! final `agent_message` out of the JSONL event stream (`~/.codex/auth.json`
//! subscription auth, never `OPENAI_API_KEY`). `ClaudeProvider` runs
//! `claude -p --output-format json` against the `~/.claude` login.
//!
//! `detect_agents()` reports which local agents are installed + authenticated,
//! so the UI can show per-agent connection status (Pencil-style cards).

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use utoipa::ToSchema;

use super::Provider;

const GEN_TIMEOUT_SECS: u64 = 240;

/// Resolve a binary: first any candidate path that is a real file, else look it
/// up by `name` on `$PATH`. `None` if not found anywhere.
fn resolve_binary(cands: &[String], name: &str) -> Option<String> {
  for c in cands {
    if !c.is_empty() && PathBuf::from(c).is_file() {
      return Some(c.clone());
    }
  }
  if let Some(paths) = std::env::var_os("PATH") {
    for dir in std::env::split_paths(&paths) {
      let p = dir.join(name);
      if p.is_file() {
        return Some(p.to_string_lossy().to_string());
      }
    }
  }
  None
}

fn codex_candidates() -> Vec<String> {
  let home = dirs::home_dir().unwrap_or_default();
  vec![
    "/Applications/Codex.app/Contents/Resources/codex".to_string(),
    home.join(".local/bin/codex").to_string_lossy().to_string(),
    "/opt/homebrew/bin/codex".to_string(),
    "/usr/local/bin/codex".to_string(),
  ]
}

fn claude_candidates() -> Vec<String> {
  let home = dirs::home_dir().unwrap_or_default();
  vec![
    home.join(".local/bin/claude").to_string_lossy().to_string(),
    home
      .join(".claude/local/claude")
      .to_string_lossy()
      .to_string(),
    "/opt/homebrew/bin/claude".to_string(),
    "/usr/local/bin/claude".to_string(),
  ]
}

fn find_codex() -> String {
  resolve_binary(&codex_candidates(), "codex").unwrap_or_else(|| "codex".to_string())
}

fn find_claude() -> String {
  resolve_binary(&claude_candidates(), "claude").unwrap_or_else(|| "claude".to_string())
}

/// Connection status of a locally-installed coding agent, for the UI's
/// Pencil-style "connect your agent" cards.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AgentStatus {
  pub id: String,     // "codex" | "claude"
  pub name: String,   // display name
  pub detected: bool, // binary found (candidate path or on $PATH)
  pub authed: bool,   // the agent's own login is present
  pub path: String,   // resolved binary path ("" if not found)
}

/// Detect which local agents are installed + logged in. `detected && authed`
/// means "Connected" (ready to use its subscription).
pub fn detect_agents() -> Vec<AgentStatus> {
  let home = dirs::home_dir().unwrap_or_default();
  let codex = resolve_binary(&codex_candidates(), "codex");
  let claude = resolve_binary(&claude_candidates(), "claude");
  vec![
    AgentStatus {
      id: "codex".to_string(),
      name: "OpenAI GPT Codex".to_string(),
      detected: codex.is_some(),
      authed: home.join(".codex/auth.json").exists(),
      path: codex.unwrap_or_default(),
    },
    AgentStatus {
      id: "claude".to_string(),
      name: "Anthropic Claude Code".to_string(),
      detected: claude.is_some(),
      authed: home.join(".claude").is_dir(),
      path: claude.unwrap_or_default(),
    },
  ]
}

/// Run `cmd` feeding `prompt` on stdin (written concurrently to avoid a
/// pipe-buffer deadlock), with a hard timeout. Returns (status_ok, stdout, stderr).
async fn run_with_stdin(
  mut cmd: tokio::process::Command,
  prompt: &str,
) -> Result<(bool, String, String), String> {
  cmd
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

  let mut stdin = child.stdin.take().ok_or("no stdin handle")?;
  let prompt_owned = prompt.to_string();
  let writer = tokio::spawn(async move {
    let _ = stdin.write_all(prompt_owned.as_bytes()).await;
    let _ = stdin.shutdown().await;
  });

  let output = tokio::time::timeout(
    Duration::from_secs(GEN_TIMEOUT_SECS),
    child.wait_with_output(),
  )
  .await
  .map_err(|_| "MARINE_GENERATE_TIMEOUT".to_string())?
  .map_err(|e| format!("process error: {e}"))?;
  let _ = writer.await;

  Ok((
    output.status.success(),
    String::from_utf8_lossy(&output.stdout).to_string(),
    String::from_utf8_lossy(&output.stderr).to_string(),
  ))
}

pub struct CodexProvider {
  pub model: Option<String>,
}

/// Pull the final assistant answer out of codex's `--experimental-json` event
/// stream (newline-delimited JSON). The answer is the last `item.completed`
/// event whose `item.type == "agent_message"` — its `item.text` is our
/// schema-constrained JSON. Mirrors how `@openai/codex-sdk` reads `runStreamed`.
fn extract_codex_answer(stdout: &str) -> (Option<String>, Option<String>) {
  let mut answer = None;
  let mut failure = None;
  for line in stdout.lines() {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    let ev: Value = match serde_json::from_str(line) {
      Ok(v) => v,
      Err(_) => continue,
    };
    match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
      "item.completed" => {
        if let Some(item) = ev.get("item") {
          if item.get("type").and_then(|t| t.as_str()) == Some("agent_message") {
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
              answer = Some(text.to_string());
            }
          }
        }
      }
      "turn.failed" | "error" => {
        failure = Some(ev.to_string());
      }
      _ => {}
    }
  }
  (answer, failure)
}

#[async_trait]
impl Provider for CodexProvider {
  async fn generate(&self, prompt: &str, schema: &Value) -> Result<String, String> {
    let ws = std::env::temp_dir().join(format!("marine-gen-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&ws).map_err(|e| format!("temp dir: {e}"))?;
    let schema_file = ws.join("schema.json");
    std::fs::write(
      &schema_file,
      serde_json::to_string(schema).unwrap_or_default(),
    )
    .map_err(|e| format!("write schema: {e}"))?;

    // Mirror Pencil / @openai/codex-sdk: `codex exec --experimental-json` streams
    // JSONL events on stdout; prompt goes on stdin; auth is the codex binary's
    // own ~/.codex/auth.json (subscription) — we deliberately do NOT set
    // OPENAI_API_KEY. `--output-schema` constrains the final message to our JSON.
    let codex = find_codex();
    let mut cmd = tokio::process::Command::new(&codex);
    cmd
      .arg("exec")
      .arg("--experimental-json")
      .arg("--skip-git-repo-check")
      .args(["--sandbox", "read-only"])
      .args(["--cd", ws.to_str().unwrap_or(".")])
      .args(["--config", "approval_policy=\"never\""])
      .arg("--output-schema")
      .arg(&schema_file)
      .env("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "codex_sdk_ts");
    if let Some(m) = &self.model {
      if !m.trim().is_empty() {
        cmd.args(["-m", m]);
      }
    }

    let result = run_with_stdin(cmd, prompt).await;
    let _ = std::fs::remove_dir_all(&ws);

    let (ok, stdout, stderr) = result?;
    let (answer, failure) = extract_codex_answer(&stdout);
    match answer {
      Some(a) => Ok(a),
      None => {
        let detail = failure.unwrap_or_else(|| stderr.trim().to_string());
        Err(format!(
          "codex produced no answer ({codex}); ok={ok}; {}",
          detail.chars().take(500).collect::<String>()
        ))
      }
    }
  }
}

pub struct ClaudeProvider {
  pub model: Option<String>,
}

#[async_trait]
impl Provider for ClaudeProvider {
  async fn generate(&self, prompt: &str, _schema: &Value) -> Result<String, String> {
    // Best-effort: `claude -p --output-format json` reads the prompt from stdin
    // and prints `{ "result": "<assistant text>", … }`. The prompt already
    // demands JSON-only, so `result` should be the JSON we want.
    let claude = find_claude();
    let mut cmd = tokio::process::Command::new(&claude);
    cmd.arg("-p").args(["--output-format", "json"]);
    if let Some(m) = &self.model {
      if !m.trim().is_empty() {
        cmd.args(["--model", m]);
      }
    }

    let (ok, stdout, stderr) = run_with_stdin(cmd, prompt).await?;
    if !ok {
      return Err(format!("claude failed: {}", stderr.trim()));
    }
    // Unwrap the CLI envelope; fall back to raw stdout if it isn't the wrapper.
    match serde_json::from_str::<Value>(&stdout) {
      Ok(v) => Ok(
        v.get("result")
          .and_then(|r| r.as_str())
          .map(|s| s.to_string())
          .unwrap_or(stdout),
      ),
      Err(_) => Ok(stdout),
    }
  }
}
