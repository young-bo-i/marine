// popup.js — 一键抓取（字幕/评论/正文）、话术资料配置与发布记录。
// 话术由本机智能体（Codex/Claude）经 Donut 后端 /v1/marine/generate-stream 执行：
// 选中评论/回复框后点页内浮出的「生成」按钮，结果只填草稿，绝不自动发送。
const $ = sel => document.querySelector(sel);

let activeTabId = null;
let lastGrab = null;   // 最近一次抓取结果（含三块内容 + 合并 bundle）
let grabGen = 0;       // 抓取代次：切页/重抓时作废在途请求，避免旧结果覆盖

// ---- 运行时配置 + 品牌状态 ----
let effectiveConfig = { apiBase: '', token: '', profileId: '' };
let configFromRuntime = false; // apiBase/token 是否来自 runtime-config.json（Marine 注入）
let profileFromRuntime = false;

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
  profileFromRuntime = nz(rc.profileId);
  return effectiveConfig;
}
function configReady() { return !!(effectiveConfig.apiBase && effectiveConfig.token); }

// ---- 本地 API 调用（每次都带 Authorization: Bearer）----
async function apiFetch(path, options) {
  options = options || {};
  if (!configReady()) throw new Error('未配置本地 API（apiBase/token）——请到「配置」手动填写，或等待 Marine 注入');
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

function syncRecordButton(hasPageContent) {
  const button = $('#btn-record');
  if (!button) return;
  const automatic = !!(lastGrab && lastGrab.platform === 'bilibili');
  button.textContent = automatic ? '发布成功后自动记录' : '记录已发布';
  button.disabled = automatic || !hasPageContent || !configReady();
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
  $('#btn-copy').disabled = true; $('#btn-record').disabled = true;
  $('#btn-more').classList.add('hidden');
  lastGrab = null;
  resetChips('loading'); setStatus('检测中…');
  try {
    const r = await send('GRAB_ALL', {});
    if (gen !== grabGen) return;   // 已被更新的抓取取代，丢弃旧结果
    lastGrab = r;
    setChip('#st-sub', r.subtitle.status, r.subtitle.count ? r.subtitle.count + '条' : '');
    setChip('#st-comment', r.comments.status, r.comments.count ? r.comments.count + '条' : '');
    setChip('#st-text', r.text.status, r.text.chars ? r.text.chars + '字' : '');
    $('#btn-more').classList.toggle('hidden', !(
      r.platform === 'bilibili' || r.platform === 'zhihu' ||
      r.platform === 'xiaohongshu' || r.comments.status === 'has'
    ));
    const any = r.subtitle.status === 'has' || r.comments.status === 'has' || r.text.status === 'has';
    $('#btn-copy').disabled = !r.bundle || !any;
    syncRecordButton(any);
    setStatus(
      any
        ? (configReady()
          ? '✓ 已检测；选中评论/回复框后点页内浮出的「生成」按钮，用本机连接器生成话术'
          : '✓ 已检测，可复制（未连接 Marine，无法同步话术与记录）')
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
      ? (configFromRuntime ? '已连接 · 由 Marine 自动配置' : '已连接 · 手填连接')
      : '未连接 · 可启动开发桥并手动配置';
    cs.className = 'conn-status ' + (connected ? 'ok' : 'off');
  }
  const src = $('#cfg-conn-source');
  if (src) {
    src.textContent = configFromRuntime
      ? '当前使用 Marine 注入的 marine-runtime-config.json（手填值仅在注入为空时生效）。'
      : (connected ? '当前使用手填连接（Chrome 独立调试）。' : '未检测到 Marine 注入，也未手填开发桥连接。');
  }
  const mc = await readManualConfig();
  if ($('#cfg-apibase')) $('#cfg-apibase').value = effectiveConfig.apiBase || mc.apiBase || '';
  // Runtime-injected credentials must never be reflected into a visible DOM
  // field. Manual credentials remain editable, but the password input masks
  // them and browser autocomplete is disabled in popup.html.
  if ($('#cfg-token')) $('#cfg-token').value = configFromRuntime ? '' : (mc.token || '');
  await loadIdentityOptions();
}

async function loadIdentityOptions() {
  const select = $('#cfg-profile');
  const status = $('#cfg-profile-status');
  if (!select) return;

  const selectedId = effectiveConfig.profileId || '';
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = configReady() ? '请选择身份…' : '请先连接 Marine…';
  select.appendChild(placeholder);
  select.disabled = true;

  if (!configReady()) {
    if (status) status.textContent = '连接 Marine 后，自动发布记录会归入所选身份。';
    return;
  }

  try {
    const response = await apiFetch('/identities');
    const identities = Array.isArray(response)
      ? response
      : (response && Array.isArray(response.identities) ? response.identities : []);
    identities.forEach(identity => {
      if (!identity || !identity.id) return;
      const option = document.createElement('option');
      option.value = String(identity.id);
      option.textContent = String(identity.name || identity.id);
      select.appendChild(option);
    });
    const selectedExists = identities.some(identity => String(identity && identity.id) === selectedId);
    if (selectedId && !selectedExists) {
      const option = document.createElement('option');
      option.value = selectedId;
      option.textContent = '当前身份不可用 · ' + selectedId;
      select.appendChild(option);
    }
    select.value = selectedId;
    select.disabled = profileFromRuntime;
    if (status) {
      status.textContent = profileFromRuntime
        ? '当前身份由 Marine 启动的浏览器配置，发布记录会自动归档。'
        : (selectedId && selectedExists
          ? '已选择身份，之后确认成功的评论会自动归档。'
          : (selectedId
            ? '原身份已不存在，请重新选择一个 Marine 身份。'
            : (identities.length ? '请选择本次 Chrome 调试所使用的 Marine 身份。' : 'Marine 中还没有可选身份。')));
    }
  } catch (e) {
    if (selectedId) {
      const option = document.createElement('option');
      option.value = selectedId;
      option.textContent = '当前身份 · ' + selectedId;
      select.appendChild(option);
      select.value = selectedId;
    }
    select.disabled = profileFromRuntime;
    if (status) status.textContent = '身份列表读取失败；请确认 Marine 已更新并正在运行。';
  }
}
$('#cfg-conn-save').addEventListener('click', async () => {
  const mc = await readManualConfig();
  mc.apiBase = ($('#cfg-apibase').value || '').trim();
  const nextToken = ($('#cfg-token').value || '').trim();
  if (nextToken) mc.token = nextToken;
  if (!profileFromRuntime && $('#cfg-profile')) mc.profileId = ($('#cfg-profile').value || '').trim();
  await saveManualConfig(mc);
  await resolveConfig();
  await loadConnFields();
  setStatus('已保存连接设置', 'ok');
});
$('#cfg-profile').addEventListener('change', async () => {
  if (profileFromRuntime) return;
  const mc = await readManualConfig();
  mc.profileId = ($('#cfg-profile').value || '').trim();
  await saveManualConfig(mc);
  await resolveConfig();
  const status = $('#cfg-profile-status');
  if (status) status.textContent = effectiveConfig.profileId
    ? '已选择身份，之后确认成功的评论会自动归档。'
    : '尚未选择身份，自动发布记录不会写入账本。';
});

// ---- 内置话术方案：后台会把母稿与补充范文发布为 Marine/Rime context ----
const SKILL_BRAND = 'scholay';

// ---- 导入本地 .md 作为补充范文（存 chrome.storage，生成时并入 skill）----
// ---- AI 模型连接器：自动探测本机 codex/claude + 读写 provider-config ----
const CONNECTOR_LABEL = { codex: 'Codex', claude: 'Claude Code', openai: '通用 OpenAI 兼容端点' };
// PUT /provider-config 是整体替换：保留 GET 到的完整配置，保存时只改 provider，
// 不清空经 API 设置的 cli_model / openai_base_url / openai_model。
let marineConnectorConfig = {};

async function loadConnectorOptions() {
  const select = $('#cfg-connector');
  const status = $('#cfg-connector-status');
  if (!select || !status) return;
  if (!configReady()) { status.textContent = '连接本地 API 后即可选择本机智能体连接器。'; return; }
  let agents = [];
  try { agents = await apiFetch('/agents') || []; }
  catch (e) { status.textContent = '检测智能体失败：' + String(e && e.message || e); return; }
  if (!Array.isArray(agents)) agents = [];
  let config = {};
  try { config = await apiFetch('/provider-config') || {}; } catch (e) {}
  marineConnectorConfig = config || {};
  const provider = typeof config.provider === 'string' ? config.provider : '';
  // 若经 API 配了 popup 下拉里没有的 provider（如 openai），动态补一项，保证保存时不被复位。
  if (provider && !Array.from(select.options).some(o => o.value === provider)) {
    const opt = document.createElement('option');
    opt.value = provider;
    opt.textContent = (CONNECTOR_LABEL[provider] || provider) + '（经 API 配置）';
    select.appendChild(opt);
  }
  select.value = provider;
  const ready = agents.filter(a => a && a.detected && a.authed).map(a => a.id);
  const parts = agents.map(a => {
    const name = CONNECTOR_LABEL[a.id] || a.id;
    const state = (a.detected && a.authed) ? '✓ 已连接' : a.detected ? '· 已安装未登录' : '· 未安装';
    return name + ' ' + state;
  });
  let hint;
  if (!ready.length) hint = '未检测到已登录的本机智能体，请先安装并登录 Codex 或 Claude Code CLI。';
  else if (!select.value) hint = '自动将使用 ' + (CONNECTOR_LABEL[ready.includes('codex') ? 'codex' : ready[0]] || ready[0]) + '。';
  else if (!ready.includes(select.value)) hint = '注意：所选连接器当前未就绪。';
  else hint = '当前使用 ' + (CONNECTOR_LABEL[select.value] || select.value) + '。';
  status.textContent = parts.join('　') + (parts.length ? ' · ' : '') + hint;
}

if ($('#cfg-connector-save')) $('#cfg-connector-save').addEventListener('click', async () => {
  const select = $('#cfg-connector');
  const status = $('#cfg-connector-status');
  if (!select) return;
  try {
    const c = marineConnectorConfig || {};
    await apiFetch('/provider-config', { method: 'PUT', body: JSON.stringify({
      provider: select.value || null,
      cli_model: c.cli_model != null ? c.cli_model : null,
      openai_base_url: c.openai_base_url != null ? c.openai_base_url : null,
      openai_model: c.openai_model != null ? c.openai_model : null,
    }) });
    if (status) status.textContent = '已保存，正在刷新…';
    await loadConnectorOptions();
  } catch (e) {
    if (status) status.textContent = '保存失败：' + String(e && e.message || e);
  }
});

async function loadSampleStatus() {
  const st = $('#sample-status'), clr = $('#sample-clear');
  let o = {};
  try { o = await chrome.storage.local.get(['marineCustomSampleName', 'marineCustomSampleMd']); } catch (e) {}
  if (o && o.marineCustomSampleMd) {
    const kb = (o.marineCustomSampleMd.length / 1024).toFixed(1);
    if (st) st.textContent = '已导入补充范文：' + (o.marineCustomSampleName || 'custom.md') + '（' + kb + 'KB，作为原版母稿之后的次级参照）';
    if (clr) clr.classList.remove('hidden');
  } else {
    if (st) st.textContent = '未导入补充范文（当前只用原版母稿）。';
    if (clr) clr.classList.add('hidden');
  }
}
if ($('#sample-import')) $('#sample-import').addEventListener('click', () => { const f = $('#sample-file'); if (f) f.click(); });
if ($('#sample-file')) $('#sample-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!/\.md$/i.test(f.name)) { setStatus('只支持导入 .md 文档', 'error'); return; }
  if (f.size > 200 * 1024) { setStatus('范文过大（>200KB），请精简后再导入', 'error'); return; }
  try {
    const text = await f.text();
    await chrome.storage.local.set({ marineCustomSampleMd: text, marineCustomSampleName: f.name });
    await loadSampleStatus();
    setStatus('已导入补充范文：' + f.name, 'ok');
  } catch (err) { setStatus('导入失败：' + ((err && err.message) || err), 'error'); }
});
if ($('#sample-clear')) $('#sample-clear').addEventListener('click', async () => {
  try { await chrome.storage.local.remove(['marineCustomSampleMd', 'marineCustomSampleName']); } catch (e) {}
  await loadSampleStatus();
  setStatus('已移除补充范文（恢复只用原版母稿）', 'ok');
});

// ---- 独立发布记录：Marine 记录事实，不生成候选 ----
async function recordPublishedManually() {
  if (!lastGrab) return;
  if (lastGrab.platform === 'bilibili') {
    setStatus('Bilibili 发布成功后会自动记录，无需手动重复归档', 'ok');
    return;
  }
  if (!configReady()) {
    setStatus('未连接 Marine，无法写入发布记录', 'error');
    return;
  }
  if (!effectiveConfig.profileId) {
    setStatus('请先到「配置」选择 Marine 身份', 'error');
    return;
  }
  const text = window.prompt('请确认实际发布的文字（如在网页中改过，请在这里同步修改）：', '');
  if (text == null) return;
  if (!text.trim()) {
    setStatus('实际发布文字不能为空', 'error');
    return;
  }
  const rawKind = window.prompt('发布类型：输入 direct（直评）或 reply（回复）', 'direct');
  if (rawKind == null) return;
  const kind = String(rawKind).trim().toLowerCase() === 'reply' ? 'reply' : 'direct';
  let targetCommentId = '';
  let targetAuthor = '';
  if (kind === 'reply') {
    targetAuthor = (window.prompt('目标作者（可留空）：', '') || '').trim();
    targetCommentId = (window.prompt('目标评论 ID（可留空）：', '') || '').trim();
  }

  const button = $('#btn-record');
  const old = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '记录中…'; }
  try {
    await apiFetch('/history', {
      method: 'POST',
      body: JSON.stringify({
        profile_id: effectiveConfig.profileId,
        brand_id: SKILL_BRAND,
        target_url: lastGrab.url || '',
        page_title: lastGrab.title || '',
        platform: lastGrab.platform || '',
        kind,
        angle: '',
        text: text.trim(),
        target_comment_id: targetCommentId,
        target_author: targetAuthor,
      }),
    });
    setStatus('已记录到发布历史', 'ok');
  } catch (e) {
    setStatus('记录失败：' + String((e && e.message) || e), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = old || '记录已发布'; }
  }
}
if ($('#btn-record')) $('#btn-record').addEventListener('click', recordPublishedManually);

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
      syncRecordButton(any);
    }
  } catch (e) {} finally { refreshingComments = false; }
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.__marineCommentUpdate && sender && sender.tab && sender.tab.id === activeTabId) refreshComments();
});

