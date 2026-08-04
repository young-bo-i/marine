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
      else textRes = marineExtractStructuredText(opts.scope);
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
      // 这个函数是**逐字段重建**消息的，不是把 operation 整个发过去 —— 漏一个
      // 字段就等于那个特性从未存在，而且没有任何报错。编排标记就在这里被丢过
      // 一次：SW 侧的豁免代码是对的、content 侧也确实设了标记，可它到不了 SW，
      // 表现为「鼠标一移开就 deferred」和之前一模一样，白查了很久。
      orchestrated: operation.orchestrated === true,
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
          if (!response.deferred) {
            // 「SW 收下了但没写」以前在这里静默返回。编排跳过推迟闸之后连
            // `deferred` 都没有，于是下面那条 warn 也不会打 —— 整条链路上一个字
            // 都不出，12 秒后以「目标准备超时」收场，把矛头指向输入框和本地服务，
            // 两个方向都是错的。记下原因，让超时文案能说出真话。
            const why = String((response && response.reason) || 'unknown');
            marineRimeTarget.lastSkipReason = why;
            if (operation.orchestrated === true) {
              marineLog('warn', 'rime-target', operation.op + ' 被 SW 跳过：' + why);
            }
            return { ok: true, applied: false, skipped: true, response };
          }
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

  // 由 marineRimeRender 每帧调用：把「生成」按钮定位到活动编辑框右上角；
  // 切到另一个 contextId 的目标时中止在途生成。
  function marineRimeGenSync() {
    const els = marineRimeGenEnsureUI();
    const active = marineRimeTarget.active;

    // 编排期间不因目标切换中止在途生成 —— 上面已经冻结了人工事件，这里是双保险
    // （比如适配器自己因为 DOM 重绘换了 contextId）。人工使用时行为不变。
    if (active && marineRimeGenBusy() && marineRimeGen.contextId &&
        active.contextId !== marineRimeGen.contextId && !marineProspectOrchestrating) {
      marineRimeGenAbort('target-switched');
    }

    // 打字期间锚定到快照编辑框；空闲时锚定到当前活动编辑框。
    const anchorEl = marineRimeGenBusy() ? marineRimeGen.editor : (active && active.editor);
    let rect = null;
    if (anchorEl && anchorEl.isConnected && marineVisible(anchorEl)) {
      try { rect = anchorEl.getBoundingClientRect(); } catch (e) { rect = null; }
    }
    if (rect && rect.bottom > 0 && rect.top < innerHeight) {
      const rightEdge = innerWidth - 4;
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
    // 把结束原因暴露出来：`done` 才是「整段敲完了」，其余（escape / 标签页隐藏
    // 等中止）都会走到同一个函数、同样把 state 落回 idle。编排必须能分清这两者
    // —— 分不清就会把中止当成完成，然后**发出半截评论**（实测在知乎发出过只有
    // 两个字的评论）。序号用来区分「这一轮的结束」和「上一轮留下的结束」。
    marineRimeGen.lastFinish = reason;
    marineRimeGen.finishSeq = (marineRimeGen.finishSeq || 0) + 1;
    marineRimeGen.streamDone = false;
    marineRimeGen.raw = '';
    marineRimeGen.wanted = '';
    if (typed && reason === 'done') {
      // 上报本次「页内生成并写入」的文本：稍后若这条被发布，sw 会据此把账本的
      // generation_source 标注为 'extension'（页内生成），区别于输入法/手填。
      try { chrome.runtime.sendMessage({ __marineGenFill: true, text: typed }); } catch (e) {}
      marineLog('ok', 'iso', '已写入并核对生成草稿，准备自动提交');
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
    // 和 `marineRimeGenFinish` 一样要推进 finishSeq。
    //
    // 之前只有 finish 写它，于是所有走 fail 的失败（输入框失效、生成结果为空、
    // 后端报错…）在编排看来既不是完成也不是中止 —— 只能干等到 120 秒超时，
    // **所有失败都伪装成「生成超时」**，把排查往生成侧带偏。实测抖音那几轮
    // 正是如此：`wanted` 已经是完整一整段，报的却是超时。
    marineRimeGen.lastFinish = 'fail:' + String(label || '');
    marineRimeGen.finishSeq = (marineRimeGen.finishSeq || 0) + 1;
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

  /**
   * 打字过程中重新解析编辑框。
   *
   * Draft.js（知乎）在接收输入时会**重建 DOM 节点**，我们打字开始时拿到的引用
   * 当场失效 —— 实测：敲到第 3 个字 `editor.isConnected` 变 false，整轮生成以
   * 「目标输入框已失效」告终。手动操作之所以不出问题，是因为人会先点一下输入
   * 框、等它挂载稳定了再点生成；编排是点完立刻生成，抢在重建之前拿了引用。
   *
   * 引用会变，选择器不会。
   *
   * **不限编排**：节点重建是 Draft.js 自己的行为，跟谁触发生成无关 —— 手动点
   * 「生成」一样会敲到一半就停（实测：只写进第一个输出块）。曾经把这层保护限
   * 定在编排模式，等于只修了一半。
   *
   * 安全性来自两点，不是来自「谁触发的」：只在原节点**已经从文档上消失**时才
   * 触发（还在就绝不换），且换回来的必须仍被 `marineRimeIsCommentEditor` 认成
   * 评论输入框。两条都满足时换过去是唯一正确的动作 —— 原节点已经不存在，继续
   * 往它上面敲字什么也不会发生。
   */
  function marineProspectRecoverEditor(stale) {
    let fresh = marineProspectFindCommentEditor(marineCommentSearchRoot());
    if (!fresh) {
      // 输入框可能**整个消失了**，不只是换了节点。
      //
      // 知乎（Draft.js）是原地重建：旧节点失效、新节点立刻在同一位置出现，
      // 重新查询就够。抖音同样是 Draft.js，但重建时会把整条输入条一起收起来 ——
      // 实测那一刻页面上 `[contenteditable]` 的数量是 **0**，重新查询查无可查。
      //
      // 所以要允许再走一遍「打开评论区」。这一步是幂等的（已经开着就什么都不做），
      // 反复调用安全。
      // 重开是**两步**流程（图标 → 占位条），一次调用只推进一步，
      // 靠打字泵的重试预算反复调用来走完。
      try { marineProspectOpenCommentPanel(detectPlatform()); } catch (e) {}
      fresh = marineProspectFindCommentEditor(marineCommentSearchRoot());
    }
    if (!fresh || !fresh.isConnected || fresh === stale) return null;
    return fresh;
  }

  function marineRimeGenPump() {
    const g = marineRimeGen;
    g.typeTimer = 0;
    if (g.state !== 'typing' && g.state !== 'streaming') return;

    // 抖音：整段交给 Rust 侧用 CDP 真实键盘事件敲，不走页内写入。
    //
    // 它的编辑器对 `execCommand('insertText')` 有反制 —— 写一两个字就把整个评论
    // 组件拆掉，而且点评论图标都恢复不了，手动点「生成」一样。CDP
    // `Input.dispatchKeyEvent` 产生的是浏览器层面的可信事件，实测同一个编辑器
    // 连打 8 个字毫发无损。
    //
    // 只对抖音这么做：另外三个平台的页内写入已经真实验证过，不该为它承担风险。
    if (detectPlatform() === 'douyin' && !g.douyinDelegated) {
      // 等整段产出完再委托：`wanted` 在流式过程中只是「目前收到的部分」，
      // 提前交出去会只敲半截。CDP 是一次性把整段打完，没有续打的语义。
      if (!g.streamDone) { g.typeTimer = setTimeout(marineRimeGenPump, 300); return; }
      g.douyinDelegated = true;
      void marineProspectTypeViaCdp(g.wanted).then(function (ok) {
        // 无论成败都把 typed 推到终点：成了就是真敲完了，败了让上层的
        // 「发送前核对输入框内容」那道闸去拦，不在这里静默继续敲。
        g.typed = ok ? g.wanted : g.typed;
        marineRimeGenFinish(ok ? 'done' : 'fail:CDP 打字失败');
      });
      return;
    }


    let editor = g.editor;
    if (!editor || !editor.isConnected) {
      // 节点被重建了就换成新的那个，而不是判死刑（见 marineProspectRecoverEditor）。
      const fresh = marineProspectRecoverEditor(editor);
      if (!fresh) {
        // 抖音重建时输入条会整个消失一小会儿。立刻判死会把一次正常的重挂载
        // 当成失败 —— 给它几轮时间，重挂上就继续敲。
        // 预算要够走完「重开评论区」这条慢路。
        //
        // 抖音敲第一个字就会把**整个评论面板**收起来（不只是输入框重建）：实测
        // 那一刻 `[data-e2e=comment-list]` 一起消失，只剩 `feed-comment-icon`。
        // 恢复要重新走「点图标 → 等列表渲染 → 点占位条」两步，实测十几秒。
        // 4.8 秒的预算刚好差一点，表现成「生成超时」，而 wanted 已经是完整
        // 一整段（136 字）—— 症状会误导人去查生成侧。
        g.recoverTries = (g.recoverTries || 0) + 1;
        if (g.recoverTries <= 40) {
          g.typeTimer = setTimeout(marineRimeGenPump, 600);
          return;
        }
        marineRimeGenFail('目标输入框已失效，请重新点选后再生成');
        return;
      }
      g.recoverTries = 0;
      editor = fresh;
      g.editor = fresh;
      // 基线要跟着换：新节点里已有的文本就是新的起点，沿用旧基线会把已经敲进去
      // 的内容再算一遍。
      g.baseline = (marineTextOf(fresh) || '').slice(0, Math.max(0, (marineTextOf(fresh) || '').length - g.typed.length));
      try { fresh.focus(); } catch (e) {}
    }
    // contenteditable 的 insertText 落在「当前聚焦元素」上，焦点跑了就必须停手，
    // 否则会把话术写进别人的输入框。
    //
    // **先把焦点抢回来再停手**：知乎的评论弹层在敲字过程中会短暂夺走焦点，
    // 一次都不容忍的话敲到第二个字就中止。抢回来是安全的 —— `editor` 就是当前
    // 这一轮的目标，`focus()` 只会把焦点还给它自己，绝不会写到别人的输入框里
    // （那条原始担忧针对的是「焦点在别处时继续 insertText」，这里恰恰相反）。
    // 抢不回来（元素没了/被禁用）才真的停手。
    //
    // 同样不限编排：夺焦是 Draft.js 重绘的副作用，手动点生成一样会碰到。
    if (!marineRimeGenEditorFocused(editor)) {
      let recovered = false;
      if (editor && editor.isConnected) {
        try { editor.focus(); recovered = marineRimeGenEditorFocused(editor); } catch (e) {}
      }
      if (!recovered) { marineRimeGenAbort('focus-lost'); return; }
    }

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
    let editor = g.editor;
    if (!editor || !editor.isConnected) {
      const fresh = marineProspectRecoverEditor(editor);
      if (!fresh) { marineRimeGenFail('目标输入框已失效，请重新点选后再生成'); return; }
      editor = fresh;
      g.editor = fresh;
    }
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
    if (marineRimeGenBusy()) return false;
    const active = marineRimeTarget.active;
    if (!active) {
      marineRimeGenEnsureUI();
      marineRimeGenShowError('请先点选一个评论/回复框');
      return false;
    }
    if (!active.publishedContext) {
      // 上下文 PUT 是异步的（往返可能 1~2s）。刚聚焦就点「生成」时不该报错——
      // 先进「准备中」，发布完成后自动继续。
      marineRimeGenWaitForPublish(active);
      return true;
    }
    marineRimeGenLaunch({
      contextId: active.contextId,
      mode: active.mode,
      editor: active.editor,
      target: active.target,
    });
    return true;
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
        // 带上 SW 的拒写原因。原来这句只说「重新点选输入框 / 检查本地服务」，
        // 而绝大多数情况下真实原因是 SW 的归属闸把 PUT 挡了（reason: authority /
        // suspended-lease / …），照它指的两个方向查一定查不到。
        const skip = marineRimeTarget.lastSkipReason;
        marineRimeGenFail(skip
          ? '目标准备超时（上下文未落地：' + String(skip) + '）'
          : '目标准备超时，请重新点选输入框再试（若持续，请检查 Marine 本地服务连接）');
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
      // 编排期间标签页多半不在前台（人在用别的程序），而 SW 默认只让活动标签页
      // 占用那个全局上下文槽位。这个标记让 SW 知道「这是编排在驱动」，跳过焦点
      // 闸。安全上没有放宽：消息只能来自本扩展的 content script（isolated
      // world），页面 JS 发不出来。
      orchestrated: marineProspectOrchestrating === true,
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
    // `directScope` 是脱敏后要上行的那份（只有 id/kind/title/authorName）。
    // `scope` 额外带上作用域元素，只在本地用于把正文抽取收窄到这一块，绝不外发。
    const scopeElement = (info && info.directScope && info.directScope.element) || null;
    const value = await Promise.race([
      marineGrabAll({
        directScope,
        scope: scopeElement
          ? { element: scopeElement, title: directScope && directScope.title }
          : null,
      }),
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

  /**
   * 编排模式。
   *
   * 存在的理由：整套目标追踪是给**人用侧边栏**设计的，隐含假设是「用户正看着
   * 这个标签页」。两条行为直接建立在这个假设上：
   *   1. 窗口失焦就清掉投放目标（`window-blur`）
   *   2. SW 只让当前活动标签页占用那个全局 Rime 上下文槽位，后台 tab 的 PUT
   *      被推迟并在 5 秒后丢弃
   *
   * 对编排来说这两条都是错的：调度器**独占**这个浏览器，就一个标签页在干活，
   * 而运行期间人必须能用鼠标干别的（跑 5 个号 × 4 个平台要占用机器很久）。
   * 实测形态：鼠标一移开，日志立刻出现 `已清理投放目标：window-blur` +
   * `put 失败：Marine Rime context deferred`，然后生成超时、台账记 failed、
   * 那条靶子按「失败不重试」永久作废。
   *
   * 刻意做成**有明确起止**的模式而不是全局常开：非编排时那两条保护仍然生效，
   * 人手动用侧边栏的行为一点不变。
   */
  let marineProspectOrchestrating = false;

  function marineProspectSetOrchestrating(on) {
    marineProspectOrchestrating = !!on;
  }

  function marineRimeRetainOrClear(reason) {
    // 编排 + 正在生成时，任何失焦都不得清掉目标。
    //
    // 失焦有**三条**独立路径，之前只豁免了 `window-blur` 一条：
    //   · `window-blur`  —— 人切到别的程序（编排期间是常态）
    //   · `editor-blur`  —— 焦点离开输入框（小红书的评论条会自己夺焦，实测）
    //   · 打字泵里的逐字焦点检查（已单独处理：先抢回来，抢不回才停手）
    // 只堵一条的后果是换个平台就复发 —— 小红书正是走 `editor-blur` 断的。
    //
    // 限定在**生成进行中**：生成结束后保护立刻恢复，人工点走目标该清还是清。
    if (marineProspectOrchestrating && marineRimeGenBusy()) {
      marineRimeSchedulePosition();
      return true;
    }
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
    // 编排正在生成时，人工点击/聚焦不得改写投放目标。
    //
    // 编排独占这个标签页，而运行期间人要用鼠标干别的 —— 随手点一下页面别处就
    // 会激活另一个编辑框、换掉 contextId，`marineRimeGenSync` 随即
    // `abort('target-switched')`，一整轮生成白费。实测就是这么中断的。
    //
    // 只在**生成进行中**冻结，生成结束后立刻恢复：不是把目标追踪关掉，而是
    // 不让它在最不能被打断的那段时间里插手。
    if (marineProspectOrchestrating && marineRimeGenBusy()) return;
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
    // 这里只由真实 URL/navigation 变更进入，不是评论组件的 DOM 重挂载。
    // 编排期间可容忍同一内容的 editor/contextId 重建，但 SPA 换内容时
    // 必须立即中止在途生成，避免把 A 的文案继续写进 B 的输入框。
    marineRimeGenAbort('navigation');
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
        // 编排期间不中止。这是四条失焦路径里唯一没有编排豁免的一条（window-blur
        // 和 editor-blur 都走 marineRimeRetainOrClear，那里已经豁免了），而它是
        // 唯一「秒杀」级的——窗口被别的程序完全盖住或最小化就触发，一触发就
        // 中止生成 → 台账记 failed → 靶子按「失败不重试」作废。编排本来就是要在
        // 人用别的程序时跑完的，隐藏是常态不是异常。
        //
        // 这里刻意**不加** marineRimeGenBusy() 条件（和 marineRimeRetainOrClear
        // 不同）：等输入框的那 40 秒里 GenBusy 为假，而那恰恰是人最可能切走的时段；
        // 一旦清掉投放目标，等待方 40 秒后报「未能定位到直评输入框」，症状指向
        // 输入框，真实原因是可见性——查错方向会被带偏。
        if (marineProspectOrchestrating) { marineRimeSchedulePosition(); return; }
        // 非编排（人在用侧边栏）时必须显式中止打字：pump 靠自排 setTimeout 推进，
        // 标签页隐藏后会被浏览器 clamp 到 1s（重度节流后 60s），而它的两个中止
        // 条件在这里都不成立——active 已被下面清成 null（所以 contextId 比较不
        // 触发），document.activeElement 在隐藏标签页里仍等于那个输入框（所以焦点
        // 校验也通过）。不管的话就变成僵尸循环，用户切回来只看到半截草稿。
        // 已敲进去的字保留。
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
  // 已支持站点上，平台适配器与本文件位于同一条 content_scripts 的 js 数组，
  // 并且适配器排在 content-iso 之前。这里仍保留一个宏任务的容错：如果旧版注入、
  // 测试沙箱或未来 manifest 拆分导致注册表还没落地，就等当前批次执行完再
  // 启动，避免知乎/小红书/抖音的目标监听器静默缺席。其它站点保持同步启动。
  if (!globalThis.MarineCommentTargetAdapters && ADAPTER_PLATFORMS[detectPlatform()]) {
    setTimeout(marineRimeStartTargetTracking, 0);
  } else {
    marineRimeStartTargetTracking();
  }
  marineLog('info', 'iso', '已加载 · 平台=' + PLATFORM_LABEL[detectPlatform()] + ' · ' + location.href);

  // ---- 发现侧编排：落到搜索页就自动开工 ----------------------------------
  //
  // 触发方式刻意是「启动网址落地即跑」而不是按钮：Donut 启动 profile 时按该
  // 账号的筛选位下发搜索 URL（marine/search_slot.rs），所以这里不需要拼 URL，
  // 也不需要人点任何东西。非搜索页 shouldRun 直接返回 false。
  //
  // 搜索页领取后会继续驱动靶子页的既有生成/发送链路；是否自动提交由交接单里的
  // stopAfter 与平台回执能力共同决定，见 prospect-run.js。
  const MARINE_PROSPECT_BOOT_DELAYS_MS = [0, 50, 100, 250, 500, 1000, 2000];
  // MV3 cold wake + runtime config + session/local durable CAS 偶尔会超过 1s。消息超时
  // 不会取消 SW 已开始的写，过早判失败会造成“页面说没写成、后台其实稍后成功”的
  // 分叉；read 有上层重试给 3s，涉及不可逆凭据的 mutation 给足 5s。
  const MARINE_PROSPECT_HANDOFF_READ_TIMEOUT_MS = 3000;
  const MARINE_PROSPECT_HANDOFF_MUTATION_TIMEOUT_MS = 5000;
  const MARINE_PROSPECT_CONTROL_TIMEOUT_MS = 5000;
  // SW 内部 ready GET 自身有 5s abort；content 必须稍长，避免边界上先把
  // 一个 SW 正在返回的权威失败压成 message_timeout。
  const MARINE_PROSPECT_READY_TIMEOUT_MS = 7000;
  const MARINE_PROSPECT_API_TIMEOUT_MS = 20000;
  const MARINE_PROSPECT_TYPE_TIMEOUT_MS = 185000;
  // 与 Rust 等待 document commit 的窗口对齐。正常站点首字节 6–10s 并不少见；
  // 5s 会在首导航仍进行时再次 assign，反而取消本可成功的请求。
  const MARINE_PROSPECT_NAVIGATION_WATCHDOG_MS = 12000;
  let marineProspectPhaseAStarted = false;
  let marineProspectBridgeReadyPromise = null;
  let marineProspectReadyProfileId = '';

  function marineProspectAutomationHost() {
    const host = String((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
    return host === 'bilibili.com' || host.endsWith('.bilibili.com') ||
      host === 'zhihu.com' || host.endsWith('.zhihu.com') ||
      host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') ||
      host === 'xhslink.com' || host.endsWith('.xhslink.com') ||
      host === 'douyin.com' || host.endsWith('.douyin.com');
  }

  function marineProspectWarmupPage(href) {
    try {
      const url = new URL(String(href || ''));
      const host = url.hostname.toLowerCase();
      // scheduler 为避免 XHS 从 about:blank 冷跳搜索导致 renderer 卡死，会先提交
      // 官网首页并停约 4s。它不是 Phase B 靶子；读取/消费旧 handoff 会与随后搜索
      // 导航打架，甚至提前改变 scheduler baseline。
      return (host === 'xiaohongshu.com' || host === 'www.xiaohongshu.com') &&
        (url.pathname === '' || url.pathname === '/');
    } catch (e) {
      return false;
    }
  }

  function marineProspectMarkBootstrapFailed(phase, label) {
    try {
      document.documentElement.removeAttribute('data-marine-prospect-ready');
      document.documentElement.setAttribute('data-marine-prospect-failed', phase);
    } catch (e) {}
    const status = phase === 'phase_b' ? 'target_bootstrap_failed' : 'prospect_bootstrap_failed';
    marineLog('error', 'iso', JSON.stringify({ status, phase, label }));
  }

  function marineProspectScheduleBoot(start, attempt, label, phase) {
    const next = (Number(attempt) || 0) + 1;
    if (next >= MARINE_PROSPECT_BOOT_DELAYS_MS.length) {
      marineProspectMarkBootstrapFailed(phase, label);
      return;
    }
    setTimeout(() => start(next), MARINE_PROSPECT_BOOT_DELAYS_MS[next]);
  }

  function marineProspectPhaseAReady() {
    return typeof marineProspectRun !== 'undefined' && marineProspectRun &&
      typeof marineProspectRun.shouldRun === 'function' &&
      typeof marineProspectRun.run === 'function' &&
      typeof marineLogin !== 'undefined' && marineLogin && typeof marineLogin.status === 'function' &&
      typeof marineDiscovery !== 'undefined' && marineDiscovery &&
      typeof marineDiscovery.parseFor === 'function' &&
      marineDiscovery.canary && typeof marineDiscovery.canary.check === 'function';
  }

  function marineProspectPhaseBReady() {
    return typeof marineProspectRun !== 'undefined' && marineProspectRun &&
      typeof marineProspectRun.platformOfSearchPage === 'function' &&
      typeof marineProspectRun.runOnTargetSingleFlight === 'function';
  }

  function marineProspectSend(message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => finish({ ok: false, error: 'message_timeout' }), Number(timeoutMs));
      }
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          const lastError = chrome.runtime.lastError;
          finish(reply || { ok: false, error: lastError && lastError.message });
        });
      } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
    });
  }

  async function marineProspectEnsureBridgeReady() {
    try {
      if (document.documentElement.getAttribute('data-marine-prospect-ready') === '1' &&
          marineProspectReadyProfileId) return true;
    } catch (e) {}
    if (marineProspectBridgeReadyPromise) return await marineProspectBridgeReadyPromise;

    const probe = marineProspectSend(
      { __marineProspectReady: true },
      MARINE_PROSPECT_READY_TIMEOUT_MS,
    ).then((reply) => {
      const profileId = String((reply && reply.profileId) || '').trim();
      if (!reply || reply.ok !== true || !profileId) return false;
      marineProspectReadyProfileId = profileId;
      try {
        document.documentElement.setAttribute('data-marine-prospect-ready', '1');
        document.documentElement.removeAttribute('data-marine-prospect-failed');
      } catch (e) {}
      return true;
    }).catch(() => false);
    marineProspectBridgeReadyPromise = probe;
    const ready = await probe;
    if (!ready && marineProspectBridgeReadyPromise === probe) {
      marineProspectBridgeReadyPromise = null;
    }
    return ready;
  }

  /**
   * 提交精确导航，并确认旧 document 真的离开了。
   *
   * `location.href` 可能在旧 document 卸载前就变成目标 URL，因此不把字符串
   * 相等当成成功。只有 pagehide/unload（或文档已不再存活）才取消
   * watchdog。第一个窗口后旧文档仍活着就精确重提交一次；第二个
   * 窗口仍存活就返回单个结构化终局，不再建新 timer。
   *
   * runtime 只用于无浏览器 smoke 注入可控时钟/生命周期；正式路径不传。
   */
  function marineProspectNavigateWithWatchdog(url, meta, runtime) {
    runtime = runtime || {};
    meta = meta || {};
    const expected = String(url || '');
    const host = runtime.window || (typeof window !== 'undefined' ? window : null);
    const doc = runtime.document || (typeof document !== 'undefined' ? document : null);
    const loc = runtime.location || (typeof location !== 'undefined' ? location : null);
    const schedule = runtime.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = runtime.clearTimeout || ((id) => clearTimeout(id));
    const delay = Number.isFinite(runtime.delayMs) && runtime.delayMs >= 0
      ? runtime.delayMs
      : MARINE_PROSPECT_NAVIGATION_WATCHDOG_MS;

    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      let attempts = 0;
      let lastError = '';

      const got = () => {
        try { return String((loc && loc.href) || ''); } catch (e) { return ''; }
      };
      const documentAlive = () => {
        if (typeof runtime.documentAlive === 'function') {
          try { return runtime.documentAlive() === true; } catch (e) { return false; }
        }
        try { return !!(doc && doc.documentElement && doc.defaultView !== null); }
        catch (e) { return false; }
      };
      const cleanup = () => {
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        if (host && typeof host.removeEventListener === 'function') {
          host.removeEventListener('pagehide', onDocumentGone);
          host.removeEventListener('unload', onDocumentGone);
        }
      };
      const finish = (status) => {
        if (finished) return;
        finished = true;
        cleanup();
        const result = {
          status,
          expected,
          got: got(),
          key: String(meta.key || ''),
          attempts,
        };
        if (lastError) result.error = lastError;
        resolve(result);
      };
      function onDocumentGone() {
        finish('target_navigation_committed');
      }
      const submit = () => {
        attempts += 1;
        try {
          if (!loc || typeof loc.assign !== 'function') throw new Error('location.assign unavailable');
          loc.assign(expected);
        } catch (e) {
          lastError = String((e && e.message) || e);
        }
      };
      const check = () => {
        timer = null;
        if (finished) return;
        if (!documentAlive()) {
          finish('target_navigation_committed');
          return;
        }
        if (attempts < 2) {
          submit();
          if (!finished) timer = schedule(check, delay);
          return;
        }
        finish('target_navigation_stalled');
      };

      if (host && typeof host.addEventListener === 'function') {
        host.addEventListener('pagehide', onDocumentGone, { once: true });
        host.addEventListener('unload', onDocumentGone, { once: true });
      }
      submit();
      if (!finished) timer = schedule(check, delay);
    });
  }

  /**
   * 交接单存在 SW 侧（按 tab），不是 sessionStorage。
   *
   * sessionStorage 按 origin 分区，而搜索页和靶子页经常不同源 —— B 站永远是
   * （search.bilibili.com -> www.bilibili.com），知乎专栏文章也是。用它的后果
   * 是 Phase A 全绿、Phase B 静默不跑，台账里留下一条永远 claimed 的记录。
   */
  const marineProspectHandoffStore = {
    read: async () => {
      const r = await marineProspectSend(
        { __marineProspectHandoff: true, op: 'read' },
        MARINE_PROSPECT_HANDOFF_READ_TIMEOUT_MS,
      );
      if (!r || !r.ok) throw new Error((r && r.error) || 'handoff_read_failed');
      return r.data || null;
    },
    write: async (value) => {
      const r = await marineProspectSend(
        { __marineProspectHandoff: true, op: 'write', value },
        MARINE_PROSPECT_HANDOFF_MUTATION_TIMEOUT_MS,
      );
      return !!(r && r.ok);
    },
    clear: async (value) => {
      const r = await marineProspectSend(
        { __marineProspectHandoff: true, op: 'clear', value },
        MARINE_PROSPECT_HANDOFF_MUTATION_TIMEOUT_MS,
      );
      if (!r || !r.ok) throw new Error((r && r.error) || 'handoff_clear_failed');
    },
    deadLetter: async (value, reason) => {
      const r = await marineProspectSend(
        { __marineProspectHandoff: true, op: 'deadLetter', value, reason },
        MARINE_PROSPECT_HANDOFF_MUTATION_TIMEOUT_MS,
      );
      if (!r || !r.ok) throw new Error((r && r.error) || 'handoff_dead_letter_failed');
    },
  };

  async function marineStartProspectRun(bootAttempt) {
    if (!marineProspectAutomationHost()) return;
    if (marineProspectPhaseAStarted) return;
    if (!marineProspectPhaseAReady() || !marineProspectPhaseBReady()) {
      marineProspectScheduleBoot(marineStartProspectRun, bootAttempt, '发现侧编排', 'phase_a');
      return;
    }
    // 同一批脚本两个 Phase 都会启动，但每个 document 只让它所属的一侧
    // 做握手/打 marker，避免 A/B 同时耗尽后互相覆盖 failed 原因。
    if (!marineProspectRun.platformOfSearchPage(location.href)) return;
    if (!(await marineProspectEnsureBridgeReady())) {
      marineProspectScheduleBoot(marineStartProspectRun, bootAttempt, '发现侧编排·认证握手', 'phase_a');
      return;
    }
    const searchHref = location.href;
    if (!marineProspectRun.shouldRun(searchHref)) return;
    marineProspectPhaseAStarted = true;

    // SW 代发：apiBase/token 只有 SW 读得到，且路由在 SW 侧有白名单。
    const send = marineProspectSend;

    // SPA 的结果卡片在 document_idle 时通常还没渲染（知乎/抖音/小红书都是），
    // 这时解析条数不足、canary 判 unhealthy。所以非终局状态要退避重试，直到
    // 渲染完成或放弃。B 站是 SSR，第一次就成，重试不产生额外开销。
    const DELAYS_MS = [0, 1500, 3000, 5000, 8000, 12000];

    const attempt = async (i) => {
      const result = await marineProspectRun.run({
        profileId: marineProspectReadyProfileId,
        login: (platform) => marineLogin.status(platform),
        // 掉登录才上报，走 SW 的写死路由（不进页面可控的白名单）。
        // 不 await：编排不该为一次记账多等一个往返。
        reportLogin: (result) => {
          void marineProspectSend({ __marineLoginReport: true, result });
        },
        pageHtml: () => document.documentElement.outerHTML,
        parse: (platform, raw) => marineDiscovery.parseFor(platform, raw),
        canary: (platform, items) => marineDiscovery.canary.check(platform, items),
        api: async (route, body) => {
          const reply = await send(
            { __marineProspectApi: true, route, body },
            MARINE_PROSPECT_API_TIMEOUT_MS,
          );
          if (!reply || !reply.ok) throw new Error((reply && reply.error) || '本地 API 调用失败');
          return reply.data;
        },
        // location.assign 提交后必须等旧 document 真正 pagehide/unload。
        // href 可能提前变成目标字符串，不能用它单独判定导航成功。
        navigate: (url, meta) => marineProspectNavigateWithWatchdog(url, meta),
        handoffStore: marineProspectHandoffStore,
      }).catch((e) => ({ status: 'error', error: String(e && e.message || e) }));

      // 正常导航已经进入 pagehide/unload，旧 document 不再落幂等成功日志。
      if (result.status === 'target_navigation_committed') return;
      // 终局才落幂等标记；unhealthy / login_unknown 这类「现在还不行」保持可重试。
      // assign 可能在旧 document 还存活时就提前改写 location.href。幂等标记
      // 必须属于启动时的搜索页，不能误记到 expected target URL 上。
      const done = marineProspectRun.markDone(searchHref, result.status);
      marineLog('info', 'iso', '发现侧编排[' + (i + 1) + '/' + DELAYS_MS.length + ']：' + JSON.stringify(result));
      if (done || i + 1 >= DELAYS_MS.length) return;
      // 页面已经导航走了就别再重试（location 变了说明上一轮成功打开了靶子）。
      if (!marineProspectRun.shouldRun(location.href)) return;
      setTimeout(() => { void attempt(i + 1); }, DELAYS_MS[i + 1]);
    };

    void attempt(0);
  }

  // ---- Phase B：在靶子页自动生成并填入 ------------------------------------
  //
  // 驱动的是既有的页内生成链路（marineRimeGenStart：流式产出 + 拟人节奏敲进
  // 输入框），不是另写一套。等待方式是轮询 marineRimeGen.state，因为那套是
  // 状态机不是 Promise。
  //
  // 终止点由交接单里的 stopAfter 决定：已具备回执的平台会继续到 send。
  // 评论区里「这是一条评论」的容器。用来把评论正文排除在关闭提示的扫描之外 ——
  // 有人评论里写「为什么无法评论」就会把整条靶子误判成关闭，而 blocked 是**全局
  // 永久**的，误判代价比漏判高得多。
  const MARINE_COMMENT_ITEM_SELECTORS =
    'bili-comment-thread-renderer, bili-comment-renderer, bili-comment-reply-renderer,' +
    '.reply-item, .comment-item, .CommentItem, .comment-item-wrapper, .parent-comment';

  function marineInsideCommentItem(el) {
    for (let cur = el, depth = 0; cur && depth < 14; cur = marineComposedParent(cur), depth++) {
      try {
        if (cur.matches && cur.matches(MARINE_COMMENT_ITEM_SELECTORS)) return true;
      } catch (e) {}
    }
    return false;
  }

  /**
   * 评论区范围内的可见文本，供「评论区是不是关了」判据使用。
   *
   * 只取**叶子**节点：父节点的 textContent 会把整块内容重复一遍，扫一个评论区
   * 能拼出好几 MB。穿 shadow DOM 是必须的 —— B 站的 <bili-comments> 把提示文案
   * 整个藏在 shadow root 里，document.querySelector 看不见。
   */
  function marineProspectCommentAreaText() {
    try {
      const root = marineCommentSearchRoot();
      if (!root) return '';
      const parts = [];
      const all = marineAllElements(root);
      for (let i = 0; i < all.length && parts.length < 400; i++) {
        const el = all[i];
        if (el.childElementCount) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 200) continue;
        if (marineInsideCommentItem(el)) continue;
        parts.push(t);
      }
      return parts.join('\n');
    } catch (e) { return ''; }
  }

  /**
   * 自动打开评论区并选中直评输入框。
   *
   * 编排缺的正是这一步。整套目标追踪是**事件驱动**的（`click` / `focusin`），
   * 为「人点一下评论框」设计；自动打开的页面没人滚也没人点，所以
   * `marineRimeGen.editor` 永远是空的，Phase B 只能等到超时报「未能定位到直评
   * 输入框」—— 实测就是卡在这里。
   *
   * 两件事：
   *   1. **滚到评论区** —— B 站的 `<bili-comments>` 在首屏之下且懒渲染，不滚
   *      过去 DOM 里根本没有输入框可选。
   *   2. **聚焦它** —— 只有真的 focus 才会触发既有的 `focusin` 监听，由它把
   *      目标登记进 `marineRimeGen`。这里刻意不自己给 `marineRimeGen.editor`
   *      赋值：那样会绕过 classify（直评/回复的判定、directScope 快照），
   *      等于把一套已经调好的逻辑复制一份出来。
   *
   * @returns {Promise<boolean>} 选中了没有
   */
  /**
   * 有些平台的评论框**不在 DOM 里**，要先点一下入口才会出现。
   *
   * B 站的输入框一直在（只是懒渲染，滚过去就有）；知乎不是 —— 回答页默认没有
   * 任何 contenteditable，必须先点「添加评论」把评论区展开。实测：不点的话页面
   * 上 `[contenteditable=true]` 的数量是 0，怎么等都等不出来。
   *
   * 只写实测过的平台，其余返回 false（照 commentsClosed 那条纪律）。
   */
  function marineProspectOpenCommentPanel(platform) {
    if (platform === 'douyin') return marineProspectOpenDouyinComments();
    if (platform !== 'zhihu') return false;
    // 知乎的入口是 BUTTON.ContentItem-action，文本「添加评论」。
    // 文本前面带零宽字符（\u200b），所以用 indexOf 而不是相等匹配。
    let all;
    try { all = document.querySelectorAll('button'); } catch (e) { return false; }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const text = String(el.textContent || '');
      if (text.indexOf('添加评论') < 0 && text.indexOf('条评论') < 0) continue;
      if (el.offsetParent === null) continue;
      // 页面上有多个（问题头部一个、每条回答各一个）。只认回答自己那条操作栏里
      // 的，否则会展开别人回答的评论区，直评就变成评到别处去了。
      if (!el.closest || !el.closest('.ContentItem-actions')) continue;
      try { el.scrollIntoView({ block: 'center' }); el.click(); } catch (e) { continue; }
      return true;
    }
    return false;
  }

  /**
   * 抖音：点开评论面板。
   *
   * 抖音用 `data-e2e` 标记关键节点，比猜类名可靠得多（类名是混淆过的，
   * 实测形如 `XJJ1G7TE`，改版必变）。入口是 `feed-comment-icon`。
   *
   * 面板已经打开时（`comment-list` 在且输入框已出现）不要再点 —— 那会把它收回去。
   */
  // 评论图标每个文档只点一次。精选页点它只是开合抽屉，反复点会把刚开的关上。
  let marineProspectDouyinIconClicked = false;

  // 这个函数有五个「没成功」的出口，以前一个都不吭声，失败一律表现为 40 秒后
  // 的「未能定位到直评输入框」—— 五种完全不同的原因长成同一个样子，只能靠猜。
  // 每种原因只报一次（轮询会调用几十次，每次都报会把日志淹掉）。
  let marineProspectDouyinSaid = Object.create(null);
  function marineProspectDouyinWhy(reason, detail) {
    if (marineProspectDouyinSaid[reason]) return false;
    marineProspectDouyinSaid[reason] = true;
    try {
      marineLog('warn', 'iso', '抖音评论区未打开·' + reason + (detail ? ' · ' + detail : ''));
    } catch (e) {}
    return false;
  }

  function marineProspectOpenDouyinComments() {
    try {
      // 输入框已经在了就什么都不做
      if (document.querySelector('[contenteditable="true"], textarea')) return true;

      // 第一步：把评论区调出来。
      //
      // 抖音有**两种页面形态**，入口完全不同：
      //   · 视频页 `/video/…` —— 播放器右侧有评论图标 `feed-comment-icon`
      //   · 图文笔记页 `/note/…` —— 右栏是「相关推荐 | 评论(N)」两个 tab，
      //     默认停在「相关推荐」上，必须先点「评论」那个 tab 才切过去
      // 只处理视频页的话，笔记页永远找不到输入框（实测：那条链路上
      // `feed-comment-icon` 根本不存在）。
      if (!document.querySelector('[data-e2e="comment-list"]')) {
        // 图标只点一次。它在**三种**形态下都存在，但只有视频页点了会出评论区；
        // 精选页点它只是开合右侧抽屉，反复点等于把刚开的又关上。
        const icon = document.querySelector('[data-e2e="feed-comment-icon"]');
        if (icon && !marineProspectDouyinIconClicked) {
          marineProspectDouyinIconClicked = true;
          icon.scrollIntoView({ block: 'center' });
          icon.click();
          return false;   // 面板要时间渲染，下一轮轮询再往下走
        }
        // 「评论」tab。两种形态都要走这一步，判据不能是「没有图标」：
        //   · 图文笔记页 `/note/…`：右栏是「相关推荐 | 评论(N)」，没有图标
        //   · **精选页 `/jingxuan?modal_id=…`**：右侧抽屉是
        //     「详情 | TA的作品 | 评论 | AI抖音 | 相关推荐」，默认停在别的 tab 上，
        //     而 `feed-comment-icon` **存在**——老代码因此永远走不到这里，
        //     一轮轮点图标直到超时（实测卡满 240 秒）。
        // 文本严格匹配，避免命中评论正文里出现的「评论」二字。
        const tab = Array.prototype.slice
          .call(document.querySelectorAll('*'))
          .filter((el) => /^评论\s*\(?\d*\)?$/.test(String(el.textContent || '').trim()) &&
            el.children.length <= 1 && marineVisible(el))
          .pop();
        if (!tab) {
          return marineProspectDouyinWhy(
            '既没有评论图标也找不到「评论」tab',
            'icon=' + (icon ? '有' : '无') + ' 已点过=' + marineProspectDouyinIconClicked,
          );
        }
        tab.scrollIntoView({ block: 'center' });
        tab.click();
        return false;
      }

      // 第二步：点开输入条。
      //
      // 评论列表出来了不等于输入框出来了 —— 抖音先放一条占位条「留下你的精彩
      // 评论吧」，点它才挂载真正的可编辑元素（挂出来的是 Draft.js，和知乎同一
      // 套）。实测：只点评论图标的话，`comment-list` 有了、`[contenteditable]`
      // 仍然是 0 个。
      //
      // 锚点用**语义结构**不用类名：抖音的类名是混淆的，而且**每个视频页都不
      // 一样**（实测同一份代码在两个视频上分别是 `McY63d8B` 和 `Ii031XNo`）。
      // 唯一稳定的是「输入条是 `[data-e2e=comment-list]` 的前一个兄弟」，
      // 占位文案在它内部。
      // 输入条的锚点有两种，因为**精选页根本没有 `comment-list`**（实测那一页
      // 一个带 comment 的 data-e2e 都没有）。所以：有 `comment-list` 就用它的
      // 前一个兄弟（视频页/笔记页最稳），没有就退回全文档按占位文案找。
      const list = document.querySelector('[data-e2e="comment-list"]');
      const head = (list && list.previousElementSibling) || document.body;
      if (!head) return marineProspectDouyinWhy('评论列表没有前一个兄弟节点');
      const spots = Array.prototype.slice
        .call(head.querySelectorAll('*'))
        .filter((el) => String(el.textContent || '').trim().indexOf('留下你的精彩评论') === 0 &&
          marineVisible(el));
      // 取最内层：外层容器同样命中这段文本，点外层不一定触发挂载
      // （B 站的发布按钮踩过同样的坑）。
      const spot = spots[spots.length - 1];
      if (!spot) {
        // 占位文案是这里唯一的锚点，抖音改一次文案就会整条链路失效，而外在表现
        // 只是「定位不到输入框」。把**实际看到的**候选文案打出来，下次一跑就知道
        // 该把哪个字符串加进来，不用靠猜。
        let seen = '';
        try {
          seen = Array.prototype.slice
            .call(head.querySelectorAll('*'))
            .filter((el) => el.children.length === 0 && marineVisible(el))
            .map((el) => String(el.textContent || '').trim())
            .filter((t) => t && t.length <= 30)
            .slice(0, 8)
            .join(' | ');
        } catch (e) {}
        return marineProspectDouyinWhy(
          '找不到「留下你的精彩评论」占位条',
          'comment-list=' + (list ? '有' : '无') + ' 锚点=' + (list ? '兄弟节点' : 'body') +
            ' 附近文案=[' + seen + ']',
        );
      }
      spot.scrollIntoView({ block: 'center' });
      spot.click();
      return true;
    } catch (e) { return false; }
  }

  function marineProspectOpenCommentsAndFocus(deadlineMs) {
    return new Promise(function (resolve) {
      const deadline = Date.now() + (deadlineMs || 15000);
      let scrolled = 0;
      let opened = false;
      (function attempt() {
        // 先把评论区展开（对需要的平台）。只点一次 —— 反复点会把刚展开的收回去。
        if (!opened) opened = marineProspectOpenCommentPanel(detectPlatform());
        const root = marineCommentSearchRoot();
        // 滚动要反复做：评论区是懒加载的，第一次滚过去时可能还没挂载，
        // 而挂载后页面高度会变，之前的滚动位置就不再对准评论区了。
        if (root && root !== document && typeof root.scrollIntoView === 'function' && scrolled < 6) {
          try { root.scrollIntoView({ block: 'center' }); scrolled++; } catch (e) {}
        }
        const editor = marineProspectFindCommentEditor(root);
        if (editor) {
          try {
            editor.scrollIntoView({ block: 'center' });
            // click 在前、focus 在后：有些站点的输入框是点击后才真正挂上
            // contenteditable 的壳子。
            editor.click();
            editor.focus();
          } catch (e) {}
          // 已经锁在这个输入框上就别再激活了。
          //
          // 激活会有三个来源同时触发：这里的显式调用、`click()` 和 `focus()`
          // 各自引发的 focusin。每次激活都会换一个新的 contextId，而
          // `marineRimeGenSync` 看到 contextId 变了就会
          // `abort('target-switched')` —— 于是生成刚起步就被自己人打断。
          // 实测：日志里连着三条「已锁定」，然后 `生成被中止：target-switched`。
          const already = marineRimeTarget && marineRimeTarget.active;
          if (already && already.editor === editor) {
            setTimeout(function () { resolve(true); }, 200);
            return;
          }

          // 再显式激活一次。
          //
          // 光靠合成事件是**不够的**，实测拿到过精确证据：`.click()` 派发的事件
          // `isTrusted:false`，而 `.focus()` 在元素已聚焦时根本不产生事件 ——
          // 于是 `marineRimeRefreshFromEvent` 里那道「导航后需要可信事件重新
          // 武装」的闸永远不放行，`navigationRearmRequired` 一直是 true，目标
          // 永远登记不上。
          //
          // 那道闸防的是「导航前的陈旧事件复活」，不是防我们自己的编排 ——
          // 这里是本扩展在明确地驱动它。仍然走 `marineRimeActivate`（内部照常
          // classify），所以直评/回复判定和 directScope 快照一个都不少，只是
          // 不再要求一个人类的点击。
          try { marineRimeActivate(editor); } catch (e) {}
          // 事件是异步派发的，给追踪一点时间登记
          setTimeout(function () {
            resolve(!!(marineRimeGen && marineRimeGen.editor && marineRimeGen.editor.isConnected));
          }, 400);
          return;
        }
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 700);
      })();
    });
  }

  /**
   * 评论区里第一个「既可编辑、又被判定为评论输入框」的元素（含 shadow DOM）。
   *
   * 从评论根开始找，**找不到就退回全文档**。不是保险，是必须：
   * `marineCommentSearchRoot()` 的选择器是逗号列表，`querySelector` 按**文档
   * 顺序**返回首个命中，B 站上先命中的可能是个普通 DIV，而输入框在
   * `<bili-comments>` 的 shadow root 里 —— 只搜那个 DIV 永远空手（实测
   * root=DIV、found=null）。退回全文档是安全的：判据本身就要求元素落在评论
   * 容器内，扩大范围不会选中页面别处的输入框。
   */
  function marineProspectFindCommentEditor(root) {
    const scoped = marineProspectScanForEditor(root);
    if (scoped) return scoped;
    return root && root !== document ? marineProspectScanForEditor(document) : null;
  }

  function marineProspectScanForEditor(root) {
    const scope = root || document;
    let all;
    try { all = marineAllElements(scope); } catch (e) { return null; }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const tag = (el.tagName || '').toLowerCase();
      const editable = tag === 'textarea' || el.isContentEditable ||
        (el.getAttribute && el.getAttribute('contenteditable') === 'true');
      if (!editable) continue;
      try { if (marineRimeIsCommentEditor(el)) return el; } catch (e) {}
    }
    return null;
  }

  function marineProspectGenerateAndFill() {
    return new Promise(function (resolve) {
      const g = marineRimeGen;
      // 先把自己变成所在窗口内的活动标签页，再做别的。
      //
      // **不抢操作系统前台** —— 编排要在人用别的程序时跑完。这里只是让本标签页
      // 在窗口内活动，从而不被判 `document.hidden`（隐藏标签页的打字泵会被浏览器
      // clamp 到 1s 起）。上下文归属靠 `orchestrated` 标记放行，不靠焦点。
      void marineProspectSend(
        { __marineProspectFocusTab: true },
        MARINE_PROSPECT_CONTROL_TIMEOUT_MS,
      ).then(function () {
        // 目标追踪是事件驱动的，自动打开的页面不会有人去点评论框 —— 自己滚到
        // 评论区并激活，再等目标登记好。
        //
        // 30s 而不是 15s：抖音的评论区要两步才打开（点图标 → 等列表渲染 →
        // 点占位条），实测整条要十几秒；15s 的窗口经常在列表刚出来时就到期，
        // 表现为「未能定位到直评输入框」，而手动同样的步骤是通的。
        void marineProspectOpenCommentsAndFocus(30000);
      });
      // 等目标登记的窗口要比「打开评论区」的窗口更长，否则评论区刚打开就超时。
      const deadline = Date.now() + 40000;
      (function waitTarget() {
        // 等的是**目标被激活**（marineRimeTarget.active），不是
        // `marineRimeGen.editor`。
        //
        // 后者只在 `marineRimeGenStart()` 之后才被赋值 —— 等它再去调
        // GenStart 是个死锁，而且症状具有误导性：日志报「未能定位到直评输入
        // 框」，可实际上输入框早就选中了（同一轮日志里抓取链路跑完了整套：
        // 字幕 186 条、评论、正文全拿到）。实测踩过。
        const active = marineRimeTarget && marineRimeTarget.active;
        if (active && active.editor && active.editor.isConnected) return waitPublished();
        if (Date.now() > deadline) return giveUp();
        setTimeout(waitTarget, 500);
      })();

      /**
       * 输入框拿到了，但上下文槽位不一定拿得到 —— 分开等，因为这两件事的性质
       * 完全不同：拿不到输入框是**这条靶子**的问题（该记 failed），拿不到槽位是
       * **我们这边**的系统性故障（记 failed 会一条接一条地烧候选，因为 Failed 是
       * 账号级终态、按「失败不重试」永久作废）。
       *
       * 不能直接进 begin()：那样只会在里面等满 12 秒再以「目标准备超时」收场，
       * 外部看不出这是系统性问题还是这条靶子的问题。
       */
      function waitPublished() {
        const until = Date.now() + 15000;
        (function tick() {
          const cur = marineRimeTarget && marineRimeTarget.active;
          if (cur && cur.publishedContext) return begin();
          if (Date.now() > until) {
            return resolve({
              ok: false,
              reason: 'context_unavailable',
              error: '上下文槽位未获得：' + String(marineRimeTarget.lastSkipReason || '无响应'),
            });
          }
          setTimeout(tick, 300);
        })();
      }

      // 等不到输入框时才去问「是不是根本不让评论」。
      //
      // 顺序是刻意的：输入框在 = 能评论，这时页面上出现「无法评论」字样只可能
      // 是别处的噪声。先确认没有输入框，再看文案，等于两道独立的闸，比单靠文案
      // 匹配稳得多。
      function giveUp() {
        let closed = null;
        try {
          closed = marineProspectRun.commentsClosed(detectPlatform(), marineProspectCommentAreaText());
        } catch (e) {}
        if (closed === true) {
          return resolve({ ok: false, reason: 'comments_closed', error: '该内容已关闭评论' });
        }
        resolve({ ok: false, error: '未能定位到直评输入框' });
      }

      function begin() {
        const before = g.typed || '';
        // 已有人工/自动生成在跑时绝不能把它的 finishSeq 当成本任务；目标在
        // waitPublished 与这里之间也可能被 SPA 重建。两种都立即失败，不进 120s poll。
        if (marineRimeGenBusy()) {
          return resolve({ ok: false, reason: 'generator_busy', error: '生成器正忙，拒绝串用其他任务' });
        }
        const active = marineRimeTarget && marineRimeTarget.active;
        if (!active || !active.publishedContext || !active.editor || !active.editor.isConnected) {
          return resolve({ ok: false, reason: 'target_lost', error: '生成前目标已失效' });
        }
        // 基线必须在 start 前取。connect/postMessage 可能同步失败并推进 finishSeq；
        // 先 start 再取会把本轮失败当成旧状态，随后白等满 120 秒。
        const seqBefore = g.finishSeq || 0;
        let started;
        try { started = marineRimeGenStart(); }
        catch (e) { return resolve({ ok: false, error: '发起生成失败：' + String(e && e.message || e) }); }
        if (started === false) {
          return resolve({ ok: false, reason: 'start_rejected', error: '生成入口拒绝启动' });
        }
        // 生成是流式的，**只有 `lastFinish === 'done'` 才算敲完**。
        //
        // 曾经用「state 回落到 idle + 文本不再增长」推断，两次都错得很惨：
        // 打字过程中 state 会短暂回落，而中止（Esc、标签页隐藏、目标被清）也会
        // 把 state 落回 idle 并让文本停止增长 —— 于是半截草稿被判成完成，接上
        // 发送之后就是往真实账号发出「这份」「"都」这样的两字评论（实测两次）。
        //
        // `marineRimeGenFinish(reason)` 是权威信号：走完整段才是 'done'。
        // 用序号而不是值本身，避免把上一轮留下的 'done' 当成这一轮的。
        const genDeadline = Date.now() + 120000;
        (function poll() {
          if (g.state === 'error') return resolve({ ok: false, error: '生成失败' });
          if (Date.now() > genDeadline) return resolve({ ok: false, error: '生成超时' });
          if ((g.finishSeq || 0) > seqBefore) {
            if (g.lastFinish !== 'done') {
              return resolve({ ok: false, error: '生成被中止：' + String(g.lastFinish) });
            }
            const typed = g.typed || '';
            if (typed === before || !typed.length) {
              return resolve({ ok: false, error: '生成结束但没有写入内容' });
            }
            return resolve({ ok: true, text: typed });
          }
          setTimeout(poll, 500);
        })();
      }
    });
  }

  /**
   * 平台的发送控件。
   *
   * B 站、知乎、小红书和抖音都已接入各自实测过的发送控件定位；未知平台
   * 仍返回 null。发送会在真实账号上留下公开痕迹，所以只允许已有回执链路和
   * 定位回归覆盖的平台进入这里。
   *
   * B 站实测（`bili-comments` 的 shadow root 内）：发布控件是 `textContent`
   * 恰为「发布」的元素，**不是 `<button>`**（同层还有 168 个按钮类元素，多数是
   * 表情/@ 之类的工具按钮，按 tagName 找必然选错）。
   */
  function marineProspectFindSendButton(platform) {
    if (platform === 'zhihu') return marineProspectFindZhihuSendButton();
    if (platform === 'xiaohongshu') return marineProspectFindXhsSendButton();
    if (platform === 'douyin') return marineProspectFindDouyinSendButton();
    if (platform !== 'bilibili') return null;
    const host = document.querySelector('bili-comments');
    if (!host) return null;
    let all;
    try { all = marineAllElements(host); } catch (e) { return null; }
    const hits = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      // 严格相等而不是 includes：一条正文里出现「发布」两个字的评论会把
      // 整个评论卡片匹配进来。
      if (String(el.textContent || '').trim() !== '发布') continue;
      if (el.offsetParent === null) continue;          // 不可见的不算
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') continue;
      if (el.disabled === true) continue;
      hits.push(el);
    }
    if (!hits.length) return null;

    // 命中的是**同一个按钮的多层包装**，不是多个按钮。实测这一组是：
    //   DIV 898x120（整个评论框外壳）→ DIV 898x32（工具栏行）
    //   → DIV 70x32（按钮外框）→ BUTTON（真正的控件）
    // 取第一个（文档序最靠前）拿到的是最外层的外壳，点下去毫无反应 —— 踩过。
    // 所以：优先 <button>，否则取面积最小的那个，即最内层。
    const area = (el) => {
      try { const r = el.getBoundingClientRect(); return r.width * r.height; }
      catch (e) { return Number.MAX_SAFE_INTEGER; }
    };
    const buttons = hits.filter((el) => (el.tagName || '').toLowerCase() === 'button');
    const pool = buttons.length ? buttons : hits;
    const chosen = pool.reduce((best, el) => (area(el) < area(best) ? el : best), pool[0]);

    // 尺寸兜底：最小的那个也可能大得离谱。
    //
    // 输入框一旦失去焦点，B站会把工具栏收起来 —— 内层 BUTTON 从 DOM 里消失，
    // 只剩外层一个 771×78 的壳还带着「发布」两个字。「取最小」于是选中那个壳，
    // 点下去毫无反应，而外部症状是「已点发送但未收到平台回执」——和真被风控拦
    // 完全一样，无从区分（实测因此白跑两轮）。
    //
    // 宁可报「未找到发送按钮」：那是**响亮的**失败，一眼看得出是选择器的问题。
    const MAX_SEND_BUTTON_AREA = 240 * 60;
    if (area(chosen) > MAX_SEND_BUTTON_AREA) return null;
    return chosen;
  }

  /**
   * 知乎的发送控件。
   *
   * 比 B 站干净得多：草稿填好后，页面上恰好只有一个可见且未禁用的
   * `<button>` 文本为「发布」（实测 `Button--primary Button--blue`，62×30）。
   * 不在 shadow DOM 里，也没有多层同文本包装。
   *
   * 仍然要求 `!disabled`：输入框为空时知乎会把它置灰，点了没用还白跑一次。
   */
  function marineProspectFindZhihuSendButton() {
    let all;
    try { all = document.querySelectorAll('button'); } catch (e) { return null; }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (String(el.textContent || '').trim() !== '发布') continue;
      if (el.offsetParent === null || el.disabled === true) continue;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') continue;
      return el;
    }
    return null;
  }

  /**
   * 当前直评输入框里的实际文本；读不到返回 null（和「空」严格区别对待 ——
   * 读不到就拒发，空则是「没敲进去」，两者都不能当成「内容对」）。
   *
   * 三级兜底：跟踪到的目标 → 评论区里认出来的输入框 → 全文档唯一的可编辑元素。
   * 知乎的评论框在弹层里，敲完字之后原来的引用可能已经不在文档上了（实测：
   * 生成正常完成，发送前却报「读不到输入框」）。最后一级只在**恰好只有一个**
   * 可编辑元素时才用 —— 有多个就说不清是哪个，宁可拒发。
   */
  /**
   * 同一个输入框的**两种**文本读法，都拿出来给调用方比。
   *
   * 为什么不能只挑一种：
   *   · `textContent` 在 contenteditable 上**没有块级分隔符** ——「第一行\n第二行」
   *     读回来是「第一行第二行」，多行草稿永远对不上（B站/知乎/抖音 全中）。
   *   · `innerText` 有分隔符，但它按**渲染结果**取值：知乎的评论框在弹层里，
   *     实测发送前那一刻它可能已经不可见了，此时 innerText 给不出内容 ——
   *     换成它之后知乎从「能发」变成了「内容不一致，拒绝发送」。
   *
   * 两种都取，任一对得上就放行。这不会削弱这道闸：真的只填进去半截，两种读法
   * 都对不上。
   */
  function marineProspectEditorTexts(el) {
    if (!el || !el.isConnected) return null;
    try {
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'textarea') return [String(el.value)];
      const out = [];
      const rendered = el.innerText;
      if (rendered != null) out.push(String(rendered));
      out.push(String(el.textContent || ''));
      return out;
    } catch (e) { return null; }
  }

  /**
   * 当前直评输入框这个**元素**（不是它的文本）。三级兜底同上。
   */
  function marineProspectResolveEditor() {
    const usable = (el) => (el && el.isConnected ? el : null);

    const active = marineRimeTarget && marineRimeTarget.active;
    const tracked = usable(active && active.editor);
    if (tracked) return tracked;

    const found = usable(marineProspectFindCommentEditor(marineCommentSearchRoot()));
    if (found) return found;

    try {
      const editable = Array.prototype.slice
        .call(document.querySelectorAll('[contenteditable="true"], textarea'))
        .filter((el) => el.isConnected && el.offsetParent !== null);
      if (editable.length === 1) return editable[0];
    } catch (e) {}
    return null;
  }

  function marineProspectReadEditorText(platform) {
    void platform;
    const texts = marineProspectEditorTexts(marineProspectResolveEditor());
    return texts && texts.length ? texts[0] : null;
  }

  /**
   * 小红书的发送控件。
   *
   * 输入框是 `#content-textarea`，发送按钮在同一个 `.engage-bar-container`
   * 里（适配器已经用这个容器认输入框，复用同一个锚点，不另找一套）。
   *
   * 限定在容器内很重要：小红书页面上「发送」「发布」这类字样不止一处（右上角
   * 还有发笔记的入口），全局找必然选错。
   */
  function marineProspectFindXhsSendButton() {
    const editor = document.querySelector('#content-textarea');
    const bar = editor && editor.closest && editor.closest('.engage-bar-container');
    const scope = bar || document;
    let all;
    try { all = scope.querySelectorAll('button, [role="button"], .btn, [class*="submit" i], [class*="send" i]'); }
    catch (e) { return null; }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const text = String(el.textContent || '').trim();
      if (text !== '发送' && text !== '发布') continue;
      if (el.offsetParent === null || el.disabled === true) continue;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') continue;
      return el;
    }
    return null;
  }

  /**
   * 抖音的发送控件。
   *
   * 输入框那一行有三个 36×36 的图标控件（@ / 表情 / 发送），**都没有文字、类名
   * 也是混淆的**（实测 `wchsYBpK jfGCpJo0`，改版必变）。唯一稳定的区分是
   * **位置**：发送在最右边（实测 x=969 / 1005 / 1041，取最大那个）。
   *
   * 锚在输入框的祖先容器里找，不全局搜 —— 页面别处还有播放器的弹幕发送框。
   */
  function marineProspectFindDouyinSendButton() {
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return null;
    let box = editor;
    for (let i = 0; i < 6 && box.parentElement; i++) box = box.parentElement;
    let all;
    try { all = box.querySelectorAll('span'); } catch (e) { return null; }

    let best = null;
    let bestLeft = -Infinity;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.offsetParent === null) continue;
      if (String(el.textContent || '').trim() !== '') continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (Math.abs(r.width - 36) > 6 || Math.abs(r.height - 36) > 6) continue;
      if (r.left > bestLeft) { bestLeft = r.left; best = el; }
    }
    return best;
  }

  /**
   * 点发送，并等平台确认。
   *
   * 两件事必须说清楚：
   *
   * 1. **必须点网站自己的按钮**，不能由扩展自己发请求。回执检测是在 MAIN world
   *    里劫持页面的 `fetch`/`XMLHttpRequest`（content-main.js），扩展从 isolated
   *    world 或 SW 发出的请求根本不经过那层劫持，**一条回执都不会产生** ——
   *    也就等于永远无法确认评论真的上线了。
   *
   * 2. **成功的判据是回执，不是「点了按钮」**。B 站在风控拒绝时同样返回 HTTP
   *    200，只有响应体 `code===0` 且带正数 `rpid` 才算数。这个判定已经由
   *    publish-receipt.js 做好，这里只等它把结果挂到 isolated world 的全局上
   *    （publish-bridge.js 的 `sendReceipt`）。
   *
   * 等不到回执就报失败 —— 宁可把一条其实发出去了的评论记成 `failed`，也不能把
   * 没发出去的记成 `posted`：后者会让 per-item cap 和整个报表都失真。
   */
  /**
   * 已经点过发送的交接单 key。
   *
   * 小红书暴露了一个危险形态：**评论已经发出去了，草稿却仍留在输入框里**
   * （B 站/知乎发完会清空）。加上「没收到回执就记 failed」，任何重试路径都会
   * 把同一条内容再发一遍 —— 而发送是整条链里唯一不可逆的动作。
   *
   * 所以按交接单 key 记一次性标记：**点过就不再点**，哪怕上一次被判成失败。
   * 宁可漏发也不能重发。
   */
  const marineProspectSentKeys = Object.create(null);

  function marineProspectNormalizeDraft(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 把整段文本交给 Rust 侧，用 CDP 真实键盘事件敲进当前焦点元素。
   *
   * 仅用于抖音，理由见调用点。Rust 侧会拒绝控制字符和超长文本，所以这里不需要
   * 也不应该自己再造一套过滤 —— 校验只放一处。
   */
  /**
   * 调试浏览器的 CDP 端口。
   *
   * 只有 `debug-browser.sh` 起的调试环境才有意义 —— 它用固定的 9333，而且
   * app 认不出这个手动启动的浏览器。正式路径上返回 undefined，Rust 侧照常走
   * `resolve_running_profile`。
   *
   * 判据必须是「这个扩展跑在调试 profile 里」而不是「端口通不通」：后者会让
   * 任意页面通过占用 9333 来诱导代打。runtime-config 的 profileId 是 app 写
   * 进去的，调试副本沿用真实 profileId，所以这里靠**扩展目录路径**区分。
   */
  function marineProspectDebugCdpPort() {
    // 由 SW 从 runtime-config 里读出来（那个文件只有调试脚手架会写这个字段，
    // app 打包的正式 profile 永远没有）。
    //
    // 不能靠扩展自己判断路径：`chrome.runtime.getURL()` 给的是
    // `chrome-extension://<固定ID>/`，看不到磁盘位置；扩展名也是同一个。
    return marineProspectDebugPortCache;
  }
  let marineProspectDebugPortCache;

  function marineProspectTypeViaCdp(text) {
    return marineProspectSend(
      { __marineProspectProfileId: true },
      MARINE_PROSPECT_CONTROL_TIMEOUT_MS,
    ).then(function (who) {
      const profileId = who && who.profileId;
      if (!profileId) {
        marineLog('warn', 'iso', 'CDP 打字：拿不到 profileId');
        return false;
      }
      return marineProspectSend(
        {
          __marineProspectApi: true,
          route: 'type-text',
          body: {
            profile_id: profileId,
            text: String(text || ''),
            // 调试浏览器不是 app 启动的，app 认不出它 —— 带上端口让 debug 构建
            // 能跑完整链路。release 构建会忽略这个字段（编译期就不存在）。
            debug_cdp_port: marineProspectDebugCdpPort(),
          },
        },
        MARINE_PROSPECT_TYPE_TIMEOUT_MS,
      ).then(function (reply) {
        const ok = !!(reply && reply.ok);
        // 失败原因必须留痕。这条链有三个可能的断点（拿不到 profileId、
        // Rust 认不出 profile、CDP 本身失败），从外面看症状完全一样。
        if (!ok) {
          marineLog('warn', 'iso',
            'CDP 打字失败：' + ((reply && reply.error) || '未知') +
            '（' + String(text || '').length + ' 字）');
        }
        return ok;
      });
    }).catch(function (e) {
      marineLog('warn', 'iso', 'CDP 打字异常：' + String((e && e.message) || e));
      return false;
    });
  }

  function marineProspectSendComment(
    platform,
    expectedText,
    handoffKey,
    expectedTargetUrl,
    markAttempted,
  ) {
    return new Promise(function (resolve) {
      const key = String(handoffKey || '');
      if (key && marineProspectSentKeys[key]) {
        return resolve({
          ok: false,
          attempted: true,
          error: '这条已经点过发送，拒绝重复发送',
        });
      }
      // 发送前核对输入框里到底是什么。
      //
      // 这是最后一道、也是唯一一道能挡住「发出半截评论」的闸。生成判据再怎么
      // 加固都是间接推断，而这里读的是**输入框的实际内容** —— 实测在知乎发出
      // 过一条只有「这份」两个字的评论，就是因为没有这一步。
      //
      // 宁可不发也不发半截：没发出去还能再来一次，发出去的公开评论撤不回。
      const expected = marineProspectNormalizeDraft(expectedText);
      if (expected) {
        const candidates = marineProspectEditorTexts(marineProspectResolveEditor());
        if (candidates === null) {
          return resolve({ ok: false, error: '发送前读不到输入框内容，拒绝发送' });
        }
        const actual = candidates[0];
        // 页面会插入零宽字符并规范化换行/空白；去掉这些表现差异后必须全文相等。
        // 只比长度会让「同长度、内容已被站点改写」的错稿直接通过并公开发布。
        //
        // 两种读法任一对得上就算数，理由见 `marineProspectEditorTexts`。
        if (!candidates.some((t) => marineProspectNormalizeDraft(t) === expected)) {
          // 以前这里只说「不一致」，不说哪里不一致 —— 而这道闸一旦误判，整条腿
          // 就白跑且候选被烧掉，光看日志根本无从下手。把两边都截一段打出来。
          try {
            const brief = (t) => {
              const n = marineProspectNormalizeDraft(t);
              return '(' + n.length + ')' + n.slice(0, 60);
            };
            marineLog(
              'warn',
              'iso',
              '草稿核对不一致 · 期望=' + brief(expectedText) +
                ' · 实读=' + candidates.map(brief).join(' 或 '),
            );
          } catch (e) {}
          return resolve({
            ok: false,
            error: '输入框内容与生成结果不一致，拒绝发送',
          });
        }
      }

      const before = (typeof window !== 'undefined' && window.marineLastPublishedReceipt) || null;
      const beforeId = before && before.eventId;

      // 找按钮之前先把输入框重新聚上焦。
      //
      // B站（很可能不止它）在输入框失焦时会把工具栏收起来，内层的发送 BUTTON
      // 直接从 DOM 里消失。编排打完字到点发送之间隔着一次读取核对，焦点很容易
      // 已经不在输入框上 —— 于是要么找不到按钮，要么只找到外层的壳。
      // 这里聚的是**输入框的 DOM 焦点**，和操作系统的窗口焦点无关，
      // 不会把浏览器抢到前台。
      let refocusDelay = 0;
      try {
        const activeTarget = marineRimeTarget && marineRimeTarget.active;
        const editor = activeTarget && activeTarget.editor;
        if (editor && editor.isConnected && marineDeepActiveElement(document) !== editor) {
          editor.focus();
          refocusDelay = 400;   // 给工具栏重新展开的时间
        }
      } catch (e) {}
      setTimeout(afterRefocus, refocusDelay);

      async function afterRefocus() {
      const btn = marineProspectFindSendButton(platform);
      if (!btn) return resolve({ ok: false, error: '未找到发送按钮' });
      // 记下点击那一刻**到底点了什么**。
      //
      // 「点了但没回执」和「点错了元素」的外部症状完全一样，都是一句
      // 「已点发送但未收到平台回执」。上一次靠给回执桥加 `built` 字段才把
      // 「没构造出来」和「构造了但被丢」分开，这里是同一类问题：没有这条，
      // 只能对着一个静置的页面反推，而页面状态早就变了。
      try {
        const r = btn.getBoundingClientRect();
        marineLog('info', 'send', platform + ' 点击发送：<' + String(btn.tagName || '?').toLowerCase()
          + '> ' + Math.round(r.width) + '×' + Math.round(r.height)
          + ' @' + Math.round(r.left) + ',' + Math.round(r.top)
          + ' cls=' + String(btn.className || '').slice(0, 30)
          + ' 窗口聚焦=' + (typeof document !== 'undefined' ? document.hasFocus() : '?'));
      } catch (e) {}
      // 故意放在 btn.click() 紧前。上层在生成完成后已验过一次，但重聚焦/
      // 找按钮这个窗口里 SPA 仍可能从 A 切到 B，所以点击当下必须再验。
      try { btn.scrollIntoView({ block: 'center' }); } catch (e) {}
      const gotTargetUrl = String((typeof location !== 'undefined' && location.href) || '');
      if (expectedTargetUrl && (typeof marineProspectRun === 'undefined' || !marineProspectRun ||
          typeof marineProspectRun.sameTarget !== 'function' ||
          !marineProspectRun.sameTarget(expectedTargetUrl, gotTargetUrl))) {
        return resolve({
          ok: false,
          reason: 'target_changed_before_send',
          error: '发送前目标页已变更，拒绝点击',
          expected: expectedTargetUrl,
          got: gotTargetUrl,
        });
      }
      // 所有可证明的 pre-click failure 已在上面正常 resolve attempted:false。现在
      // 即将跨不可逆边界，必须先把 unconfirmed durable；否则 click 触发同步导航
      // 时旧 document 消失，下一份文档只看得到预备态 failed，会错误放开重发。
      if (typeof markAttempted === 'function') {
        try {
          if ((await markAttempted()) !== true) throw new Error('attempt guard rejected');
        } catch (e) {
          return resolve({
            ok: false,
            attempted: true,
            error: '发送尝试凭据写入失败：' + String((e && e.message) || e),
          });
        }
      }
      // durable mutation 最慢可等 5s，期间 SPA 仍可能换页；所以 guard 返回后还要
      // 再读一次 URL。此时 unconfirmed 已 durable，若目标变了就不 click，但也不
      // 能回退 failed（旧 document 可能在 guard 回执边界消失），保守按 attempted。
      const finalTargetUrl = String((typeof location !== 'undefined' && location.href) || '');
      if (expectedTargetUrl && (typeof marineProspectRun === 'undefined' || !marineProspectRun ||
          typeof marineProspectRun.sameTarget !== 'function' ||
          !marineProspectRun.sameTarget(expectedTargetUrl, finalTargetUrl))) {
        return resolve({
          ok: false,
          attempted: true,
          reason: 'target_changed_before_send',
          error: '发送尝试凭据落定后目标页已变更，拒绝点击',
          expected: expectedTargetUrl,
          got: finalTargetUrl,
        });
      }
      // 标记要在**点击之前**落下：点完再标记的话，点击本身抛异常或页面立刻跳转
      // 就会漏标，下一轮又点一次。宁可把一次没点成的也算成点过。
      if (key) marineProspectSentKeys[key] = true;
      try {
        btn.click();
      } catch (e) {
        // click() 已进入不可逆边界；即使调用栈抛错，站点 listener 也可能已产生
        // 部分外部副作用。保守记 unconfirmed，绝不能按 failed 放开重领/重发。
        return resolve({
          ok: false,
          attempted: true,
          error: '点击发送失败：' + String((e && e.message) || e),
        });
      }

      // 等回执。20s 够一次正常往返；超时按失败处理。
      const deadline = Date.now() + 20000;
      (function poll() {
        const now = (typeof window !== 'undefined' && window.marineLastPublishedReceipt) || null;
        if (now && now.eventId && now.eventId !== beforeId) {
          return resolve({ ok: true, eventId: now.eventId, platformCommentId: now.platformCommentId });
        }
        if (Date.now() > deadline) {
          return resolve({
            ok: false,
            attempted: true,
            error: '已点发送但未收到平台回执（可能被风控拦截）',
          });
        }
        setTimeout(poll, 500);
      })();
      }
    });
  }

  async function marineStartProspectTargetPhase(bootAttempt) {
    if (!marineProspectAutomationHost()) return;
    // 必须在依赖/ready 握手和 handoff read 之前排除；warmup 的职责只有让搜索
    // 导航可提交，恢复工作留给紧随其后的 Phase A search document。
    if (marineProspectWarmupPage(location.href)) return;
    if (!marineProspectPhaseAReady() || !marineProspectPhaseBReady()) {
      marineProspectScheduleBoot(marineStartProspectTargetPhase, bootAttempt, '发现侧编排·靶子页', 'phase_b');
      return;
    }
    if (marineProspectRun.platformOfSearchPage(location.href)) return;
    if (!(await marineProspectEnsureBridgeReady())) {
      marineProspectScheduleBoot(
        marineStartProspectTargetPhase,
        bootAttempt,
        '发现侧编排·靶子页·认证握手',
        'phase_b',
      );
      return;
    }
    // Phase A 与 Phase B 都注入在搜索页；上面已在握手之前完成 URL 分流。
    const send = marineProspectSend;
    void marineProspectRun.runOnTargetSingleFlight({
      handoffStore: marineProspectHandoffStore,
      // 确认有交接单以后才进入编排模式。普通人工详情页会做几次只读重试，不能
      // 因此绕过失焦保护。
      beginTarget: async () => {
        marineProspectSetOrchestrating(true);
        // 调试环境的 CDP 端口（正式 profile 拿不到，返回 undefined）。
        try {
          const cfg = await marineProspectSend(
            { __marineProspectProfileId: true },
            MARINE_PROSPECT_CONTROL_TIMEOUT_MS,
          );
          marineProspectDebugPortCache = (cfg && cfg.debugCdpPort) || undefined;
        } catch (e) {}
      },
      endTarget: () => {
        // 无论成败都要退出编排模式。留着的话这个标签页后续的人工操作会一直
        // 绕过焦点保护。
        marineProspectSetOrchestrating(false);
      },
      generateAndFill: () => marineProspectGenerateAndFill(),
      currentHref: () => location.href,
      // 只有交接单里 stopAfter==='send' 时才会被调用。哪些平台进入 send 模式
      // 由 prospect-run 的 SEND_ENABLED_PLATFORMS 决定。
      send: (platform, text, key, expectedTargetUrl, markAttempted) =>
        marineProspectSendComment(platform, text, key, expectedTargetUrl, markAttempted),
      api: async (route, body) => {
        const reply = await send(
          { __marineProspectApi: true, route, body },
          MARINE_PROSPECT_API_TIMEOUT_MS,
        );
        if (!reply || !reply.ok) throw new Error((reply && reply.error) || '本地 API 调用失败');
        return reply.data;
      },
      // 只在「评论区对所有人关闭」时用得上：换一条靶子。跟 Phase A 用同一个
      // 导航方式，落地后新页面的 Phase B 会靠新交接单接上。
      navigate: (url, meta) => marineProspectNavigateWithWatchdog(url, meta),
    }).then((r) => {
      // 无交接单是普通人工页面的常态，不刷日志；传输失败和所有真实编排结果都留证。
      if (r && r.status !== 'no_handoff' && r.status !== 'target_already_started' &&
          r.status !== 'target_navigation_committed') {
        marineLog('info', 'iso', '发现侧编排·靶子页：' + JSON.stringify(r));
      }
    }).catch((e) => {
      marineLog('error', 'iso', '发现侧编排·靶子页异常：' + String((e && e.message) || e));
    });
  }

  // 调试出口。
  //
  // content-iso 整个包在 IIFE 里，从外面（CDP 求值）一个内部状态都够不着 ——
  // 排查目标追踪为什么没选中输入框时只能靠日志反推，代价极高。这里把只读的
  // 状态挂出来。
  //
  // 安全上是干净的：content script 跑在 ISOLATED world，这个全局对页面 JS
  // **不可见**（世界隔离，不是靠命名躲）。全部只读，没有能改状态的入口。
  var marineInternals = {
    gen: function () {
      if (!marineRimeGen) return null;
      const t = marineRimeTarget && marineRimeTarget.active;
      return {
        state: String(marineRimeGen.state),
        // 按钮文案是这套状态机最可读的投影：生成 / 准备中… / 生成中… / 重新生成
        btn: (marineRimeGen.els && marineRimeGen.els.lbl && marineRimeGen.els.lbl.textContent) || '',
        typed: String(marineRimeGen.typed || '').length,
        wanted: String(marineRimeGen.wanted || '').length,
        streamDone: !!marineRimeGen.streamDone,
        finishSeq: marineRimeGen.finishSeq || 0,
        lastFinish: String(marineRimeGen.lastFinish || ''),
        err: String(marineRimeGen.errorText || ''),
        hasEditor: !!(marineRimeGen.editor && marineRimeGen.editor.isConnected),
        editorTag: marineRimeGen.editor ? marineRimeGen.editor.tagName + '.' + String(marineRimeGen.editor.className || '').split(' ')[0] : null,
        hasActive: !!t,
        // 生成能不能启动全看它：没有就只能进「准备中」等上下文发布
        pubCtx: !!(t && t.publishedContext),
      };
    },
    target: function () {
      return marineRimeTarget ? {
        navigationRearmRequired: !!marineRimeTarget.navigationRearmRequired,
        navigationEventCutoff: marineRimeTarget.navigationEventCutoff,
        hasDirectScope: !!marineRimeTarget.directScope,
        sourceId: String(marineRimeTarget.sourceId || ''),
      } : null;
    },
    commentRoot: function () {
      var r = marineCommentSearchRoot();
      return r === document ? 'document' : (r ? r.tagName : null);
    },
    findEditor: function () {
      var el = marineProspectFindCommentEditor(marineCommentSearchRoot());
      return el ? el.tagName + '.' + String(el.className || '').split(' ')[0] : null;
    },
    isCommentEditor: function (sel) {
      var el = document.querySelector(sel);
      return el ? marineRimeIsCommentEditor(el) : 'no-such-element';
    },
    focusEditor: function () { return marineProspectOpenCommentsAndFocus(8000); },
    // 调试用：按人工路径触发一次生成（点扩展自己的「生成」按钮），
    // 用来和编排路径做 A/B —— 手动可用而编排不可用时，差别只可能在触发方式上。
    clickGenButton: function () {
      const b = marineRimeGen && marineRimeGen.els && marineRimeGen.els.genBtn;
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    },
    // 打字期间编辑框还在不在文档上 —— 知乎实测敲到第 3 个字就 isConnected=false
    editorAlive: function () {
      const e = marineRimeGen && marineRimeGen.editor;
      return { has: !!e, connected: !!(e && e.isConnected), inDoc: !!(e && document.contains(e)) };
    },
  };
  if (typeof window !== 'undefined') window.marineInternals = marineInternals;

  // discovery/login/prospect-run 已在同一条 manifest js 数组中排在本文件
  // 之前。仍从下一个宏任务启动，并由 Phase A/B 的有界依赖重试覆盖
  // 旧版注入、测试沙箱或 MV3 worker 恢复较慢的情况。
  setTimeout(marineStartProspectRun, 0);
  // 靶子页的第二阶段。给目标追踪一点时间先把直评框认出来。
  setTimeout(marineStartProspectTargetPhase, 1500);
})();
