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

## 许可

`donut/` 衍生自 Donut Browser，遵循 **AGPL-3.0**：衍生作品需开源并保留同一许可。
