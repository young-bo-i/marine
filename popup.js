// popup.js — 一键抓取（字幕/评论/正文），评论可分页加载更多；
// 「本地智能体」把 skills + 三个内容文件写到「下载/marine/<run>/」并用 codex:// 新建对话读取。
const $ = sel => document.querySelector(sel);

let activeTabId = null;
let lastGrab = null;   // 最近一次抓取结果（含三块内容 + 合并 bundle）
const BRAND = 'scholay';

function send(type, opts) { return chrome.tabs.sendMessage(activeTabId, { type, opts }); }

// 唯一标识（便于在下载里定位、避免重名）
function uid() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' +
    Math.random().toString(36).slice(2, 5);
}
function setChip(id, state, extra) {
  const el = $(id);
  const map = { pending: ['待获取', 'pending'], loading: ['获取中…', 'loading'], has: ['有' + (extra ? ' · ' + extra : ''), 'has'], none: ['无', 'none'] };
  const v = map[state] || map.pending;
  el.textContent = v[0]; el.className = 'chip ' + v[1];
}
function resetChips(s) { setChip('#st-sub', s); setChip('#st-comment', s); setChip('#st-text', s); }
function setStatus(text, kind) { const el = $('#grab-status'); el.textContent = text || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }
function showReloadHint(v) { $('#reload-hint').classList.toggle('hidden', !v); }

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
  showReloadHint(false);
  $('#btn-grab').disabled = true; $('#btn-copy').disabled = true; $('#btn-codex').disabled = true;
  $('#btn-more').classList.add('hidden');
  lastGrab = null;
  resetChips('loading'); setStatus('抓取中…');
  try {
    const r = await send('GRAB_ALL', {});
    lastGrab = r;
    setChip('#st-sub', r.subtitle.status, r.subtitle.count ? r.subtitle.count + '条' : '');
    setChip('#st-comment', r.comments.status, r.comments.count ? r.comments.count + '条' : '');
    setChip('#st-text', r.text.status, r.text.chars ? r.text.chars + '字' : '');
    $('#btn-more').classList.toggle('hidden', r.comments.status !== 'has');
    const any = r.subtitle.status === 'has' || r.comments.status === 'has' || r.text.status === 'has';
    $('#btn-copy').disabled = !r.bundle || !any;
    $('#btn-codex').disabled = !any;
    setStatus(any ? '✓ 完成，可复制或发到本地智能体' : '本页没抓到内容', any ? 'ok' : 'error');
  } catch (e) {
    resetChips('pending');
    if (/Receiving end does not exist|establish connection/i.test(String(e && e.message || e))) {
      setStatus('本页未注入脚本', 'error'); showReloadHint(true);
    } else setStatus('出错：' + (e && e.message || e), 'error');
  } finally { $('#btn-grab').disabled = false; }
}
$('#btn-grab').addEventListener('click', grab);

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

// ---- 读取扩展自带的 skill（合并成一份）----
async function fetchText(rel) {
  try { const r = await fetch(chrome.runtime.getURL(rel)); return r.ok ? await r.text() : ''; }
  catch (e) { return ''; }
}
// 文件名转 ASCII（macOS unzip 无法解压 UTF-8 文件名；文件内容仍是 UTF-8 中文，不受影响）
function asciiName(name, fallback) {
  const c = String(name || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '_').replace(/^[_.]+|_+$/g, '');
  return /[A-Za-z0-9]/.test(c) ? c : fallback;
}
// 组装 zip 内的文件项：skills/（上传启用的，否则内置 scholay）+ content/（本次抓取）。文件名全用 ASCII。
async function buildZipEntries(d) {
  const entries = [];
  const up = (await getSkills()).filter(s => s.enabled);
  if (up.length) {
    up.forEach((s, i) => {
      const ext = (String(s.name).match(/\.[A-Za-z0-9]+$/) || ['.md'])[0];
      const stem = asciiName(String(s.name).replace(/\.[^.]+$/, ''), 'skill_' + (i + 1));
      entries.push({ name: 'skills/' + stem + ext, content: s.content });
    });
  } else {
    const base = 'skills/scholay/';
    const [agents, brandMd, voice, style] = await Promise.all([
      fetchText('AGENTS.md'), fetchText(base + '品牌.md'), fetchText(base + '评论口径.md'), fetchText(base + '风格参数.json'),
    ]);
    entries.push({ name: 'AGENTS.md', content: agents });
    entries.push({ name: 'skills/scholay/brand.md', content: brandMd });
    entries.push({ name: 'skills/scholay/voice.md', content: voice });
    entries.push({ name: 'skills/scholay/style.json', content: style });
  }
  entries.push({ name: 'content/maintext.md', content: d.main });
  entries.push({ name: 'content/comments.md', content: d.cmt });
  entries.push({ name: 'content/subtitle.md', content: d.sub });
  entries.push({ name: 'content/source.txt', content: d.url });
  return entries;
}

