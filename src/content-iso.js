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
    if (/(^|\.)netflix\.com$/.test(h)) return 'netflix';
    return 'generic';
  }
  const PLATFORM_LABEL = { youtube: 'YouTube', bilibili: 'Bilibili', netflix: 'Netflix', generic: '通用页面' };

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
    let n = 0;
    try { n = marineBuildBiliComments([{ url: d.url, body: d.body }]).stats.count; } catch (e) {}
    marineLog('net', 'iso', '评论响应 ' + shortUrl(d.url) + ' → +' + n + ' 条（累计响应 ' + commentCaptures.length + '）');
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

    // 结构化文本
    let textRes = null;
    try { textRes = marineExtractStructuredText(); } catch (e) { textRes = null; }
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
    if (d.__marine === 'net-capture' && d.kind === 'comment' && d.body) { marineIngestComment(d); return; }
    if (d.__marine !== 'net-capture' || !d.body) return;
    // 按 URL 去重，保留最近 30 条
    const exist = captured.find(c => c.url === d.url);
    if (exist) { exist.body = d.body; exist.ts = Date.now(); return; }
    captured.push({ id: 'cap_' + (++capSeq), url: d.url, body: d.body, ct: d.ct || '', ts: Date.now() });
    if (captured.length > 30) captured.shift();
    let n = 0; try { n = marineParseAuto(d.body, d.url).length; } catch (err) {}
    marineLog('net', 'iso', '捕获字幕响应 ' + shortUrl(d.url) + ' → ' + n + ' 条');
    marineDebug.setMeta({ captured: captured.length });
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
    return document.querySelector('bili-comments, #commentapp, .comment-container, .comment-list, .reply-warp') || document;
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
        return el.matches && el.matches('button,a,[role="button"],.reply,.reply-btn,.sub-reply') &&
          /^回复$|回复/.test(txt) && txt.length <= 12 && marineVisible(el);
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
  marineLog('info', 'iso', '已加载 · 平台=' + PLATFORM_LABEL[detectPlatform()] + ' · ' + location.href);
})();
