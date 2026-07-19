//! OpenAI-compatible chat-completions provider. Works against any endpoint that
//! speaks the OpenAI `/chat/completions` shape (OpenAI, local servers, proxies).
//! Uses `response_format: json_object` (broadly supported by compatible servers)
//! plus the prompt's own JSON-only instruction. The API key comes from the
//! `DONUT_MARINE_OPENAI_API_KEY` env var — never persisted in plaintext.

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{send_provider_delta, Provider, GENERATION_TIMEOUT_SECS, MAX_STREAMED_PROVIDER_BYTES};

const MAX_SSE_LINE_BYTES: usize = 128 * 1024;
const MAX_SSE_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_SSE_EVENTS: usize = 8192;
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

enum OpenAiSseEvent {
  Delta(String),
  Done,
}

#[derive(Default)]
struct OpenAiSseDecoder {
  line: Vec<u8>,
  wire_bytes: usize,
  events: usize,
  terminal_seen: bool,
}

impl OpenAiSseDecoder {
  fn push(&mut self, chunk: &[u8]) -> Result<Vec<OpenAiSseEvent>, String> {
    if self.wire_bytes.saturating_add(chunk.len()) > MAX_SSE_TOTAL_BYTES {
      return Err("OpenAI SSE exceeded the configured wire limit".to_string());
    }
    self.wire_bytes += chunk.len();

    let mut decoded = Vec::new();
    let mut offset = 0usize;
    while offset < chunk.len() {
      if let Some(relative_newline) = chunk[offset..].iter().position(|byte| *byte == b'\n') {
        let newline = offset + relative_newline;
        self.append_line_segment(&chunk[offset..newline])?;
        self.events = self.events.saturating_add(1);
        if self.events > MAX_SSE_EVENTS {
          return Err("OpenAI SSE emitted too many events".to_string());
        }
        let (is_data, event) = self.decode_line()?;
        if self.terminal_seen && is_data {
          return Err("OpenAI SSE emitted data after the terminal [DONE] event".to_string());
        }
        if let Some(event) = event {
          if matches!(event, OpenAiSseEvent::Done) {
            self.terminal_seen = true;
          }
          decoded.push(event);
        }
        self.line.clear();
        offset = newline + 1;
      } else {
        if self.terminal_seen && offset < chunk.len() {
          return Err(
            "OpenAI SSE contained trailing bytes after the terminal [DONE] event".to_string(),
          );
        }
        self.append_line_segment(&chunk[offset..])?;
        break;
      }
    }
    Ok(decoded)
  }

  fn finish(self) -> Result<(), String> {
    if !self.line.is_empty() {
      Err("OpenAI SSE ended with an incomplete line".to_string())
    } else if self.terminal_seen {
      Ok(())
    } else {
      Err("OpenAI SSE closed before the terminal [DONE] event".to_string())
    }
  }

  fn append_line_segment(&mut self, segment: &[u8]) -> Result<(), String> {
    if self.line.len().saturating_add(segment.len()) > MAX_SSE_LINE_BYTES {
      return Err("OpenAI SSE line exceeded the configured limit".to_string());
    }
    self.line.extend_from_slice(segment);
    Ok(())
  }

  fn decode_line(&self) -> Result<(bool, Option<OpenAiSseEvent>), String> {
    let line = self.line.strip_suffix(b"\r").unwrap_or(&self.line);
    let line =
      std::str::from_utf8(line).map_err(|_| "OpenAI SSE contained invalid UTF-8".to_string())?;
    let Some(data) = line.strip_prefix("data:") else {
      return Ok((false, None));
    };
    let data = data.trim_start();
    if data == "[DONE]" {
      return Ok((true, Some(OpenAiSseEvent::Done)));
    }
    Ok((true, openai_content_delta(data)?.map(OpenAiSseEvent::Delta)))
  }
}

pub struct OpenAiProvider {
  pub base_url: String,
  pub model: String,
  pub api_key: String,
}

#[async_trait]
impl Provider for OpenAiProvider {
  async fn generate_stream(
    &self,
    prompt: &str,
    _schema: &Value,
    deltas: mpsc::Sender<String>,
    cancellation: CancellationToken,
  ) -> Result<String, String> {
    let work = self.generate_stream_inner(prompt, deltas, cancellation.clone());
    tokio::select! {
      _ = cancellation.cancelled() => Err("MARINE_GENERATE_CANCELLED".to_string()),
      result = tokio::time::timeout(Duration::from_secs(GENERATION_TIMEOUT_SECS), work) => {
        result.map_err(|_| "MARINE_GENERATE_TIMEOUT".to_string())?
      }
    }
  }
}

