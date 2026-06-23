// popup.js — 一键抓取（字幕/评论/正文），评论可分页加载更多；
// 「本地智能体」通过 native messaging 调 Codex host，生成直评/回复并可填入页面回复草稿。
const $ = sel => document.querySelector(sel);

let activeTabId = null;
let lastGrab = null;   // 最近一次抓取结果（含三块内容 + 合并 bundle）
let grabGen = 0;       // 抓取代次：切页/重抓时作废在途请求，避免旧结果覆盖
const BRAND = 'scholay';

function send(type, opts) { return chrome.tabs.sendMessage(activeTabId, { type, opts }); }

function setChip(id, state, extra) {
  const el = $(id);
  const map = { pending: ['待获取', 'pending'], loading: ['获取中…', 'loading'], has: ['有' + (extra ? ' · ' + extra : ''), 'has'], none: ['无', 'none'] };
  const v = map[state] || map.pending;
  el.textContent = v[0]; el.className = 'chip ' + v[1];
}
function resetChips(s) { setChip('#st-sub', s); setChip('#st-comment', s); setChip('#st-text', s); }
function setStatus(text, kind) { const el = $('#grab-status'); el.textContent = text || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }
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
    $('#btn-codex').disabled = !any;
    setStatus(any ? '✓ 已检测，可复制或发到本地智能体' : '本页暂无可抓内容', any ? 'ok' : '');
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

// ---- 读取扩展自带的 skill（合并成一份）----
async function fetchText(rel) {
  try { const r = await fetch(chrome.runtime.getURL(rel)); return r.ok ? await r.text() : ''; }
  catch (e) { return ''; }
}
// 读取启用的 skill（上传的优先，否则内置 scholay），合并成一份文本交给本地智能体
async function loadSkill(brand) {
  const up = (await getSkills()).filter(s => s.enabled);
  if (up.length) return up.map(s => '# ' + s.name + '\n\n' + s.content).join('\n\n---\n\n');
  const base = 'skills/' + brand + '/';
  const [agents, brandMd, voice, style] = await Promise.all([
    fetchText('AGENTS.md'), fetchText(base + '品牌.md'), fetchText(base + '评论口径.md'), fetchText(base + '风格参数.json'),
  ]);
  return ['# 输出契约 / 流程', agents, '', '---', '', brandMd, '', '---', '', voice, '', '---', '', '# 风格参数', '```json', style, '```'].join('\n');
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


// ---- 本地智能体：通过 Chrome native messaging 调用本地 Codex host ----
$('#btn-codex').addEventListener('click', async () => {
  if (!lastGrab) return;
  $('#btn-codex').disabled = true;
  renderReplies(null);
  setStatus('本地智能体生成中…（首次可能十几秒）');
  try {
    const skill = await loadSkill(BRAND);
    const payload = {
      type: 'generate', skill,
      subtitle: (lastGrab.subtitle && lastGrab.subtitle.text) || '',
      comments: (lastGrab.comments && (lastGrab.comments.agentMd || lastGrab.comments.md)) || '',
      maintext: (lastGrab.text && lastGrab.text.md) || '',
      platform: lastGrab.platform || '', url: lastGrab.url || '',
    };
    const res = await chrome.runtime.sendNativeMessage('com.marine.codex', payload);
    if (res && res.ok) {
      renderReplies(res);
      setStatus('✓ 直评 ' + ((res.direct || []).length) + ' / 回复 ' + ((res.replies || []).length), 'ok');
    } else {
      setStatus('生成失败：' + ((res && res.error) || '未知'), 'error');
    }
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/host not found|not found|forbidden|native/i.test(m)) {
      setStatus('未连接本地 host —— 先双击 host/install.command 装一次，再到 chrome://extensions 重载 Marine（' + m + '）', 'error');
    } else setStatus('出错：' + m, 'error');
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
    c.appendChild(h); c.appendChild(t); c.appendChild(actions);
    return c;
  }
  function replyHead(target) {
    let cleaned = String(target || '').trim();
    for (let i = 0; i < 3; i++) cleaned = cleaned.replace(/^回复\s*@?\s*/, '').trim();
    cleaned = cleaned.replace(/^@+\s*/, '').trim();
    return cleaned ? ('回复 @' + cleaned) : '回复';
  }
  (res.direct || []).forEach((d, i) => box.appendChild(card('直评 ' + (i + 1) + (d.angle ? ' · ' + d.angle : ''), d.text || '')));
  (res.replies || []).forEach((r) => box.appendChild(card(replyHead(r.target), r.text || '', { reply: r })));
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;
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
chrome.tabs.onActivated.addListener(info => { if (info.windowId === myWindowId) attach(false); });
chrome.tabs.onUpdated.addListener((tabId, ci) => {
  if (tabId !== activeTabId) return;
  if (ci.url) attach(true);
  else if (ci.status === 'complete') attach(false);
});

// ---- 初始化（一次性）----
(async function init() {
  try { const w = await chrome.windows.getCurrent(); myWindowId = w.id; } catch (e) {}
  await attach();

  renderSkills();
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
