# Marine 重设计：浏览器内扩展 + Donut 做后端

> **状态：已落地并跑通端到端。** Marine 是装进 Donut 启动的 Wayfern profile 的侧边栏扩展（`donut/marine-extension`），"重活"走 Donut 本地 REST API（`donut/src-tauri/src/api_server.rs` 的 `/v1/marine/*`）；Donut 主程序无 Marine UI。
>
> **R1–R4（初始重设计）**：R1 本地 API 端点；R2 扩展接后端；R3 启动 profile 时装扩展 + 盖章 runtime-config + `--load-extension`；R4 删原生 Marine UI + CDP 命令。
>
> **R4 之后的变更（当前真实状态，已取代下文部分设计）**：
> - **本地智能体连接照 Pencil 逆向重做**：`marine/generate/cli.rs` 调本机 `codex exec --experimental-json`（stdin 喂 prompt、读 JSONL、订阅鉴权、**绝不设 OPENAI_API_KEY**）/ `claude`。扩展 UI 照 Pencil 设计语言重做（zinc 深色、引擎卡片自动识别 codex/claude 连接态）。
> - **本地 API 开机自启**：Marine 每个 profile 都注入扩展、都要用 API，所以 `lib.rs` setup **无条件**确保 token + 起 server + 持久化 `api_enabled=true`（取代旧的"手动去 Integrations 开一次"）。`ApiServer::start()` 构建含 `run_profile` 的 router，从 profile 启动路径调它会触发 rustc 类型环 / 非 Send，所以只能在 setup 起；`ensure_for_profile` 只读端口 + get-or-generate token + 盖章 runtime-config。
> - **去掉品牌选择，内置话术**：话术方案（`donut/marine-extension/skills/scholay/`）预制在扩展里，`loadSkill()` 合并成文本；`/generate` 契约从 `{brand_id,payload}` 改为 `{skill,payload}`；扩展删掉品牌选择 / CRUD UI；面板内点「生成话术」直接出直评 + 回复 → 填入回复框。**后端品牌 CRUD 端点 + BrandManager + `marine/brand.rs` 已随之移除**（`BrowserProfile.brand_id` 惰性字段保留）。
> - **退出收割浏览器**：Donut 退出（确认退出 / 托盘 / Cmd+Q）会 kill 掉它启动的浏览器。
> - **E2E 已验证**：开机自动起 API（10108）→ profile 启动盖章真实 token → 扩展引擎卡片变绿 → `/generate` 出 3 直评 + 3 回复（Scholay 人设/点名/卖点正确）。
>
> 完整决策见记忆 `donut-marine-fork`。下面 §1–§8 是当初的设计推演（**背景**，其中品牌 CRUD、手动开 API 等已被上面的变更取代）。

---

> **缘由（用户反馈）**：把 Marine 做在 Donut 主程序里、用 CDP 远程驱动另一个浏览器窗口——不直观、易出错、不利观察。改为**做在浏览器的扩展位置（侧边栏）**，所见即所得。
>
> **三项决策（已定）**：① 扩展基座 = 复用现有 Marine 扩展；② 扩展的"重活"走 **Donut 本地 REST API**（复用 Rust 双-provider 引擎）；③ **Donut 主程序不做任何 Marine UI**——只负责把扩展装进 profile + 提供本地 API + 管 profile/代理/反检测。

---

## 1. 为什么这个方向更好（把旧版三个痛点直接消掉）

| 旧版（主程序 + CDP 远程驱动） | 新版（浏览器内扩展） |
|---|---|
| 内容在 Wayfern 窗口、操作面板在 Donut 窗口，来回看，不直观 | 侧边栏贴在页面旁，所见即所得 |
| 靠抓取时的 `cN` id 事后再定位评论 → 点赞/排序变就静默错位 | 扩展活在页面里，直接拿真实 DOM 节点，无事后映射 |
| CDP 穿不进 B 站闭合 shadow root → B 站打不通（留 P4） | 扩展有 `chrome.dom.openOrClosedShadowRoot` → **B 站直接可用** |

