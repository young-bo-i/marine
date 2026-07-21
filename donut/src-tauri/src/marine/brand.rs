//! Canonical Marine brand voices.
//!
//! The browser extension identifies the active profile and page target. This
//! module owns the reusable brand rules/examples and compiles a bounded skill
//! snapshot that Rime can safely keep with that target lease.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tempfile::NamedTempFile;
use utoipa::ToSchema;

pub const BUILTIN_BRAND_ID: &str = "scholay";
const SCHEMA_VERSION: u8 = 1;
const MAX_BRANDS: usize = 256;
const MAX_EXAMPLES: usize = 128;
const MAX_KEYWORDS: usize = 32;
const MAX_SHORT_BYTES: usize = 512;
const MAX_LONG_BYTES: usize = 32 * 1024;
const MAX_EXAMPLE_BYTES: usize = 16 * 1024;
const MAX_BRAND_JSON_BYTES: usize = 512 * 1024;
const MAX_SKILL_BYTES: usize = 64 * 1024;
const MAX_SELECTED_EXAMPLES: usize = 2;

const SCHOLAY_BRAND_MD: &str = include_str!("../../../marine-extension/skills/scholay/品牌.md");
const SCHOLAY_EXECUTION_MD: &str =
  include_str!("../../../marine-extension/skills/scholay/执行口径.md");
const SCHOLAY_MOTHER_MD: &str = include_str!("../../../marine-extension/skills/scholay/母稿.md");
const SCHOLAY_INDEX_JSON: &str =
  include_str!("../../../marine-extension/skills/scholay/母稿索引.json");

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrandTone {
  pub warmth: u8,
  pub expertise: u8,
  pub wit: u8,
  pub directness: u8,
  pub emoji: String,
  pub length: String,
}

