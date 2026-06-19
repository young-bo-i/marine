// debug-panel.js — 页面内调试面板（ISOLATED world，bundle 内最先加载）
// 提供全局 marineLog(level, tag, msg, data) 与 marineDebug 控制对象。
// 用 Shadow DOM 隔离样式，避免与页面互相污染。日志先进环形缓冲，挂载后回放。
var marineDebug = (function () {
  'use strict';
  const MAX = 600;
  const buffer = [];
  let host, root, panelEl, bodyEl, launcherEl, metaEl, badgeEl, filterVal = '';
  let mounted = false;
  const state = { enabled: true, open: true, platform: '', captured: 0, tracks: 0 };
  const COLORS = { info: '#9da7b3', net: '#4ea1ff', track: '#37c2a8', warn: '#e3b341', error: '#ff6b6b', ok: '#3fb950', debug: '#9da7b3' };

  function pad(n, l) { return ('00' + n).slice(-(l || 2)); }
  function now() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function toStr(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

  function log(level, tag, msg, data) {
    const e = { t: now(), level: COLORS[level] ? level : 'info', tag: tag || '', msg: msg == null ? '' : String(msg), data };
    buffer.push(e);
    if (buffer.length > MAX) buffer.shift();
    if (mounted) appendLine(e);
    return e;
  }

  function appendLine(e) {
    if (!bodyEl) return;
    const line = document.createElement('div');
    line.className = 'line';
    line.dataset.search = (e.level + ' ' + e.tag + ' ' + e.msg + ' ' + toStr(e.data)).toLowerCase();
    let html = '<span class="t">' + e.t + '</span>' +
      '<span class="lv" style="color:' + (COLORS[e.level]) + '">' + e.level + '</span>';
    if (e.tag) html += '<span class="tag">' + esc(e.tag) + '</span>';
    html += '<span class="msg">' + esc(e.msg) + '</span>';
    if (e.data !== undefined) html += '<span class="data">' + esc(trunc(toStr(e.data), 400)) + '</span>';
    line.innerHTML = html;
    if (filterVal && line.dataset.search.indexOf(filterVal) === -1) line.style.display = 'none';
    const atBottom = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 30;
    bodyEl.appendChild(line);
    while (bodyEl.children.length > MAX) bodyEl.removeChild(bodyEl.firstChild);
    if (atBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  const TEMPLATE = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
      .launcher {
        display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
        background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 18px;
        padding: 6px 12px; font-size: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.35); user-select: none;
      }
      .launcher .badge {
        background: #2563eb; color: #fff; border-radius: 10px; padding: 0 6px;
        font-size: 11px; min-width: 16px; text-align: center;
      }
      .panel {
        width: 440px; max-width: 92vw; height: 46vh; min-height: 220px;
        display: flex; flex-direction: column; background: #0d1117; color: #e6edf3;
        border: 1px solid #30363d; border-radius: 8px; overflow: hidden;
        box-shadow: 0 8px 30px rgba(0,0,0,.5); font-size: 12px;
      }
      .header {
        display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        background: #161b22; border-bottom: 1px solid #30363d; cursor: move; user-select: none;
      }
      .header .title { font-weight: 600; }
      .header .meta { color: #768390; font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .header button {
        background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 5px;
        padding: 2px 7px; cursor: pointer; font-size: 11px;
      }
      .header button:hover { border-color: #2563eb; }
      .toolbar { display: flex; padding: 5px 8px; border-bottom: 1px solid #21262d; }
      .toolbar input {
        flex: 1; background: #010409; color: #e6edf3; border: 1px solid #30363d;
        border-radius: 5px; padding: 3px 7px; font-size: 11px;
      }
      .body { flex: 1; overflow: auto; padding: 4px 8px 8px; }
      .line { padding: 1px 0; line-height: 1.5; word-break: break-word; border-bottom: 1px solid rgba(255,255,255,.03); }
      .line .t { color: #545d68; margin-right: 6px; }
      .line .lv { display: inline-block; min-width: 38px; margin-right: 6px; font-weight: 600; }
      .line .tag { color: #d2a8ff; margin-right: 6px; }
      .line .msg { color: #e6edf3; }
      .line .data { color: #768390; margin-left: 6px; }
      .hidden { display: none !important; }
    </style>
    <div id="launcher" class="launcher hidden">🐟 Marine Debug <span id="badge" class="badge">0</span></div>
    <div id="panel" class="panel hidden">
      <div id="header" class="header">
        <span class="title">🐟 Marine Debug</span>
        <span id="meta" class="meta"></span>
        <button id="btn-clear" title="清空">清空</button>
        <button id="btn-copy" title="复制全部日志">复制</button>
        <button id="btn-min" title="最小化">—</button>
        <button id="btn-disable" title="关闭面板（可在弹窗里重新开启）">×</button>
      </div>
      <div class="toolbar"><input id="filter" placeholder="过滤日志（如 net / error / youtube）…"></div>
      <div id="body" class="body"></div>
    </div>`;

  function mount() {
    if (mounted) return;
    host = document.createElement('div');
    host.id = 'marine-debug-host';
    host.style.cssText = 'all:initial; position:fixed; z-index:2147483647; bottom:12px; right:12px;';
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = TEMPLATE;
    (document.documentElement || document.body).appendChild(host);

    panelEl = root.getElementById('panel');
    bodyEl = root.getElementById('body');
    launcherEl = root.getElementById('launcher');
    metaEl = root.getElementById('meta');
    badgeEl = root.getElementById('badge');

    root.getElementById('btn-clear').onclick = clear;
    root.getElementById('btn-copy').onclick = copyLogs;
    root.getElementById('btn-min').onclick = function () { setOpen(false); };
    root.getElementById('btn-disable').onclick = function () { setEnabled(false); };
    launcherEl.onclick = function () { setOpen(true); };
    const f = root.getElementById('filter');
    f.oninput = function () { filterVal = f.value.toLowerCase(); applyFilter(); };
    enableDrag(root.getElementById('header'));

    mounted = true;
    bodyEl.innerHTML = '';
    buffer.forEach(appendLine);
    renderMeta();
    applyState();
  }

  function enableDrag(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      host.style.left = ox + 'px'; host.style.top = oy + 'px';
      host.style.right = 'auto'; host.style.bottom = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      host.style.left = (ox + e.clientX - sx) + 'px';
      host.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
  }

  function applyFilter() {
    if (!bodyEl) return;
    Array.prototype.forEach.call(bodyEl.children, function (line) {
      line.style.display = (!filterVal || line.dataset.search.indexOf(filterVal) !== -1) ? '' : 'none';
    });
  }

  function clear() { buffer.length = 0; if (bodyEl) bodyEl.innerHTML = ''; log('debug', 'panel', '日志已清空'); }

  function copyLogs() {
    const text = buffer.map(function (e) {
      return e.t + ' [' + e.level + '] ' + (e.tag ? e.tag + ' ' : '') + e.msg + (e.data !== undefined ? ' ' + toStr(e.data) : '');
    }).join('\n');
    const done = function () { log('ok', 'panel', '已复制 ' + buffer.length + ' 行到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    (root || document.body).appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function renderMeta() {
    if (metaEl) metaEl.textContent = (state.platform || '—') + ' · 捕获 ' + state.captured + ' · 轨道 ' + state.tracks + ' · ' + buffer.length + ' 行';
    if (badgeEl) badgeEl.textContent = String(state.captured + state.tracks);
  }

  function applyState() {
    if (!mounted) return;
    if (!state.enabled) { host.style.display = 'none'; return; }
    host.style.display = '';
    panelEl.classList.toggle('hidden', !state.open);
    launcherEl.classList.toggle('hidden', state.open);
  }

  function persist() {
    try { chrome.storage && chrome.storage.local.set({ marineDebug: { enabled: state.enabled, open: state.open } }); } catch (e) {}
  }

  function setOpen(open) { state.open = open; applyState(); persist(); }
  function setEnabled(en) { state.enabled = en; if (en && !mounted) mount(); applyState(); persist(); }
  function setMeta(m) {
    if (m.platform != null) state.platform = m.platform;
    if (m.captured != null) state.captured = m.captured;
    if (m.tracks != null) state.tracks = m.tracks;
    renderMeta();
  }

  function init(opts) {
    opts = opts || {};
    state.enabled = opts.enabled !== false;
    state.open = opts.open !== false;
    mount();
    log('debug', 'panel', 'Marine 调试面板已就绪 · ' + location.host);
  }

  return { log: log, init: init, setOpen: setOpen, setEnabled: setEnabled, setMeta: setMeta, isEnabled: function () { return state.enabled; } };
})();

function marineLog(level, tag, msg, data) { return marineDebug.log(level, tag, msg, data); }
