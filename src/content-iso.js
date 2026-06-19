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
  function marineIngestComment(d) {
    commentCaptures.push({ url: d.url, body: d.body, ts: Date.now() });
    if (commentCaptures.length > 400) commentCaptures.shift();
    let n = 0;
    try { n = marineBuildBiliComments([{ url: d.url, body: d.body }]).stats.count; } catch (e) {}
    marineLog('net', 'iso', '评论响应 ' + shortUrl(d.url) + ' → +' + n + ' 条（累计响应 ' + commentCaptures.length + '）');
  }

  function marineSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function marineCommentsResult(built) {
    if (!built.ok) return { ok: false, error: built.error || '未解析出评论', stats: built.stats || { count: 0 } };
    return {
      ok: true,
      platform: detectPlatform(),
      stats: built.stats,
      preview: marineCommentsPreview(built.comments, 100),
      json: JSON.stringify(built.comments, null, 2),
    };
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

    // 评论：评论型平台每次抓取只加载一页（~20 条），重复点「抓取」累积更多
    let commentsBuilt = null;
    if (platform === 'bilibili' || platform === 'zhihu') {
      try { await marineDriveOnce(); } catch (e) {}
    }
    commentsBuilt = marineBuildComments(platform, commentCaptures);
    if (commentsBuilt.ok) out.comments = { status: 'has', count: commentsBuilt.stats.count, md: marineCommentsPreview(commentsBuilt.comments, 100000) };

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
          case 'DEBUG_SET':
            marineDebug.setEnabled(!!msg.enabled);
            sendResponse({ ok: true });
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
            sendResponse({ ok: true, comments: built.ok ? { status: 'has', count: built.stats.count, md: marineCommentsPreview(built.comments, 100000) } : { status: 'none' }, bundle });
            break;
          }
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

  // ---- 初始化调试面板 ----
  function bootDebug(saved) {
    saved = saved || {};
    marineDebug.init({ enabled: saved.enabled !== false, open: saved.open !== false });
    const label = PLATFORM_LABEL[detectPlatform()];
    marineDebug.setMeta({ platform: label, captured: captured.length, tracks: trackBuffers.length });
    marineLog('info', 'iso', '已加载 · 平台=' + label + ' · ' + location.href);
  }
  try {
    const p = chrome.storage.local.get('marineDebug');
    if (p && p.then) p.then(o => bootDebug(o && o.marineDebug)).catch(() => bootDebug());
    else bootDebug();
  } catch (e) { bootDebug(); }
})();
