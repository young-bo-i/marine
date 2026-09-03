# Marine × Donut Browser

把「Marine 截流话术」能力集成进开源反检测浏览器 **Donut Browser** 的 fork。

## 结构

- **`donut/`** — Fork 的 Donut Browser（Tauri v2 · Rust + Next.js，AGPL-3.0），产品主体。
  - **`donut/marine-extension/`** — Marine 浏览器扩展（侧边栏 side panel）：抓取正文 / 字幕 / 评论（含 B 站闭合 shadow root）、内置 Scholay 话术方案、面板内生成直评 + 回复、填入回复框（**永不自动发，人工确认后手动发**）。
  - **`donut/src-tauri/src/marine/`** + `api_server.rs` 的 `/v1/marine/*` — 扩展的本地 REST 后端：生成引擎（本机 codex / claude CLI，或 OpenAI 兼容端点）、发布历史。
- **`MARINE_EXTENSION_REDESIGN.md`** — 架构与演进说明。

## 工作方式

Donut 启动一个 profile → 自动把 Marine 扩展装进该 profile + 起本地 API（`127.0.0.1:10108`，bearer token 自动生成）→ 扩展侧边栏自动连上。在页面侧边栏里：**抓取内容 → 点「生成话术」→ 逐条直评 / 回复 → 填入回复框**，人工确认后手动发送。

## 开发

```bash
cd donut
pnpm install
pnpm tauri dev
```

引擎：本机 **codex**（`~/.codex` 订阅）/ **claude**（`~/.claude`）自动识别；或 **OpenAI 兼容端点**（key 走 `DONUT_MARINE_OPENAI_API_KEY` 环境变量）。

走 codex 时，模型与推理深度由 Marine 显式下发（默认 `gpt-5.3-codex-spark` + `low`），**不继承 `~/.codex/config.toml`**——否则终端里换个模型或把 `model_reasoning_effort` 调到 `xhigh`，就会悄悄改掉每一条评论的生成模型和耗时。两者都在扩展「配置 → AI 模型连接器」里可改；推理深度走 `-c` 下发、回包独立校验，掉了会直接报错；模型名则不做存在性校验（codex 0.144.4 在 `thread/start` 阶段原样回显，不解析），写错要到真正发起请求时才知道——这种情况会报 `MARINE_MODEL_REJECTED` 并带上模型名，而不是笼统的"生成失败"。

## 许可

`donut/` 衍生自 Donut Browser，遵循 **AGPL-3.0**：衍生作品需开源并保留同一许可。
