# Marine 字幕 & 文本提取器

一个**轻量、无构建、零依赖**的 Chrome 扩展（Manifest V3）：

- 一键提取主流视频平台的字幕；
- 一键把任意网页正文抽成结构化 Markdown。

> 研究了 youtube-transcript / Subadub / Language Reactor / IndieKKY-bilibili-subtitle / yt-dlp 等开源项目的做法后，取其核心、去其重，做的精简版。

## 支持矩阵

| 平台 | 方式 | 说明 |
|---|---|---|
| **YouTube** | 读取页面 `ytInitialPlayerResponse` 的字幕轨 → 拉取 `timedtext&fmt=json3`；失败时回退抓取「显示文字记录」面板 | 内容脚本与 youtube.com 同源，自动带上页面的 POT token，比服务端抓取稳得多 |
| **Bilibili** | `view → cid → x/player/wbi/v2 → subtitle_url → body[]` | **需已登录 B 站**（字幕登录可见），自动复用浏览器 Cookie |
| **Netflix / 其它流媒体** | MAIN world 钩 `fetch`/`XHR`，被动捕获 `.vtt`/`webvtt`/`timedtext` 等响应体 | 播放时打开字幕即可在弹窗「字幕来源」里看到 |
| **任意 `<video>` 站点** | HTML5 `TextTrack` API（把字幕轨设为 `hidden` 读取 cues） | 通用兜底，适用于使用原生 `<track>` 的站点 |
| **任意网页** | 选正文容器 → 遍历语义标签输出 Markdown | 标题 / 段落 / 列表 / 表格 / 代码 / 引用 / 链接 / 图片 |

输出格式：**纯文本 / 带时间文本 / SRT / VTT**（文本提取为 `.md`）。

## 安装（开发者模式加载）

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录 `marine_chrome_extension`
4. 打开任意视频页 / 文章页，点工具栏的扩展图标

需要 Chrome 111+（MAIN world 内容脚本）。

## 使用

- **字幕**：在 YouTube / Bilibili 视频页点「提取字幕」；多语言时可在「语言」里切换；流媒体站点先播放并打开字幕，再到「字幕来源」下拉里选捕获到的轨。
- **结构化文本**：任意文章页点「提取本页文本」，得到 Markdown，可复制或下载。

## 目录结构

```
manifest.json
popup.html / popup.css / popup.js     # 弹窗 UI
src/
  content-main.js     # MAIN world：钩 fetch/XHR 被动捕获；读取 YouTube 页面全局
  content-iso.js      # ISOLATED world 总控：消息路由 + TextTrack 捕获 + 平台分发
  format.js           # 字幕解析(json3/VTT/SRT/TTML/B站JSON) 与格式转换
  extract-text.js     # 网页正文 → Markdown
  platforms/
    youtube.js        # YouTube 提取
    bilibili.js       # Bilibili 提取
```

## 已知限制（精简版的取舍）

- **Bilibili 需登录**；本版未实现 WBI 签名（登录态下 `x/player/wbi/v2` 一般可直接请求，若遇风控需补签名）。
- **Youku / 爱奇艺 / 腾讯视频**：字幕走平台私有签名（mtop / ckey / WASM），未做专门适配；能被动捕获到明文 `.vtt/.srt/.ass` 时仍可用，硬字幕（烧录进画面）无法提取，需 OCR。
- **Netflix 等**仅做被动捕获，未实现「强制请求 WebVTT 轨」（Subadub 的 `JSON.stringify` 注入），故偶有只剩 DFXP 的标题抓不到。
- 跨域 `<track>` 若页面未设 `crossorigin`，浏览器会屏蔽 cues，TextTrack 兜底对这类站点无效。
- 正文提取是启发式的；复杂排版可后续接入 `@mozilla/readability` 提升准确度。

## 可扩展方向

- 接入 Readability.js 提升正文识别；
- 给 Bilibili 加 WBI 签名、支持番剧 `ep/ss`；
- Netflix 强制 WebVTT 轨；双语字幕对照；
- 一键发送到笔记 / LLM 总结。