**唯一代价**：装扩展给 profile 增加一点指纹面（anti-detect 略打折）。已由用户拍板：直观+可靠+B站 优先。缓解：只给"要操作的" profile 装；扩展保持精简。

---

## 2. 新架构分层

```
┌─ Wayfern 浏览器窗口（操作现场）───────────────────────────┐
│  Marine 扩展（复用 marine_chrome_extension，侧边栏 side panel）  │
│   · 内容脚本：抓 正文/字幕/评论（含 B 站闭合 shadow root）直接读  │
│   · 侧边栏 UI：抓取 → 生成 → 逐条草稿 → 填入回复框 → 人工发       │
│   · 回复注入：直接操作页面真实 DOM（无 CDP、无 id 漂移）          │
│   · 品牌/skill 配置 UI 也在这里                                 │
│        │ 生成话术 / 品牌·内容·草稿 CRUD  →  HTTP 调本地 API        │
├────────┼──────────────────────────────────────────────────┤
│  Donut 主程序（基座 + 后端，无 Marine UI）                       │
│   本地 REST API (api_server.rs) 新增 /marine/*：                │
│     POST /marine/generate         复用 Rust 双-provider 引擎     │
│     CRUD /marine/brands|content|drafts|history                  │
│     GET/PUT /marine/provider-config                             │
│   把 Marine 扩展装进 profile（extension_manager）+ 启动时写入      │
│     运行期配置（API base + token）到扩展包                        │
│   profile / 代理 / 反检测 / 多号（donut 原生，不动）              │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 复用 / 搬移 / 删除（我们这几天的成果大部分不浪费）

| 组件 | 处置 |
|---|---|
| Rust 生成引擎 `marine/generate/{mod,cli,openai,prompt}.rs` | **复用**，从 Tauri 命令改为 REST 端点 `POST /marine/generate` 暴露 |
| Rust 实体/管理器 `marine/{brand,content,draft,history}.rs` | **复用**，改为 REST CRUD 端点暴露 |
| `settings_manager` 的 marine provider 字段 | **复用**，经 `/marine/provider-config` 端点读写 |
| `marine/cdp.rs` + `automation.rs` | **保留**（MCP 仍用），但 **Marine 不再走 CDP 抓取/填充** |
| Rust `marine/grab.js` + `fill.js` + `inject_js.rs` + CDP 版 `marine_grab`/`marine_fill_reply` 命令 | **删除**——抓取/回复回到扩展内容脚本（现有扩展已具备，且已解决 B 站） |
| Donut 前端 Marine UI（`marine-page.tsx`/`marine-brands`/`marine-content`/`marine-drafts`/`marine-provider-settings`/`use-marine-*`/rail 入口/相关 i18n） | **删除**（主程序不碰 Marine UI） |
| Marine 的 Tauri 命令注册（generate_handler 里那批 `marine_*`） | **删除**（扩展走 HTTP，不走 Tauri 命令） |
| 现有 `marine_chrome_extension`（侧边栏 + 内容脚本 + comments.js 穿透 + fill 注入 + skills） | **复用为基座**，改造后端调用（见 §4） |

---

## 4. 扩展改造点（基于现有 marine_chrome_extension）

- **生成后端**：`popup.js` 原来 → native messaging host（`host/marine-codex-host.js`）。改为 → `fetch(Donut 本地 API /marine/generate)`。native host 相关（`host/`、install 脚本、4-byte framing、扩展 ID 绑定）**弃用**。
- **品牌/内容/草稿存储**：原来 `chrome.storage.local('marineSkills')` → 改为调 `/marine/brands|content|drafts` API（这样品牌能进 Donut 的 sync 体系、跨号共享）。
- **保留不动**：内容脚本的抓取（正文/字幕/评论，含 `comments.js` 的闭合 shadow root 穿透）、回复草稿注入（`content-iso.js` 的定位/填充）、侧边栏 UI 骨架。
- **侧边栏 UI 补齐**：把品牌配置、草稿卡片（编辑/批准/跳过/填入/标记已发）做进侧边栏（部分是把我们在 Donut 里写的 React UI 语义搬到扩展的 popup.js/侧边栏）。

## 5. 关键集成机制：扩展 ↔ Donut 本地 API（发现 + 鉴权）

问题：扩展在 Wayfern 进程里，怎么知道 Donut 本地 API 的**端口 + token**（端口默认 10108，冲突会漂移；API 带 bearer token）。

**提案（最稳、Donut 完全掌控）**：Donut 把 Marine 扩展装进 profile 时，是它**自己拷贝/生成扩展目录**的——所以在加载前，往扩展包里**写一个 `marine-runtime-config.json`**（内容：`{ apiBase: "http://127.0.0.1:<当前端口>/marine", token }`）。扩展启动读 `chrome.runtime.getURL('marine-runtime-config.json')` 拿到 base+token，之后所有 API 调用带上。端口漂移/重启由 Donut 每次启动 profile 时重写该文件解决。无需扩展探测端口、无需 CDP 往扩展里塞配置。

## 6. Donut 改动清单

- `api_server.rs`：新增 `/marine/*` 路由（generate / brands CRUD / content / drafts / history / provider-config）——handler 复用已有 managers/引擎，`Result<_,String>`→REST。**两处都要改**：`.routes(routes!())` + `ApiDoc #[openapi]`。所有路由受既有 localhost + bearer 中间件保护。
- `extension_manager.rs` / `browser_runner.rs`：把 Marine 扩展作为**内置扩展**打包随 app 分发，启动选定 profile 时 `--load-extension` 加载 + 写入 §5 的 runtime-config。
- 删除 §3 表中标"删除"的原生 Marine UI + CDP grab/fill 命令 + inject_js/grab.js/fill.js。
- `tauri.conf.json`：把 Marine 扩展目录纳入 resources（随包分发）。

## 7. 分阶段落地

- **R1｜后端 API 化（additive、低风险，先做）**：`api_server.rs` 加 `/marine/*` 端点，复用现有 generate 引擎 + brand/content/draft/history managers。此阶段 Donut 原生 Marine UI 暂留、能同时验证 API。
- **R2｜扩展接后端**：改造 `marine_chrome_extension`——生成/存储改调 `/marine/*`；读取 `marine-runtime-config.json`；保留 in-page 抓取/评论/回复。本地手动 load 该扩展进一个 Wayfern profile 实测闭环（含 B 站）。
- **R3｜Donut 装扩展**：内置打包 Marine 扩展 + 启动 profile 时 `--load-extension` + 写 runtime-config。做到"建号→启动→侧边栏就在→抓取→生成→填入→人工发"。
- **R4｜清理**：删原生 Marine UI + CDP grab/fill 命令 + inject_js/grab.js/fill.js + 相关 i18n/命令注册。跑 cargo/tsc/biome/unused-commands 收尾。

## 8. 风险 / 未决

- **anti-detect 指纹面**：装扩展可被探测。用户已接受；缓解=只给操作号装、扩展精简。
- **扩展↔API 鉴权**：采用 §5 的 runtime-config 文件方案；若担心 token 落在扩展目录，可改为 localhost 免 token（Donut API 对 127.0.0.1 的 /marine/* 放行）——**需用户定**。
- **B 站字幕**：现有扩展的 B 站字幕链路（view→cid→wbi/v2）需确认可用；评论穿透已具备。
- **删原生 UI**：会移除我们刚写的 Donut 端 Marine 页——但领域逻辑（引擎/实体）全部保留为 API 后端，不是白做。
- **AGPL**：扩展若与 Donut 一起分发，同属衍生，保持开源+许可。
