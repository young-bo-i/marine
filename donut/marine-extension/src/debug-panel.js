// debug-panel.js — 日志收集 + 转发到侧边栏「调试」tab（不再在页面上悬浮）
// 提供全局 marineLog(level, tag, msg, data) 与 marineDebug.buffer()。
var marineDebug = (function () {
  'use strict';
  const MAX = 800;
  const LEVELS = { info: 1, net: 1, track: 1, warn: 1, error: 1, ok: 1, debug: 1, comment: 1 };
  const buffer = [];

  function pad(n, l) { return ('00' + n).slice(-(l || 2)); }
  function now() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }
  function log(level, tag, msg, data) {
    const e = {
      t: now(),
      level: LEVELS[level] ? level : 'info',
      tag: tag || '',
      msg: msg == null ? '' : String(msg),
      data: (data === undefined) ? undefined : (typeof data === 'string' ? data : safeJson(data)),
    };
    buffer.push(e);
    if (buffer.length > MAX) buffer.shift();
    // 转发到侧边栏（best-effort；面板没开就静默丢弃）
    try { chrome.runtime.sendMessage({ __marineLog: e }, function () { void chrome.runtime.lastError; }); } catch (err) {}
    return e;
  }
  function safeJson(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

  return {
    log: log,
    buffer: function () { return buffer.slice(); },
    clear: function () { buffer.length = 0; },
    // 旧 API 保留为 no-op，避免改动各处调用
    init: function () {}, setMeta: function () {}, setEnabled: function () {},
  };
})();

function marineLog(level, tag, msg, data) { return marineDebug.log(level, tag, msg, data); }