// ---- 对准当前标签页（侧边栏常驻，切 tab / 刷新要重对准并重置）----
let myWindowId = null;
async function attach(reset) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;
  lastGrab = null;
  resetChips('pending');
  $('#btn-copy').disabled = true;
  $('#btn-record').disabled = true;
  $('#btn-record').textContent = '记录已发布';
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
// `myWindowId` is best-effort (see init): if it could not be resolved, fall back
// to re-attaching on ANY activation rather than never. This is now the ONLY
// tab-tracking path — the injected panel used to pin itself to its host tab —
// so failing closed here would silently freeze the panel on one tab.
chrome.tabs.onActivated.addListener(info => {
  if (myWindowId == null || info.windowId === myWindowId) attach(false);
});
chrome.tabs.onUpdated.addListener((tabId, ci) => {
  if (tabId !== activeTabId) return;
  if (ci.url) attach(true);
  else if (ci.status === 'complete') attach(false);
});

// ---- 初始化（一次性）----
(async function init() {
  try { const w = await chrome.windows.getCurrent(); myWindowId = w.id; } catch (e) {}
  await resolveConfig();          // 解析 runtime-config / 手填连接
  await attach();

  await loadConnFields();
  try { await loadConnectorOptions(); } catch (e) {}  // AI 连接器：探测 + 当前选择
  try { await loadSampleStatus(); } catch (e) {}   // 本地导入范文状态（与 API 无关）
  if (!configReady()) setStatus('未连接本地 API —— 请在「配置」中手动连接，或由 Marine 自动注入', '');
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
  if (!msg || !sender || !sender.tab || sender.tab.id !== activeTabId) return;
  // 合批推送是当前格式；单条格式保留，兼容页面里还没被替换掉的旧注入脚本。
  if (Array.isArray(msg.__marineLogBatch)) msg.__marineLogBatch.forEach(dbgRender);
  else if (msg.__marineLog) dbgRender(msg.__marineLog);
});
$('#dbg-clear').addEventListener('click', async () => {
  const b = $('#dbg-log'); if (b) b.innerHTML = '';
  try { await send('CLEAR_LOGS'); } catch (e) {}
});
// 多级导出：剪贴板 → execCommand → 下载文件。原因曾是注入式悬浮侧栏的 iframe 权限策略
// 会挡掉剪贴板；那个面板已移除，但侧边栏失焦时 navigator.clipboard 仍会被拒，兜底照旧。
async function exportSnapshotText(text, filename) {
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
        { url, filename: filename || 'marine-snapshot.json', saveAs: false },
        (id) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(id))));
    } else {
      const a = document.createElement('a'); a.href = url; a.download = filename || 'marine-snapshot.json';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    return 'download';
  } catch (e) {}
  return null;
}
$('#dbg-rime').addEventListener('click', async () => {
  const btn = $('#dbg-rime'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '复制中…';
  try {
    const r = await send('GET_RIME_DIAGNOSTICS');
    const events = (r && r.events) || [];
    if (!events.length) throw new Error('还没有 Rime 诊断事件，请先复现一次');
    const text = JSON.stringify({ schema: 1, events }, null, 2);
    const how = await exportSnapshotText(text, 'marine-rime-diagnostic.json');
    if (!how) throw new Error('复制与下载都失败');
    btn.textContent = how === 'clipboard' ? '已复制 ✓' : '已下载 ✓';
  } catch (e) {
    btn.textContent = '无诊断';
    dbgRender({ t: new Date().toLocaleTimeString(), level: 'warn', tag: 'rime-diag', msg: String(e && e.message || e) });
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 1800);
});
$('#dbg-snapshot').addEventListener('click', async () => {
  const btn = $('#dbg-snapshot'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '抓取中…';
  const now = () => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } };
  try {
    const r = await send('DEBUG_SNAPSHOT');
    if (!r || !r.ok || !r.snapshot) throw new Error((r && r.error) || '无返回（本页可能未注入脚本，刷新后再试）');
    const text = JSON.stringify(r.snapshot, null, 2);
    const info = '（' + text.length + ' 字符，平台=' + (r.snapshot.meta && r.snapshot.meta.platform) + '，捕获 ' + (r.snapshot.captureCount || 0) + ' 条响应，解析 ' + ((r.snapshot.grab && r.snapshot.grab.count) || 0) + ' 条）';
    const how = await exportSnapshotText(text, 'marine-snapshot.json');
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