impl OpenAiProvider {
  async fn generate_stream_inner(
    &self,
    prompt: &str,
    deltas: mpsc::Sender<String>,
    cancellation: CancellationToken,
  ) -> Result<String, String> {
    let base = self.base_url.trim_end_matches('/');
    let url = format!("{base}/chat/completions");
    let body = serde_json::json!({
      "model": self.model,
      "messages": [{ "role": "user", "content": prompt }],
      "response_format": { "type": "json_object" },
      "temperature": 0.8,
      "stream": true,
    });
    let response = reqwest::Client::new()
      .post(&url)
      .bearer_auth(&self.api_key)
      .json(&body)
      .send()
      .await
      .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
      let text = read_response_text_bounded(response, MAX_ERROR_BODY_BYTES).await?;
      return Err(format!(
        "endpoint returned {status}: {}",
        text.chars().take(300).collect::<String>()
      ));
    }

    let mut bytes = response.bytes_stream();
    let mut decoder = OpenAiSseDecoder::default();
    let mut raw = String::new();
    while let Some(next) = tokio::select! {
      _ = cancellation.cancelled() => return Err("MARINE_GENERATE_CANCELLED".to_string()),
      next = bytes.next() => next,
    } {
      let chunk = next.map_err(|error| format!("read stream failed: {error}"))?;
      for event in decoder.push(&chunk)? {
        match event {
          OpenAiSseEvent::Done => return Ok(raw),
          OpenAiSseEvent::Delta(delta) => {
            if raw.len().saturating_add(delta.len()) > MAX_STREAMED_PROVIDER_BYTES {
              return Err("OpenAI streamed output exceeded the configured limit".to_string());
            }
            raw.push_str(&delta);
            send_provider_delta(&deltas, &cancellation, delta).await?;
          }
        }
      }
    }
    decoder.finish()?;
    unreachable!("terminal SSE decoder errors before reaching this point")
  }
}

async fn read_response_text_bounded(
  response: reqwest::Response,
  maximum: usize,
) -> Result<String, String> {
  let mut stream = response.bytes_stream();
  let mut output = Vec::new();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|error| format!("read body failed: {error}"))?;
    if output.len().saturating_add(chunk.len()) > maximum {
      return Err("endpoint error body exceeded the configured limit".to_string());
    }
    output.extend_from_slice(&chunk);
  }
  String::from_utf8(output).map_err(|_| "endpoint error body contained invalid UTF-8".to_string())
}

fn openai_content_delta(data: &str) -> Result<Option<String>, String> {
  let value: Value =
    serde_json::from_str(data).map_err(|error| format!("bad JSON in OpenAI SSE: {error}"))?;
  Ok(
    value
      .get("choices")
      .and_then(|choices| choices.get(0))
      .and_then(|choice| choice.get("delta"))
      .and_then(|delta| delta.get("content"))
      .and_then(Value::as_str)
      .map(ToOwned::to_owned),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn extracts_real_openai_sse_content_deltas() {
    let data = serde_json::json!({
      "choices": [{"delta": {"content": "{\"direct\":"}}]
    })
    .to_string();
    assert_eq!(
      openai_content_delta(&data).unwrap().as_deref(),
      Some("{\"direct\":")
    );
    assert_eq!(
      openai_content_delta(r#"{"choices":[{"delta":{}}]}"#).unwrap(),
      None
    );
  }

  #[test]
  fn sse_framing_is_per_line_and_requires_done() {
    let mut decoder = OpenAiSseDecoder::default();
    let first_comment = format!(":{}\n", "a".repeat(80 * 1024));
    let second_comment = format!(":{}\n", "b".repeat(80 * 1024));
    let payload = format!(
      "{first_comment}{second_comment}data: {{\"choices\":[{{\"delta\":{{\"content\":\"x\"}}}}]}}\ndata: [DONE]\n"
    );
    let events = decoder.push(payload.as_bytes()).unwrap();
    assert!(
      matches!(events.as_slice(), [OpenAiSseEvent::Delta(text), OpenAiSseEvent::Done] if text == "x")
    );

    assert!(OpenAiSseDecoder::default().finish().is_err());

    let mut after_done = OpenAiSseDecoder::default();
    assert!(after_done
      .push(b"data: [DONE]\ndata: {\"choices\":[{\"delta\":{}}]}\n")
      .is_err());
    let mut unterminated_after_done = OpenAiSseDecoder::default();
    assert!(unterminated_after_done
      .push(b"data: [DONE]\ndata: {\"choices\":[{\"delta\":{}}]}")
      .is_err());
  }
}
