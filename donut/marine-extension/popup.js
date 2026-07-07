// popup.js — 一键抓取（字幕/评论/正文），评论可分页加载更多；
// 「本地智能体」通过本地 HTTP API（Donut）生成直评/回复并可填入页面回复草稿。
const $ = sel => document.querySelector(sel);

// 嵌入模式：作为注入网页的悬浮侧栏（panel-inject.js）加载时，URL 带 ?tabId=<宿主标签页>，
// 面板绑定该标签页，不做跨标签重对准。无此参数则是原生侧边栏模式（沿用旧逻辑）。
const EMBEDDED_TAB_ID = (() => {
  const v = new URLSearchParams(location.search).get('tabId');
  return v != null && v !== '' ? Number(v) : null;
})();

let activeTabId = null;
let lastGrab = null;   // 最近一次抓取结果（含三块内容 + 合并 bundle）
let grabGen = 0;       // 抓取代次：切页/重抓时作废在途请求，避免旧结果覆盖

// ---- 运行时配置 + 品牌状态 ----
let effectiveConfig = { apiBase: '', token: '', profileId: '' };
let configFromRuntime = false; // apiBase/token 是否来自 runtime-config.json（Donut 注入）

function send(type, opts) { return chrome.tabs.sendMessage(activeTabId, { type, opts }); }

