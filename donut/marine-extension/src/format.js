// format.js — 字幕解析与格式转换工具
// 统一 cue 模型: { start: 秒(number), end: 秒(number), text: string }
// 本文件内的函数都用 function 声明，以便在 content-script 包内的其它文件中直接调用。

function marinePad(n, len) {
  return String(n).padStart(len || 2, '0');
}

// 秒 -> 时间戳。sep 为毫秒分隔符: SRT 用 ','，VTT 用 '.'
function marineFmtTime(sec, sep) {
  if (sec == null || isNaN(sec) || sec < 0) sec = 0;
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return marinePad(h) + ':' + marinePad(m) + ':' + marinePad(s) + (sep || ',') + marinePad(ms, 3);
}

// "1:23" / "01:02:03" -> 秒
function marineParseClock(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// "00:00:01,234" / "1.5" / "12345t"(ticks/ms) -> 秒
function marineParseTimestamp(ts) {
  ts = String(ts).trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(ts)) return parseFloat(ts);     // 纯秒
  if (/^\d+t$/.test(ts)) return parseInt(ts, 10) / 1000;   // 部分 TTML 用 ms+t
  const parts = ts.split(':').map(parseFloat);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function marineStripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// 去重 + 按时间排序（cuechange 累积时会有重复）
function marineNormalizeCues(cues) {
  const seen = new Set();
  const out = [];
  for (const c of cues) {
    if (!c || !c.text) continue;
    const key = Math.round((c.start || 0) * 1000) + '|' + c.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: c.start || 0, end: c.end || 0, text: c.text });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ---- 解析器 ----

// YouTube json3 (timedtext&fmt=json3)
function marineParseJson3(data) {
  const events = (data && data.events) || [];
  const cues = [];
  for (const e of events) {
    if (!e.segs) continue;
    const text = e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!text) continue;
    const start = (e.tStartMs || 0) / 1000;
    const end = start + (e.dDurationMs || 0) / 1000;
    cues.push({ start, end, text });
  }
  return cues;
}

// Bilibili 字幕 JSON: { body: [{ from, to, content }] }
function marineParseBiliBody(data) {
  const body = (data && data.body) || [];
  return body
    .map(b => ({ start: b.from, end: b.to, text: (b.content || '').trim() }))
    .filter(c => c.text);
}

// WebVTT / SRT 文本
function marineParseVTT(text) {
  text = String(text || '').replace(/\r/g, '');
  const cues = [];
  const tcRe = /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '' && !/^WEBVTT/i.test(l));
    const idx = lines.findIndex(l => tcRe.test(l));
    if (idx === -1) continue;
    const m = lines[idx].match(tcRe);
    const txt = marineStripTags(lines.slice(idx + 1).join(' '));
    if (m && txt) cues.push({ start: marineParseTimestamp(m[1]), end: marineParseTimestamp(m[2]), text: txt });
  }
  return cues;
}

// TTML / DFXP / srv3 (<p begin end> 或 <text t d>)
function marineParseTTML(xml) {
  const cues = [];
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return cues; }
  if (doc.querySelector('parsererror')) return cues;
  doc.querySelectorAll('p, text').forEach(p => {
    const text = marineStripTags(p.textContent);
    if (!text) return;
    const begin = p.getAttribute('begin') || p.getAttribute('t') || p.getAttribute('start');
    const endAttr = p.getAttribute('end');
    const dur = p.getAttribute('dur') || p.getAttribute('d');
    const start = begin ? marineParseTimestamp(begin) : 0;
    let end;
    if (endAttr) end = marineParseTimestamp(endAttr);
    else if (dur) end = start + marineParseTimestamp(dur);
    else end = start + 3;
    cues.push({ start, end, text });
  });
  return cues;
}

// 自动识别一段原始字幕文本/JSON -> cues
function marineParseAuto(body, url) {
  const t = String(body || '').trim();
  if (!t) return [];
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      if (j.events) return marineParseJson3(j);
      if (Array.isArray(j.body)) return marineParseBiliBody(j);
    } catch (e) { /* 落到下面 */ }
  }
  if (/^WEBVTT/im.test(t) || /-->/.test(t)) return marineParseVTT(t);
  if (/<tt[\s>]|<transcript[\s>]|<timedtext[\s>]|<\?xml/i.test(t)) return marineParseTTML(t);
  return [];
}

// ---- 输出格式 ----

function marineCuesToSRT(cues) {
  return cues.map((c, i) =>
    (i + 1) + '\n' +
    marineFmtTime(c.start, ',') + ' --> ' + marineFmtTime(c.end || c.start, ',') + '\n' +
    c.text + '\n'
  ).join('\n');
}

function marineCuesToVTT(cues) {
  return 'WEBVTT\n\n' + cues.map(c =>
    marineFmtTime(c.start, '.') + ' --> ' + marineFmtTime(c.end || c.start, '.') + '\n' + c.text
  ).join('\n\n') + '\n';
}

function marineCuesToText(cues, withTime) {
  if (withTime) {
    return cues.map(c => '[' + marineFmtTime(c.start, '.').slice(0, 8) + '] ' + c.text).join('\n');
  }
  return cues.map(c => c.text).join('\n');
}

function marineFormatCues(cues, fmt) {
  cues = marineNormalizeCues(cues);
  switch (fmt) {
    case 'srt': return marineCuesToSRT(cues);
    case 'vtt': return marineCuesToVTT(cues);
    case 'time': return marineCuesToText(cues, true);
    case 'text':
    default: return marineCuesToText(cues, false);
  }
}