// ---- 「配置」里的 Skill 上传管理 ----
function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtSize(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
async function getSkills() { try { const o = await chrome.storage.local.get('marineSkills'); return o.marineSkills || []; } catch (e) { return []; } }
async function saveSkills(arr) { try { await chrome.storage.local.set({ marineSkills: arr }); } catch (e) {} }
async function renderSkills() {
  const ul = $('#skill-list'); if (!ul) return;
  const arr = await getSkills();
  ul.innerHTML = '';
  if (!arr.length) { ul.innerHTML = '<li class="skill-empty">未上传，使用内置 scholay</li>'; return; }
  for (const s of arr) {
    const li = document.createElement('li');
    li.className = 'skill-item';
    li.innerHTML = '<input type="checkbox" class="sk-toggle" data-id="' + s.id + '"' + (s.enabled ? ' checked' : '') + '>' +
      '<span class="sk-name" title="' + escHtml(s.name) + '">' + escHtml(s.name) + '</span>' +
      '<span class="sk-size">' + fmtSize((s.content || '').length) + '</span>' +
      '<button class="sk-del" data-id="' + s.id + '" title="删除">✕</button>';
    ul.appendChild(li);
  }
}
$('#skill-file').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const arr = await getSkills();
  for (const f of files) {
    const content = await f.text();
    arr.push({ id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: f.name, content, enabled: true });
  }
  await saveSkills(arr);
  e.target.value = '';
  renderSkills();
});
$('#skill-list').addEventListener('change', async (e) => {
  const t = e.target.closest('.sk-toggle'); if (!t) return;
  const arr = await getSkills();
  const s = arr.find(x => x.id === t.dataset.id);
  if (s) { s.enabled = t.checked; await saveSkills(arr); }
});
$('#skill-list').addEventListener('click', async (e) => {
  const del = e.target.closest('.sk-del'); if (!del) return;
  const arr = (await getSkills()).filter(x => x.id !== del.dataset.id);
  await saveSkills(arr); renderSkills();
});

function absPathOf(id) {
  return new Promise(resolve => {
    let n = 0;
    const tick = () => chrome.downloads.search({ id }, items => {
      const it = items && items[0];
      if (it && it.filename) resolve(it.filename);
      else if (++n < 15) setTimeout(tick, 100);
      else resolve(null);
    });
    tick();
  });
}

// ---- 本地智能体：写 4 个文件 + codex:// 新建对话 ----
$('#btn-codex').addEventListener('click', async () => {
  if (!lastGrab) return;
  $('#btn-codex').disabled = true;
  setStatus('打包写入文件…');
  try {
    const sub = (lastGrab.subtitle && lastGrab.subtitle.text) || '（无字幕）';
    const cmt = (lastGrab.comments && lastGrab.comments.md) || '（无评论）';
    const main = (lastGrab.text && lastGrab.text.md) || '（无正文）';
    // 打包成 1 个 zip：skills/（品牌话术+输出契约）+ content/（本页正文/评论/字幕）
    const entries = await buildZipEntries({ sub, cmt, main, url: lastGrab.url || lastGrab.host || '' });
    const blob = marineZip(entries);

    const url = URL.createObjectURL(blob);
    const fileName = 'marine_' + uid() + '.zip';
    const id = await new Promise((res, rej) => chrome.downloads.download(
      { url, filename: fileName, conflictAction: 'overwrite', saveAs: false },
      d => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(d)));
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    const abs = await absPathOf(id);
    if (!abs) { setStatus('写入失败：拿不到文件路径', 'error'); return; }
    const folder = abs.slice(0, abs.lastIndexOf(abs.includes('\\') ? '\\' : '/'));

    // 引用 zip 的真实绝对路径，哪怕被改名也能定位；Codex(full access) 解压读取
    const prompt = '解压并读取这个 zip：' + abs + ' 。结构：AGENTS.md=输出契约/流程；skills/ 是品牌话术 Skill（brand.md=品牌, voice.md=评论口径, style.json=风格参数，或上传的 skill 文件）；' +
      'content/ 是本页抓取（maintext.md=正文, comments.md=评论, subtitle.md=字幕）。' +
      '请先解压（可解到临时目录），按 skills 的口径与风格参数产出「直评（3条）+ 回复」，' +
      '每条直评和回复都必须自然、明确地出现 Skill 里指定的品牌名（内置为 Scholay）。';
    const codexUrl = 'codex://new?path=' + encodeURI(folder) + '&prompt=' + encodeURIComponent(prompt);
    const a = document.createElement('a'); a.href = codexUrl; document.body.appendChild(a); a.click(); a.remove();
    setStatus('已生成 zip 并拉起 Codex（' + (abs.split(/[\\/]/).pop()) + '）', 'ok');
  } catch (e) { setStatus('出错：' + (e && e.message || e), 'error'); }
  finally { $('#btn-codex').disabled = false; }
});

// ---- 刷新页面（未注入时）----
$('#btn-reload').addEventListener('click', async () => {
  try { await chrome.tabs.reload(activeTabId); showReloadHint(false); resetChips('pending'); setStatus('已刷新页面，稍候再点「一键抓取」', ''); }
  catch (e) { setStatus('刷新失败：' + (e && e.message || e), 'error'); }
});

// ---- 初始化 ----
(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;
  try {
    const ping = await chrome.tabs.sendMessage(activeTabId, { type: 'PING' });
    $('#platform').textContent = ping.platformLabel || ping.platform;
  } catch (e) {
    $('#platform').textContent = '未注入';
    setStatus('本页未注入脚本', 'error'); showReloadHint(true);
  }

  const dbg = $('#debug-toggle');
  try { const o = await chrome.storage.local.get('marineDebug'); dbg.checked = !(o.marineDebug && o.marineDebug.enabled === false); }
  catch (e) { dbg.checked = true; }
  dbg.addEventListener('change', async () => {
    const enabled = dbg.checked;
    try { const o = await chrome.storage.local.get('marineDebug'); const s = (o && o.marineDebug) || {}; s.enabled = enabled; await chrome.storage.local.set({ marineDebug: s }); } catch (e) {}
    try { await chrome.tabs.sendMessage(activeTabId, { type: 'DEBUG_SET', enabled }); } catch (e) {}
  });

  renderSkills();
})();