// ---- 运行时配置解析：runtime-config.json 优先，为空则回退到 chrome.storage 手填 ----
async function readRuntimeConfig() {
  try {
    const r = await fetch(chrome.runtime.getURL('marine-runtime-config.json'), { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) {}
  return {};
}
async function readManualConfig() {
  try { const o = await chrome.storage.local.get('marineManualConfig'); return o.marineManualConfig || {}; }
  catch (e) { return {}; }
}
async function saveManualConfig(cfg) {
  try { await chrome.storage.local.set({ marineManualConfig: cfg }); } catch (e) {}
}
// 有效配置：runtime-config 的非空字段优先，缺失则回退到手填值
async function resolveConfig() {
  const rc = await readRuntimeConfig();
  const mc = await readManualConfig();
  const nz = v => (v != null && String(v).trim() !== '');
  const pick = k => (nz(rc[k]) ? String(rc[k]).trim() : (mc[k] || ''));
  effectiveConfig = { apiBase: pick('apiBase'), token: pick('token'), profileId: pick('profileId') };
  configFromRuntime = nz(rc.apiBase) && nz(rc.token);
  return effectiveConfig;
}
function configReady() { return !!(effectiveConfig.apiBase && effectiveConfig.token); }

// ---- 本地 API 调用（每次都带 Authorization: Bearer）----
async function apiFetch(path, options) {
  options = options || {};
  if (!configReady()) throw new Error('未配置本地 API（apiBase/token）——请到「配置」填写，或等待 Donut 注入');
  const headers = Object.assign(
    { 'Authorization': 'Bearer ' + effectiveConfig.token },
    options.body ? { 'Content-Type': 'application/json' } : {},
    options.headers || {}
  );
  const res = await fetch(effectiveConfig.apiBase + path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) {}
    throw new Error('HTTP ' + res.status + (detail ? ' · ' + detail.slice(0, 200) : ''));
  }
  const ct = res.headers.get('content-type') || '';
  if (res.status === 204 || !ct.includes('application/json')) return null;
  return res.json();
}

function setChip(id, state, extra) {
  const el = $(id);
  const map = { pending: ['待获取', 'pending'], loading: ['获取中…', 'loading'], has: ['有' + (extra ? ' · ' + extra : ''), 'has'], none: ['无', 'none'] };
  const v = map[state] || map.pending;
  el.textContent = v[0]; el.className = 'chip ' + v[1];
}
function resetChips(s) { setChip('#st-sub', s); setChip('#st-comment', s); setChip('#st-text', s); }
function setStatus(text, kind) {
  // Route feedback to the pane the user is actually looking at: #grab-status
  // lives in the 抓取 pane, #cfg-status in the 配置 pane. Without this, a save
  // error on the 配置 tab would land on the hidden 抓取 pane and be invisible.
  const cfgActive = $('#pane-config') && $('#pane-config').classList.contains('active');
  const el = (cfgActive && $('#cfg-status')) ? $('#cfg-status') : $('#grab-status');
  if (!el) return;
  el.textContent = text || ''; el.className = 'status' + (kind ? ' ' + kind : '');
}
function showReloadHint(v) { $('#reload-hint').classList.toggle('hidden', !v); }
function staleContentScriptError(v) {
  return /未知指令|Receiving end does not exist|Could not establish connection|message port closed/i.test(String((v && v.message) || v || ''));
}

async function injectReplyDraftDirect(opts) {
  if (!chrome.scripting || !activeTabId) throw new Error('插件刚更新过，请到 chrome://extensions 重新加载 Marine 后再试');
  const injected = await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    world: 'MAIN',
    args: [opts || {}],
    func: async (payload) => {
      function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
      function cssEscape(s) {
        try { return CSS.escape(String(s)); } catch (e) { return String(s).replace(/["\\]/g, '\\$&'); }
      }
      function textOf(el) {
        try { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
        catch (e) { return ''; }
      }
      function visible(el) {
        try {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
        } catch (e) { return false; }
      }
      function composedParent(el) {
        if (!el) return null;
        const p = el.parentElement || el.parentNode;
        if (p && p.nodeType === 11 && p.host) return p.host;
        return p && p.nodeType === 1 ? p : null;
      }
      function collect(root, acc, state) {
        acc = acc || [];
        state = state || { n: 0, max: 60000 };
        if (!root || state.n >= state.max) return acc;
        if (root.nodeType === 1) {
          acc.push(root); state.n++;
          if (root.shadowRoot) collect(root.shadowRoot, acc, state);
        }
        let walker = null;
        try { walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); } catch (e) { return acc; }
        let el;
        while ((el = walker.nextNode()) && state.n < state.max) {
          acc.push(el); state.n++;
          if (el.shadowRoot) collect(el.shadowRoot, acc, state);
        }
        return acc;
      }
      function allElements(root) { return collect(root || document); }
      function commentSearchRoot() {
        return document.querySelector('bili-comments, #commentapp, .comment-container, .comment-list, .reply-warp') || document;
      }
      function snippet(s, n) {
        return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 28);
      }
      function parseTarget(label) {
        const s = String(label || '').replace(/^回复\s*@?\s*/, '').trim();
        const author = ((s.match(/^@?([^（(「"“：:]+)/) || [])[1] || '').trim();
        const quoted = (s.match(/[「"“](.+?)[」"”]/) || [])[1] || '';
        return { author, snippet: quoted.replace(/\s+/g, ' ').trim() };
      }
      function containsTarget(el, target) {
        const txt = textOf(el);
        if (!txt || txt.length > 4000) return false;
        if (target.authorName && txt.indexOf(target.authorName) < 0) return false;
        const sn = snippet(target.text || target.snippet || '', 28);
        if (sn && txt.indexOf(sn) < 0) return false;
        return true;
      }
      function findCommentElement(target) {
        const root = commentSearchRoot();
        const all = allElements(root);
        const id = String(target.id || '').trim();
        if (id) {
          const sel = [
            '[data-id="' + cssEscape(id) + '"]',
            '[data-rpid="' + cssEscape(id) + '"]',
            '[data-reply-id="' + cssEscape(id) + '"]',
            '[reply-id="' + cssEscape(id) + '"]',
            '[rpid="' + cssEscape(id) + '"]',
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
        const parsed = parseTarget(target.label || '');
        const fallback = {
          authorName: target.authorName || parsed.author,
          text: target.text || parsed.snippet,
          snippet: target.snippet || parsed.snippet,
        };
        const matches = all.filter(el => containsTarget(el, fallback));
        matches.sort((a, b) => textOf(a).length - textOf(b).length);
        return matches[0] || null;
      }
      function diagnoseTarget(target) {
        const parsed = parseTarget(target.label || '');
        const author = target.authorName || parsed.author;
        const text = snippet(target.text || target.snippet || parsed.snippet || '', 28);
        const bodyText = textOf(document.body || document.documentElement);
        const root = commentSearchRoot();
        return '页面文本包含作者=' + (!!author && bodyText.indexOf(author) >= 0) +
          '，包含片段=' + (!!text && bodyText.indexOf(text) >= 0) +
          '，搜索根=' + ((root && root.tagName) || 'document') +
          (target.id ? '，targetId=' + target.id : '');
      }
      function findReplyButton(root) {
        let cur = root;
        for (let i = 0; cur && i < 8; i++, cur = composedParent(cur)) {
          const els = [cur].concat(allElements(cur));
          const btn = els.find(el => {
            const txt = textOf(el);
            return el.matches && el.matches('button,a,[role="button"],.reply,.reply-btn,.sub-reply') &&
              /^回复$|回复/.test(txt) && txt.length <= 12 && visible(el);
          });
          if (btn) return btn;
        }
        return null;
      }
      function isEditor(el) {
        if (!el || !visible(el)) return false;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'textarea') return !el.disabled && !el.readOnly;
        if (tag === 'input') return /^(text|search)?$/.test(el.type || 'text') && !el.disabled && !el.readOnly;
        return el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === 'plaintext-only';
      }
      function deepActive(root) {
        let a = (root || document).activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a;
      }
      function composedContains(root, el) {
        for (let cur = el; cur; cur = composedParent(cur)) {
          if (cur === root) return true;
        }
        return false;
      }
      function clickElement(el) {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
        try { el.click(); return; } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
      }
      function findEditor(commentEl) {
        const scopes = [];
        for (let cur = commentEl, i = 0; cur && i < 4; i++, cur = composedParent(cur)) scopes.push(cur);
        const active = deepActive(document);
        if (isEditor(active) && scopes.some(r => composedContains(r, active))) return active;
        for (const r of scopes) {
          const found = allElements(r).filter(isEditor);
          if (found.length) return found[found.length - 1];
        }
        let commentRect = null;
        try { commentRect = commentEl && commentEl.getBoundingClientRect(); } catch (e) {}
        const nearby = allElements(document).filter(el => {
          if (!isEditor(el)) return false;
          if (!commentRect) return true;
          try {
            const r = el.getBoundingClientRect();
            return r.top >= commentRect.top - 12 && r.top <= commentRect.bottom + 320;
          } catch (e) { return false; }
        });
        if (nearby.length) return nearby[nearby.length - 1];
        return null;
      }
      function setEditorText(el, text) {
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
          if (textOf(el).indexOf(snippet(text, 12)) < 0) el.textContent = text;
        }
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); }
        catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const target = {
        id: payload.targetId || (payload.target && payload.target.id) || '',
        authorName: payload.target && payload.target.authorName,
        text: payload.target && payload.target.text,
        snippet: payload.target && payload.target.snippet,
        label: payload.targetLabel || payload.targetRaw || '',
      };
      const replyText = String(payload.text || '').trim();
      if (!replyText) return { ok: false, error: '回复内容为空' };
      const commentEl = findCommentElement(target);
      if (!commentEl) return { ok: false, error: '找不到目标评论，请先加载/滚动到这条评论附近（' + diagnoseTarget(target) + '）' };
      try { commentEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      await sleep(250);
      const replyBtn = findReplyButton(commentEl);
      if (!replyBtn) return { ok: false, error: '找到了评论，但没找到“回复”按钮' };
      clickElement(replyBtn);
      let editor = null;
      for (let i = 0; i < 12 && !editor; i++) {
        await sleep(180);
        editor = findEditor(commentEl);
      }
      if (!editor) return { ok: false, error: '已点开回复，但没找到输入框' };
      setEditorText(editor, replyText);
      return { ok: true };
    },
  });
  return (injected && injected[0] && injected[0].result) || { ok: false, error: '直接注入无返回' };
}

// ---- 底部 tab 切换 ----
document.querySelectorAll('.tabbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabbtn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('#pane-' + btn.dataset.tab).classList.add('active');
  });
});

// ---- 抓取 ----
async function grab() {
  const gen = ++grabGen;
  showReloadHint(false);
  $('#btn-copy').disabled = true; $('#btn-codex').disabled = true;
  $('#btn-more').classList.add('hidden');
  lastGrab = null;
  renderReplies(null);
  resetChips('loading'); setStatus('检测中…');
  try {
    const r = await send('GRAB_ALL', {});
    if (gen !== grabGen) return;   // 已被更新的抓取取代，丢弃旧结果
    lastGrab = r;
    setChip('#st-sub', r.subtitle.status, r.subtitle.count ? r.subtitle.count + '条' : '');
    setChip('#st-comment', r.comments.status, r.comments.count ? r.comments.count + '条' : '');
    setChip('#st-text', r.text.status, r.text.chars ? r.text.chars + '字' : '');
    $('#btn-more').classList.toggle('hidden', !(r.platform === 'bilibili' || r.platform === 'zhihu' || r.comments.status === 'has'));
    const any = r.subtitle.status === 'has' || r.comments.status === 'has' || r.text.status === 'has';
    $('#btn-copy').disabled = !r.bundle || !any;
    // 本地智能体按钮要连上本地 API 才可用，否则禁用避免误导。
    $('#btn-codex').disabled = !any || !configReady();
    setStatus(
      any
        ? (configReady() ? '✓ 已检测，可复制或点「生成话术」' : '✓ 已检测，可复制（未连接本地 API）')
        : '本页暂无可抓内容',
      any ? 'ok' : '',
    );
  } catch (e) {
    if (gen !== grabGen) return;
    resetChips('pending');
    if (/Receiving end does not exist|establish connection/i.test(String(e && e.message || e))) {
      setStatus('本页未注入脚本', 'error'); showReloadHint(true);
    } else setStatus('出错：' + (e && e.message || e), 'error');
  }
}

// ---- 评论分页：加载更多 ----
$('#btn-more').addEventListener('click', async () => {
  if (!lastGrab) return;
  const b = $('#btn-more'); b.disabled = true; b.textContent = '加载中…';
  setChip('#st-comment', 'loading');
  try {
    const r = await send('LOAD_MORE_COMMENTS', {});
    if (r && r.ok) {
      setChip('#st-comment', r.comments.status, r.comments.count ? r.comments.count + '条' : '');
      if (r.comments.md != null) lastGrab.comments = r.comments;
      if (r.bundle != null) lastGrab.bundle = r.bundle;
      setStatus('已加载更多评论（共 ' + (r.comments.count || 0) + ' 条）', 'ok');
    }
  } catch (e) { setStatus('加载更多失败：' + (e && e.message || e), 'error'); }
  finally { b.disabled = false; b.textContent = '加载更多'; }
});

// ---- 复制（合并内容）----
$('#btn-copy').addEventListener('click', async () => {
  if (!lastGrab || !lastGrab.bundle) return;
  try { await navigator.clipboard.writeText(lastGrab.bundle); setStatus('已复制全部内容', 'ok'); }
  catch (e) { setStatus('复制失败：' + (e && e.message || e), 'error'); }
});

// ---- 本地 API 连接（手填回退）：apiBase + token 持久化到 chrome.storage.local ----
async function loadConnFields() {
  const connected = configReady();
  const cs = $('#conn-status'), cst = $('#conn-status-text');
  if (cs && cst) {
    cst.textContent = connected
      ? (configFromRuntime ? '已连接 · 由 Donut 自动配置' : '已连接 · 手填连接')
      : '未连接 · 请从 Donut 启动此 profile';
    cs.className = 'conn-status ' + (connected ? 'ok' : 'off');
  }
  const src = $('#cfg-conn-source');
  if (src) {
    src.textContent = configFromRuntime
      ? '当前使用 Donut 注入的 marine-runtime-config.json（手填值仅在注入为空时生效）。'
      : (connected ? '当前使用手填连接（未检测到 Donut 注入）。' : '未检测到 Donut 注入，也未手填连接。');
  }
  const mc = await readManualConfig();
  if ($('#cfg-apibase')) $('#cfg-apibase').value = effectiveConfig.apiBase || mc.apiBase || '';
  if ($('#cfg-token')) $('#cfg-token').value = effectiveConfig.token || mc.token || '';
}
$('#cfg-conn-save').addEventListener('click', async () => {
  const mc = await readManualConfig();
  mc.apiBase = ($('#cfg-apibase').value || '').trim();
  mc.token = ($('#cfg-token').value || '').trim();
  await saveManualConfig(mc);
  await resolveConfig();
  await loadConnFields();
  setStatus('已保存连接设置', 'ok');
  try { await loadProviderConfig(); await loadAgents(); } catch (e) {}
});

// ---- 内置话术方案（skill）：预制在扩展 skills/<brand>/，直接复用，无需选品牌 ----
const SKILL_BRAND = 'scholay';
let skillCache = null;
async function fetchText(rel) {
  try { const r = await fetch(chrome.runtime.getURL(rel)); return r.ok ? await r.text() : ''; }
  catch (e) { return ''; }
}
// 合并 品牌.md + 评论口径.md + 风格参数.json 成一份人设/话术文本，交给本地智能体。
async function loadSkill() {
  if (skillCache) return skillCache;
  const base = 'skills/' + SKILL_BRAND + '/';
  const [brandMd, voice, style] = await Promise.all([
    fetchText(base + '品牌.md'),
    fetchText(base + '评论口径.md'),
    fetchText(base + '风格参数.json'),
  ]);
  skillCache = [brandMd, '', '---', '', voice, '', '---', '', '# 风格参数', '```json', style, '```'].join('\n');
  return skillCache;
}

// ---- 引擎 / 本地智能体（/provider-config + /agents）----
let selectedProvider = 'codex';
function selectProvider(p) {
  selectedProvider = p || 'codex';
  document.querySelectorAll('.agent-card').forEach((c) => c.classList.toggle('active', c.dataset.provider === selectedProvider));
  if ($('#openai-row')) $('#openai-row').classList.toggle('hidden', selectedProvider !== 'openai');
  if ($('#cli-model-row')) $('#cli-model-row').classList.toggle('hidden', selectedProvider === 'openai');
}
document.querySelectorAll('.agent-card').forEach((c) => c.addEventListener('click', () => selectProvider(c.dataset.provider)));

// 自动识别本机 codex / claude 的连接状态（Pencil 风格）
// 把 codex/claude 两张卡统一置为某个状态（避免一直停在「检测中…」占位）。
function setAgentCardsState(text, cls) {
  for (const id of ['codex', 'claude']) {
    const st = $('#ac-' + id + '-status');
    if (st) { st.textContent = text; st.className = 'agent-status ' + cls; }
    const card = $('#ac-' + id);
    const dot = card && card.querySelector('.agent-dot');
    if (dot) dot.className = 'agent-dot ' + cls;
  }
}
async function loadAgents() {
  if (!configReady()) { setAgentCardsState('未连接', 'off'); return; }
  try {
    const arr = (await apiFetch('/agents')) || [];
    for (const a of arr) {
      const st = $('#ac-' + a.id + '-status');
      const connected = a.detected && a.authed;
      if (st) {
        st.textContent = connected ? '已连接' : (a.detected ? '未登录 · 先在终端登录' : '未检测到');
        st.className = 'agent-status ' + (connected ? 'ok' : (a.detected ? 'warn' : 'off'));
      }
      const card = $('#ac-' + a.id);
      const dot = card && card.querySelector('.agent-dot');
      if (dot) dot.className = 'agent-dot ' + (connected ? 'ok' : (a.detected ? 'warn' : 'off'));
    }
  } catch (e) {
    // 已配置但请求失败（服务没起/端口不对/token 失效）——显式置「连接失败」，
    // 不要把卡片留在「检测中…」。
    setAgentCardsState('连接失败', 'off');
  }
}

async function loadProviderConfig() {
  try {
    const cfg = await apiFetch('/provider-config');
    if (!cfg) return;
    selectProvider(cfg.provider || 'codex');
    if ($('#pv-cli-model')) $('#pv-cli-model').value = cfg.cli_model || '';
    if ($('#pv-openai-base')) $('#pv-openai-base').value = cfg.openai_base_url || '';
    if ($('#pv-openai-model')) $('#pv-openai-model').value = cfg.openai_model || '';
  } catch (e) { /* 未连接时静默 */ }
}
$('#pv-save').addEventListener('click', async () => {
  const body = {
    provider: selectedProvider || null,
    cli_model: ($('#pv-cli-model').value || '').trim() || null,
    openai_base_url: ($('#pv-openai-base').value || '').trim() || null,
    openai_model: ($('#pv-openai-model').value || '').trim() || null,
  };
  try {
    await apiFetch('/provider-config', { method: 'PUT', body: JSON.stringify(body) });
    setStatus('已保存引擎配置', 'ok');
  } catch (e) { setStatus('保存引擎配置失败：' + (e && e.message || e), 'error'); }
});

// ---- 本地智能体：调用本地 HTTP API 生成直评/回复 ----
$('#btn-codex').addEventListener('click', async () => {
  if (!lastGrab) return;
  if (!configReady()) { setStatus('未连接本地 API —— 从 Donut 启动此 profile 会自动连接', 'error'); return; }
  $('#btn-codex').disabled = true;
  renderReplies(null);
  setStatus('本地智能体生成中…（首次可能十几秒）');
  try {
    const maintext = (lastGrab.text && lastGrab.text.md) || '';
    const subtitleText = (lastGrab.subtitle && lastGrab.subtitle.text) || '';
    const commentsStr = (lastGrab.comments && (lastGrab.comments.agentMd || lastGrab.comments.md)) || '';
    const payload = {
      article: maintext ? { markdown: maintext } : null,
      subtitle: subtitleText ? { text: subtitleText } : null,
      comments: commentsStr ? { agentMd: commentsStr } : null,
    };
    const res = await apiFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({ skill: await loadSkill(), payload }),
    });
    if (res && (res.direct || res.replies)) {
      renderReplies(res);
      setStatus('✓ 直评 ' + ((res.direct || []).length) + ' / 回复 ' + ((res.replies || []).length), 'ok');
    } else {
      setStatus('生成失败：返回为空', 'error');
    }
  } catch (e) {
    setStatus('出错：' + String((e && e.message) || e), 'error');
  } finally { $('#btn-codex').disabled = false; }
});

// 渲染本地智能体返回的推荐话术（res=null 清空）
function renderReplies(res) {
  const box = $('#replies'); if (!box) return;
  box.innerHTML = '';
  if (!res) return;
  function parseReplyTarget(target) {
    const s = String(target || '').replace(/^回复\s*@?\s*/, '').trim();
    return {
      authorName: ((s.match(/^@?([^（(「"“：:]+)/) || [])[1] || '').trim(),
      snippet: ((s.match(/[「"“](.+?)[」"”]/) || [])[1] || '').replace(/\s+/g, ' ').trim(),
    };
  }
  function findReplyTarget(reply) {
    const targets = (lastGrab && lastGrab.comments && lastGrab.comments.targets) || [];
    const id = String((reply && reply.targetId) || '').trim();
    if (id) return targets.find(t => String(t.id) === id) || { id, label: reply.target || '' };
    const parsed = parseReplyTarget(reply && reply.target);
    if (!parsed.authorName && !parsed.snippet) return { label: reply && reply.target || '' };
    const byAuthor = targets.filter(t => !parsed.authorName || t.authorName === parsed.authorName);
    const bySnippet = byAuthor.find(t => parsed.snippet && String(t.text || '').indexOf(parsed.snippet) >= 0);
    return bySnippet || byAuthor[0] || { authorName: parsed.authorName, snippet: parsed.snippet, label: reply && reply.target || '' };
  }
  async function injectReplyDraft(reply, text, btn) {
    if (!reply || !text) return;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '填入中…';
    const target = findReplyTarget(reply);
    const payload = {
      targetId: reply.targetId || target.id || '',
      target,
      targetRaw: reply.target || '',
      text,
    };
    try {
      let r = await send('INJECT_REPLY_DRAFT', payload);
      if ((!r || !r.ok) && staleContentScriptError((r && r.error) || r)) r = await injectReplyDraftDirect(payload);
      if (r && r.ok) {
        btn.textContent = '已填入';
        setStatus('已填入对应回复框，请在页面里确认后手动发送', 'ok');
        setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
      } else {
        btn.textContent = old; btn.disabled = false;
        setStatus('填入失败：' + ((r && r.error) || '未知'), 'error');
      }
    } catch (e) {
      try {
        if (!staleContentScriptError(e)) throw e;
        const r = await injectReplyDraftDirect(payload);
        if (r && r.ok) {
          btn.textContent = '已填入';
          setStatus('已填入对应回复框，请在页面里确认后手动发送', 'ok');
          setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
          return;
        }
        btn.textContent = old; btn.disabled = false;
        setStatus('填入失败：' + ((r && r.error) || '未知'), 'error');
      } catch (err) {
        btn.textContent = old; btn.disabled = false;
        setStatus('填入失败：' + ((err && err.message) || err), 'error');
      }
    }
  }
  async function markPosted(opts, text, btn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '记录中…';
    try {
      await apiFetch('/history', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: effectiveConfig.profileId || '',
          brand_id: SKILL_BRAND,
          target_url: (lastGrab && lastGrab.url) || '',
          platform: (lastGrab && lastGrab.platform) || '',
          kind: opts.kind || 'direct',
          angle: opts.angle || '',
          text: text || '',
        }),
      });
      btn.textContent = '已发'; btn.classList.add('done');
      setStatus('已记录到发布历史', 'ok');
    } catch (e) {
      btn.textContent = old; btn.disabled = false;
      setStatus('标记失败：' + String((e && e.message) || e), 'error');
    }
  }
  function card(head, text, opts) {
    opts = opts || {};
    const c = document.createElement('div'); c.className = 'reply-card';
    const h = document.createElement('div'); h.className = 'reply-head'; h.textContent = head;
    const t = document.createElement('div'); t.className = 'reply-text'; t.textContent = text;
    const actions = document.createElement('div'); actions.className = 'reply-actions';
    const cp = document.createElement('button'); cp.className = 'reply-copy'; cp.textContent = '复制';
    cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制'; }, 1200); } catch (e) {}
    });
    actions.appendChild(cp);
    if (opts.reply) {
      const fill = document.createElement('button');
      fill.className = 'reply-copy reply-fill';
      fill.textContent = '填入回复框';
      fill.addEventListener('click', () => injectReplyDraft(opts.reply, text, fill));
      actions.appendChild(fill);
    }
    const post = document.createElement('button');
    post.className = 'reply-copy reply-post';
    post.textContent = '标记已发';
    post.addEventListener('click', () => markPosted(opts, text, post));
    actions.appendChild(post);
    c.appendChild(h); c.appendChild(t); c.appendChild(actions);
    return c;
  }
  function replyHead(target) {
    let cleaned = String(target || '').trim();
    for (let i = 0; i < 3; i++) cleaned = cleaned.replace(/^回复\s*@?\s*/, '').trim();
    cleaned = cleaned.replace(/^@+\s*/, '').trim();
    return cleaned ? ('回复 @' + cleaned) : '回复';
  }
  (res.direct || []).forEach((d, i) => box.appendChild(card('直评 ' + (i + 1) + (d.angle ? ' · ' + d.angle : ''), d.text || '', { kind: 'direct', angle: d.angle || '' })));
  (res.replies || []).forEach((r) => box.appendChild(card(replyHead(r.target), r.text || '', { reply: r, kind: 'reply', angle: '' })));
}

// ---- 刷新页面（未注入时）----
$('#btn-reload').addEventListener('click', async () => {
  try { await chrome.tabs.reload(activeTabId); showReloadHint(false); resetChips('pending'); setStatus('已刷新页面，稍候再点「一键抓取」', ''); }
  catch (e) { setStatus('刷新失败：' + (e && e.message || e), 'error'); }
});

// ---- 评论被动到了（晚于抓取） → 刷新计数（不滚动页面）----
let refreshingComments = false;
async function refreshComments() {
  if (refreshingComments || !lastGrab) return;
  refreshingComments = true;
  try {
    const r = await send('REBUILD_COMMENTS');
    if (r && r.ok && r.comments) {
      setChip('#st-comment', r.comments.status, r.comments.count ? r.comments.count + '条' : '');
      lastGrab.comments = r.comments;
      if (r.bundle != null) lastGrab.bundle = r.bundle;
      const any = (lastGrab.subtitle && lastGrab.subtitle.status === 'has') || r.comments.status === 'has' || (lastGrab.text && lastGrab.text.status === 'has');
      $('#btn-copy').disabled = !lastGrab.bundle || !any;
      $('#btn-codex').disabled = !any;
    }
  } catch (e) {} finally { refreshingComments = false; }
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.__marineCommentUpdate && sender && sender.tab && sender.tab.id === activeTabId) refreshComments();
});

// ---- 对准当前标签页（侧边栏常驻，切 tab / 刷新要重对准并重置）----
let myWindowId = null;
async function attach(reset) {
  if (EMBEDDED_TAB_ID != null) {
    activeTabId = EMBEDDED_TAB_ID;   // 悬浮侧栏：绑定宿主标签页
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    activeTabId = tab.id;
  }
  lastGrab = null;
  resetChips('pending');
  $('#btn-copy').disabled = true;
  $('#btn-codex').disabled = true;
  $('#btn-more').classList.add('hidden');
  showReloadHint(false);
  setStatus('检测中…');
  let ping;
  try { ping = await chrome.tabs.sendMessage(activeTabId, { type: 'PING' }); }
  catch (e) {
    $('#platform').textContent = '未注入';
    setStatus('本页未注入脚本', 'error'); showReloadHint(true);
    return;
  }
  $('#platform').textContent = ping.platformLabel || ping.platform;
  loadLogs();   // 拉当前页的历史日志到「调试」tab
  if (reset) { try { await chrome.tabs.sendMessage(activeTabId, { type: 'RESET_COMMENTS' }); } catch (e) {} }
  grab();   // 自动抓取（被动，不滚动页面）
}
// 切标签 → 重对准并自动抓；页内导航(换视频)/整页加载完成 → 重抓（导航时清旧评论）
chrome.tabs.onActivated.addListener(info => { if (EMBEDDED_TAB_ID == null && info.windowId === myWindowId) attach(false); });
chrome.tabs.onUpdated.addListener((tabId, ci) => {
  if (tabId !== activeTabId) return;
  if (ci.url) attach(true);
  else if (ci.status === 'complete') attach(false);
});

// ---- 初始化（一次性）----
(async function init() {
  if (EMBEDDED_TAB_ID == null) {
    try { const w = await chrome.windows.getCurrent(); myWindowId = w.id; } catch (e) {}
  }
  await resolveConfig();          // 解析 runtime-config / 手填连接
  await attach();

  await loadConnFields();
  try { await loadAgents(); } catch (e) {}   // 已处理未连接态（显示「未连接」）
  if (configReady()) {
    try { await loadProviderConfig(); } catch (e) {}
  } else {
    setStatus('未连接本地 API —— 从 Donut 启动此 profile 会自动连接', '');
  }
})();

// ---- 调试日志（侧边栏「调试」tab）----
const DBG_CLASS = { net: 'dbg-net', ok: 'dbg-ok', track: 'dbg-track', comment: 'dbg-track', warn: 'dbg-warn', error: 'dbg-error', info: 'dbg-info', debug: 'dbg-info' };
function dbgRender(e) {
  const box = $('#dbg-log'); if (!box) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const div = document.createElement('div');
  div.className = 'dbg-line ' + (DBG_CLASS[e.level] || 'dbg-info');
  div.textContent = e.t + ' ' + (e.tag ? '[' + e.tag + '] ' : '') + e.msg + (e.data !== undefined ? '  ' + e.data : '');
  box.appendChild(div);
  while (box.children.length > 800) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
async function loadLogs() {
  const box = $('#dbg-log'); if (!box) return;
  box.innerHTML = '';
  try { const r = await send('GET_LOGS'); ((r && r.logs) || []).forEach(dbgRender); } catch (e) {}
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.__marineLog && sender && sender.tab && sender.tab.id === activeTabId) dbgRender(msg.__marineLog);
});
$('#dbg-clear').addEventListener('click', () => { const b = $('#dbg-log'); if (b) b.innerHTML = ''; });
// 多级导出：剪贴板 → execCommand → 下载文件（注入式悬浮侧栏里剪贴板会被 iframe 权限策略挡）。
async function exportSnapshotText(text) {
  try { await navigator.clipboard.writeText(text); return 'clipboard'; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return 'clipboard';
  } catch (e) {}
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    if (chrome.downloads && chrome.downloads.download) {
      await new Promise((res, rej) => chrome.downloads.download(
        { url, filename: 'marine-snapshot.json', saveAs: false },
        (id) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(id))));
    } else {
      const a = document.createElement('a'); a.href = url; a.download = 'marine-snapshot.json';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    return 'download';
  } catch (e) {}
  return null;
}
$('#dbg-snapshot').addEventListener('click', async () => {
  const btn = $('#dbg-snapshot'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '抓取中…';
  const now = () => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } };
  try {
    const r = await send('DEBUG_SNAPSHOT');
    if (!r || !r.ok || !r.snapshot) throw new Error((r && r.error) || '无返回（本页可能未注入脚本，刷新后再试）');
    const text = JSON.stringify(r.snapshot, null, 2);
    const info = '（' + text.length + ' 字符，平台=' + (r.snapshot.meta && r.snapshot.meta.platform) + '，捕获 ' + (r.snapshot.captureCount || 0) + ' 条响应，解析 ' + ((r.snapshot.grab && r.snapshot.grab.count) || 0) + ' 条）';
    const how = await exportSnapshotText(text);
    if (how === 'clipboard') { btn.textContent = '已复制 ✓'; dbgRender({ t: now(), level: 'ok', tag: 'snapshot', msg: '已复制快照到剪贴板 ' + info + '——粘贴发给开发者' }); }
    else if (how === 'download') { btn.textContent = '已下载 ✓'; dbgRender({ t: now(), level: 'ok', tag: 'snapshot', msg: '剪贴板被拦，已下载 marine-snapshot.json ' + info + '——把该文件发给开发者' }); }
    else throw new Error('复制与下载都失败');
  } catch (e) {
    btn.textContent = '失败';
    dbgRender({ t: now(), level: 'error', tag: 'snapshot', msg: '导出快照失败：' + (e && e.message || e) });
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 1600);
  }
});
