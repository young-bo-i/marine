//! OpenAI-compatible chat-completions provider. Works against any endpoint that
//! speaks the OpenAI `/chat/completions` shape (OpenAI, local servers, proxies).
//! Uses `response_format: json_object` (broadly supported by compatible servers)
//! plus the prompt's own JSON-only instruction. The API key comes from the
//! `DONUT_MARINE_OPENAI_API_KEY` env var — never persisted in plaintext.

use async_trait::async_trait;
use serde_json::Value;

use super::Provider;

pub struct OpenAiProvider {
  pub base_url: String,
  pub model: String,
  pub api_key: String,
}

#[async_trait]
impl Provider for OpenAiProvider {
  async fn generate(&self, prompt: &str, _schema: &Value) -> Result<String, String> {
    let base = self.base_url.trim_end_matches('/');
    let url = format!("{base}/chat/completions");

    let body = serde_json::json!({
      "model": self.model,
      "messages": [{ "role": "user", "content": prompt }],
      "response_format": { "type": "json_object" },
      "temperature": 0.8,
    });

    let resp = reqwest::Client::new()
      .post(&url)
      .bearer_auth(&self.api_key)
      .json(&body)
      .send()
      .await
      .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let text = resp
      .text()
      .await
      .map_err(|e| format!("read body failed: {e}"))?;
    if !status.is_success() {
      return Err(format!(
        "endpoint returned {status}: {}",
        text.chars().take(300).collect::<String>()
      ));
    }

    let v: Value =
      serde_json::from_str(&text).map_err(|e| format!("bad JSON from endpoint: {e}"))?;
    v.get("choices")
      .and_then(|c| c.get(0))
      .and_then(|c| c.get("message"))
      .and_then(|m| m.get("content"))
      .and_then(|c| c.as_str())
      .map(|s| s.to_string())
      .ok_or_else(|| "no choices[0].message.content in response".to_string())
  }
}
