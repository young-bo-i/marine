//! Connector prompt assembly for Marine's frozen Rime context.
//!
//! Marine does not authorize or execute AI providers. Rime-side Codex,
//! Claude Code, and OpenAI-compatible connectors consume the prepared prompt
//! and own model execution.

pub mod prompt;
