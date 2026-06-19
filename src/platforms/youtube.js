// youtube.js — YouTube 字幕提取（运行在 ISOLATED world）
// 方法一：通过 MAIN world 读取 ytInitialPlayerResponse 的 captionTracks，
//         再 fetch baseUrl&fmt=json3（content script 在 youtube.com 上为同源，
//         且 baseUrl 自带页面生成的 POT token，故可直接获取）。
// 方法二（兜底）：点击“显示文字记录”，抓取页面上的 transcript 面板。

function marineYtRequestTracks() {
  return new Promise(resolve => {
    const reqId = 'yt_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 3000);
    function handler(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__marine !== 'yt-tracks-result' || d.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(d.tracks || null);
    }
    window.addEventListener('message', handler);
    window.postMessage({ __marine: 'get-yt-tracks', reqId }, location.origin);
  });
}

function marineWaitFor(getter, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      let v = null;
      try { v = getter(); } catch (e) {}
      if (v && (!v.length || v.length > 0)) { resolve(v); return; }
      if (Date.now() - t0 > (timeout || 4000)) { resolve(v || null); return; }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function marineYtScrapeTranscript() {
  const openSelectors = [
    'ytd-video-description-transcript-section-renderer button',
    'button[aria-label="Show transcript"]',
    'button[aria-label*="transcript" i]',
    'button[aria-label*="文字记录"]',
    'button[aria-label*="字幕"]'
  ];
  for (const sel of openSelectors) {
    const btn = document.querySelector(sel);
    if (btn) { btn.click(); break; }
  }
  const segs = await marineWaitFor(
    () => document.querySelectorAll('ytd-transcript-segment-renderer'), 4500);
  if (!segs || !segs.length) return null;
  const cues = [];
  segs.forEach(el => {
    const ts = (el.querySelector('.segment-timestamp') || {}).textContent || '0:00';
    const txtEl = el.querySelector('.segment-text, yt-formatted-string.segment-text');
    const text = txtEl ? txtEl.textContent.trim() : '';
    if (text) cues.push({ start: marineParseClock(ts), end: 0, text });
  });
  for (let i = 0; i < cues.length; i++) {
    cues[i].end = cues[i + 1] ? cues[i + 1].start : cues[i].start + 3;
  }
  return cues.length ? cues : null;
}

async function marineExtractYouTube(opts) {
  opts = opts || {};
  marineLog('info', 'youtube', '开始提取：向页面请求 ytInitialPlayerResponse 字幕轨');
  let tracks = await marineYtRequestTracks();
  marineLog(tracks && tracks.length ? 'info' : 'warn', 'youtube',
    '字幕轨：' + (tracks && tracks.length ? tracks.length + ' 条' : '未取到（将回退 DOM 面板）'));

  if (tracks && tracks.length) {
    const langs = tracks.map(t => ({
      code: t.languageCode,
      name: t.name + (t.kind === 'asr' ? '（自动生成）' : ''),
      kind: t.kind
    }));
    // 选轨：优先用户指定语言；否则优先人工字幕
    let track = tracks.find(t => opts.lang && t.languageCode === opts.lang)
      || tracks.find(t => !t.kind)
      || tracks[0];

    let url = track.baseUrl;
    url = /[?&]fmt=/.test(url) ? url.replace(/([?&]fmt=)[^&]*/, '$1json3') : url + '&fmt=json3';
    if (opts.tlang) url += '&tlang=' + encodeURIComponent(opts.tlang);

    marineLog('net', 'youtube', '拉取 json3：' + track.languageCode + (track.kind ? '/' + track.kind : ''));
    try {
      const res = await fetch(url);
      const data = await res.json();
      const cues = marineParseJson3(data);
      if (cues.length) {
        marineLog('ok', 'youtube', 'json3 解析成功：' + cues.length + ' 条');
        return { ok: true, source: 'youtube', lang: track.languageCode, langs, cues };
      }
      marineLog('warn', 'youtube', 'json3 内容为空（可能受 POT 限制）');
    } catch (e) {
      marineLog('error', 'youtube', 'json3 拉取失败：' + (e && e.message || e));
    }
  }

  // 兜底：抓取 transcript 面板
  marineLog('info', 'youtube', '回退：尝试抓取「显示文字记录」面板');
  const domCues = await marineYtScrapeTranscript();
  if (domCues && domCues.length) {
    marineLog('ok', 'youtube', 'transcript 面板解析：' + domCues.length + ' 条');
    return { ok: true, source: 'youtube-dom', lang: 'auto', langs: [], cues: domCues };
  }
  return { ok: false, error: '未找到字幕：该视频可能没有字幕，或字幕受 POT 限制。可尝试手动打开「显示文字记录」后重试。' };
}
