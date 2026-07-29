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
  // 转发到侧边栏（best-effort；面板没开就静默丢弃）。
  // 每条日志一次 sendMessage 会在面板根本没开时也把 service worker 唤醒一次，而
  // 日志是突发式的（一次抓取就是几十条，且每个 iframe 各发一份）。合批之后 IPC
  // 次数降一个数量级，面板侧仍是准实时（≤200ms）。
  const FLUSH_MS = 200;
  const FLUSH_MAX = 40;
  let pending = [];
  let flushTimer = null;

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      chrome.runtime.sendMessage({ __marineLogBatch: batch }, function () { void chrome.runtime.lastError; });
    } catch (err) {}
  }

  function forward(entry) {
    pending.push(entry);
    if (pending.length >= FLUSH_MAX) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
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
    forward(e);
    // 镜像到 console。
    //
    // 不是冗余：另外两条通路都会在最需要它们的时候失效 —— 侧边栏只在面板打开时
    // 活着（而调度器每条腿结束都关浏览器），SW 转发依赖的正是「SW 消息通道 +
    // 本地 API」这套本身就可能是故障点的机制。console 只依赖页面自己，而且
    // CDP 的 Runtime.consoleAPICalled 是**事件订阅**，Wayfern 的付费闸门只封
    // Runtime.evaluate 那类求值方法，不影响事件 —— 实测确认。
    // 统一前缀是为了好过滤。
    try {
      console.log('[marine]', e.level, e.tag ? '[' + e.tag + ']' : '', e.msg,
        e.data === undefined ? '' : e.data);
    } catch (err) {}
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
