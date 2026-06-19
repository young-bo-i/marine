// content-main.js — 运行在页面的 MAIN world（document_start）
// 作用：
//  1) 钩住 fetch / XMLHttpRequest，被动捕获字幕类请求的响应体（Netflix / 通用 .vtt 等）。
//  2) 应 ISOLATED 世界的请求，读取页面全局变量（YouTube 的 ytInitialPlayerResponse）。
// MAIN world 没有 chrome.* API，只能通过 window.postMessage 与 ISOLATED 世界通信。
(function () {
  'use strict';
  const ORIGIN = location.origin;

  // 仅匹配“明确是字幕”的 URL，避免捕获巨大的清单/视频流响应。
  const SUB_RE = /(\.vtt|\.srt|\.ass|\.dfxp|\.ttml)(\?|#|$)|timedtext|aisubtitle|webvtt|\/subtitle|subtitles?\?|\/captions?\b|caption\.|dfxp|ttml/i;

  // 评论类接口（Phase 0：哔哩哔哩）。被动捕获页面自己发出的、已签名的评论请求响应。
  const COMMENT_RE = /\/x\/v2\/reply(\/wbi\/main|\/reply)?(\?|$)/i;

  function matchKind(url) {
    if (COMMENT_RE.test(url)) return 'comment';
    if (SUB_RE.test(url)) return 'subtitle';
    return null;
  }

  function post(payload) {
    try { window.postMessage(Object.assign({ __marine: 'net-capture' }, payload), ORIGIN); }
    catch (e) { /* 结构化克隆失败等，忽略 */ }
  }

  // 把日志桥接到 ISOLATED 世界的调试面板
  function mlog(level, msg, data) {
    try { window.postMessage({ __marine: 'log', level: level, tag: 'main', msg: msg, data: data }, ORIGIN); }
    catch (e) {}
  }
  function shortUrl(u) {
    try { const x = new URL(u, location.href); return (x.pathname.split('/').pop() || x.hostname) + ' @' + x.hostname; }
    catch (e) { return String(u).slice(0, 70); }
  }

  // ---- fetch 钩子 ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      const args = arguments;
      const p = origFetch.apply(this, args);
      try {
        const a0 = args[0];
        const url = (a0 && typeof a0 === 'object' && a0.url) ? a0.url : String(a0 || '');
        const kind = url && matchKind(url);
        if (kind) {
          mlog('net', kind + ' fetch ⇢ ' + shortUrl(url));
          p.then(res => {
            try {
              const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
              res.clone().text().then(body => { if (body) post({ url, body, ct, kind }); }).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return p;          // 永远返回原始响应，绝不影响页面
    };
  }

  // ---- XHR 钩子 ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__marineUrl = url; } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__marineUrl;
      const kind = url && matchKind(String(url));
      if (kind) {
        mlog('net', kind + ' xhr ⇢ ' + shortUrl(url));
        this.addEventListener('load', function () {
          try {
            const rt = this.responseType;
            const body = (rt === '' || rt === 'text') ? this.responseText
              : (typeof this.response === 'string' ? this.response : '');
            if (body) post({ url: String(url), body, kind });
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // ---- 应请求读取 YouTube 页面全局 ----
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__marine !== 'get-yt-tracks') return;
    mlog('info', '收到 YouTube 字幕轨请求');
    let tracks = null;
    try {
      const pr = window.ytInitialPlayerResponse;
      const want = new URLSearchParams(location.search).get('v');
      const vid = pr && pr.videoDetails && pr.videoDetails.videoId;
      // 仅当播放器响应与当前 URL 视频一致时才采用（SPA 切换后可能过期）
      if (pr && (!want || !vid || vid === want)) {
        const r = pr.captions
          && pr.captions.playerCaptionsTracklistRenderer
          && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (r && r.length) {
          // 只挑可序列化的字段，避免 postMessage 克隆问题
          tracks = r.map(t => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode,
            kind: t.kind || '',
            name: (t.name && (t.name.simpleText
              || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode
          }));
        }
      }
    } catch (err) { mlog('error', 'YouTube 读取失败', String(err && err.message || err)); }
    mlog(tracks ? 'ok' : 'warn', 'YouTube 字幕轨 → ' + (tracks ? tracks.length + ' 条' : '无/播放器数据过期'));
    window.postMessage({ __marine: 'yt-tracks-result', reqId: d.reqId, tracks }, ORIGIN);
  }, false);

  mlog('info', '已注入 fetch/XHR 钩子 @ ' + location.host);
})();
