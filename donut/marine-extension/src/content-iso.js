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
    if (/(^|\.)netflix\.com$/.test(h)) return 'netflix';
    return 'generic';
  }
  const PLATFORM_LABEL = { youtube: 'YouTube', bilibili: 'Bilibili', zhihu: '知乎', xiaohongshu: '小红书', netflix: 'Netflix', generic: '通用页面' };

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

  // 自动滚动 + 展开，驱动页面自发请求（钩子续收），实现「尽量全量」
  async function marineDriveComments(opts) {
    opts = opts || {};
    const budget = Math.min(opts.budgetMs || 20000, 60000);
    const t0 = Date.now();
    const rootHint = detectPlatform() === 'bilibili' ? 'bili-comments' : null;
    let last = -1, stable = 0, rounds = 0;
    marineLog('info', 'iso', '开始自动滚动加载评论（预算 ' + Math.round(budget / 1000) + 's）…');
    while (Date.now() - t0 < budget && stable < 3) {
      rounds++;
      try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) {}
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
    const rootHint = detectPlatform() === 'bilibili' ? 'bili-comments' : null;
    try {
      const el = rootHint && document.querySelector(rootHint);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'end' });
      window.scrollTo(0, document.documentElement.scrollHeight);
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

  // 把字幕 + 评论 + 正文打成一份可复制的 Markdown（喂 Codex 用）
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
      const noteMd = marineExtractNoteText(platform, commentCaptures);
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
  function hookVideos() {
    document.querySelectorAll('video').forEach(v => {
      if (v.__marineHooked) return;
      v.__marineHooked = true;
      const tt = v.textTracks;
      if (!tt) return;
      for (let i = 0; i < tt.length; i++) wireTrack(tt[i]);
      if (tt.addEventListener) tt.addEventListener('addtrack', ev => wireTrack(ev.track));
    });
  }
  hookVideos();
  new MutationObserver(hookVideos).observe(document.documentElement, { childList: true, subtree: true });

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
  function marineRimeNewSourceId() {
    try { return crypto.randomUUID(); }
    catch (e) { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  }

  const marineRimeTarget = {
    active: null,
    revision: 0,
    activationSerial: 0,
    sourceId: marineRimeNewSourceId(),
    pendingReply: null,
    pendingReplyTimer: null,
    replyBindings: new WeakMap(),
    blurTimer: null,
    positionFrame: 0,
    refreshTimer: null,
    overlay: null,
    grabCache: null,
    pageUrl: location.href,
    navigationRearmRequired: false,
    navigationEventCutoff: 0,
    diagnosticSequence: 0,
    diagnosticLastAt: new Map(),
  };

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

  function marineRimeSemanticKey(mode, target, editor) {
    const targetText = [(target && target.authorName) || '', (target && target.snippet) || ''].filter(Boolean).join('|');
    const targetKey = mode === 'direct'
      ? 'direct'
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

  function marineRimeKnownTargets() {
    try {
      const built = marineBuildComments(detectPlatform(), commentCaptures);
      return built && built.ok ? marineFlattenComments(built.comments) : [];
    } catch (e) { return []; }
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
    return attributed;
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
    if (!editor || detectPlatform() !== 'bilibili' || !/\/video\//.test(location.pathname)) return false;
    const root = marineCommentSearchRoot();
    if (root !== document && marineComposedContains(root, editor)) return true;
    if (marineRimeCommentContainer(editor)) return true;
    return /(\u8bc4\u8bba|\u56de\u590d|\u53d1\u4e00\u6761\u53cb\u5584)/.test(marineRimeEditorContextLabel(editor));
  }

  function marineRimeClassify(editor) {
    if (!marineRimeIsCommentEditor(editor)) return null;
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
    if (!reply) return { mode: 'direct', editor, commentEl: null, target: null };
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
    return { mode: 'reply', editor, commentEl, target };
  }

  function marineRimeEnsureOverlay() {
    if (marineRimeTarget.overlay) return marineRimeTarget.overlay;
    const make = function (kind) {
      const el = document.createElement('div');
      el.setAttribute('data-marine-rime-target', kind);
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, {
        display: 'none', position: 'fixed', boxSizing: 'border-box', pointerEvents: 'none',
        zIndex: '2147483646', borderRadius: '8px', transition: 'left 80ms ease, top 80ms ease, width 80ms ease, height 80ms ease',
      });
      (document.documentElement || document.body).appendChild(el);
      return el;
    };
    const comment = make('comment');
    Object.assign(comment.style, { border: '2px solid rgba(0, 174, 236, .92)', background: 'rgba(0, 174, 236, .055)', boxShadow: '0 0 0 3px rgba(0, 174, 236, .12)' });
    const editor = make('editor');
    Object.assign(editor.style, { border: '2px solid rgb(0, 174, 236)', background: 'rgba(0, 174, 236, .035)', boxShadow: '0 0 0 3px rgba(0, 174, 236, .18)' });
    const badge = make('badge');
    Object.assign(badge.style, {
      height: '24px', width: 'auto', padding: '3px 9px', borderRadius: '999px',
      color: '#fff', background: 'rgb(0, 132, 180)', font: '600 12px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      letterSpacing: '.1px', whiteSpace: 'nowrap', boxShadow: '0 3px 10px rgba(0, 0, 0, .18)',
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
    const active = marineRimeTarget.active;
    if (!active) {
      overlay.comment.style.display = 'none';
      overlay.editor.style.display = 'none';
      overlay.badge.style.display = 'none';
      return;
    }
    const editorRect = marineRimePlaceOutline(overlay.editor, active.editor, 3);
    if (active.mode === 'reply') marineRimePlaceOutline(overlay.comment, active.commentEl, 4);
    else overlay.comment.style.display = 'none';
    if (!editorRect || overlay.editor.style.display === 'none') { overlay.badge.style.display = 'none'; return; }
    const author = active.target && active.target.authorName;
    overlay.badge.textContent = active.mode === 'reply' ? ('Marine \u00b7 \u56de\u590d @' + (author || '\u4f5c\u8005')) : 'Marine \u00b7 \u76f4\u8bc4';
    overlay.badge.style.display = 'block';
    const badgeWidth = overlay.badge.getBoundingClientRect().width || 120;
    const top = editorRect.top >= 31 ? editorRect.top - 29 : Math.min(innerHeight - 26, editorRect.bottom + 5);
    overlay.badge.style.left = Math.max(4, Math.min(innerWidth - badgeWidth - 4, editorRect.left)) + 'px';
    overlay.badge.style.top = Math.max(4, top) + 'px';
  }

  function marineRimeSchedulePosition() {
    if (marineRimeTarget.positionFrame) return;
    marineRimeTarget.positionFrame = requestAnimationFrame(function () {
      marineRimeTarget.positionFrame = 0;
      marineRimeRender();
    });
  }

  function marineRimeSend(op, contextId, context, revision) {
    try {
      chrome.runtime.sendMessage({
        __marineRimeContext: true,
        op,
        contextId,
        context,
        revision,
        sourceId: marineRimeTarget.sourceId,
      }, function (response) {
        const err = chrome.runtime.lastError;
        if (err) { marineLog('warn', 'rime-target', op + ' 失败：' + err.message); return; }
        if (response && !response.ok) marineLog('warn', 'rime-target', op + ' 失败：' + (response.error || '未知错误'));
      });
    } catch (e) { marineLog('warn', 'rime-target', op + ' 失败：' + String(e && e.message || e)); }
  }

  async function marineRimeGrabContext() {
    const key = marineRimePageKey() + '|' + commentCaptures.length;
    const cached = marineRimeTarget.grabCache;
    if (cached && cached.key === key && Date.now() - cached.at < 30000) return cached.value;
    const value = await Promise.race([
      marineGrabAll({}),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('抓取上下文超时')); }, 8000);
      }),
    ]);
    marineRimeTarget.grabCache = { key, at: Date.now(), value };
    return value;
  }

  function marineRimeTargetSummary(info) {
    if (info.mode === 'direct') return '直评 \u00b7 ' + (document.title || location.href);
    const target = info.target || {};
    const author = target.authorName || '作者';
    const snippet = marineCommentSnippet(target.text || target.snippet, 80);
    return '@' + author + (snippet ? '：「' + snippet + '」' : '');
  }

  async function marineRimePublish(info, revision) {
    let grab;
    try { grab = await marineRimeGrabContext(); }
    catch (e) {
      marineLog('warn', 'rime-target', '抓取上下文失败，使用当前页基本信息：' + String(e && e.message || e));
      grab = { platform: detectPlatform(), url: location.href, title: document.title, bundle: '', text: { status: 'none' }, comments: { status: 'none' }, subtitle: { status: 'none' } };
    }
    const active = marineRimeTarget.active;
    if (!active || active.contextId !== info.contextId || marineRimeTarget.revision !== revision) return;
    const actionId = info.mode === 'reply' ? 'marine.generate-reply' : 'marine.generate-direct';
    const targetSummary = marineRimeTargetSummary(info);
    const target = info.mode === 'reply' ? marineRimeBuildReplyTarget(info.target) : null;
    const context = {
      contextId: info.contextId,
      mode: info.mode,
      actionId,
      label: info.mode === 'reply' ? ('Marine \u00b7 \u56de\u590d @' + ((info.target && info.target.authorName) || '作者')) : 'Marine \u00b7 \u76f4\u8bc4',
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
    active.publishedContext = context;
    active.publishedAt = Date.now();
    marineRimeSend('put', info.contextId, context, revision);
    marineLog('ok', 'rime-target', '已锁定 ' + context.label + '：' + context.targetSummary);
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
    info.semanticKey = marineRimeSemanticKey(info.mode, info.target, info.editor);
    const current = marineRimeTarget.active;
    if (current && current.semanticKey === info.semanticKey && current.editor === info.editor) {
      current.commentEl = info.commentEl;
      current.target = info.target;
      marineRimeSchedulePosition();
      if (!current.publishedAt || Date.now() - current.publishedAt > 30000) marineRimeRenew();
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

  function marineRimeRenew() {
    const active = marineRimeTarget.active;
    if (!active || !active.publishedContext || document.hidden) return;
    const focused = marineDeepActiveElement(document);
    if (focused !== active.editor) return;
    const revision = ++marineRimeTarget.revision;
    const context = Object.assign({}, active.publishedContext, {
      updatedAt: Date.now(),
    });
    active.publishedContext = context;
    active.publishedAt = Date.now();
    marineRimeSend('put', active.contextId, context, revision);
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
        marineRimeClearPendingReply('editor-blur');
        marineRimeClear('editor-blur');
      }
    }, 100);
  }

  function marineRimeHandleNavigation(url) {
    if (url && url === marineRimeTarget.pageUrl) return;
    marineRimeTarget.pageUrl = url || location.href;
    marineRimeTarget.navigationRearmRequired = true;
    marineRimeTarget.navigationEventCutoff = performance.now();
    marineRimeClearPendingReply('navigation');
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
    if (detectPlatform() !== 'bilibili') return;
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
    window.addEventListener('scroll', marineRimeSchedulePosition, true);
    window.addEventListener('resize', marineRimeSchedulePosition, false);
    window.addEventListener('blur', function () {
      marineRimeClearPendingReply('window-blur');
      marineRimeClear('window-blur');
    });
    window.addEventListener('focus', function () { setTimeout(function () { marineRimeRefreshFromEvent(null); }, 0); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
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
  marineRimeStartTargetTracking();
  marineLog('info', 'iso', '已加载 · 平台=' + PLATFORM_LABEL[detectPlatform()] + ' · ' + location.href);
})();
