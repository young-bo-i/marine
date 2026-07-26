// content-iso.js — ISOLATED world 总控（document_idle）
// 职责：
//  - 监听 MAIN world 经 window.postMessage 发来的被动捕获字幕；
//  - 钩住页面内 <video> 的 TextTrack，作为任意站点的通用兜底；
//  - 响应 popup 的 chrome.runtime 消息，路由到各平台提取逻辑。
(function () {
  'use strict';

  // ---- 平台识别 ----
  function detectPlatform() {
    const h = location.hostname;
    if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') return 'youtube';
    if (/(^|\.)bilibili\.com$/.test(h)) return 'bilibili';
    if (/(^|\.)zhihu\.com$/.test(h)) return 'zhihu';
    if (/(^|\.)xiaohongshu\.com$/.test(h) || h === 'xhslink.com') return 'xiaohongshu';
    if (/(^|\.)douyin\.com$/.test(h)) return 'douyin';
    if (/(^|\.)netflix\.com$/.test(h)) return 'netflix';
    return 'generic';
  }
  const PLATFORM_LABEL = { youtube: 'YouTube', bilibili: 'Bilibili', zhihu: '知乎', xiaohongshu: '小红书', douyin: '抖音', netflix: 'Netflix', generic: '通用页面' };
  // 有评论目标适配器的平台 —— 就是 comment-targets.js 的 adapters.get 认识的那四个。
  // 刻意小于 detectPlatform() 的全集，也小于 manifest 里那条 host 列表：
  //   detectPlatform  ⊃ manifest host 列表 ⊃ 本表
  //   · netflix 只有通用 textTrack 抽取，没有任何 src/platforms/ 文件；
  //   · youtube 有 src/platforms/youtube.js（字幕）但没有评论适配器。
  // 本表只用于判断「适配器注册表本该已经存在」，不要拿它当注入范围用。
  const ADAPTER_PLATFORMS = { bilibili: 1, zhihu: 1, xiaohongshu: 1, douyin: 1 };

  // ---- 1) MAIN world 被动捕获 ----
  const captured = [];          // { id, url, body, ct, ts }
  let capSeq = 0;

  // ---- 评论被动捕获（按响应累积，去重交给解析层） ----
  const commentCaptures = [];   // { url, body, ts }
  let lastGrabParts = null;     // 缓存上次抓取的字幕/正文，供「加载更多评论」重建 bundle
  let commentNotifyTimer = null;
  function marineIngestComment(d) {
    commentCaptures.push({ url: d.url, body: d.body, ts: Date.now() });
    if (commentCaptures.length > 400) commentCaptures.shift();
    marineRimeContextDataChanged();
    // 只做一个廉价的「本条响应约几条」计数用于日志（不跑完整 builder，
    // 尤其避免知乎每条响应都重复解析巨大的 js-initialData）。
    let n = 0;
    try {
      const j = JSON.parse(d.body);
      let arr = [];
      if (j) {
        if (j.data && Array.isArray(j.data.comments)) arr = j.data.comments;         // 小红书
        else if (Array.isArray(j.data)) arr = j.data;                                // 知乎 feeds/评论
        else if (j.data && Array.isArray(j.data.replies)) arr = j.data.replies;      // B站
        else if (Array.isArray(j.replies || j.comments)) arr = j.replies || j.comments;
      }
      n = arr.length;
    } catch (e) {}
    marineLog('net', 'iso', '评论响应 ' + shortUrl(d.url) + ' → 约 +' + n + ' 条（累计响应 ' + commentCaptures.length + '）');
    // 评论是页面异步加载的，可能晚于抓取 → 防抖通知面板刷新计数（不滚动页面）
    if (commentNotifyTimer) clearTimeout(commentNotifyTimer);
    commentNotifyTimer = setTimeout(function () {
      try { chrome.runtime.sendMessage({ __marineCommentUpdate: true }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }, 400);
  }

  function marineSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function marineCommentsResult(built) {
    if (!built.ok) return { ok: false, error: built.error || '未解析出评论', stats: built.stats || { count: 0 } };
    return {
      ok: true,
      platform: detectPlatform(),
      stats: built.stats,
      preview: marineCommentsPreview(built.comments, 100),
      agentMd: marineCommentsForAgent(built.comments, 100000),
      targets: marineFlattenComments(built.comments),
      json: JSON.stringify(built.comments, null, 2),
    };
  }

  function marineCommentsPanelPayload(built) {
    return built.ok ? {
      status: 'has',
      count: built.stats.count,
      md: marineCommentsPreview(built.comments, 100000),
      agentMd: marineCommentsForAgent(built.comments, 100000),
      targets: marineFlattenComments(built.comments),
    } : { status: 'none', targets: [] };
  }

  function marineCommentDriveRootHint() {
    const platform = detectPlatform();
    if (platform === 'bilibili') return 'bili-comments';
    if (platform === 'zhihu') return '.Modal-content, .Comments-container, .CommentListV2';
    if (platform === 'xiaohongshu') return '.note-scroller, .comments-container';
    if (platform === 'douyin') return '.comment-mainContent, [class*="comment-list" i], [class*="comment-header-inner-container"]';
    return null;
  }

  function marineCommentScrollSurface() {
    let root = marineCommentSearchRoot();
    for (let current = root, depth = 0; current && current !== document && depth < 8;
      current = marineComposedParent(current), depth++) {
      try {
        const style = getComputedStyle(current);
        if (current.scrollHeight > current.clientHeight + 24 &&
            /(auto|scroll)/.test(style.overflowY || style.overflow)) return current;
      } catch (e) {}
    }
    return null;
  }

  function marineScrollCommentsToEnd() {
    const surface = marineCommentScrollSurface();
    if (surface) {
      try { surface.scrollTo(0, surface.scrollHeight); }
      catch (e) { try { surface.scrollTop = surface.scrollHeight; } catch (ignore) {} }
      return;
    }
    try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) {}
  }

  // 自动滚动 + 展开，驱动页面自发请求（钩子续收），实现「尽量全量」
  async function marineDriveComments(opts) {
    opts = opts || {};
    const budget = Math.min(opts.budgetMs || 20000, 60000);
    const t0 = Date.now();
    const rootHint = marineCommentDriveRootHint();
    let last = -1, stable = 0, rounds = 0;
    marineLog('info', 'iso', '开始自动滚动加载评论（预算 ' + Math.round(budget / 1000) + 's）…');
    while (Date.now() - t0 < budget && stable < 3) {
      rounds++;
      marineScrollCommentsToEnd();
      let clicked = 0;
      try { clicked = marineClickExpanders(rootHint); } catch (e) {}
      await marineSleep(1100);
      const n = commentCaptures.length;
      if (n === last) stable++; else { stable = 0; last = n; }
      marineLog('track', 'iso', '滚动 ' + rounds + ' 轮：累计响应 ' + n + (clicked ? '，展开 ' + clicked + ' 处' : ''));
    }
    const built = marineBuildComments(detectPlatform(), commentCaptures);
    marineLog(built.ok ? 'ok' : 'warn', 'iso', '自动加载结束：评论 ' + built.stats.count + ' 条');
    return marineCommentsResult(built);
  }

  // 单步加载：滚一屏 + 展开，约触发一页（~20 条）。重复调用即可加载更多。
  async function marineDriveOnce() {
    const rootHint = marineCommentDriveRootHint();
    try {
      const el = rootHint && document.querySelector(rootHint);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'end' });
      marineScrollCommentsToEnd();
    } catch (e) {}
    let clicked = 0;
    try { clicked = marineClickExpanders(rootHint); } catch (e) {}
    await marineSleep(1600);
    marineLog('track', 'iso', '加载一页评论' + (clicked ? '（展开 ' + clicked + ' 处）' : ''));
  }

  function marineCountTree(tree) {
    let n = 0;
    (function w(l) { for (const c of l) { n++; if (c.children && c.children.length) w(c.children); } })(tree || []);
    return n;
  }

  // 把字幕 + 评论 + 正文打成一份可复制的 Markdown（供当前 AI 连接器使用）
  function marineBuildBundle(d) {
    const parts = [];
    parts.push('平台：' + (PLATFORM_LABEL[d.platform] || d.platform) + '　来源：' + d.url);
    parts.push('');
    parts.push('## 正文');
    parts.push(d.textMarkdown && d.textMarkdown.trim() ? d.textMarkdown.trim() : '（无）');
    parts.push('');
    parts.push('## 评论' + (d.comments && d.comments.length ? '（' + marineCountTree(d.comments) + ' 条）' : ''));
    parts.push(d.comments && d.comments.length ? marineCommentsPreview(d.comments, 100000) : '（无）');
    parts.push('');
    parts.push('## 字幕');
    parts.push(d.cues && d.cues.length ? marineFormatCues(d.cues, 'text') : '（无）');
    return parts.join('\n');
  }

  // 一次抓全部：字幕 + 评论 + 结构化文本，返回三项状态 + 合并 bundle
  async function marineGrabAll(opts) {
    opts = opts || {};
    const platform = detectPlatform();
    const out = { platform, subtitle: { status: 'none' }, comments: { status: 'none' }, text: { status: 'none' } };
    marineLog('info', 'iso', '一次抓取：字幕 + 评论 + 正文 @ ' + platform);

    // 评论：被动解析已捕获的（自动抓取不滚动页面；要更多评论点「加载更多」）
    const commentsBuilt = marineBuildComments(platform, commentCaptures);
    if (commentsBuilt.ok) out.comments = marineCommentsPanelPayload(commentsBuilt);

    // 字幕
    let subRes = null;
    try {
      if (platform === 'youtube') subRes = await marineExtractYouTube({});
      else if (platform === 'bilibili') subRes = await marineExtractBilibili({});
      else subRes = extractGeneric();
    } catch (e) { subRes = null; }
    if (subRes && subRes.ok && subRes.cues && subRes.cues.length) out.subtitle = { status: 'has', count: subRes.cues.length, text: marineFormatCues(subRes.cues, 'text') };

    // 结构化文本：知乎/小红书优先从结构化数据取干净正文，其它站点用通用提取兜底
    let textRes = null;
    try {
      const noteMd = marineExtractNoteText(platform, commentCaptures, opts);
      if (noteMd && noteMd.trim()) textRes = { ok: true, chars: noteMd.length, markdown: noteMd };
      else textRes = marineExtractStructuredText();
    } catch (e) { textRes = null; }
    if (textRes && textRes.ok) out.text = { status: 'has', chars: textRes.chars, md: textRes.markdown };

    lastGrabParts = {
      textMarkdown: textRes && textRes.ok ? textRes.markdown : '',
      cues: subRes && subRes.ok ? subRes.cues : null,
    };

    out.bundle = marineBuildBundle({
      platform, url: location.href,
      textMarkdown: textRes && textRes.ok ? textRes.markdown : '',
      comments: commentsBuilt && commentsBuilt.ok ? commentsBuilt.comments : [],
      cues: subRes && subRes.ok ? subRes.cues : null,
    });
    out.url = location.href;
    out.host = location.hostname;
    out.title = document.title;
    marineLog('ok', 'iso', '抓取完成：字幕=' + out.subtitle.status + ' 评论=' + out.comments.status + ' 正文=' + out.text.status);
    return out;
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__marine) return;
    // 来自 MAIN world 的日志，转发到调试面板
    if (d.__marine === 'log') { marineLog(d.level, d.tag || 'main', d.msg, d.data); return; }
    if (d.__marine === 'navigation') { marineRimeHandleNavigation(d.url); return; }
    if (d.__marine === 'net-capture' && d.kind === 'comment' && d.body) { marineIngestComment(d); return; }
    if (d.__marine !== 'net-capture' || !d.body) return;
    // 按 URL 去重，保留最近 30 条
    const exist = captured.find(c => c.url === d.url);
    if (exist) {
      exist.body = d.body;
      exist.ts = Date.now();
      marineRimeContextDataChanged();
      return;
    }
    captured.push({ id: 'cap_' + (++capSeq), url: d.url, body: d.body, ct: d.ct || '', ts: Date.now() });
    if (captured.length > 30) captured.shift();
    let n = 0; try { n = marineParseAuto(d.body, d.url).length; } catch (err) {}
    marineLog('net', 'iso', '捕获字幕响应 ' + shortUrl(d.url) + ' → ' + n + ' 条');
    marineDebug.setMeta({ captured: captured.length });
    marineRimeContextDataChanged();
  }, false);

  function capturedSources() {
    return captured.slice().reverse().map(c => {
      const cues = marineParseAuto(c.body, c.url);
      return { id: c.id, kind: 'captured', label: shortUrl(c.url), count: cues.length };
    }).filter(s => s.count > 0);
  }
  function shortUrl(u) {
    try { const x = new URL(u); return (x.pathname.split('/').pop() || x.hostname) + '（' + x.hostname + '）'; }
    catch (e) { return u.slice(0, 60); }
  }

  // ---- 2) 通用 TextTrack 捕获 ----
  const trackBuffers = [];      // { id, label, lang, cuesMap }
  let trkSeq = 0;
  function wireTrack(track) {
    if (!track || (track.kind !== 'subtitles' && track.kind !== 'captions')) return;
    if (track.__marineWired) return;
    track.__marineWired = true;
    // 仅把 disabled 轨改为 hidden（加载 cues 而不显示），不动用户正在看的 showing 轨
    if (track.mode === 'disabled') { try { track.mode = 'hidden'; } catch (e) {} }
    const buf = { id: 'trk_' + (++trkSeq), label: track.label || track.language || ('轨道' + trkSeq), lang: track.language || '', cuesMap: new Map(), logged: 0 };
    trackBuffers.push(buf);
    marineLog('track', 'iso', '发现字幕轨：' + buf.label + (buf.lang ? '（' + buf.lang + '）' : '') + ' · mode=' + track.mode);
    marineDebug.setMeta({ tracks: trackBuffers.length });
    const collect = () => {
      const list = track.cues;          // 跨域轨道时可能为 null
      if (!list) { if (!buf.logged) marineLog('warn', 'iso', '轨道「' + buf.label + '」无 cues（可能跨域受限）'); return; }
      for (const c of list) {
        const text = marineStripTags(c.text);
        if (text) buf.cuesMap.set(c.id || (c.startTime + '|' + text), { start: c.startTime, end: c.endTime, text });
      }
      if (buf.cuesMap.size > buf.logged) {
        buf.logged = buf.cuesMap.size;
        marineLog('track', 'iso', '轨道「' + buf.label + '」已加载 ' + buf.cuesMap.size + ' 条 cue');
        marineRimeContextDataChanged();
      }
    };
    track.addEventListener('cuechange', collect);
    setTimeout(collect, 600);
    setTimeout(collect, 2000);
  }
  // 一个 <video> 都没有的页面（GitHub / Gmail 之类）上，这个 observer 此前仍会在
  // 每一批 DOM 变更里跑一次全文档 querySelectorAll('video')——React SPA 上每秒
  // 几十次，全是空转。改用一个 live HTMLCollection：没有视频时读 length 近乎零
  // 成本，有视频时也比重新全文档查询便宜。再合一次帧，同一批变更只处理一次。
  const marineVideoNodes = document.getElementsByTagName('video');
  let marineHookVideosScheduled = false;

  function hookVideos() {
    for (let i = 0; i < marineVideoNodes.length; i++) {
      const v = marineVideoNodes[i];
      if (v.__marineHooked) continue;
      v.__marineHooked = true;
      const tt = v.textTracks;
      if (!tt) continue;
      for (let j = 0; j < tt.length; j++) wireTrack(tt[j]);
      if (tt.addEventListener) tt.addEventListener('addtrack', ev => wireTrack(ev.track));
    }
  }
  function scheduleHookVideos() {
    if (marineHookVideosScheduled || !marineVideoNodes.length) return;
    marineHookVideosScheduled = true;
    setTimeout(function () { marineHookVideosScheduled = false; hookVideos(); }, 0);
  }
  hookVideos();
  new MutationObserver(scheduleHookVideos).observe(document.documentElement, { childList: true, subtree: true });

  function trackSources() {
    return trackBuffers.map(b => ({ id: b.id, kind: 'texttrack', label: b.label + (b.lang ? '（' + b.lang + '）' : ''), count: b.cuesMap.size }))
      .filter(s => s.count > 0);
  }

  // ---- 取某个来源的 cues ----
  function cuesFromSource(id) {
    if (id && id.indexOf('cap_') === 0) {
      const c = captured.find(x => x.id === id);
      return c ? marineParseAuto(c.body, c.url) : [];
    }
    if (id && id.indexOf('trk_') === 0) {
      const b = trackBuffers.find(x => x.id === id);
      return b ? Array.from(b.cuesMap.values()) : [];
    }
    return [];
  }

  // ---- 把推荐回复填入目标评论的回复框（只填草稿，不点击发送）----
  function marineCssEscape(s) {
    try { return CSS.escape(String(s)); } catch (e) { return String(s).replace(/["\\]/g, '\\$&'); }
  }
  function marineTextOf(el) {
    try { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
    catch (e) { return ''; }
  }
  function marineVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return false; }
  }
  function marineComposedParent(el) {
    if (!el) return null;
    const p = el.parentElement || el.parentNode;
    if (p && p.nodeType === 11 && p.host) return p.host;
    return p && p.nodeType === 1 ? p : null;
  }
  function marineAllElements(root) {
    return marineCollectShadow(root || document, [], { n: 0, max: 60000 });
  }
  function marineCommentSearchRoot() {
    const adapter = marineRimeSiteAdapter();
    if (adapter && typeof adapter.commentSearchRoot === 'function') {
      try {
        const root = adapter.commentSearchRoot(document);
        if (root) return root;
      } catch (e) {}
    }
    return document.querySelector('bili-comments, #commentapp, .comment-container, .comment-list, .reply-warp, .Comments-container, .CommentListV2, .Question-main, .ListShortcut, .comments-el, .comments-container, .note-scroller') || document;
  }
  function marineParseReplyTarget(target) {
    const s = String(target || '').replace(/^回复\s*@?\s*/, '').trim();
    const author = ((s.match(/^@?([^（(「"“：:]+)/) || [])[1] || '').trim();
    const quoted = (s.match(/[「"“](.+?)[」"”]/) || [])[1] || '';
    return { author, snippet: quoted.replace(/\s+/g, ' ').trim() };
  }
  function marineContainsTarget(el, target) {
    const txt = marineTextOf(el);
    if (!txt || txt.length > 4000) return false;
    if (target.authorName && txt.indexOf(target.authorName) < 0) return false;
    const sn = marineCommentSnippet(target.text || target.snippet || '', 28);
    if (sn && txt.indexOf(sn) < 0) return false;
    return true;
  }
  function marineFindReplyButton(root) {
    let cur = root;
    for (let i = 0; cur && i < 8; i++, cur = marineComposedParent(cur)) {
      const els = [cur].concat(marineAllElements(cur));
      const btn = els.find(el => {
        const txt = marineTextOf(el);
        return el.matches && el.matches('button,a,[role="button"],.reply,.reply-btn,.sub-reply,.Button') &&
          /^回复$|回复|^评论$|^添加评论$|写评论/.test(txt) && txt.length <= 12 && marineVisible(el);
      });
      if (btn) return btn;
    }
    return null;
  }
  function marineFindCommentElement(target) {
    const root = marineCommentSearchRoot();
    const all = marineAllElements(root);
    const id = String(target.id || '').trim();
    if (id) {
      const sel = [
        '[data-id="' + marineCssEscape(id) + '"]',
        '[data-rpid="' + marineCssEscape(id) + '"]',
        '[data-reply-id="' + marineCssEscape(id) + '"]',
        '[reply-id="' + marineCssEscape(id) + '"]',
        '[rpid="' + marineCssEscape(id) + '"]',
      ].join(',');
      try {
        const direct = (root.querySelector && root.querySelector(sel)) || document.querySelector(sel);
        if (direct) return direct;
      } catch (e) {}
      const byAttr = all.filter(el => {
        try {
          for (const a of Array.from(el.attributes || [])) {
            const name = a.name.toLowerCase();
            if (/(^|[-_:])(id|rpid|reply)([-_:]|$)/.test(name) && String(a.value) === id) return true;
          }
        } catch (e) {}
        return false;
      });
      if (byAttr.length) return byAttr[0];
    }
    const parsed = marineParseReplyTarget(target.label || '');
    const fallback = {
      authorName: target.authorName || parsed.author,
      text: target.text || parsed.snippet,
      snippet: target.snippet || parsed.snippet,
    };
    const matches = all.filter(el => marineContainsTarget(el, fallback));
    matches.sort((a, b) => marineTextOf(a).length - marineTextOf(b).length);
    return matches[0] || null;
  }
  function marineIsEditor(el) {
    if (!el || !marineVisible(el)) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return !el.disabled && !el.readOnly;
    if (tag === 'input') return /^(text|search)?$/.test(el.type || 'text') && !el.disabled && !el.readOnly;
    return el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === 'plaintext-only';
  }
  function marineDeepActiveElement(root) {
    let a = (root || document).activeElement;
    let shadow = a && marineShadowRootOf(a);
    while (shadow && shadow.activeElement) {
      a = shadow.activeElement;
      shadow = marineShadowRootOf(a);
    }
    return a;
  }
  function marineSetEditorText(el, text) {
    try { el.focus(); } catch (e) {}
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    } else {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      } catch (e) {}
      if (marineTextOf(el).indexOf(marineCommentSnippet(text, 12)) < 0) el.textContent = text;
    }
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); } catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function marineComposedContains(root, el) {
    for (let cur = el; cur; cur = marineComposedParent(cur)) {
      if (cur === root) return true;
    }
    return false;
  }
  function marineClickElement(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    try { el.click(); return; } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
  }
  function marineFindEditor(commentEl) {
    const scopes = [];
    for (let cur = commentEl, i = 0; cur && i < 4; i++, cur = marineComposedParent(cur)) scopes.push(cur);
    const active = marineDeepActiveElement(document);
    if (marineIsEditor(active) && scopes.some(r => marineComposedContains(r, active))) return active;
    for (const r of scopes) {
      const found = marineAllElements(r).filter(marineIsEditor);
      if (found.length) return found[found.length - 1];
    }
    let commentRect = null;
    try { commentRect = commentEl && commentEl.getBoundingClientRect(); } catch (e) {}
    const nearby = marineAllElements(document).filter(el => {
      if (!marineIsEditor(el)) return false;
      if (!commentRect) return true;
      try {
        const r = el.getBoundingClientRect();
        return r.top >= commentRect.top - 12 && r.top <= commentRect.bottom + 320;
      } catch (e) { return false; }
    });
    if (nearby.length) return nearby[nearby.length - 1];
    return null;
  }
  async function marineInjectReplyDraft(opts) {
    opts = opts || {};
    const target = {
      id: opts.targetId || (opts.target && opts.target.id) || '',
      authorName: opts.target && opts.target.authorName,
      text: opts.target && opts.target.text,
      snippet: opts.target && opts.target.snippet,
      label: opts.targetLabel || opts.targetRaw || '',
    };
    const replyText = String(opts.text || '').trim();
    if (!replyText) return { ok: false, error: '回复内容为空' };

    const commentEl = marineFindCommentElement(target);
    if (!commentEl) return { ok: false, error: '找不到目标评论，请先加载/滚动到这条评论附近' };
    try { commentEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    await marineSleep(250);

    const replyBtn = marineFindReplyButton(commentEl);
    if (!replyBtn) return { ok: false, error: '找到了评论，但没找到“回复”按钮' };
    marineClickElement(replyBtn);

    let editor = null;
    for (let i = 0; i < 12 && !editor; i++) {
      await marineSleep(180);
      editor = marineFindEditor(commentEl);
    }
    if (!editor) return { ok: false, error: '已点开回复，但没找到输入框' };
    marineSetEditorText(editor, replyText);
    marineLog('ok', 'iso', '已填入回复草稿：' + (target.id || target.authorName || '目标评论'));
    return { ok: true };
  }

  // ---- Rime 动作插件：当前评论投放目标 ----
  // 目标由用户对编辑器/“回复”按钮的交互驱动；不扫描轮询 DOM，也不点击发布。
  function marineRimeSiteAdapter(platform) {
    const registry = globalThis.MarineCommentTargetAdapters;
    if (!registry || typeof registry.get !== 'function') return null;
    try { return registry.get(platform || detectPlatform()) || null; }
    catch (e) { return null; }
  }

  function marineRimeAdapterSupportsPage(adapter) {
    if (!adapter || typeof adapter.supportsPage !== 'function') {
      return detectPlatform() === 'bilibili' && /\/video\//.test(location.pathname);
    }
    try { return adapter.supportsPage(location) === true; }
    catch (e) { return false; }
  }

  function marineRimePublicDirectScope(scope) {
    if (!scope || !String(scope.id || '').trim() || !String(scope.kind || '').trim()) return null;
    return {
      id: String(scope.id).trim(),
      kind: String(scope.kind).trim(),
      title: String(scope.title || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      authorName: String(scope.authorName || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  }

  function marineRimeDirectScopeForEditor(editor) {
    const adapter = marineRimeSiteAdapter();
    if (!adapter || typeof adapter.directScopeForEditor !== 'function') return null;
    try {
      const resolved = adapter.directScopeForEditor(
        editor,
        marineRimeTarget.directScope,
        location,
        document,
      );
      if (!marineRimePublicDirectScope(resolved)) return null;
      return resolved;
    } catch (e) { return null; }
  }

  function marineRimeTheme() {
    const adapter = marineRimeSiteAdapter();
    const value = adapter && adapter.theme || {};
    return {
      accent: value.accent || 'rgb(0, 174, 236)',
      soft: value.soft || 'rgba(0, 174, 236, .055)',
      ring: value.ring || 'rgba(0, 174, 236, .18)',
      badge: value.badge || 'rgb(0, 132, 180)',
      directLabel: value.directLabel || 'Marine \u00b7 \u76f4\u8bc4',
      replyLabel: value.replyLabel || 'Marine \u00b7 \u56de\u590d',
    };
  }

  function marineRimeNewSourceId() {
    try { return crypto.randomUUID(); }
    catch (e) { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  }

  const marineRimeTarget = {
    active: null,
    revision: 0,
    activationSerial: 0,
    sourceId: marineRimeNewSourceId(),
    directScope: null,
    pendingReply: null,
    pendingReplyTimer: null,
    replyBindings: new WeakMap(),
    blurTimer: null,
    positionFrame: 0,
    // 上一帧是否真的画了东西：用来在「无目标且无在途生成」时停掉 rAF 空转，
    // 同时保证从「有」变「无」的那一帧仍会跑一次去收起覆盖层。
    painted: false,
    badgeLabel: '',
    badgeWidth: 0,
    refreshTimer: null,
    overlay: null,
    grabCache: null,
    pageUrl: location.href,
    navigationRearmRequired: false,
    navigationEventCutoff: 0,
    lifecycleObserver: null,
    lifecycleTimer: null,
    diagnosticSequence: 0,
    diagnosticLastAt: new Map(),
  };
  let marineRimeSendQueue = Promise.resolve();

  function marineRimeReleaseDirectScope(reason, clearActive) {
    const scope = marineRimeTarget.directScope;
    if (scope) {
      scope.invalidated = true;
      try { if (scope.modalObserver) scope.modalObserver.disconnect(); } catch (e) {}
    }
    marineRimeTarget.directScope = null;
    marineRimeTarget.grabCache = null;
    if (clearActive) marineRimeClear(reason || 'direct-scope-released');
  }

  // BEGIN marine-rime-reliable-transport
  const MARINE_RIME_SEND_ATTEMPTS = 3;
  // service worker 的 ACK 要等它把整个 context PUT 到本地 API 才回，实测 0.4~1.7s
  // （debug 构建更慢）。超时过短会误判失败→重试，重试又可能撞上中间的 DELETE 墓碑
  // （后端对已撤销的 contextId 一律 409），导致目标永远发布不上去。
  const MARINE_RIME_SEND_ACK_TIMEOUT_MS = 6000;
  const MARINE_RIME_SEND_RETRY_DELAYS_MS = [60, 180];

  function marineRimeDelay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function marineRimeOperationIsCurrent(operation) {
    const active = marineRimeTarget.active;
    if (operation.op === 'put') {
      const revisionMatches = operation.leaseRenewal === true
        ? Number(active && active.publishedRevision) === operation.revision
        : marineRimeTarget.revision === operation.revision;
      return marineRimeTarget.sourceId === operation.sourceId &&
        revisionMatches &&
        !!active && active.contextId === operation.contextId;
    }
    // Context IDs are unique per focus lease. A delayed DELETE may still
    // safely revoke its own old lease, but must never delete a context that
    // has somehow become active again.
    return !active || active.contextId !== operation.contextId;
  }

  async function marineRimeSendOnce(message) {
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(function () { return chrome.runtime.sendMessage(message); }),
        new Promise(function (_, reject) {
          timeout = setTimeout(function () {
            reject(new Error('Marine Rime ACK timed out'));
          }, MARINE_RIME_SEND_ACK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function marineRimeDeliver(operation) {
    const message = {
      __marineRimeContext: true,
      op: operation.op,
      contextId: operation.contextId,
      context: operation.context,
      revision: operation.revision,
      sourceId: operation.sourceId,
      retainWhenUnfocused: operation.retainWhenUnfocused === true,
      leaseRenewal: operation.leaseRenewal === true,
    };
    let lastError = null;
    for (let attempt = 0; attempt < MARINE_RIME_SEND_ATTEMPTS; attempt++) {
      if (!marineRimeOperationIsCurrent(operation)) {
        return { ok: true, applied: false, stale: true };
      }
      try {
        const response = await marineRimeSendOnce(message);
        if (!marineRimeOperationIsCurrent(operation)) {
          return { ok: true, applied: false, stale: true };
        }
        if (response && response.ok === true) {
          if (!response.skipped) return { ok: true, applied: true, response };
          if (!response.deferred) return { ok: true, applied: false, skipped: true, response };
          lastError = new Error('Marine Rime context deferred');
        } else {
          lastError = new Error(response && response.error || 'Marine Rime 未收到有效 ACK');
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < MARINE_RIME_SEND_ATTEMPTS) {
        await marineRimeDelay(MARINE_RIME_SEND_RETRY_DELAYS_MS[attempt]);
      }
    }
    const detail = String(lastError && lastError.message || lastError || '未知错误');
    marineLog('warn', 'rime-target', operation.op + ' 失败：' + detail);
    return { ok: false, applied: false, error: detail };
  }
  // END marine-rime-reliable-transport

  function marineRimeHash(value) {
    let h = 2166136261;
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function marineRimePageKey() {
    return location.origin + location.pathname + location.search;
  }

  function marineRimeElementKey(element) {
    const parts = [];
    for (let el = element, depth = 0; el && depth < 10; el = marineComposedParent(el), depth++) {
      const parent = marineComposedParent(el);
      let index = 0;
      if (parent && parent.children) index = Array.prototype.indexOf.call(parent.children, el);
      parts.push((el.tagName || '').toLowerCase() + ':' + Math.max(0, index));
    }
    return parts.join('/');
  }

  function marineRimeSemanticKey(mode, target, editor, directScope) {
    const targetText = [(target && target.authorName) || '', (target && target.snippet) || ''].filter(Boolean).join('|');
    const scope = marineRimePublicDirectScope(directScope);
    const targetKey = mode === 'direct'
      ? ('direct|' + (scope ? scope.kind + '|' + scope.id : marineRimeElementKey(editor)))
      : ((target && target.id) || targetText || marineRimeElementKey(editor));
    return marineRimePageKey() + '|' + mode + '|' + targetKey;
  }

  function marineRimeContextId(info) {
    const semanticHash = marineRimeHash(info.semanticKey);
    const serial = ++marineRimeTarget.activationSerial;
    // Every focus lease is unique across tabs, documents, profiles, and later
    // re-focuses of the same editor. Conditional DELETE can therefore never
    // revoke another browser instance's otherwise identical target.
    return 'marine:' + detectPlatform() + ':' + semanticHash + ':' + marineRimeTarget.sourceId + ':' + serial.toString(36);
  }

  function marineRimeEventPath(event) {
    try { return event.composedPath().filter(function (el) { return el && el.nodeType === 1; }); }
    catch (e) { return event.target && event.target.nodeType === 1 ? [event.target] : []; }
  }

  // Retained diagnostics for real-page target binding.  Keep this deliberately
  // structural: tag/class, the author already visible in the reply label, and
  // aggregate counters only. Never place comment bodies, URLs, element IDs,
  // runtime credentials, or draft text in a rime-diag event.
  function marineRimeDiagnosticShape(el) {
    if (!el || !el.tagName) return { tag: '', cls: '' };
    let rawClass = '';
    try {
      rawClass = typeof el.className === 'string'
        ? el.className
        : String(el.className && el.className.baseVal || '');
    } catch (e) {}
    const cls = rawClass.split(/\s+/).filter(function (token) {
      return /^[A-Za-z0-9_-]{1,64}$/.test(token);
    }).slice(0, 6).join('.');
    return {
      tag: String(el.tagName || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64),
      cls,
    };
  }

  function marineRimeDiagnosticChain(el, max) {
    const result = [];
    for (let current = el, i = 0; current && i < (max || 8); current = marineComposedParent(current), i++) {
      const shape = marineRimeDiagnosticShape(current);
      if (shape.tag) result.push(shape);
    }
    return result;
  }

  function marineRimeDiagnosticAuthor(value) {
    return marineRimeNormalizeCommentIdentity(String(value || ''))
      .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 48);
  }

  function marineRimeDiagnostic(stage, data, throttleKey) {
    const now = Date.now();
    const key = stage + '|' + String(throttleKey || '');
    const previous = marineRimeTarget.diagnosticLastAt.get(key) || 0;
    if (throttleKey && now - previous < 700) return;
    marineRimeTarget.diagnosticLastAt.set(key, now);
    if (marineRimeTarget.diagnosticLastAt.size > 120) marineRimeTarget.diagnosticLastAt.clear();
    marineLog('debug', 'rime-diag', stage, Object.assign({
      seq: ++marineRimeTarget.diagnosticSequence,
    }, data || {}));
  }

  function marineRimeEditorFromEvent(event) {
    const path = event ? marineRimeEventPath(event) : [];
    for (const el of path) if (marineIsEditor(el)) return el;
    const active = marineDeepActiveElement(document);
    return marineIsEditor(active) ? active : null;
  }

  function marineRimeAttr(el, names) {
    for (const name of names) {
      try {
        const value = el.getAttribute(name);
        if (value != null && String(value).trim()) return String(value).trim();
      } catch (e) {}
    }
    return '';
  }

  function marineRimeIsCommentBoundary(el) {
    if (!el || !el.tagName) return false;
    const adapter = marineRimeSiteAdapter();
    if (adapter && typeof adapter.isCommentBoundary === 'function') {
      try { if (adapter.isCommentBoundary(el)) return true; }
      catch (e) {}
    }
    const tag = el.tagName.toLowerCase();
    if (/^bili-comment-(?:reply-)?renderer$/.test(tag) || tag === 'bili-comment-card') return true;
    const cls = String(el.className && typeof el.className === 'string' ? el.className : '');
    if (/(^|\s)(root-reply(?:-container)?|sub-reply-item|reply-item|comment-item|comment-renderer|comment-card)(\s|$)/i.test(cls)) return true;
    return false;
  }

  function marineRimeCommentContainer(startOrPath) {
    const path = Array.isArray(startOrPath) ? startOrPath : [];
    if (path.length) {
      for (const el of path) if (marineRimeIsCommentBoundary(el)) return el;
      return null;
    }
    for (let el = startOrPath, i = 0; el && i < 18; el = marineComposedParent(el), i++) {
      if (marineRimeIsCommentBoundary(el)) return el;
    }
    return null;
  }

  function marineRimeBoundaryOwner(el) {
    for (let current = el, i = 0; current && i < 24; current = marineComposedParent(current), i++) {
      if (marineRimeIsCommentBoundary(current)) return current;
    }
    return null;
  }

  function marineRimeOwnedCommentElements(commentEl, max) {
    return marineCollectShadow(commentEl, [], { n: 0, max: max || 4000 }).filter(function (el) {
      return marineRimeBoundaryOwner(el) === commentEl;
    });
  }

  function marineRimeCommentId(commentEl) {
    if (!commentEl) return '';
    const adapter = marineRimeSiteAdapter();
    if (adapter && typeof adapter.commentId === 'function') {
      try {
        const siteId = String(adapter.commentId(commentEl) || '').trim();
        if (siteId) return siteId;
      } catch (e) {}
    }
    const values = new Set();
    const addValue = function (value) {
      if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value > 0) values.add(String(value));
        return;
      }
      if (typeof value !== 'string') return;
      const normalized = value.trim();
      if (/^[1-9]\d*$/.test(normalized)) values.add(normalized);
    };
    const addAttrs = function (el) {
      for (const name of ['data-rpid', 'data-reply-id', 'reply-id', 'rpid']) {
        try { addValue(el.getAttribute(name)); } catch (e) {}
      }
    };
    addAttrs(commentEl);
    const els = marineRimeOwnedCommentElements(commentEl, 3000);
    for (const el of els) {
      // Closed Shadow DOM may hold the rpid on an internal element. Accept it
      // only when that element is owned by this exact comment renderer; never
      // inherit an ID from a nested reply/comment descendant.
      addAttrs(el);
    }
    // Current Bilibili renderers sometimes keep rpid only in the component's
    // backing record. Traverse only a bounded whitelist of record containers;
    // never enumerate arbitrary properties or read generic `id`, `root`, etc.
    const containers = ['data', 'reply', 'comment', 'item', '_data', '__data'];
    const records = [{ value: commentEl, depth: 0 }];
    const seenRecords = new Set();
    for (let index = 0; index < records.length && index < 20; index++) {
      const record = records[index].value;
      const depth = records[index].depth;
      if (!record || (typeof record !== 'object' && typeof record !== 'function') || seenRecords.has(record)) continue;
      seenRecords.add(record);
      for (const name of ['rpid_str', 'rpid', 'reply_id_str', 'reply_id', 'replyId']) {
        try { addValue(record[name]); } catch (e) {}
      }
      if (depth >= 2) continue;
      for (const name of containers) {
        try {
          const nested = record[name];
          if (nested && (typeof nested === 'object' || typeof nested === 'function')) {
            records.push({ value: nested, depth: depth + 1 });
          }
        } catch (e) {}
      }
    }
    return values.size === 1 ? values.values().next().value : '';
  }

  // 一趟目标解析是同步完成的，期间页面 DOM 不会变化，因此整趟可以共享三样东西：
  // 每个 boundary 的身份、渲染边界清单、以及从捕获记录重建出的已知目标。
  // 此前每个 boundary 的身份要被重算两遍（renderedIdentityCount 一次、
  // containedRenderedOwnership 一次），而 resolveOpenReplyEditor 又对每个候选
  // 重跑一整个 domTarget —— 合起来是 O(B²)，一个 150 楼的评论区点一下要几百毫秒。
  // 可重入：嵌套调用复用最外层的 pass，最外层负责建立和拆除。
  let marineRimePass = null;

  function marineRimeWithPass(fn) {
    if (marineRimePass) return fn();
    marineRimePass = { identities: new WeakMap(), inventory: null, known: null };
    try { return fn(); }
    finally { marineRimePass = null; }
  }

  function marineRimeKnownTargets() {
    if (marineRimePass && marineRimePass.known) return marineRimePass.known;
    let known;
    try {
      const built = marineBuildComments(detectPlatform(), commentCaptures);
      known = built && built.ok ? marineFlattenComments(built.comments) : [];
    } catch (e) { known = []; }
    if (marineRimePass) marineRimePass.known = known;
    return known;
  }

  function marineRimeSmallText(el) {
    const text = marineTextOf(el);
    return text && text.length <= 600 ? text : '';
  }

  // Bilibili's current comment renderer keeps the visible body inside nested
  // closed Shadow DOM. `innerText`/`textContent` on the outer renderer is then
  // empty even though chrome.dom can expose the rendered shadow tree to this
  // extension. Walk that composed tree with hard node/byte limits and stop at
  // nested comment boundaries. The result is matching evidence only: reply
  // payloads still use the captured API record's exact id/author/text.
  function marineRimeComposedEvidenceText(root, commentEl) {
    if (!root || !commentEl) return '';
    const seen = new Set();
    const parts = [];
    let nodeCount = 0;
    let charCount = 0;
    let overflow = false;
    const maxNodes = 6000;
    const maxChars = 24000;
    const append = function (value) {
      const raw = String(value || '');
      if (!raw) return;
      charCount += raw.length;
      if (charCount > maxChars) { overflow = true; return; }
      parts.push(raw);
    };
    const separatesBlock = function (el, tag) {
      if (/^(?:address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|menu|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/.test(tag)) {
        return true;
      }
      // Custom comment/rich-text components are frequently block-level even
      // though their tag has no native display semantics. Consult computed
      // style only for those components, avoiding a layout query per node.
      if (tag.indexOf('-') < 0) return false;
      try {
        return /^(?:block|flow-root|flex|grid|list-item|table(?:-.+)?)$/.test(getComputedStyle(el).display);
      } catch (e) { return false; }
    };
    const visit = function (node) {
      if (!node || overflow || seen.has(node)) return;
      seen.add(node);
      nodeCount++;
      if (nodeCount > maxNodes) { overflow = true; return; }
      if (node.nodeType === 3) {
        append(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        const el = node;
        if (el !== commentEl && marineRimeIsCommentBoundary(el)) return;
        if (el !== root && marineRimeBoundaryOwner(el) !== commentEl) return;
        const tag = String(el.tagName || '').toLowerCase();
        if (/^(?:style|script|template|noscript)$/.test(tag) || marineIsEditor(el)) return;
        const block = separatesBlock(el, tag);
        if (block) append(' ');
        if (tag === 'br') append('\n');
        if (tag === 'img') append(marineRimeAttr(el, ['alt', 'aria-label']));
        if (tag === 'slot') {
          let assigned = [];
          try { assigned = el.assignedNodes({ flatten: true }) || []; } catch (e) {}
          if (assigned.length) {
            for (const child of assigned) visit(child);
            if (block) append(' ');
            return;
          }
        }
        const shadow = marineShadowRootOf(el);
        if (shadow) {
          visit(shadow);
          if (block) append(' ');
          return;
        }
        let children = [];
        try { children = Array.from(node.childNodes || []); } catch (e) {}
        for (const child of children) visit(child);
        if (block) append(' ');
        return;
      }
      let children = [];
      try { children = Array.from(node.childNodes || []); } catch (e) {}
      for (const child of children) visit(child);
    };
    visit(root);
    return overflow ? '' : marineRimeNormalizeCommentIdentity(parts.join(''));
  }

  function marineRimeDomIdentity(commentEl) {
    if (!commentEl) return { authorName: '', text: '', confidentText: false };
    const memo = marineRimePass && marineRimePass.identities;
    if (memo) {
      const cached = memo.get(commentEl);
      if (cached) return cached;
    }
    const identity = marineRimeComputeDomIdentity(commentEl);
    if (memo) memo.set(commentEl, identity);
    return identity;
  }

  function marineRimeComputeDomIdentity(commentEl) {
    const adapter = marineRimeSiteAdapter();
    if (adapter && typeof adapter.domIdentity === 'function') {
      try {
        const siteIdentity = adapter.domIdentity(commentEl);
        if (siteIdentity && (siteIdentity.authorName || siteIdentity.text || siteIdentity.wholeText)) {
          const siteText = marineRimeNormalizeCommentIdentity(siteIdentity.text);
          return {
            authorName: marineRimeNormalizeCommentIdentity(siteIdentity.authorName),
            text: siteText,
            wholeText: marineRimeNormalizeCommentIdentity(siteIdentity.wholeText || siteText),
            confidentText: siteIdentity.confidentText !== false && !!siteText,
          };
        }
      } catch (e) {}
    }
    const directWholeText = marineTextOf(commentEl);
    const composedWholeText = marineRimeComposedEvidenceText(commentEl, commentEl);
    const wholeText = composedWholeText.length > directWholeText.length ? composedWholeText : directWholeText;
    const els = marineRimeOwnedCommentElements(commentEl, 4000);
    const authorSelectors = /(^|[\s_-])(user-name|sub-user-name|nickname|author|name)([\s_-]|$)/i;
    const authorCandidates = [];
    for (const el of els) {
      let cls = '';
      try { cls = String(el.className && typeof el.className === 'string' ? el.className : ''); } catch (e) {}
      const href = marineRimeAttr(el, ['href']);
      if (!authorSelectors.test(cls) && href.indexOf('space.bilibili.com') < 0 && marineRimeAttr(el, ['id']) !== 'user-name') continue;
      const value = marineRimeSmallText(el) || marineRimeAttr(el, ['title', 'data-user-name']);
      if (value && value.length <= 80 && !/^(\u56de\u590d|\u4e3e\u62a5|\u70b9\u8d5e)/.test(value)) authorCandidates.push(value);
    }
    authorCandidates.sort(function (a, b) { return a.length - b.length; });
    const authorName = authorCandidates[0] || '';
    const textCandidates = [];
    const contentSelectors = /(^|[\s_-])(reply-content|sub-reply-content|comment-content|message|content|rich-text)([\s_-]|$)/i;
    for (const el of els) {
      if (el === commentEl) continue;
      let cls = '';
      try { cls = String(el.className && typeof el.className === 'string' ? el.className : ''); } catch (e) {}
      const tag = String(el.tagName || '').toLowerCase();
      if (!contentSelectors.test(cls) && marineRimeAttr(el, ['id']) !== 'content' &&
          !/^bili-(?:comment-)?rich-text$/.test(tag)) continue;
      const value = marineRimeSmallText(el);
      if (value && value !== authorName && !/^(\u56de\u590d|\u4e3e\u62a5|\u5206\u4eab)$/.test(value)) textCandidates.push(value);
    }
    textCandidates.sort(function (a, b) { return a.length - b.length; });
    const exactText = textCandidates[0] || '';
    return {
      authorName,
      text: exactText,
      // wholeText is transient matching evidence only. Keep it complete so a
      // later same-author candidate cannot hide beyond a truncation boundary;
      // it is never logged or copied into a target/prompt.
      wholeText,
      confidentText: !!exactText,
    };
  }

  function marineRimeRenderedCommentInventory() {
    if (marineRimePass && marineRimePass.inventory) return marineRimePass.inventory;
    const inventory = marineRimeComputeRenderedCommentInventory();
    if (marineRimePass) marineRimePass.inventory = inventory;
    return inventory;
  }

  function marineRimeComputeRenderedCommentInventory() {
    const root = marineCommentSearchRoot();
    const all = marineCollectShadow(root, [], { n: 0, max: 20000 });
    const renderers = all.filter(function (el) {
      const tag = String(el && el.tagName || '').toLowerCase();
      return /^bili-comment-(?:reply-)?renderer$/.test(tag);
    });
    const recognized = all.filter(marineRimeIsCommentBoundary);
    // A live page can mix Web Components with class-based renderers during a
    // rollout. Keep the union; choosing one family would make uniqueness
    // checks silently ignore the other.
    const boundaries = Array.from(new Set(recognized.concat(renderers)));
    const seen = new Set();
    return {
      all,
      rendererCount: renderers.length,
      recognizedCount: recognized.length,
      boundaries: boundaries.filter(function (boundary) {
        if (seen.has(boundary)) return false;
        seen.add(boundary);
        return true;
      }),
    };
  }

  function marineRimeRenderedCommentBoundaries() {
    return marineRimeRenderedCommentInventory().boundaries;
  }

  function marineRimeRenderedIdentityCount(identity) {
    const boundaries = marineRimeRenderedCommentBoundaries();
    const seen = new Set();
    let count = 0;
    for (const boundary of boundaries) {
      if (seen.has(boundary)) continue;
      seen.add(boundary);
      const candidate = marineRimeDomIdentity(boundary);
      if (marineRimeNormalizeCommentIdentity(candidate.authorName) !== marineRimeNormalizeCommentIdentity(identity.authorName)) continue;
      if (marineRimeNormalizeCommentIdentity(candidate.text) !== marineRimeNormalizeCommentIdentity(identity.text)) continue;
      count++;
      if (count > 1) break;
    }
    return count;
  }

  function marineRimeContainedRenderedOwnership(commentEl, target, expectedAuthor) {
    const targetAuthor = marineRimeNormalizeCommentIdentity(
      (target && target.authorName) || expectedAuthor,
    );
    const targetText = marineRimeNormalizeCommentIdentity(target && target.text);
    if (!commentEl || !targetAuthor || !targetText) return { count: 0, ownsClicked: false };
    const boundaries = marineRimeRenderedCommentBoundaries().concat(commentEl);
    const seen = new Set();
    const matches = [];
    for (const boundary of boundaries) {
      if (!boundary || seen.has(boundary) || !boundary.isConnected) continue;
      seen.add(boundary);
      const candidate = marineRimeDomIdentity(boundary);
      const candidateAuthor = marineRimeNormalizeCommentIdentity(
        candidate.authorName || (boundary === commentEl ? expectedAuthor : ''),
      );
      if (candidateAuthor !== targetAuthor) continue;
      if (marineRimeNormalizeCommentIdentity(candidate.wholeText).indexOf(targetText) < 0) continue;
      matches.push(boundary);
    }
    return { count: matches.length, ownsClicked: matches.length === 1 && matches[0] === commentEl };
  }

  function marineRimeDomTarget(commentEl, expectedAuthor) {
    return marineRimeWithPass(function () {
      return marineRimeResolveDomTarget(commentEl, expectedAuthor);
    });
  }

  function marineRimeResolveDomTarget(commentEl, expectedAuthor) {
    if (!commentEl) return { id: '', authorName: '', text: '', snippet: '', parentId: '', rootId: '' };
    const id = marineRimeCommentId(commentEl);
    const known = marineRimeKnownTargets();
    const rawIdentity = marineRimeDomIdentity(commentEl);
    const identity = Object.assign({}, rawIdentity, {
      authorName: rawIdentity.authorName || marineRimeNormalizeCommentIdentity(expectedAuthor),
    });
    const containment = marineRimeResolveContainedCapturedTarget(known, identity);
    const containedOwnership = !id && !identity.confidentText && containment.target
      ? marineRimeContainedRenderedOwnership(commentEl, containment.target, expectedAuthor)
      : { count: 0, ownsClicked: false };
    const diagnostic = function (resolution) {
      marineRimeDiagnostic('target-resolution', {
        resolution,
        boundary: marineRimeDiagnosticShape(commentEl),
        labelAuthor: marineRimeDiagnosticAuthor(expectedAuthor),
        identityAuthor: marineRimeDiagnosticAuthor(identity.authorName),
        identityTextLength: marineRimeNormalizeCommentIdentity(identity.text).length,
        wholeTextLength: marineRimeNormalizeCommentIdentity(identity.wholeText).length,
        confidentText: !!identity.confidentText,
        hasDomRpid: !!id,
        knownCount: known.length,
        knownSameAuthorCount: containment.sameAuthorCount,
        containedMatchCount: containment.containedMatchCount,
        renderedContainedMatchCount: containedOwnership.count,
        containedOwnsClicked: containedOwnership.ownsClicked,
      }, resolution + '|' + marineRimeDiagnosticAuthor(identity.authorName) + '|' + marineRimeDiagnosticShape(commentEl).tag);
    };

    let target = id ? known.find(function (item) { return String(item.id) === String(id); }) : null;
    if (target) {
      diagnostic('dom-rpid-captured');
      return Object.assign({}, target, { snippet: marineCommentSnippet(target.text, 80) });
    }

    const renderedMatchCount = marineRimeRenderedIdentityCount(identity);
    target = marineRimeResolveExactCapturedTarget(
      known,
      identity,
      renderedMatchCount,
    );
    if (target) {
      diagnostic('exact-captured');
      return Object.assign({}, target, { snippet: marineCommentSnippet(target.text, 80) });
    }

    // When the renderer has no dedicated content node, its whole accessible
    // text includes author/actions (and sometimes nested replies). Use it only
    // as evidence to select one unique captured comment by the same author.
    // Returning the captured record is essential: it keeps the prompt's target
    // body exact instead of leaking the entire rendered thread into target.text.
    if (!id && !identity.confidentText && containment.target && containedOwnership.ownsClicked) {
      diagnostic('contained-captured');
      return Object.assign({}, containment.target, {
        snippet: marineCommentSnippet(containment.target.text, 80),
      });
    }

    // The clicked renderer itself is an exact user-selected target. If its
    // API record is not captured (common for freshly inserted comments), keep
    // a deterministic page/element identity rather than disabling reply or
    // borrowing an id from a neighbouring floor.
    const stableDomId = !id && identity.confidentText
      ? marineRimeStableDomTargetId(marineRimePageKey(), identity, marineRimeElementKey(commentEl))
      : '';

    const safeText = identity.confidentText ? identity.text : '';
    diagnostic(stableDomId ? 'stable-dom' : (id ? 'dom-rpid-no-exact-text' : 'unresolved'));

    return {
      id: id || stableDomId,
      authorName: identity.authorName,
      text: safeText,
      snippet: marineCommentSnippet(safeText, 80),
      parentId: '',
      rootId: '',
    };
  }

  function marineRimeReplyControl(event) {
    const path = marineRimeEventPath(event);
    for (const el of path) {
      if (marineIsEditor(el)) return null;
      const text = marineTextOf(el);
      let cls = '';
      try { cls = String(el.className && typeof el.className === 'string' ? el.className : ''); } catch (e) {}
      const interactive = el.matches && el.matches('button,a,[role="button"]');
      if ((interactive || /(^|[-_\s])reply([-_\s]|$)/i.test(cls)) && /^\u56de\u590d(?:\s*\d+)?$/.test(text) && text.length <= 12) {
        return { element: el, path };
      }
    }
    return null;
  }

  function marineRimeEditorPlaceholder(editor) {
    const values = [];
    for (let el = editor, i = 0; el && i < 4; el = marineComposedParent(el), i++) {
      values.push(marineRimeAttr(el, ['placeholder', 'aria-label', 'data-placeholder']));
    }
    return values.filter(Boolean).join(' ');
  }

  // New Bilibili comment boxes render "回复 @作者 :" as a sibling label,
  // rather than as textarea placeholder/aria-label. Read only the smallest
  // composed container that owns exactly one visible editor so a label from a
  // different comment box cannot bleed in from the whole comment list.
  function marineRimeEditorContextLabel(editor) {
    const attributed = marineRimeEditorPlaceholder(editor);
    const adapter = marineRimeSiteAdapter();
    let siteLabel = '';
    if (adapter && typeof adapter.editorContextLabel === 'function') {
      try { siteLabel = String(adapter.editorContextLabel(editor) || '').trim(); }
      catch (e) {}
    }
    if (marineRimeIsReplyEditorPlaceholder(siteLabel)) {
      const siteAuthor = marineRimeReplyPlaceholderAuthor(siteLabel);
      marineRimeDiagnostic('editor-label', {
        source: 'site-adapter',
        labelAuthor: marineRimeDiagnosticAuthor(siteAuthor),
        editor: marineRimeDiagnosticShape(editor),
        chain: marineRimeDiagnosticChain(editor, 7),
      }, 'site|' + siteAuthor + '|' + marineRimeDiagnosticShape(editor).tag);
      return siteLabel;
    }
    if (marineRimeIsReplyEditorPlaceholder(attributed)) {
      const attributedAuthor = marineRimeReplyPlaceholderAuthor(attributed);
      marineRimeDiagnostic('editor-label', {
        source: 'attribute',
        labelAuthor: marineRimeDiagnosticAuthor(attributedAuthor),
        editor: marineRimeDiagnosticShape(editor),
        chain: marineRimeDiagnosticChain(editor, 7),
      }, 'attribute|' + attributedAuthor + '|' + marineRimeDiagnosticShape(editor).tag);
      return attributed;
    }
    const commentRoot = marineCommentSearchRoot();
    for (let scope = editor, depth = 0; scope && depth < 7; scope = marineComposedParent(scope), depth++) {
      const elements = marineCollectShadow(scope, [], { n: 0, max: 240 });
      const editors = elements.filter(marineIsEditor);
      if (editors.length === 1 && editors[0] === editor) {
        const labels = [];
        for (const el of elements) {
          if (el === editor || marineIsEditor(el)) continue;
          const text = marineTextOf(el);
          if (!text) continue;
          const match = text.slice(0, 160).match(/^\s*(\u56de\u590d\s*@?\s*[^\s：:]+\s*[：:]?)/);
          if (match) labels.push(match[1]);
        }
        const normalized = Array.from(new Set(labels.map(marineRimeNormalizeCommentIdentity)));
        if (normalized.length === 1) {
          const siblingAuthor = marineRimeReplyPlaceholderAuthor(normalized[0]);
          marineRimeDiagnostic('editor-label', {
            source: 'owned-container',
            labelAuthor: marineRimeDiagnosticAuthor(siblingAuthor),
            depth,
            editorCount: editors.length,
            labelCount: normalized.length,
            scope: marineRimeDiagnosticShape(scope),
            editor: marineRimeDiagnosticShape(editor),
            chain: marineRimeDiagnosticChain(editor, 7),
          }, 'owned|' + siblingAuthor + '|' + marineRimeDiagnosticShape(editor).tag);
          return normalized[0];
        }
        if (normalized.length > 1) {
          marineRimeDiagnostic('editor-label-ambiguous', {
            reason: 'multiple-owned-labels',
            labelAuthors: normalized.slice(0, 4).map(marineRimeReplyPlaceholderAuthor).map(marineRimeDiagnosticAuthor),
            depth,
            editorCount: editors.length,
            labelCount: normalized.length,
            scope: marineRimeDiagnosticShape(scope),
          }, 'ambiguous|' + marineRimeDiagnosticShape(editor).tag);
        }
      }
      if (scope === commentRoot) break;
    }
    return siteLabel || attributed;
  }

  function marineRimeIsReplyEditorPlaceholder(value) {
    return /^\s*\u56de\u590d(?:\s|@|$)/.test(String(value || ''));
  }

  function marineRimeClearPendingReply(reason) {
    if (marineRimeTarget.pendingReplyTimer) {
      clearTimeout(marineRimeTarget.pendingReplyTimer);
      marineRimeTarget.pendingReplyTimer = null;
    }
    if (!marineRimeTarget.pendingReply) return;
    marineRimeTarget.pendingReply = null;
    if (reason) marineLog('info', 'rime-target', '\u5df2\u6e05\u7406\u56de\u590d\u7f16\u8f91\u5668\u4ea4\u63a5\uff1a' + reason);
  }

  function marineRimeBeginReplyLease(commentEl) {
    marineRimeClearPendingReply('new-reply-click');
    const editorsBefore = new WeakSet();
    const editorPlaceholders = new WeakMap();
    for (const editor of marineAllElements(marineCommentSearchRoot()).filter(marineIsEditor)) {
      editorsBefore.add(editor);
      editorPlaceholders.set(editor, marineRimeEditorContextLabel(editor));
    }
    const target = marineRimeDomTarget(commentEl);
    const lease = {
      commentEl,
      target,
      authorName: target.authorName || '',
      pageKey: marineRimePageKey(),
      sourceId: marineRimeTarget.sourceId,
      editorsBefore,
      editorPlaceholders,
      expiresAt: Date.now() + MARINE_RIME_REPLY_HANDOFF_MS,
    };
    marineRimeTarget.pendingReply = lease;
    marineRimeDiagnostic('reply-lease', {
      boundary: marineRimeDiagnosticShape(commentEl),
      identityAuthor: marineRimeDiagnosticAuthor(target.authorName),
      targetHasId: !!String(target.id || '').trim(),
      targetHasExactText: !!String(target.text || '').trim(),
      editorCountBefore: marineAllElements(marineCommentSearchRoot()).filter(marineIsEditor).length,
    }, marineRimeDiagnosticShape(commentEl).tag + '|' + marineRimeDiagnosticAuthor(target.authorName));
    marineRimeTarget.pendingReplyTimer = setTimeout(function () {
      if (marineRimeTarget.pendingReply === lease) marineRimeClearPendingReply('handoff-expired');
    }, MARINE_RIME_REPLY_HANDOFF_MS + 20);
    return lease;
  }

  function marineRimePendingCanClaimEditor(pending, editor, now) {
    const placeholder = marineRimeEditorContextLabel(editor);
    const previousPlaceholder = pending.editorPlaceholders && pending.editorPlaceholders.get(editor);
    const previousAuthor = marineRimeReplyPlaceholderAuthor(previousPlaceholder);
    const placeholderAuthor = marineRimeReplyPlaceholderAuthor(placeholder);
    const facts = {
      isReplyEditor: marineRimeIsReplyEditorPlaceholder(placeholder),
      structurallyOwned: marineRimeEditorBelongsTo(editor, pending.commentEl),
      isNewEditor: !(pending.editorsBefore && pending.editorsBefore.has(editor)),
      becameReplyEditor: previousPlaceholder != null &&
        !marineRimeIsReplyEditorPlaceholder(previousPlaceholder) &&
        marineRimeIsReplyEditorPlaceholder(placeholder),
      retargetedReplyEditor: marineRimeIsReplyEditorPlaceholder(previousPlaceholder) &&
        marineRimeIsReplyEditorPlaceholder(placeholder) && previousAuthor !== placeholderAuthor,
      placeholderAuthor,
    };
    const accepted = marineRimeCanClaimReplyLease(
      pending,
      facts,
      marineRimePageKey(),
      marineRimeTarget.sourceId,
      now,
    );
    marineRimeDiagnostic('handoff-evaluate', {
      accepted,
      labelAuthor: marineRimeDiagnosticAuthor(placeholderAuthor),
      expectedAuthor: marineRimeDiagnosticAuthor(pending.authorName),
      isReplyEditor: facts.isReplyEditor,
      structurallyOwned: facts.structurallyOwned,
      isNewEditor: facts.isNewEditor,
      becameReplyEditor: facts.becameReplyEditor,
      retargetedReplyEditor: facts.retargetedReplyEditor,
      editor: marineRimeDiagnosticShape(editor),
    }, marineRimeDiagnosticAuthor(placeholderAuthor) + '|' + accepted);
    return accepted;
  }

  function marineRimeIsReplyThread(el) {
    if (!el || !el.tagName) return false;
    const adapter = marineRimeSiteAdapter();
    if (adapter && typeof adapter.isReplyThread === 'function') {
      try { if (adapter.isReplyThread(el)) return true; }
      catch (e) {}
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'bili-comment-thread-renderer' || tag === 'bili-comment-card') return true;
    const cls = String(el.className && typeof el.className === 'string' ? el.className : '');
    return /(^|\s)(root-reply(?:-container)?|comment-thread|reply-thread)(\s|$)/i.test(cls);
  }

  function marineRimeReplyThread(start) {
    for (let el = start, i = 0; el && i < 18; el = marineComposedParent(el), i++) {
      if (marineRimeIsReplyThread(el)) return el;
    }
    return null;
  }

  function marineRimeEditorBelongsTo(editor, commentEl) {
    if (!editor || !commentEl) return false;
    if (marineComposedContains(commentEl, editor)) return true;

    // Bilibili normally mounts the reply editor beside the clicked renderer,
    // under their shared thread.  Never climb farther (for example to the
    // whole <bili-comments> root), because that lets a pending reply bind to
    // the direct editor or to a renderer in another thread.
    const commentThread = marineRimeReplyThread(commentEl);
    if (!commentThread || !marineComposedContains(commentThread, editor)) return false;
    const editorThread = marineRimeReplyThread(editor);
    if (editorThread !== commentThread) return false;

    const editorComment = marineRimeCommentContainer(editor);
    return !editorComment || editorComment === commentEl || editorComment === commentThread;
  }

  function marineRimeResolveOpenReplyEditor(editor, label) {
    const authorName = marineRimeReplyPlaceholderAuthor(label);
    if (!editor || !authorName) return null;
    let editorRect;
    try { editorRect = editor.getBoundingClientRect(); } catch (e) { return null; }
    if (!editorRect || editorRect.width <= 0 || editorRect.height <= 0) return null;

    const normalizedAuthor = marineRimeNormalizeCommentIdentity(authorName);
    const candidates = [];
    for (const commentEl of marineRimeRenderedCommentBoundaries()) {
      if (!commentEl || !commentEl.isConnected || !marineVisible(commentEl)) continue;
      const identity = marineRimeDomIdentity(commentEl);
      if (marineRimeNormalizeCommentIdentity(identity.authorName) !== normalizedAuthor) continue;
      const target = marineRimeDomTarget(commentEl, authorName);
      if (!String(target.id || '').trim() || !String(target.text || '').trim()) continue;
      let rect;
      try { rect = commentEl.getBoundingClientRect(); } catch (e) { continue; }
      const gap = editorRect.top - rect.bottom;
      if (gap < -24 || gap > 800) continue;
      const overlap = Math.min(editorRect.right, rect.right) - Math.max(editorRect.left, rect.left);
      const minWidth = Math.max(1, Math.min(editorRect.width, rect.width));
      if (overlap < minWidth * 0.12) continue;
      const score = Math.max(0, gap) + Math.abs(editorRect.left - rect.left) * 0.04;
      candidates.push({ commentEl, target, score, gap });
    }
    candidates.sort(function (a, b) { return a.score - b.score; });
    if (!candidates.length) return null;
    // Identical geometry means the DOM does not tell us which same-author
    // renderer owns the detached editor. Fail closed instead of selecting an
    // arbitrary floor.
    if (candidates.length > 1 && Math.abs(candidates[0].score - candidates[1].score) < 1 &&
        String(candidates[0].target.id) !== String(candidates[1].target.id)) return null;
    return candidates[0];
  }

  function marineRimeIsCommentEditor(editor) {
    if (!editor) return false;
    const platform = detectPlatform();
    const adapter = marineRimeSiteAdapter(platform);
    if (!marineRimeAdapterSupportsPage(adapter)) return false;
    if (adapter && typeof adapter.isCommentEditor === 'function') {
      try { if (adapter.isCommentEditor(editor)) return true; }
      catch (e) {}
    }
    if (platform !== 'bilibili' || !/\/video\//.test(location.pathname)) return false;
    const root = marineCommentSearchRoot();
    if (root !== document && marineComposedContains(root, editor)) return true;
    if (marineRimeCommentContainer(editor)) return true;
    return /(\u8bc4\u8bba|\u56de\u590d|\u53d1\u4e00\u6761\u53cb\u5584)/.test(marineRimeEditorContextLabel(editor));
  }

  // pass 必须罩住整个 classify，而不只是单次 domTarget：resolveOpenReplyEditor
  // 会对每个同名候选再调一次 domTarget，只有共享 pass 才能把 O(B²) 压回 O(B)。
  function marineRimeClassify(editor) {
    return marineRimeWithPass(function () {
      return marineRimeClassifyInPass(editor);
    });
  }

  function marineRimeClassifyInPass(editor) {
    if (!marineRimeIsCommentEditor(editor)) return null;
    const directScope = marineRimeDirectScopeForEditor(editor);
    const now = Date.now();
    let pending = marineRimeTarget.pendingReply;
    if (pending && !marineRimeReplyLeaseIsFresh(
      pending,
      marineRimePageKey(),
      marineRimeTarget.sourceId,
      now,
    )) {
      marineRimeClearPendingReply('handoff-stale');
      pending = null;
    }
    const placeholder = marineRimeEditorContextLabel(editor);
    const placeholderAuthor = marineRimeReplyPlaceholderAuthor(placeholder);
    const ownComment = marineRimeCommentContainer(editor);
    let commentEl = ownComment;
    let target = ownComment ? marineRimeDomTarget(ownComment, placeholderAuthor) : null;
    let matchedPending = false;
    if (pending && marineRimePendingCanClaimEditor(pending, editor, now)) {
      commentEl = pending.commentEl;
      const currentTarget = marineRimeDomTarget(commentEl, placeholderAuthor);
      target = currentTarget.id ? currentTarget : pending.target;
      matchedPending = true;
    } else {
      // The direct box can remain focused briefly while Bilibili mounts the
      // reply editor. Preserve the hand-off only for that pre-existing,
      // non-reply editor; a different reply editor invalidates it immediately.
      const wasPresent = pending && pending.editorsBefore && pending.editorsBefore.has(editor);
      if (pending && !(wasPresent && !marineRimeIsReplyEditorPlaceholder(placeholder))) {
        marineRimeClearPendingReply('different-editor');
        pending = null;
      }
      const binding = marineRimeTarget.replyBindings.get(editor);
      const bindingAuthor = binding && binding.target && binding.target.authorName;
      const bindingValid = binding && binding.pageKey === marineRimePageKey() &&
        binding.sourceId === marineRimeTarget.sourceId &&
        binding.commentEl && binding.commentEl.isConnected &&
        (!placeholderAuthor || !bindingAuthor ||
          marineRimeNormalizeCommentIdentity(placeholderAuthor) === marineRimeNormalizeCommentIdentity(bindingAuthor));
      if (bindingValid) {
        commentEl = binding.commentEl;
        target = binding.target;
      } else if (binding) {
        marineRimeTarget.replyBindings.delete(editor);
      }
    }
    if (!commentEl && marineRimeIsReplyEditorPlaceholder(placeholder)) {
      const resolved = marineRimeResolveOpenReplyEditor(editor, placeholder);
      if (resolved) {
        commentEl = resolved.commentEl;
        target = resolved.target;
        marineRimeTarget.replyBindings.set(editor, {
          commentEl,
          target,
          pageKey: marineRimePageKey(),
          sourceId: marineRimeTarget.sourceId,
        });
      }
    }
    const reply = !!(commentEl || marineRimeIsReplyEditorPlaceholder(placeholder) || matchedPending);
    if (!reply) {
      // 一个知乎页面可以同时有多条回答。没有回答 scope 时宁可不启用，
      // 也不能把话术投到另一条回答的评论框。
      if (detectPlatform() === 'zhihu' && !marineRimePublicDirectScope(directScope)) return null;
      return { mode: 'direct', editor, commentEl: null, target: null, directScope };
    }
    if (!target && matchedPending && pending) { commentEl = pending.commentEl; target = pending.target; }
    target = target || { id: '', authorName: '', text: '', snippet: '', parentId: '', rootId: '' };
    if (!target.authorName) target.authorName = marineRimeReplyPlaceholderAuthor(placeholder);
    // Exact hierarchy is the contract of the reply action. Author/text-only
    // guesses are useful for display but cannot safely select a generated
    // reply candidate, so require either rpid or the clicked renderer's
    // deterministic DOM target id.
    if (!String(target.id || '').trim()) {
      marineLog('warn', 'rime-target', '回复目标缺少稳定评论 ID，未建立投放目标');
      return null;
    }
    if (matchedPending) {
      marineRimeTarget.replyBindings.set(editor, {
        commentEl,
        target,
        pageKey: marineRimePageKey(),
        sourceId: marineRimeTarget.sourceId,
      });
      if (marineRimeTarget.pendingReply === pending) marineRimeClearPendingReply('handoff-complete');
    }
    return { mode: 'reply', editor, commentEl, target, directScope };
  }

  function marineRimeEnsureOverlay() {
    if (marineRimeTarget.overlay) return marineRimeTarget.overlay;
    const theme = marineRimeTheme();
    const make = function (kind) {
      const el = document.createElement('div');
      el.setAttribute('data-marine-rime-target', kind);
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, {
        display: 'none', position: 'fixed', boxSizing: 'border-box', pointerEvents: 'none',
        // 只过渡尺寸，不过渡 left/top——滚动时经 rAF 高频重定位，位置过渡会让轮廓「尾随」评论框。
        zIndex: '2147483646', borderRadius: '8px', transition: 'width 80ms ease, height 80ms ease',
      });
      (document.documentElement || document.body).appendChild(el);
      return el;
    };
    const comment = make('comment');
    Object.assign(comment.style, { border: '2px solid ' + theme.accent, background: theme.soft, boxShadow: '0 0 0 3px ' + theme.ring });
    const editor = make('editor');
    Object.assign(editor.style, { border: '2px solid ' + theme.accent, background: theme.soft, boxShadow: '0 0 0 3px ' + theme.ring });
    const badge = make('badge');
    Object.assign(badge.style, {
      height: '24px', width: 'auto', padding: '3px 9px', borderRadius: '999px',
      color: '#fff', background: theme.badge, font: '600 12px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      letterSpacing: '.1px', whiteSpace: 'nowrap', boxShadow: '0 3px 10px rgba(0, 0, 0, .18)',
      textShadow: '0 1px 2px rgba(0, 0, 0, .4)',
    });
    marineRimeTarget.overlay = { comment, editor, badge };
    return marineRimeTarget.overlay;
  }

  function marineRimePlaceOutline(el, target, padding) {
    if (!target || !target.isConnected || !marineVisible(target)) { el.style.display = 'none'; return null; }
    let rect;
    try { rect = target.getBoundingClientRect(); } catch (e) { el.style.display = 'none'; return null; }
    if (rect.bottom < -20 || rect.top > innerHeight + 20 || rect.right < -20 || rect.left > innerWidth + 20) {
      el.style.display = 'none'; return rect;
    }
    const p = padding || 0;
    Object.assign(el.style, {
      display: 'block', left: Math.max(0, rect.left - p) + 'px', top: Math.max(0, rect.top - p) + 'px',
      width: Math.max(0, Math.min(innerWidth, rect.right + p) - Math.max(0, rect.left - p)) + 'px',
      height: Math.max(0, Math.min(innerHeight, rect.bottom + p) - Math.max(0, rect.top - p)) + 'px',
    });
    return rect;
  }

  function marineRimeRender() {
    const overlay = marineRimeEnsureOverlay();
    const theme = marineRimeTheme();
    const active = marineRimeTarget.active;
    if (!active) {
      overlay.comment.style.display = 'none';
      overlay.editor.style.display = 'none';
      overlay.badge.style.display = 'none';
      marineRimeGenSync();
      marineRimeTarget.painted = marineRimeNeedsPaint();
      return;
    }
    marineRimeTarget.painted = true;
    const editorRect = marineRimePlaceOutline(overlay.editor, active.editor, 3);
    if (active.mode === 'reply') marineRimePlaceOutline(overlay.comment, active.commentEl, 4);
    else overlay.comment.style.display = 'none';
    if (!editorRect || overlay.editor.style.display === 'none') { overlay.badge.style.display = 'none'; return; }
    const author = active.target && active.target.authorName;
    const badgeLabel = active.mode === 'reply'
      ? (theme.replyLabel + ' @' + (author || '\u4f5c\u8005'))
      : theme.directLabel;
    overlay.badge.textContent = badgeLabel;
    overlay.badge.style.display = 'block';
    // \u91cf\u4e00\u6b21\u5c31\u591f\uff1a\u6807\u7b7e\u4e0d\u53d8\u65f6\u5bbd\u5ea6\u4e0d\u53d8\uff0c\u800c\u8fd9\u6b21\u8bfb\u53d6\u7d27\u8ddf\u5728\u4e0a\u9762\u7684\u5199\u5165\u4e4b\u540e\uff0c
    // \u6bcf\u5e27\u90fd\u4f1a\u5f3a\u5236\u4e00\u6b21\u540c\u6b65\u5e03\u5c40\u3002\u91cf\u5230 0\uff08\u5c1a\u672a\u663e\u793a\uff09\u65f6\u4e0d\u7f13\u5b58\uff0c\u4e0b\u4e00\u5e27\u518d\u91cf\u3002
    if (marineRimeTarget.badgeLabel !== badgeLabel || !marineRimeTarget.badgeWidth) {
      const measured = overlay.badge.getBoundingClientRect().width;
      if (measured > 0) {
        marineRimeTarget.badgeWidth = measured;
        marineRimeTarget.badgeLabel = badgeLabel;
      }
    }
    const badgeWidth = marineRimeTarget.badgeWidth || 120;
    const top = editorRect.top >= 31 ? editorRect.top - 29 : Math.min(innerHeight - 26, editorRect.bottom + 5);
    overlay.badge.style.left = Math.max(4, Math.min(innerWidth - badgeWidth - 4, editorRect.left)) + 'px';
    overlay.badge.style.top = Math.max(4, top) + 'px';
    marineRimeGenSync();
  }

  function marineRimeNeedsPaint() {
    return !!marineRimeTarget.active || marineRimeGenBusy();
  }

  function marineRimeSchedulePosition() {
    if (marineRimeTarget.positionFrame) return;
    // \u6ca1\u6709\u6d3b\u52a8\u76ee\u6807\u3001\u4e5f\u6ca1\u6709\u5728\u9014\u751f\u6210\u65f6\uff0c\u6574\u5e27\u7684\u4ea7\u51fa\u53ea\u6709\u300c\u9690\u85cf\u300d\uff0c\u800c\u4ee3\u4ef7\u662f\u591a\u6b21
    // getBoundingClientRect \u548c\u5f3a\u5236\u540c\u6b65\u5e03\u5c40\u2014\u2014\u6eda\u52a8\u65f6\u6bcf\u5e27\u90fd\u5728\u767d\u8dd1\u3002\u4ece\u300c\u6709\u300d\u53d8
    // \u300c\u65e0\u300d\u7684\u90a3\u4e00\u5e27\u5fc5\u987b\u771f\u7684\u6267\u884c\u4e00\u6b21\u53bb\u6536\u8d77\u8986\u76d6\u5c42\uff0c\u6240\u4ee5\u53ea\u8df3\u8fc7\u4e4b\u540e\u7684\u91cd\u590d\u5e27\u3002
    if (!marineRimeNeedsPaint() && !marineRimeTarget.painted) return;
    marineRimeTarget.positionFrame = requestAnimationFrame(function () {
      marineRimeTarget.positionFrame = 0;
      marineRimeRender();
    });
  }

  // ---- 页面内「生成」按钮 + 本地智能体流式直接输入 ----
  // 选中评论/回复框后浮出「生成」；点击 = 等价输入法上的「生成评论」键：让 sw 调本地
  // Marine API 的 /generate-stream（本机 codex/claude 智能体）流式产出话术，然后**直接写进
  // 那个输入框**——没有预览弹窗。红线不变：只写草稿，绝不自动提交页面表单。
  //
  // 写入方式刻意不按 delta 分块整段灌入：文本被拆成「一个字 / 一个词」，以随机间隔逐个
  // 敲进去，接近真人打字节奏（见 marineRimeGenPump / NextUnit / NextDelay）。
  //
  // 生成一旦开始就快照 editor/mode/target，之后不依赖 active——点按钮会让评论框失焦，
  // 可能导致目标被清理，但写入始终用快照。仅当切到「另一个 contextId」的目标、或输入框
  // 失去焦点（contenteditable 的 insertText 会落到当前聚焦元素）时才中止本轮。
  const marineRimeGen = {
    host: null, root: null, els: null, port: null,
    state: 'idle', // idle | preparing | streaming | typing | error
    serial: 0,
    contextId: '', mode: 'direct', target: null, editor: null,
    raw: '',        // 累积的原始 delta（用于增量抽取 blocks-v1 的 text）
    wanted: '',     // 目前已知的完整目标文本
    typed: '',      // 已经敲进输入框的部分
    baseline: '',   // 开始生成前输入框里的原有内容（只追加，不动它）
    streamDone: false,
    typeTimer: 0,
    typingStartedAt: 0,
    errorText: '',
    errorTimer: 0,
  };

  function marineRimeGenActionId(mode) {
    return mode === 'reply' ? 'marine.generate-reply' : 'marine.generate-direct';
  }

  function marineRimeGenBusy() {
    const st = marineRimeGen.state;
    return st === 'preparing' || st === 'streaming' || st === 'typing';
  }

  function marineRimeGenErrorLabel(code, message) {
    const map = {
      MARINE_NOT_CONFIGURED: 'Marine 本地服务未连接',
      MARINE_RIME_CONTEXT_INVALID: '目标已失效，请重新点选输入框',
      MARINE_GENERATE_TIMEOUT: '生成超时，请重试',
      MARINE_GENERATE_CANCELLED: '生成已取消',
      MARINE_RIME_PROMPT_TOO_LARGE: '页面内容过大，无法生成',
      MARINE_OPENAI_NOT_CONFIGURED: '未配置 OpenAI 兼容端点',
      MARINE_OPENAI_KEY_MISSING: '缺少 OpenAI 兼容端点密钥',
      MARINE_SETTINGS_FAILED: '读取设置失败',
      MARINE_GENERATE_FAILED: '生成失败，请重试',
    };
    return map[code] || (message ? String(message) : '生成失败，请重试');
  }

  // 从（可能未闭合的）blocks-v1 原始 JSON 里尽力抽出 blocks[0].text，供边生成边打字；
  // 最终仍以 done 帧的 blocks 为准。
  function marineExtractBlockText(raw) {
    if (!raw) return null;
    const anchor = raw.match(/"blocks"\s*:\s*\[\s*\{/);
    const from = anchor ? anchor.index + anchor[0].length : 0;
    const key = raw.indexOf('"text"', from);
    if (key < 0) return null;
    const colon = raw.indexOf(':', key + 6);
    if (colon < 0) return null;
    const open = raw.indexOf('"', colon + 1);
    if (open < 0) return null;
    let out = '';
    for (let i = open + 1; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const next = raw[i + 1];
        if (next === undefined) break;
        if (next === 'n') { out += '\n'; i += 1; }
        else if (next === 't') { out += '\t'; i += 1; }
        else if (next === 'r') { out += '\r'; i += 1; }
        else if (next === 'u') {
          const hex = raw.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          const code = parseInt(hex, 16);
          if (!Number.isNaN(code)) out += String.fromCharCode(code);
          i += 5;
        } else { out += next; i += 1; }
        continue;
      }
      if (ch === '"') return out;
      out += ch;
    }
    return out;
  }

  function marineRimeGenEnsureUI() {
    if (marineRimeGen.host) return marineRimeGen.els;
    const host = document.createElement('div');
    host.setAttribute('data-marine-rime-actions', '');
    Object.assign(host.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none',
    });
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    const theme = marineRimeTheme();
    const style = document.createElement('style');
    style.textContent = [
      ':host,*{box-sizing:border-box;}',
      '.gen,.tip{position:fixed;pointer-events:auto;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.gen{display:none;align-items:center;gap:5px;height:28px;padding:0 12px;border:none;border-radius:999px;',
      'color:#fff;background:' + theme.badge + ';box-shadow:0 3px 12px rgba(0,0,0,.22);cursor:pointer;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.4);}',
      '.gen:hover{filter:brightness(1.06);}',
      '.gen:disabled{opacity:.72;cursor:default;}',
      '.gen.pending{opacity:.72;}',
      '.gen .dot{width:6px;height:6px;border-radius:50%;background:#fff;opacity:.9;}',
      '.gen.busy .dot{animation:mgpulse 1s ease-in-out infinite;}',
      '@keyframes mgpulse{0%,100%{opacity:.35;}50%{opacity:1;}}',
      '.gen:focus-visible{outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 4px ' + theme.ring + ';}',
      // 只用于报错的一行提示，不再展示生成内容（内容直接进输入框）。
      '.tip{display:none;max-width:min(360px,calc(100vw - 24px));padding:7px 11px;border-radius:9px;',
      'background:var(--mg-bg);color:#e5484d;border:1px solid var(--mg-border);box-shadow:0 8px 26px rgba(0,0,0,.24);}',
      ':host{--mg-bg:#fff;--mg-border:rgba(0,0,0,.12);}',
      '@media (prefers-color-scheme:dark){:host{--mg-bg:#20242a;--mg-border:rgba(255,255,255,.14);}}',
      '@media (prefers-reduced-motion:reduce){.gen.busy .dot{animation:none;}}',
    ].join('');
    root.appendChild(style);

    const genBtn = document.createElement('button');
    genBtn.className = 'gen';
    genBtn.type = 'button';
    genBtn.setAttribute('aria-label', '生成话术');
    genBtn.innerHTML = '<span class="dot"></span><span class="lbl">生成</span>';

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-live', 'polite');

    root.appendChild(genBtn);
    root.appendChild(tip);
    (document.documentElement || document.body).appendChild(host);

    // 保住评论框焦点：点按钮不能让编辑框失焦，否则 execCommand 会写到别处。
    genBtn.addEventListener('mousedown', function (event) { event.preventDefault(); });
    genBtn.addEventListener('click', function (e) { e.preventDefault(); marineRimeGenStart(); });

    marineRimeGen.host = host;
    marineRimeGen.root = root;
    marineRimeGen.els = { genBtn, tip, lbl: genBtn.querySelector('.lbl') };
    return marineRimeGen.els;
  }

  function marineRimeGenRenderButton() {
    const els = marineRimeGen.els;
    if (!els) return;
    const busy = marineRimeGenBusy();
    els.genBtn.disabled = busy;
    els.genBtn.classList.toggle('busy', busy);
    els.lbl.textContent = marineRimeGen.state === 'preparing' ? '准备中…'
      : busy ? '生成中…'
      : (marineRimeGen.typed ? '重新生成' : '生成');
    els.tip.style.display = marineRimeGen.errorText ? 'block' : 'none';
    els.tip.textContent = marineRimeGen.errorText || '';
  }

  function marineRimeGenShowError(label) {
    marineRimeGen.errorText = label;
    if (marineRimeGen.errorTimer) clearTimeout(marineRimeGen.errorTimer);
    marineRimeGen.errorTimer = setTimeout(function () {
      marineRimeGen.errorTimer = 0;
      marineRimeGen.errorText = '';
      marineRimeGenRenderButton();
      marineRimeGenSync();
    }, 6000);
    marineRimeGenRenderButton();
    marineRimeGenSync();
  }

  // 右侧悬浮侧栏(panel-inject)展开时占 384px；生成 UI 定位要避开它。
  function marineRimePanelRightInset() {
    try {
      const host = document.getElementById('__marine_panel_host');
      const panel = host && host.shadowRoot && host.shadowRoot.querySelector('.m-panel');
      if (panel && !panel.classList.contains('collapsed')) {
        const rect = panel.getBoundingClientRect();
        if (rect.width > 0 && rect.left < innerWidth) return Math.max(0, innerWidth - rect.left);
      }
    } catch (e) {}
    return 0;
  }

  // 由 marineRimeRender 每帧调用：把「生成」按钮定位到活动编辑框右上角；
  // 切到另一个 contextId 的目标时中止在途生成。
  function marineRimeGenSync() {
    const els = marineRimeGenEnsureUI();
    const active = marineRimeTarget.active;

    if (active && marineRimeGenBusy() && marineRimeGen.contextId &&
        active.contextId !== marineRimeGen.contextId) {
      marineRimeGenAbort('target-switched');
    }

    // 打字期间锚定到快照编辑框；空闲时锚定到当前活动编辑框。
    const anchorEl = marineRimeGenBusy() ? marineRimeGen.editor : (active && active.editor);
    let rect = null;
    if (anchorEl && anchorEl.isConnected && marineVisible(anchorEl)) {
      try { rect = anchorEl.getBoundingClientRect(); } catch (e) { rect = null; }
    }
    if (rect && rect.bottom > 0 && rect.top < innerHeight) {
      // 只有真要摆按钮时才去量侧栏宽度：这一步是一次 shadow-root querySelector
      // 加一次布局读取，此前即使按钮根本不显示也每帧都做。
      const rightEdge = innerWidth - marineRimePanelRightInset() - 4;
      const w = els.genBtn.getBoundingClientRect().width || 64;
      const top = rect.top - 34 >= 4 ? rect.top - 34 : Math.min(innerHeight - 32, rect.bottom + 6);
      els.genBtn.classList.toggle('pending', !!active && !active.publishedContext && !marineRimeGenBusy());
      els.genBtn.style.display = 'inline-flex';
      els.genBtn.style.left = Math.max(4, Math.min(rightEdge - w, rect.right - w)) + 'px';
      els.genBtn.style.top = top + 'px';
      if (marineRimeGen.errorText) {
        const tw = els.tip.getBoundingClientRect().width || 240;
        els.tip.style.left = Math.max(8, Math.min(rightEdge - tw, rect.right - tw)) + 'px';
        els.tip.style.top = Math.max(8, top - 40) + 'px';
      }
    } else {
      els.genBtn.style.display = 'none';
      els.tip.style.display = 'none';
    }
  }

  function marineRimeGenClosePort() {
    if (marineRimeGen.port) {
      try { marineRimeGen.port.disconnect(); } catch (e) {}
      marineRimeGen.port = null;
    }
  }

  function marineRimeGenStopTyping() {
    if (marineRimeGen.typeTimer) {
      clearTimeout(marineRimeGen.typeTimer);
      marineRimeGen.typeTimer = 0;
    }
  }

  /// 结束一轮生成：保留已经敲进输入框的文字（它就是草稿），只复位内部状态。
  function marineRimeGenFinish(reason) {
    marineRimeGenClosePort();
    marineRimeGenStopTyping();
    const typed = marineRimeGen.typed;
    marineRimeGen.state = 'idle';
    marineRimeGen.streamDone = false;
    marineRimeGen.raw = '';
    marineRimeGen.wanted = '';
    if (typed && reason === 'done') {
      // 上报本次「页内生成并写入」的文本：稍后若这条被发布，sw 会据此把账本的
      // generation_source 标注为 'extension'（页内生成），区别于输入法/手填。
      try { chrome.runtime.sendMessage({ __marineGenFill: true, text: typed }); } catch (e) {}
      marineLog('ok', 'iso', '已写入生成草稿（请人工确认后手动发送）');
    }
    marineRimeGenRenderButton();
    marineRimeSchedulePosition();
  }

  function marineRimeGenAbort(reason) {
    if (!marineRimeGenBusy()) return;
    marineRimeGenFinish(reason);
  }

  function marineRimeGenFail(label) {
    marineRimeGenClosePort();
    marineRimeGenStopTyping();
    marineRimeGen.state = 'idle';
    marineRimeGen.streamDone = false;
    marineRimeGenShowError(label);
  }

  // ---- 拟人化打字 ----
  // 生成是分块（delta）到达的，但绝不按块整段写入：把文本拆成「一个字 / 一个词」，
  // 用随机间隔逐个写进输入框，接近真人的输入节奏。

  function marineRimeGenEditorFocused(editor) {
    try { return marineDeepActiveElement(document) === editor; } catch (e) { return false; }
  }

  /// 取下一个输入单元：拉丁串按词成串敲出，中文按 1~2 字（模拟输入法逐词上屏），
  /// 并保证不劈开代理对（emoji）。
  // 一轮打字的目标总时长。真人节奏（约 145ms/单元）在长文本上会拖到几十秒——
  // 300 字实测 33 秒，作为工具太慢。超预算时按比例压缩间隔并成串上屏（仍是渐进
  // 输入，不是整段灌入），短文本则完全按原节奏走。
  const MARINE_TYPING_BUDGET_MS = 12000;

  function marineRimeGenNextUnit(text, from) {
    const first = text.charAt(from);
    if (!first) return '';
    if (/[\uD800-\uDBFF]/.test(first)) return text.slice(from, from + 2);
    if (/[A-Za-z0-9]/.test(first)) {
      let n = 1;
      while (n < 6 && /[A-Za-z0-9]/.test(text.charAt(from + n))) n++;
      if (Math.random() < 0.5) n = Math.min(n, 1 + Math.floor(Math.random() * 3));
      return text.slice(from, from + n);
    }
    // 落后于预算时，中文一次多上几个字（像输入法整句上屏），而不是把间隔压到失真。
    const remaining = text.length - from;
    const behind = marineRimeGenBudgetRatio(remaining) > 1.6;
    const step = behind ? 3 + Math.floor(Math.random() * 3) : (Math.random() < 0.3 ? 2 : 1);
    return text.slice(from, from + step);
  }

  /// 「按当前节奏打完剩余部分所需时间 ÷ 剩余预算」。>1 表示要加速。
  function marineRimeGenBudgetRatio(remaining) {
    const spent = Date.now() - (marineRimeGen.typingStartedAt || Date.now());
    const left = Math.max(400, MARINE_TYPING_BUDGET_MS - spent);
    return (remaining * 145) / left;
  }

  function marineRimeGenNextDelay(unit, remaining) {
    let delay = (45 + Math.random() * 70) * Math.min(unit.length, 2);
    const last = unit.charAt(unit.length - 1);
    if (/[，。！？；：、,.!?;:]/.test(last)) delay += 180 + Math.random() * 260;
    if (unit.indexOf('\n') >= 0) delay += 200 + Math.random() * 300;
    if (Math.random() < 0.04) delay += 250 + Math.random() * 450; // 偶尔「想一下」
    const ratio = marineRimeGenBudgetRatio(remaining);
    if (ratio > 1) delay = Math.max(20, delay / ratio); // 只加速，永不拖慢
    return delay;
  }

  /// 往输入框追加一个单元。contenteditable 走 insertText（在光标处插入），
  /// textarea/input 走原生 value setter 重写全量并把光标移到末尾。
  function marineRimeGenWriteUnit(editor, unit, fullValue) {
    const tag = (editor.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(editor, fullValue); else editor.value = fullValue;
      try { editor.selectionStart = editor.selectionEnd = fullValue.length; } catch (e) {}
    } else {
      try { document.execCommand('insertText', false, unit); } catch (e) {}
    }
    try {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: unit }));
    } catch (e) {
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function marineRimeGenPump() {
    const g = marineRimeGen;
    g.typeTimer = 0;
    if (g.state !== 'typing' && g.state !== 'streaming') return;
    const editor = g.editor;
    if (!editor || !editor.isConnected) { marineRimeGenFail('目标输入框已失效，请重新点选后再生成'); return; }
    // contenteditable 的 insertText 落在「当前聚焦元素」上，焦点跑了就必须停手，
    // 否则会把话术写进别人的输入框。
    if (!marineRimeGenEditorFocused(editor)) { marineRimeGenAbort('focus-lost'); return; }

    if (g.wanted.indexOf(g.typed) !== 0) {
      // 流式抽取的前缀被最终结果修正了（少见）：一次性对齐到已知文本再继续逐字敲。
      marineSetEditorText(editor, g.baseline + g.wanted);
      g.typed = g.wanted;
    }

    if (g.typed.length >= g.wanted.length) {
      if (g.streamDone) { marineRimeGenFinish('done'); return; }
      g.typeTimer = setTimeout(marineRimeGenPump, 120); // 等更多 delta
      return;
    }

    const unit = marineRimeGenNextUnit(g.wanted, g.typed.length);
    if (!unit) { g.typeTimer = setTimeout(marineRimeGenPump, 120); return; }
    g.typed += unit;
    marineRimeGenWriteUnit(editor, unit, g.baseline + g.typed);
    const remaining = g.wanted.length - g.typed.length;
    g.typeTimer = setTimeout(marineRimeGenPump, marineRimeGenNextDelay(unit, remaining));
  }

  /// 开始把 wanted 敲进输入框：聚焦、把光标移到末尾，然后启动节拍器。
  function marineRimeGenBeginTyping() {
    const g = marineRimeGen;
    if (g.state === 'typing') return;
    const editor = g.editor;
    if (!editor || !editor.isConnected) { marineRimeGenFail('目标输入框已失效，请重新点选后再生成'); return; }
    g.state = 'typing';
    g.typed = '';
    g.typingStartedAt = Date.now();
    g.baseline = marineTextOf(editor) || '';
    try { editor.focus(); } catch (e) {}
    const tag = (editor.tagName || '').toLowerCase();
    if (tag !== 'textarea' && tag !== 'input') {
      // 光标放到已有内容末尾，保证只追加、不覆盖用户已经写的东西。
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (e) {}
    } else {
      try { editor.selectionStart = editor.selectionEnd = (editor.value || '').length; } catch (e) {}
    }
    marineRimeGenRenderButton();
    marineRimeGenStopTyping();
    g.typeTimer = setTimeout(marineRimeGenPump, 60);
  }

  function marineRimeGenStart() {
    if (marineRimeGenBusy()) return;
    const active = marineRimeTarget.active;
    if (!active) {
      marineRimeGenEnsureUI();
      marineRimeGenShowError('请先点选一个评论/回复框');
      return;
    }
    if (!active.publishedContext) {
      // 上下文 PUT 是异步的（往返可能 1~2s）。刚聚焦就点「生成」时不该报错——
      // 先进「准备中」，发布完成后自动继续。
      marineRimeGenWaitForPublish(active);
      return;
    }
    marineRimeGenLaunch({
      contextId: active.contextId,
      mode: active.mode,
      editor: active.editor,
      target: active.target,
    });
  }

  function marineRimeGenWaitForPublish(active) {
    marineRimeGenEnsureUI();
    marineRimeGenClosePort();
    const serial = ++marineRimeGen.serial;
    marineRimeGen.state = 'preparing';
    marineRimeGen.errorText = '';
    marineRimeGen.contextId = active.contextId;
    marineRimeGen.mode = active.mode;
    marineRimeGen.editor = active.editor;
    marineRimeGen.target = active.target;
    marineRimeGenRenderButton();
    marineRimeGenSync();
    const startedAt = Date.now();
    const tick = function () {
      if (serial !== marineRimeGen.serial) return;
      const current = marineRimeTarget.active;
      if (current && current.publishedContext && current.contextId === marineRimeGen.contextId) {
        marineRimeGenLaunch({
          contextId: current.contextId,
          mode: current.mode,
          editor: current.editor,
          target: current.target,
        });
        return;
      }
      if (Date.now() - startedAt > 12000) {
        marineRimeGenFail('目标准备超时，请重新点选输入框再试（若持续，请检查 Marine 本地服务连接）');
        return;
      }
      setTimeout(tick, 300);
    };
    setTimeout(tick, 300);
  }

  function marineRimeGenLaunch(spec) {
    marineRimeGenClosePort();
    marineRimeGenStopTyping();
    const serial = ++marineRimeGen.serial;
    const g = marineRimeGen;
    g.state = 'streaming';
    g.raw = '';
    g.wanted = '';
    g.typed = '';
    g.streamDone = false;
    g.errorText = '';
    g.contextId = spec.contextId;
    g.mode = spec.mode;
    g.editor = spec.editor;
    g.target = spec.target;
    marineRimeGenRenderButton();
    marineRimeGenSync();

    let port;
    try { port = chrome.runtime.connect({ name: 'marine-generate' }); }
    catch (e) { marineRimeGenFail('扩展未连接，请重开页面'); return; }
    g.port = port;
    port.onMessage.addListener(function (frame) {
      if (serial !== marineRimeGen.serial) return;
      marineRimeGenOnFrame(frame);
    });
    port.onDisconnect.addListener(function () {
      if (serial !== marineRimeGen.serial) return;
      marineRimeGen.port = null;
      if (marineRimeGen.state === 'streaming') marineRimeGenFail('生成连接中断，请重试');
    });
    try {
      port.postMessage({
        type: 'start',
        contextId: spec.contextId,
        actionId: marineRimeGenActionId(spec.mode),
        requestId: 'gen-' + Date.now() + '-' + serial,
      });
    } catch (e) { marineRimeGenFail('无法发起生成'); }
  }

  function marineRimeGenOnFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    const g = marineRimeGen;
    if (frame.type === 'delta') {
      g.raw += String(frame.text || '');
      const text = marineExtractBlockText(g.raw);
      if (text != null && text.length > g.wanted.length) g.wanted = text;
      // 一拿到可写内容就开始逐字敲，边生成边输入。
      if (g.wanted && g.state === 'streaming') marineRimeGenBeginTyping();
    } else if (frame.type === 'done') {
      marineRimeGenClosePort();
      const blocks = Array.isArray(frame.blocks) ? frame.blocks : [];
      const finalText = blocks.length ? String(blocks[0].text || '') : String(g.wanted || '');
      if (!finalText.trim()) { marineRimeGenFail('生成结果为空，请重试'); return; }
      g.wanted = finalText;
      g.streamDone = true;
      if (g.state === 'streaming') marineRimeGenBeginTyping();
      else if (!g.typeTimer) g.typeTimer = setTimeout(marineRimeGenPump, 60);
    } else if (frame.type === 'error') {
      marineRimeGenFail(marineRimeGenErrorLabel(frame.code, frame.message));
    }
  }

  function marineRimeSend(op, contextId, context, revision, options) {
    const active = marineRimeTarget.active;
    const operation = {
      op,
      contextId,
      context,
      revision,
      sourceId: marineRimeTarget.sourceId,
      retainWhenUnfocused: op === 'put' && !!active && active.contextId === contextId &&
        marineRimePersistentTargetIsOpen(active),
      leaseRenewal: op === 'put' && !!options && options.leaseRenewal === true,
    };
    const result = marineRimeSendQueue.catch(function () {}).then(function () {
      return marineRimeDeliver(operation);
    });
    marineRimeSendQueue = result.catch(function () {});
    return result;
  }

  async function marineRimeGrabContext(info) {
    const directScope = marineRimePublicDirectScope(info && info.directScope);
    const key = marineRimePageKey() + '|' + commentCaptures.length + '|' +
      (directScope ? directScope.kind + ':' + directScope.id : 'page');
    const cached = marineRimeTarget.grabCache;
    if (cached && cached.key === key && Date.now() - cached.at < 30000) return cached.value;
    const value = await Promise.race([
      marineGrabAll({ directScope }),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('抓取上下文超时')); }, 8000);
      }),
    ]);
    marineRimeTarget.grabCache = { key, at: Date.now(), value };
    return value;
  }

  function marineRimeTargetSummary(info) {
    let summary;
    if (info.mode === 'direct') {
      const scope = marineRimePublicDirectScope(info.directScope);
      if (scope && scope.kind === 'answer') {
        summary = '直评回答' + (scope.authorName ? ' @' + scope.authorName : '') +
          ' \u00b7 ' + (scope.title || scope.id);
      } else if (scope && scope.kind === 'article') {
        // 知乎专栏文章：与回答共用同一套 data-zop 元信息，只是 type=article。
        // 没有这一支就会掉进通用兜底，白白丢掉文章标题和作者。
        summary = '直评文章' + (scope.authorName ? ' @' + scope.authorName : '') +
          ' \u00b7 ' + (scope.title || scope.id);
      } else if (scope && scope.kind === 'note') {
        summary = '直评笔记 \u00b7 ' + (scope.title || scope.id);
      } else summary = '直评 \u00b7 ' + (document.title || location.href);
    }
    else {
      const target = info.target || {};
      const author = target.authorName || '作者';
      const snippet = marineCommentSnippet(target.text || target.snippet, 80);
      summary = '@' + author + (snippet ? '：「' + snippet + '」' : '');
    }
    return marineRimeTruncateUtf8(summary, MARINE_RIME_TARGET_SUMMARY_MAX_BYTES);
  }

  async function marineRimePublish(info, revision) {
    let grab;
    try { grab = await marineRimeGrabContext(info); }
    catch (e) {
      marineLog('warn', 'rime-target', '抓取上下文失败，使用当前页基本信息：' + String(e && e.message || e));
      grab = { platform: detectPlatform(), url: location.href, title: document.title, bundle: '', text: { status: 'none' }, comments: { status: 'none' }, subtitle: { status: 'none' } };
    }
    const active = marineRimeTarget.active;
    if (!active || active.contextId !== info.contextId || marineRimeTarget.revision !== revision) return;
    const actionId = info.mode === 'reply' ? 'marine.generate-reply' : 'marine.generate-direct';
    const targetSummary = marineRimeTargetSummary(info);
    const target = info.mode === 'reply' ? marineRimeBuildReplyTarget(info.target) : null;
    const theme = marineRimeTheme();
    const context = {
      contextId: info.contextId,
      mode: info.mode,
      actionId,
      label: info.mode === 'reply'
        ? (theme.replyLabel + ' @' + ((info.target && info.target.authorName) || '作者'))
        : theme.directLabel,
      targetSummary,
      platform: grab.platform || detectPlatform(),
      url: location.href,
      title: document.title,
      target,
      payload: marineRimeBuildPayload(grab, {
        platform: grab.platform || detectPlatform(),
        url: location.href,
        title: document.title,
        mode: info.mode,
        targetSummary,
      }),
      updatedAt: Date.now(),
    };
    if (marineRimeContextWireBytes(context) > MARINE_RIME_CONTEXT_MAX_BYTES) {
      marineLog('warn', 'rime-target', '投放上下文超过安全传输上限，未建立目标');
      return;
    }
    const delivered = await marineRimeSend('put', info.contextId, context, revision);
    const published = marineRimeTarget.active;
    if (!delivered.applied || !published || published.contextId !== info.contextId ||
        marineRimeTarget.revision !== revision) {
      // 发布没成功（如慢 PUT 触发重试、重试又撞上中间 DELETE 的墓碑 → 后端对已撤销的
      // contextId 恒 409）。若目标仍活着且没被切走，就换一个全新 contextId 重发一次，
      // 否则目标会永远停在「未发布」，用户点生成只会看到「尚未就绪」。
      if (!delivered.stale && published === info && !info.publishedContext &&
          marineRimeTarget.revision === revision) {
        const attempts = (info.publishRetries || 0) + 1;
        info.publishRetries = attempts;
        if (attempts <= 2) {
          setTimeout(function () {
            const current = marineRimeTarget.active;
            if (current !== info || current.publishedContext) return;
            current.contextId = marineRimeContextId(current);
            void marineRimePublish(current, ++marineRimeTarget.revision);
          }, 600 * attempts);
        }
      }
      return;
    }
    published.publishedContext = context;
    published.publishedRevision = revision;
    published.publishedAt = Date.now();
    marineLog('ok', 'rime-target', '已锁定 ' + context.label + '：' + context.targetSummary);
    // 发布成功后补一次渲染，让「生成」按钮在 publishedContext 置上后立即出现：
    // marineRimeGenSync 只在 render 时跑，而 activate 那次 render 时 publishedContext
    // 尚未就绪（PUT 是异步的），若不补渲染按钮要等下次滚动/交互才出现。
    marineRimeSchedulePosition();
  }

  function marineRimeContextDataChanged() {
    marineRimeTryPendingReply();
    if (!marineRimeTarget.active) return;
    marineRimeTarget.grabCache = null;
    if (marineRimeTarget.refreshTimer) clearTimeout(marineRimeTarget.refreshTimer);
    marineRimeTarget.refreshTimer = setTimeout(function () {
      marineRimeTarget.refreshTimer = null;
      const active = marineRimeTarget.active;
      if (!active) return;
      const revision = ++marineRimeTarget.revision;
      void marineRimePublish(active, revision);
    }, 700);
  }

  function marineRimeActivate(editor) {
    const info = marineRimeClassify(editor);
    if (!info) { marineRimeClear('not-comment-editor'); return; }
    info.semanticKey = marineRimeSemanticKey(info.mode, info.target, info.editor, info.directScope);
    const current = marineRimeTarget.active;
    if (current && current.semanticKey === info.semanticKey && current.editor === info.editor) {
      current.commentEl = info.commentEl;
      current.target = info.target;
      current.directScope = info.directScope;
      marineRimeSchedulePosition();
      if (!current.publishedAt) {
        const revision = ++marineRimeTarget.revision;
        void marineRimePublish(current, revision);
      } else if (Date.now() - current.publishedAt > 30000) void marineRimeRenew();
      return;
    }
    if (current) {
      marineRimeTarget.active = null;
      const clearRevision = ++marineRimeTarget.revision;
      // Revoke the old lease before any subtitle/comment network work for the
      // new target. The overlay below may change immediately, but Rime can no
      // longer act on the visually obsolete target during the grab.
      marineRimeSend('delete', current.contextId, null, clearRevision);
    }
    info.contextId = marineRimeContextId(info);
    const revision = ++marineRimeTarget.revision;
    marineRimeTarget.active = info;
    marineRimeRender();
    void marineRimePublish(info, revision);
  }

  async function marineRimeRenew() {
    const active = marineRimeTarget.active;
    if (!active || !active.publishedContext || document.hidden) return;
    const focused = marineDeepActiveElement(document);
    if (focused !== active.editor) return;
    // A lease renewal is not a new target/content generation. Reuse the exact
    // revision that the worker last acknowledged so WINDOW_ID_NONE can refresh
    // only the already-tracked retained reply, never grant a newer/stale PUT.
    const revision = Number(active.publishedRevision) || 0;
    if (revision <= 0) return;
    const context = Object.assign({}, active.publishedContext, {
      updatedAt: Date.now(),
    });
    const delivered = await marineRimeSend(
      'put', active.contextId, context, revision, { leaseRenewal: true },
    );
    const published = marineRimeTarget.active;
    if (!delivered.applied || !published || published.contextId !== active.contextId ||
        Number(published.publishedRevision) !== revision) return;
    published.publishedContext = context;
    published.publishedRevision = revision;
    published.publishedAt = Date.now();
  }

  function marineRimeClear(reason) {
    const previous = marineRimeTarget.active;
    if (!previous) return;
    marineRimeTarget.active = null;
    const revision = ++marineRimeTarget.revision;
    marineRimeRender();
    marineRimeSend('delete', previous.contextId, null, revision);
    marineLog('info', 'rime-target', '已清理投放目标：' + reason);
  }

  function marineRimePersistentTargetIsOpen(info) {
    const adapter = marineRimeSiteAdapter();
    if (!info || !adapter || typeof adapter.persistentTargetIsOpen !== 'function') return false;
    try { return adapter.persistentTargetIsOpen(info, document, location) === true; }
    catch (e) { return false; }
  }

  function marineRimeRetainOrClear(reason) {
    const active = marineRimeTarget.active;
    marineRimeClearPendingReply(reason);
    if (active && marineRimePersistentTargetIsOpen(active)) {
      marineRimeSchedulePosition();
      return true;
    }
    marineRimeClear(reason);
    return false;
  }

  function marineRimeCheckPersistentTarget() {
    marineRimeTarget.lifecycleTimer = null;
    const active = marineRimeTarget.active;
    if (!active || active.mode !== 'reply' || !active.publishedContext) return;
    const adapter = marineRimeSiteAdapter();
    if (!adapter || typeof adapter.persistentTargetIsOpen !== 'function') return;
    if (marineRimePersistentTargetIsOpen(active)) return;
    marineRimeReleaseDirectScope('target-closed-scope', false);
    marineRimeClearPendingReply('target-closed');
    marineRimeClear('target-closed');
  }

  function marineRimeScheduleLifecycleCheck() {
    const active = marineRimeTarget.active;
    if (!active || active.mode !== 'reply' || !active.publishedContext) return;
    const adapter = marineRimeSiteAdapter();
    if (!adapter || typeof adapter.persistentTargetIsOpen !== 'function') return;
    if (marineRimeTarget.lifecycleTimer) clearTimeout(marineRimeTarget.lifecycleTimer);
    marineRimeTarget.lifecycleTimer = setTimeout(marineRimeCheckPersistentTarget, 50);
  }

  function marineRimeTryPendingReply() {
    const pending = marineRimeTarget.pendingReply;
    if (!pending) return false;
    const now = Date.now();
    if (!marineRimeReplyLeaseIsFresh(
      pending,
      marineRimePageKey(),
      marineRimeTarget.sourceId,
      now,
    )) {
      marineRimeClearPendingReply('handoff-stale');
      return false;
    }
    const editor = marineDeepActiveElement(document);
    if (!marineIsEditor(editor) || !marineRimeIsCommentEditor(editor)) return false;
    if (!marineRimePendingCanClaimEditor(pending, editor, now)) return false;
    marineRimeActivate(editor);
    return true;
  }

  function marineRimeRefreshFromEvent(event) {
    if (marineRimeTarget.navigationRearmRequired) {
      const eventTime = Number(event && event.timeStamp) || 0;
      if (!event || event.isTrusted !== true || eventTime <= marineRimeTarget.navigationEventCutoff) return;
      marineRimeTarget.navigationRearmRequired = false;
    }
    const editor = marineRimeEditorFromEvent(event);
    if (editor) marineRimeActivate(editor);
  }

  function marineRimeHandleClick(event) {
    const adapter = marineRimeSiteAdapter();
    if (adapter && typeof adapter.shouldClearTargetFromEventPath === 'function') {
      let shouldClear = false;
      try { shouldClear = adapter.shouldClearTargetFromEventPath(
        marineRimeEventPath(event), marineRimeTarget.active,
      ); }
      catch (e) {}
      if (shouldClear) {
        marineRimeReleaseDirectScope('explicit-cancel', false);
        marineRimeClearPendingReply('explicit-cancel');
        marineRimeClear('explicit-cancel');
        return;
      }
    }
    if (adapter && typeof adapter.shouldClearDirectScopeFromEventPath === 'function') {
      let shouldClear = false;
      try { shouldClear = adapter.shouldClearDirectScopeFromEventPath(marineRimeEventPath(event)); }
      catch (e) {}
      if (shouldClear) {
        marineRimeReleaseDirectScope('direct-scope-closed', true);
        marineRimeClearPendingReply('direct-scope-closed');
        return;
      }
    }
    if (adapter && typeof adapter.directScopeFromEventPath === 'function') {
      let directScope = null;
      try { directScope = adapter.directScopeFromEventPath(marineRimeEventPath(event)); }
      catch (e) {}
      const publicScope = marineRimePublicDirectScope(directScope);
      if (publicScope) {
        const previousRaw = marineRimeTarget.directScope;
        const previous = marineRimePublicDirectScope(marineRimeTarget.directScope);
        const replaced = !!previousRaw && previousRaw !== directScope;
        if (replaced) marineRimeReleaseDirectScope('direct-scope-replaced', true);
        marineRimeTarget.directScope = directScope;
        marineRimeClearPendingReply('direct-scope');
        if (!previous || replaced || previous.kind !== publicScope.kind || previous.id !== publicScope.id) {
          marineRimeClear('direct-scope-change');
          marineRimeTarget.grabCache = null;
        }
        marineRimeDiagnostic('direct-scope', {
          platform: detectPlatform(),
          kind: publicScope.kind,
          hasId: !!publicScope.id,
          hasTitle: !!publicScope.title,
          hasAuthor: !!publicScope.authorName,
        }, detectPlatform() + '|' + publicScope.kind + '|' + publicScope.id);
        for (const delay of [0, 80, 200, 500]) {
          setTimeout(function () { marineRimeRefreshFromEvent(null); }, delay);
        }
        return;
      }
    }
    const reply = marineRimeReplyControl(event);
    if (reply) {
      const commentEl = marineRimeCommentContainer(reply.path);
      marineRimeDiagnostic('reply-click', {
        accepted: !!commentEl,
        reason: commentEl ? 'boundary-found' : 'boundary-missing',
        control: marineRimeDiagnosticShape(reply.element),
        boundary: marineRimeDiagnosticShape(commentEl),
        path: reply.path.slice(0, 8).map(marineRimeDiagnosticShape),
      }, marineRimeDiagnosticShape(reply.element).tag + '|' + marineRimeDiagnosticShape(commentEl).tag);
      if (commentEl) {
        // The user's click changes the semantic destination immediately. Do
        // not leave the old direct/reply lease actionable while Bilibili is
        // animating or asynchronously mounting the new editor.
        marineRimeClear('reply-handoff');
        marineRimeBeginReplyLease(commentEl);
      }
      for (const delay of [0, 80, 200, 500, 1000]) setTimeout(marineRimeTryPendingReply, delay);
      return;
    }
    const replyLike = marineRimeEventPath(event).find(function (el) {
      if (marineIsEditor(el)) return false;
      const text = marineTextOf(el);
      return /^\u56de\u590d(?:\s*\d+)?$/.test(text) && text.length <= 12;
    });
    if (replyLike) {
      marineRimeDiagnostic('reply-click', {
        accepted: false,
        reason: 'control-not-recognized',
        control: marineRimeDiagnosticShape(replyLike),
        path: marineRimeEventPath(event).slice(0, 8).map(marineRimeDiagnosticShape),
      }, 'rejected|' + marineRimeDiagnosticShape(replyLike).tag + '|' + marineRimeDiagnosticShape(replyLike).cls);
    }
    const editor = marineRimeEditorFromEvent(event);
    if (editor) {
      if (!marineRimeTarget.active || marineRimeTarget.active.editor !== editor) {
        marineRimeClearPendingReply('explicit-editor-click');
      }
      setTimeout(function () { marineRimeRefreshFromEvent(event); }, 0);
    } else {
      marineRimeClearPendingReply('outside-click');
    }
  }

  function marineRimeHandleFocusOut() {
    if (marineRimeTarget.blurTimer) clearTimeout(marineRimeTarget.blurTimer);
    marineRimeTarget.blurTimer = setTimeout(function () {
      marineRimeTarget.blurTimer = null;
      if (marineRimeTarget.navigationRearmRequired) return;
      const editor = marineDeepActiveElement(document);
      if (marineIsEditor(editor) && marineRimeIsCommentEditor(editor)) marineRimeActivate(editor);
      else if (marineRimeReplyLeaseIsFresh(
        marineRimeTarget.pendingReply,
        marineRimePageKey(),
        marineRimeTarget.sourceId,
        Date.now(),
      )) {
        // The reply button itself takes focus before Bilibili mounts the box.
        // The explicit click already revoked the old active lease; keep only
        // this bounded hand-off, which an outside click/window blur can cancel.
        return;
      } else {
        marineRimeRetainOrClear('editor-blur');
      }
    }, 100);
  }

  function marineRimeHandleNavigation(url) {
    if (url && url === marineRimeTarget.pageUrl) return;
    marineRimeTarget.pageUrl = url || location.href;
    marineRimeTarget.navigationRearmRequired = true;
    marineRimeTarget.navigationEventCutoff = performance.now();
    marineRimeClearPendingReply('navigation');
    marineRimeReleaseDirectScope('navigation-scope', false);
    marineRimeTarget.grabCache = null;
    if (marineRimeTarget.refreshTimer) { clearTimeout(marineRimeTarget.refreshTimer); marineRimeTarget.refreshTimer = null; }
    commentCaptures.length = 0;
    lastGrabParts = null;
    marineRimeClear('navigation');
    // Chrome may report a same-document pushState as a loading transition and
    // retire the old content source in the service worker. Treat the SPA page
    // as a fresh lease domain so an explicit click can publish again without
    // allowing any pre-navigation message to return.
    marineRimeTarget.sourceId = marineRimeNewSourceId();
    marineRimeTarget.activationSerial = 0;
  }

  function marineRimeStartTargetTracking() {
    const adapter = marineRimeSiteAdapter();
    if (!marineRimeAdapterSupportsPage(adapter)) return;
    document.addEventListener('click', marineRimeHandleClick, true);
    document.addEventListener('focusin', function (event) {
      const editor = marineRimeEditorFromEvent(event);
      // Moving between descendants of a real editor should retain the lease.
      // A focusin on an ordinary button/link must not cancel the focusout
      // timer, otherwise a stale reply target survives after leaving its box.
      if (editor) {
        if (marineRimeTarget.blurTimer) { clearTimeout(marineRimeTarget.blurTimer); marineRimeTarget.blurTimer = null; }
        marineRimeRefreshFromEvent(event);
      }
    }, true);
    document.addEventListener('focusout', marineRimeHandleFocusOut, true);
    document.addEventListener('keydown', function (event) {
      if (event && event.key === 'Escape') {
        // 生成/打字进行中时，Esc 先停下这一轮（已敲进输入框的文字保留，它就是草稿），
        // 不清目标，方便用户接着改或重新生成。
        if (marineRimeGenBusy()) {
          marineRimeGenAbort('escape');
          return;
        }
        marineRimeReleaseDirectScope('escape', true);
        marineRimeClearPendingReply('escape');
      }
    }, true);
    window.addEventListener('scroll', marineRimeSchedulePosition, true);
    window.addEventListener('resize', marineRimeSchedulePosition, false);
    window.addEventListener('blur', function () {
      marineRimeRetainOrClear('window-blur');
    });
    window.addEventListener('focus', function () { setTimeout(function () { marineRimeRefreshFromEvent(null); }, 0); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // 必须显式中止打字：pump 靠自排 setTimeout 推进，标签页隐藏后会被浏览器
        // clamp 到 1s（重度节流后 60s），而它的两个中止条件在这里都不成立——
        // active 已被下面清成 null（所以 contextId 比较不触发），document.activeElement
        // 在隐藏标签页里仍等于那个输入框（所以焦点校验也通过）。不管的话就变成
        // 僵尸循环，用户切回来只看到半截草稿。已敲进去的字保留。
        marineRimeGenAbort('tab-hidden');
        marineRimeClearPendingReply('tab-hidden');
        marineRimeClear('tab-hidden');
      } else setTimeout(function () { marineRimeRefreshFromEvent(null); }, 0);
    });
    try {
      if (window.navigation && window.navigation.addEventListener) {
        window.navigation.addEventListener('navigate', function () {
          setTimeout(function () { marineRimeHandleNavigation(location.href); }, 0);
        });
      }
    } catch (e) {}
    // MAIN-world history hooks are the fast path. This isolated-world watcher
    // is the deterministic fallback when another page script replaces those
    // hooks or Chrome reports tabs.onUpdated before postMessage crosses worlds.
    setInterval(function () {
      if (location.href !== marineRimeTarget.pageUrl) marineRimeHandleNavigation(location.href);
    }, 250);
    window.addEventListener('pagehide', function () {
      marineRimeClearPendingReply('pagehide');
      marineRimeClear('pagehide');
    });
    window.addEventListener('pageshow', function (event) {
      // A document restored from BFCache keeps its JavaScript heap. Give that
      // restored document a new source lease so the service worker can reject
      // genuinely late messages from the pre-navigation incarnation while
      // still accepting this legitimate restoration.
      if (event && event.persisted) {
        marineRimeTarget.sourceId = marineRimeNewSourceId();
        marineRimeTarget.activationSerial = 0;
        marineRimeClearPendingReply('bfcache-restore');
      }
      setTimeout(function () { marineRimeRefreshFromEvent(null); }, 0);
    });
    setInterval(marineRimeRenew, 60000);
    if (typeof MutationObserver === 'function' && document.documentElement) {
      marineRimeTarget.lifecycleObserver = new MutationObserver(marineRimeScheduleLifecycleCheck);
      try {
        marineRimeTarget.lifecycleObserver.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'hidden', 'aria-hidden', 'style'],
        });
      } catch (e) {
        try { marineRimeTarget.lifecycleObserver.disconnect(); } catch (ignore) {}
        marineRimeTarget.lifecycleObserver = null;
      }
    }
    // Readiness marker for unpacked-extension development and E2E fixtures.
    // It carries no context or credentials and is never trusted as input.
    if (document.documentElement) document.documentElement.setAttribute('data-marine-rime-ready', '1');
  }

  // ---- 通用提取：优先 TextTrack，其次被动捕获 ----
  function extractGeneric() {
    const trk = trackSources();
    if (trk.length) {
      const cues = cuesFromSource(trk[0].id);
      if (cues.length) return { ok: true, source: 'texttrack', lang: '', langs: [], cues };
    }
    const cap = capturedSources();
    if (cap.length) {
      const cues = cuesFromSource(cap[0].id);
      if (cues.length) return { ok: true, source: 'captured', lang: '', langs: [], cues };
    }
    return { ok: false, error: '本页未发现可提取的字幕。若是流媒体站点，请先开始播放并打开字幕，再回到这里重试。' };
  }

  // ---- 调试快照：打包当前页的捕获响应 + SSR 状态 + DOM 样本 + 平台信息 ----
  // 给开发者调平台解析用：直接看页面真实 API 结构 / DOM，无需猜字段。
  function marineDebugSnapshot() {
    const platform = detectPlatform();
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n…[已截断，原长 ' + s.length + ']' : s; };
    const snap = {
      meta: {
        platform, label: PLATFORM_LABEL[platform],
        url: location.href, host: location.hostname, title: document.title,
        ua: navigator.userAgent, time: new Date().toISOString(),
      },
      captureCount: commentCaptures.length,
      captures: commentCaptures.slice(-12).map(function (c) { return { url: c.url, body: clip(c.body, 20000) }; }),
      ssr: {},
      domSamples: {},
      grab: null,
    };
    // SSR 状态：知乎 #js-initialData（script 标签，可读）；小红书/其它 __INITIAL_STATE__（找含它的 script）
    try {
      const zi = document.getElementById('js-initialData');
      if (zi && zi.textContent) snap.ssr.jsInitialData = clip(zi.textContent, 40000);
      const scripts = document.scripts || [];
      for (let i = 0; i < scripts.length; i++) {
        const t = scripts[i].textContent || '';
        if (t.indexOf('__INITIAL_STATE__') >= 0 || t.indexOf('__NEXT_DATA__') >= 0) { snap.ssr.pageState = clip(t, 40000); break; }
      }
    } catch (e) { snap.ssr.error = String(e && e.message || e); }
    // DOM 样本：命中的前几个候选评论/内容容器 outerHTML（供回填定位调参）
    try {
      const sels = ['bili-comments', '.reply-item', '.comment-item', '.Comments-container', '.CommentItem',
        '.List-item', '.AnswerItem', '.RichContent', '.comments-el', '.note-scroller', '[class*="comment" i]'];
      let got = 0;
      for (const sel of sels) {
        if (got >= 4) break;
        let el; try { el = document.querySelector(sel); } catch (e) { continue; }
        if (el) { snap.domSamples[sel] = clip(el.outerHTML, 6000); got++; }
      }
    } catch (e) { snap.domSamples.error = String(e && e.message || e); }
    // 当前解析结果摘要
    try {
      const b = marineBuildComments(platform, commentCaptures);
      snap.grab = {
        ok: b.ok, count: b.stats && b.stats.count, roots: b.stats && b.stats.roots,
        subs: b.stats && b.stats.subs, error: b.error,
        sampleAgentMd: clip(b.ok ? marineCommentsForAgent(b.comments, 20) : '', 2000),
      };
    } catch (e) { snap.grab = { error: String(e && e.message || e) }; }
    return snap;
  }

  // ---- 消息路由 ----
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    (async () => {
      try {
        if (msg && msg.type && msg.type !== 'PING') {
          marineLog('info', 'cmd', msg.type + (msg.opts && Object.keys(msg.opts).length ? ' ' + JSON.stringify(msg.opts) : ''));
        }
        switch (msg && msg.type) {
          case 'PING':
            sendResponse({ ok: true, platform: detectPlatform(), platformLabel: PLATFORM_LABEL[detectPlatform()], url: location.href, title: document.title });
            break;
          case 'GET_LOGS':
            sendResponse({ logs: marineDebug.buffer() });
            break;
          case 'GET_RIME_DIAGNOSTICS':
            sendResponse({
              events: marineDebug.buffer().filter(function (entry) { return entry && entry.tag === 'rime-diag'; }),
            });
            break;
          case 'CLEAR_LOGS':
            marineDebug.clear();
            sendResponse({ ok: true });
            break;
          case 'DEBUG_SNAPSHOT':
            sendResponse({ ok: true, snapshot: marineDebugSnapshot() });
            break;
          case 'LIST_SOURCES': {
            const plat = detectPlatform();
            sendResponse({
              ok: true, platform: plat,
              extra: capturedSources().concat(trackSources())   // 平台原生字幕之外，被动捕获 + TextTrack
            });
            break;
          }
          case 'EXTRACT_SUBTITLE': {
            const plat = detectPlatform();
            const opts = msg.opts || {};
            let result;
            if (opts.sourceId) result = wrapCues(cuesFromSource(opts.sourceId));
            else if (plat === 'youtube') result = await marineExtractYouTube(opts);
            else if (plat === 'bilibili') result = await marineExtractBilibili(opts);
            else result = extractGeneric();
            marineLog(result.ok ? 'ok' : 'error', 'iso',
              '字幕提取' + (result.ok ? '成功：' + (result.cues ? result.cues.length + ' 条' : 'ok') + '（' + result.source + '）' : '失败：' + result.error));
            sendResponse(result);
            break;
          }
          case 'EXTRACT_TEXT': {
            const tr = marineExtractStructuredText();
            marineLog(tr.ok ? 'ok' : 'error', 'iso', '文本提取' + (tr.ok ? '成功：约 ' + tr.chars + ' 字' : '失败：' + tr.error));
            sendResponse(tr);
            break;
          }
          case 'EXTRACT_COMMENTS': {
            const built = marineBuildComments(detectPlatform(), commentCaptures);
            marineLog(built.ok ? 'ok' : 'warn', 'iso',
              '评论抓取：' + built.stats.count + ' 条（根 ' + (built.stats.roots || 0) + ' / 楼中楼 ' + (built.stats.subs || 0) + '）');
            sendResponse(marineCommentsResult(built));
            break;
          }
          case 'DRIVE_COMMENTS':
            sendResponse(await marineDriveComments(msg.opts || {}));
            break;
          case 'GRAB_ALL':
            sendResponse(await marineGrabAll(msg.opts || {}));
            break;
          case 'RESET_COMMENTS':   // 页内导航（换视频）时清空旧评论缓冲
            commentCaptures.length = 0;
            lastGrabParts = null;
            sendResponse({ ok: true });
            break;
          case 'REBUILD_COMMENTS': {   // 被动评论到了 → 不滚动、只重建并回传（含 bundle）
            const built = marineBuildComments(detectPlatform(), commentCaptures);
            const parts = lastGrabParts || { textMarkdown: '', cues: null };
            const bundle = marineBuildBundle({
              platform: detectPlatform(), url: location.href,
              textMarkdown: parts.textMarkdown,
              comments: built.ok ? built.comments : [],
              cues: parts.cues,
            });
            sendResponse({ ok: true, comments: marineCommentsPanelPayload(built), bundle });
            break;
          }
          case 'LOAD_MORE_COMMENTS': {
            await marineDriveOnce();
            const built = marineBuildComments(detectPlatform(), commentCaptures);
            const parts = lastGrabParts || { textMarkdown: '', cues: null };
            const bundle = marineBuildBundle({
              platform: detectPlatform(), url: location.href,
              textMarkdown: parts.textMarkdown,
              comments: built.ok ? built.comments : [],
              cues: parts.cues,
            });
            marineLog('ok', 'iso', '加载更多评论 → 累计 ' + (built.ok ? built.stats.count : 0) + ' 条');
            sendResponse({ ok: true, comments: marineCommentsPanelPayload(built), bundle });
            break;
          }
          case 'INJECT_REPLY_DRAFT':
            sendResponse(await marineInjectReplyDraft(msg.opts || {}));
            break;
          default:
            sendResponse({ ok: false, error: '未知指令' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;   // 异步 sendResponse 必须返回 true
  });

  function wrapCues(cues) {
    return cues && cues.length
      ? { ok: true, source: 'source', lang: '', langs: [], cues }
      : { ok: false, error: '该来源暂无字幕内容。' };
  }

  // 日志转发到侧边栏「调试」tab（GET_LOGS 取历史 + 实时 __marineLog 推送），无页面悬浮层
  //
  // 平台适配器现在只注入到各自的站点，和本文件分属不同的 content_scripts 条目。
  // Chrome 按 manifest 顺序注入，但跨条目顺序并不在文档契约里。本该有适配器的站点上
  // 如果注册表还没落地，就推迟一个宏任务再启动（同批 document_idle 脚本此时必已执行
  // 完），避免静默退回 marineRimeAdapterSupportsPage 里「只认 B 站 /video/」的兜底
  // 分支——那会让知乎/小红书/抖音一个监听器都挂不上。其它站点保持同步启动，行为不变。
  if (!globalThis.MarineCommentTargetAdapters && ADAPTER_PLATFORMS[detectPlatform()]) {
    setTimeout(marineRimeStartTargetTracking, 0);
  } else {
    marineRimeStartTargetTracking();
  }
  marineLog('info', 'iso', '已加载 · 平台=' + PLATFORM_LABEL[detectPlatform()] + ' · ' + location.href);
})();
