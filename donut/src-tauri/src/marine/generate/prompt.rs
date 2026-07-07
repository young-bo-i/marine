//! Prompt + JSON-schema assembly for 截流 generation. Ported from
//! `host/marine-codex-host.js`. The persona/话术 ("skill") is pre-built and
//! shipped inside the Marine extension (`skills/<brand>/`); the extension merges
//! those files and sends the combined text as `skill`, so here we only splice it
//! together with the grabbed content and the fixed task/output contract. The
//! comment list comes from the grab payload's `comments.agentMd` (the `[id=...]`
//! markers let the model's `targetId` map back to a comment).

use serde_json::Value;

/// The strict output schema: `{ direct:[{text,angle}], replies:[{targetId,target,text}] }`.
/// Byte-for-byte the contract from `marine-codex-host.js`.
pub fn schema() -> Value {
  serde_json::json!({
    "type": "object",
    "additionalProperties": false,
    "required": ["direct", "replies"],
    "properties": {
      "direct": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false, "required": ["text", "angle"],
          "properties": { "text": { "type": "string" }, "angle": { "type": "string" } }
        }
      },
      "replies": {
        "type": "array",
        "items": {
          "type": "object", "additionalProperties": false, "required": ["targetId", "target", "text"],
          "properties": {
            "targetId": { "type": "string" }, "target": { "type": "string" }, "text": { "type": "string" }
          }
        }
      }
    }
  })
}

fn payload_str(payload: &Value, path: &[&str]) -> Option<String> {
  let mut cur = payload;
  for key in path {
    cur = cur.get(key)?;
  }
  cur.as_str().map(|s| s.to_string())
}

/// Build the full prompt + schema for the given grab payload and pre-built skill
/// text (the merged persona/话术 the extension ships and sends as `skill`).
pub fn build(payload: &Value, skill: &str) -> (String, Value) {
  let skill = if skill.trim().is_empty() {
    "（未提供 Skill）"
  } else {
    skill
  };

  let maintext = payload_str(payload, &["article", "markdown"]).unwrap_or_default();
  let maintext = if maintext.trim().is_empty() {
    "（无正文）".to_string()
  } else {
    maintext
  };
  let comments = payload_str(payload, &["comments", "agentMd"]).unwrap_or_default();
  let comments = if comments.trim().is_empty() {
    "（无评论）".to_string()
  } else {
    comments
  };
  let subtitle = payload_str(payload, &["subtitle", "text"]).unwrap_or_default();
  let subtitle = if subtitle.trim().is_empty() {
    "（无字幕）".to_string()
  } else {
    subtitle
  };

  let prompt = [
    skill.to_string(),
    String::new(),
    "====== 本次抓取内容 ======".to_string(),
    String::new(),
    "## 正文".to_string(),
    maintext,
    String::new(),
    "## 评论".to_string(),
    comments,
    String::new(),
    "## 字幕".to_string(),
    subtitle,
    String::new(),
    "====== 任务 ======".to_string(),
    "按上面 Skill 的口径与风格参数，针对评论与内容产出截流话术，以 JSON 输出：".to_string(),
    "direct = 直评数组（每条 text + angle，共 3 条、角度各不同），".to_string(),
    "replies = 回复数组（挑评论区最适合接话的几条）。每条必须包含：".to_string(),
    "  targetId = 评论行里的 id 值（评论列表每条形如 [id=...]；没有 id 才填空字符串），"
      .to_string(),
    "  target = \"@作者（「评论原文片段」）\"，".to_string(),
    "  text = 要填入该评论回复框的回复内容。".to_string(),
    "每条 direct 与 reply 的 text 都要严格遵循上面 Skill 的口径、风格参数与点名要求。只输出 JSON。"
      .to_string(),
  ]
  .join("\n");

  (prompt, schema())
}