impl Default for BrandTone {
  fn default() -> Self {
    Self {
      warmth: 45,
      expertise: 85,
      wit: 65,
      directness: 70,
      emoji: "light".into(),
      length: "medium".into(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrandExample {
  pub id: String,
  pub title: String,
  pub text: String,
  #[serde(default)]
  pub keywords: Vec<String>,
  pub platform: String,
  pub kind: String,
  #[serde(default = "default_true")]
  pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrandProfile {
  pub schema_version: u8,
  pub id: String,
  pub name: String,
  pub display_name: String,
  pub language: String,
  #[serde(default)]
  pub platforms: Vec<String>,
  #[serde(default)]
  pub positioning: String,
  #[serde(default)]
  pub audience: String,
  #[serde(default)]
  pub persona_voice: String,
  #[serde(default)]
  pub product_info: String,
  #[serde(default)]
  pub comment_style: String,
  #[serde(default)]
  pub do_rules: Vec<String>,
  #[serde(default)]
  pub dont_rules: Vec<String>,
  #[serde(default)]
  pub tone: BrandTone,
  #[serde(default)]
  pub examples: Vec<BrandExample>,
  pub revision: u64,
  pub updated_at: u64,
  #[serde(default)]
  pub built_in: bool,
  #[serde(default)]
  pub sync_enabled: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub last_sync: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrandPreviewContext {
  #[serde(default)]
  pub platform: String,
  #[serde(default)]
  pub title: String,
  #[serde(default)]
  pub target_summary: String,
  #[serde(default)]
  pub mode: String,
  #[serde(default)]
  pub source_text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrandPreview {
  pub brand_id: String,
  pub revision: u64,
  pub selected_example_ids: Vec<String>,
  pub skill: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BrandError {
  #[error("brand not found")]
  NotFound,
  #[error("built-in brand cannot be deleted")]
  BuiltIn,
  #[error("brand revision conflict (expected {expected}, actual {actual})")]
  Conflict { expected: u64, actual: u64 },
  #[error("invalid brand field: {0}")]
  Invalid(&'static str),
  #[error("brand storage failed: {0}")]
  Storage(String),
}

impl BrandError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::NotFound => "MARINE_BRAND_NOT_FOUND",
      Self::BuiltIn => "MARINE_BRAND_BUILT_IN",
      Self::Conflict { .. } => "MARINE_BRAND_REVISION_CONFLICT",
      Self::Invalid(_) => "MARINE_BRAND_INVALID",
      Self::Storage(_) => "MARINE_BRAND_STORAGE_FAILED",
    }
  }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MotherIndex {
  routes: Vec<MotherRoute>,
}

#[derive(Debug, Deserialize)]
struct MotherRoute {
  id: String,
  paragraph: usize,
  label: String,
  keywords: Vec<String>,
}

fn default_true() -> bool {
  true
}

fn now_secs() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

fn is_safe_id(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn bounded(value: &str, max_bytes: usize) -> bool {
  value.len() <= max_bytes && !value.contains('\0')
}

fn validate_string_list(values: &[String], max_items: usize) -> bool {
  values.len() <= max_items
    && values
      .iter()
      .all(|value| bounded(value, MAX_SHORT_BYTES) && !value.trim().is_empty())
}

fn validate_brand(brand: &BrandProfile) -> Result<(), BrandError> {
  if brand.schema_version != SCHEMA_VERSION {
    return Err(BrandError::Invalid("schemaVersion"));
  }
  if !is_safe_id(&brand.id) {
    return Err(BrandError::Invalid("id"));
  }
  if brand.name.trim().is_empty() || !bounded(&brand.name, MAX_SHORT_BYTES) {
    return Err(BrandError::Invalid("name"));
  }
  if !bounded(&brand.display_name, MAX_SHORT_BYTES)
    || !bounded(&brand.language, 64)
    || !bounded(&brand.positioning, MAX_LONG_BYTES)
    || !bounded(&brand.audience, MAX_LONG_BYTES)
    || !bounded(&brand.persona_voice, MAX_LONG_BYTES)
    || !bounded(&brand.product_info, MAX_LONG_BYTES)
    || !bounded(&brand.comment_style, MAX_LONG_BYTES)
  {
    return Err(BrandError::Invalid("text"));
  }
  if !validate_string_list(&brand.platforms, 32)
    || !validate_string_list(&brand.do_rules, 128)
    || !validate_string_list(&brand.dont_rules, 128)
  {
    return Err(BrandError::Invalid("rules"));
  }
  if brand.tone.warmth > 100
    || brand.tone.expertise > 100
    || brand.tone.wit > 100
    || brand.tone.directness > 100
    || !bounded(&brand.tone.emoji, 64)
    || !bounded(&brand.tone.length, 64)
  {
    return Err(BrandError::Invalid("tone"));
  }
  if brand.examples.len() > MAX_EXAMPLES {
    return Err(BrandError::Invalid("examples"));
  }
  for example in &brand.examples {
    if !is_safe_id(&example.id)
      || example.title.trim().is_empty()
      || !bounded(&example.title, MAX_SHORT_BYTES)
      || example.text.trim().is_empty()
      || !bounded(&example.text, MAX_EXAMPLE_BYTES)
      || !validate_string_list(&example.keywords, MAX_KEYWORDS)
      || !bounded(&example.platform, 64)
      || !matches!(example.kind.as_str(), "both" | "direct" | "reply")
    {
      return Err(BrandError::Invalid("example"));
    }
  }
  let json = serde_json::to_vec(brand).map_err(|error| BrandError::Storage(error.to_string()))?;
  if json.len() > MAX_BRAND_JSON_BYTES {
    return Err(BrandError::Invalid("size"));
  }
  Ok(())
}

fn builtin_brand() -> BrandProfile {
  let paragraphs: Vec<&str> = SCHOLAY_MOTHER_MD
    .split("\n\n")
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .collect();
  let index: MotherIndex = serde_json::from_str(SCHOLAY_INDEX_JSON)
    .expect("bundled Scholay mother-draft index must be valid");
  let examples = index
    .routes
    .into_iter()
    .filter_map(|route| {
      let text = paragraphs.get(route.paragraph.checked_sub(1)?)?;
      Some(BrandExample {
        id: route.id,
        title: route.label,
        text: (*text).to_string(),
        keywords: route.keywords,
        platform: "all".into(),
        kind: "both".into(),
        enabled: true,
      })
    })
    .collect();

  BrandProfile {
    schema_version: SCHEMA_VERSION,
    id: BUILTIN_BRAND_ID.into(),
    name: "Scholay".into(),
    display_name: "Scholay".into(),
    language: "zh-CN".into(),
    platforms: vec!["bilibili".into(), "xiaohongshu".into(), "zhihu".into()],
    positioning: "覆盖查文献、矩阵分析、写作编辑与 AI 模拟评审的学术科研平台。".into(),
    audience: "在读研究生、青年科研人员，以及正在投稿、开题、改格式或管理文献的人。".into(),
    persona_voice: "在读研究生 / 青年科研人；专业、毒舌、真诚，有具体经历感。".into(),
    product_info: SCHOLAY_BRAND_MD.trim().to_string(),
    comment_style: SCHOLAY_EXECUTION_MD.trim().to_string(),
    do_rules: vec![
      "先接住当前作品或目标评论真正谈论的问题。".into(),
      "每条只突出一个核心卖点，并自然点名 Scholay。".into(),
      "使用具体人物关系、时间线、动作、受挫过程和结果中的至少三项。".into(),
    ],
    dont_rules: vec![
      "不承诺包录用、包过或代写论文。".into(),
      "不贬低评论者本人，不与人对骂。".into(),
      "不写成功能罗列、客服腔、官腔或空泛夸奖。".into(),
    ],
    tone: BrandTone::default(),
    examples,
    revision: 1,
    updated_at: 1,
    built_in: true,
    // Brand cloud transport is intentionally not advertised until the client
    // has a complete multi-account conflict protocol. Local persistence and
    // profile binding are fully available in this release.
    sync_enabled: false,
    last_sync: None,
  }
}

#[derive(Debug, Default)]
pub struct BrandManager;

impl BrandManager {
  pub fn new() -> Self {
    Self
  }

  fn dir(&self) -> PathBuf {
    crate::app_dirs::brands_dir()
  }

  fn path(&self, id: &str) -> PathBuf {
    self.dir().join(format!("{id}.json"))
  }

  fn read_path(&self, path: &Path) -> Result<BrandProfile, BrandError> {
    let bytes = fs::read(path).map_err(|error| BrandError::Storage(error.to_string()))?;
    if bytes.len() > MAX_BRAND_JSON_BYTES {
      return Err(BrandError::Invalid("size"));
    }
    let mut brand: BrandProfile =
      serde_json::from_slice(&bytes).map_err(|error| BrandError::Storage(error.to_string()))?;
    brand.sync_enabled = false;
    brand.last_sync = None;
    validate_brand(&brand)?;
    Ok(brand)
  }

  fn write(&self, brand: &BrandProfile) -> Result<(), BrandError> {
    validate_brand(brand)?;
    let dir = self.dir();
    fs::create_dir_all(&dir).map_err(|error| BrandError::Storage(error.to_string()))?;
    let bytes =
      serde_json::to_vec_pretty(brand).map_err(|error| BrandError::Storage(error.to_string()))?;
    let mut temp =
      NamedTempFile::new_in(&dir).map_err(|error| BrandError::Storage(error.to_string()))?;
    temp
      .write_all(&bytes)
      .and_then(|_| temp.write_all(b"\n"))
      .and_then(|_| temp.as_file().sync_all())
      .map_err(|error| BrandError::Storage(error.to_string()))?;
    temp
      .persist(self.path(&brand.id))
      .map_err(|error| BrandError::Storage(error.error.to_string()))?;
    Ok(())
  }

  pub fn list(&self) -> Result<Vec<BrandProfile>, BrandError> {
    let dir = self.dir();
    let mut brands = Vec::new();
    if dir.exists() {
      for entry in fs::read_dir(&dir).map_err(|error| BrandError::Storage(error.to_string()))? {
        let entry = entry.map_err(|error| BrandError::Storage(error.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
          continue;
        }
        brands.push(self.read_path(&path)?);
        if brands.len() > MAX_BRANDS {
          return Err(BrandError::Invalid("brandCount"));
        }
      }
    }
    if !brands.iter().any(|brand| brand.id == BUILTIN_BRAND_ID) {
      brands.push(builtin_brand());
    }
    brands.sort_by(|left, right| {
      right
        .built_in
        .cmp(&left.built_in)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.id.cmp(&right.id))
    });
    Ok(brands)
  }

  pub fn get(&self, id: &str) -> Result<BrandProfile, BrandError> {
    if !is_safe_id(id) {
      return Err(BrandError::Invalid("id"));
    }
    let path = self.path(id);
    if path.exists() {
      return self.read_path(&path);
    }
    if id == BUILTIN_BRAND_ID {
      return Ok(builtin_brand());
    }
    Err(BrandError::NotFound)
  }

  pub fn create(&self, name: String) -> Result<BrandProfile, BrandError> {
    let name = name.trim();
    if name.is_empty() || !bounded(name, MAX_SHORT_BYTES) {
      return Err(BrandError::Invalid("name"));
    }
    if self.list()?.len() >= MAX_BRANDS {
      return Err(BrandError::Invalid("brandCount"));
    }
    let brand = BrandProfile {
      schema_version: SCHEMA_VERSION,
      id: uuid::Uuid::new_v4().to_string(),
      name: name.to_string(),
      display_name: name.to_string(),
      language: "zh-CN".into(),
      platforms: vec!["bilibili".into(), "xiaohongshu".into(), "zhihu".into()],
      positioning: String::new(),
      audience: String::new(),
      persona_voice: String::new(),
      product_info: String::new(),
      comment_style: String::new(),
      do_rules: Vec::new(),
      dont_rules: Vec::new(),
      tone: BrandTone::default(),
      examples: Vec::new(),
      revision: 1,
      updated_at: now_secs(),
      built_in: false,
      sync_enabled: false,
      last_sync: None,
    };
    self.write(&brand)?;
    Ok(brand)
  }

  pub fn save(
    &self,
    mut brand: BrandProfile,
    expected_revision: u64,
  ) -> Result<BrandProfile, BrandError> {
    // Keep the UI truthful while cloud transport is still a separate phase.
    brand.sync_enabled = false;
    brand.last_sync = None;
    validate_brand(&brand)?;
    let current = self.get(&brand.id)?;
    if current.revision != expected_revision {
      return Err(BrandError::Conflict {
        expected: expected_revision,
        actual: current.revision,
      });
    }
    brand.schema_version = SCHEMA_VERSION;
    brand.built_in = current.built_in;
    brand.revision = current.revision.saturating_add(1);
    brand.updated_at = now_secs().max(current.updated_at.saturating_add(1));
    brand.last_sync = current.last_sync;
    self.write(&brand)?;
    Ok(brand)
  }

  pub fn delete(&self, id: &str, expected_revision: u64) -> Result<(), BrandError> {
    let current = self.get(id)?;
    if current.built_in {
      return Err(BrandError::BuiltIn);
    }
    if current.revision != expected_revision {
      return Err(BrandError::Conflict {
        expected: expected_revision,
        actual: current.revision,
      });
    }
    fs::remove_file(self.path(id)).map_err(|error| BrandError::Storage(error.to_string()))
  }

  pub fn compile(
    &self,
    brand: &BrandProfile,
    context: &BrandPreviewContext,
  ) -> Result<BrandPreview, BrandError> {
    validate_brand(brand)?;
    compile_brand(brand, context)
  }
}

pub static BRAND_MANAGER: LazyLock<Mutex<BrandManager>> =
  LazyLock::new(|| Mutex::new(BrandManager::new()));

fn occurrences(haystack: &str, needle: &str) -> usize {
  if needle.is_empty() {
    return 0;
  }
  haystack.match_indices(needle).count()
}

fn eligible(example: &BrandExample, context: &BrandPreviewContext) -> bool {
  let platform = context.platform.trim().to_lowercase();
  let example_platform = example.platform.trim().to_lowercase();
  let mode = context.mode.trim().to_lowercase();
  example.enabled
    && (example_platform.is_empty() || example_platform == "all" || example_platform == platform)
    && (example.kind == "both" || example.kind == mode)
}

fn score(example: &BrandExample, context: &BrandPreviewContext) -> usize {
  let target = context.target_summary.to_lowercase();
  let title = context.title.to_lowercase();
  let source = context.source_text.to_lowercase();
  example
    .keywords
    .iter()
    .map(|raw| {
      let keyword = raw.trim().to_lowercase();
      let weight = keyword.chars().count().clamp(2, 8);
      occurrences(&target, &keyword) * weight * 5
        + occurrences(&title, &keyword) * weight * 3
        + occurrences(&source, &keyword) * weight
    })
    .sum()
}

fn push_section(parts: &mut Vec<String>, title: &str, body: &str) {
  if !body.trim().is_empty() {
    parts.push(format!("# {title}\n\n{}", body.trim()));
  }
}

fn compile_brand(
  brand: &BrandProfile,
  context: &BrandPreviewContext,
) -> Result<BrandPreview, BrandError> {
  let mut ranked: Vec<(usize, usize, &BrandExample)> = brand
    .examples
    .iter()
    .enumerate()
    .filter(|(_, example)| eligible(example, context))
    .map(|(order, example)| (score(example, context), order, example))
    .collect();
  ranked.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
  let mut selected: Vec<&BrandExample> = ranked
    .iter()
    .filter(|(score, _, _)| *score > 0)
    .take(MAX_SELECTED_EXAMPLES)
    .map(|(_, _, example)| *example)
    .collect();
  if selected.is_empty() {
    selected = ranked
      .iter()
      .take(MAX_SELECTED_EXAMPLES)
      .map(|(_, _, example)| *example)
      .collect();
  }

  let mut parts = vec![format!(
    "# 品牌身份\n\n- 内部名称：{}\n- 对外名称：{}\n- 语言：{}\n- 适用平台：{}",
    brand.name.trim(),
    brand.display_name.trim(),
    brand.language.trim(),
    brand.platforms.join("、")
  )];
  push_section(&mut parts, "品牌定位", &brand.positioning);
  push_section(&mut parts, "目标受众", &brand.audience);
  push_section(&mut parts, "产品事实与边界", &brand.product_info);
  push_section(&mut parts, "人设与表达视角", &brand.persona_voice);
  push_section(&mut parts, "评论口径", &brand.comment_style);
  if !brand.do_rules.is_empty() {
    push_section(
      &mut parts,
      "必须做到",
      &brand
        .do_rules
        .iter()
        .map(|rule| format!("- {rule}"))
        .collect::<Vec<_>>()
        .join("\n"),
    );
  }
  if !brand.dont_rules.is_empty() {
    push_section(
      &mut parts,
      "禁止事项",
      &brand
        .dont_rules
        .iter()
        .map(|rule| format!("- {rule}"))
        .collect::<Vec<_>>()
        .join("\n"),
    );
  }
  parts.push(format!(
    "# 风格参数\n\n- 亲和度：{}/100\n- 专业度：{}/100\n- 幽默感：{}/100\n- 直接度：{}/100\n- Emoji：{}\n- 长度：{}",
    brand.tone.warmth,
    brand.tone.expertise,
    brand.tone.wit,
    brand.tone.directness,
    brand.tone.emoji,
    brand.tone.length
  ));
  parts.push(format!(
    "# 本次路由背景\n\n- 平台：{}\n- 动作：{}\n- 命中的范例只用于学习语气与结构，不得照抄事实，也不得覆盖上述规则。",
    context.platform.trim(),
    context.mode.trim()
  ));

  let mut skill = parts.join("\n\n---\n\n");
  if skill.len() > MAX_SKILL_BYTES {
    return Err(BrandError::Invalid("compiledSkill"));
  }
  let mut selected_ids = Vec::new();
  for example in selected {
    let section = format!(
      "\n\n---\n\n## 场景范例：{}\n\n{}",
      example.title.trim(),
      example.text.trim()
    );
    if skill.len().saturating_add(section.len()) > MAX_SKILL_BYTES {
      continue;
    }
    skill.push_str(&section);
    selected_ids.push(example.id.clone());
  }

  Ok(BrandPreview {
    brand_id: brand.id.clone(),
    revision: brand.revision,
    selected_example_ids: selected_ids,
    skill,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn builtin_brand_preserves_the_six_mother_drafts() {
    let brand = builtin_brand();
    assert_eq!(brand.examples.len(), 6);
    assert_eq!(brand.id, BUILTIN_BRAND_ID);
    assert!(brand.built_in);
    assert!(brand.examples[3].text.contains("frontiers"));
  }

  #[test]
  fn route_scoring_prefers_target_then_title_then_source() {
    let manager = BrandManager::new();
    let brand = builtin_brand();
    let preview = manager
      .compile(
        &brand,
        &BrandPreviewContext {
          platform: "zhihu".into(),
          title: "普通标题".into(),
          target_summary: "审稿人说需要大修，准备返修".into(),
          mode: "reply".into(),
          source_text: "顺便提到格式".into(),
        },
      )
      .unwrap();
    assert_eq!(preview.selected_example_ids[0], "submission-review");
    assert!(preview.skill.len() <= MAX_SKILL_BYTES);
  }

  #[test]
  fn save_uses_revision_compare_and_swap() {
    let temp = tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = BrandManager::new();
    let mut brand = manager.create("Test".into()).unwrap();
    brand.positioning = "Position".into();
    let saved = manager.save(brand.clone(), 1).unwrap();
    assert_eq!(saved.revision, 2);
    assert!(matches!(
      manager.save(brand, 1),
      Err(BrandError::Conflict {
        expected: 1,
        actual: 2
      })
    ));
  }

  #[test]
  fn builtin_is_saveable_but_not_deletable() {
    let temp = tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = BrandManager::new();
    let mut brand = manager.get(BUILTIN_BRAND_ID).unwrap();
    brand.comment_style.push_str("\nExtra rule");
    let saved = manager.save(brand, 1).unwrap();
    assert_eq!(saved.revision, 2);
    assert!(matches!(
      manager.delete(BUILTIN_BRAND_ID, 2),
      Err(BrandError::BuiltIn)
    ));
  }

  #[test]
  fn unsafe_ids_never_become_paths() {
    let manager = BrandManager::new();
    assert!(matches!(
      manager.get("../../profiles"),
      Err(BrandError::Invalid("id"))
    ));
  }
}
