// comments.js — 评论抽取（Phase 0：哔哩哔哩）
// 思路：被动捕获页面自己发出的（已签名的）评论 API 响应，只解析已解密 JSON，零签名负担。
// 规范化结构 NormalizedComment：{ id, parentId, rootId, author{name,id}, text, likeCount,
//   time(ISO), ipLocation, replyCount, children[] }。本文件零依赖、函数全局可见。

// ---- 工具：穿透 Shadow DOM 收集元素（B站新版评论区是 Web Component） ----
function marineShadowRootOf(el) {
  try {
    if (!el) return null;
    if (el.shadowRoot) return el.shadowRoot;
    if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el);
    }
  } catch (e) {}
  return null;
}

function marineCollectShadow(root, acc, budget) {
  acc = acc || [];
  budget = budget || { n: 0, max: 12000 };
  if (!root || budget.n > budget.max) return acc;
  if (root.nodeType === 1) {
    acc.push(root);
    budget.n++;
    const rootShadow = marineShadowRootOf(root);
    if (rootShadow) marineCollectShadow(rootShadow, acc, budget);
  }
  let nodes;
  try { nodes = root.querySelectorAll('*'); } catch (e) { return acc; }
  for (const el of nodes) {
    if (budget.n++ > budget.max) return acc;
    acc.push(el);
    const shadow = marineShadowRootOf(el);
    if (shadow) marineCollectShadow(shadow, acc, budget);
  }
  return acc;
}

// 点击「查看更多 / 展开 / 共N条回复」一类按钮，触发页面自发请求（被钩子续收）
function marineClickExpanders(rootHint) {
  let root = document;
  if (rootHint) { const h = document.querySelector(rootHint); if (h) root = h; }
  const els = marineCollectShadow(root);
  let clicked = 0;
  const RE = /(查看|展开|点击查看|共\s*\d+\s*条回复|更多回复|加载更多)/;
  for (const el of els) {
    if (clicked >= 25) break;
    let txt = '';
    try { txt = (el.textContent || '').trim(); } catch (e) { continue; }
    if (!txt || txt.length > 18 || !RE.test(txt)) continue;
    const clickable = el.matches && (el.matches('button,a,[role="button"]') ||
      /view-more|more|expand|sub-reply|view-all/i.test(el.className || ''));
    if (!clickable) continue;
    try { el.click(); clicked++; } catch (e) {}
  }
  return clicked;
}

// ---- 哔哩哔哩归一化 ----
// 注意：rpid / oid / root / parent 超 2^53，必须读 *_str 字段，否则 JSON.parse 丢精度。
function marineNormBili(r) {
  const m = r.member || {};
  const ctrl = r.reply_control || {};
  return {
    id: String(r.rpid_str || r.rpid || ''),
    parentId: (r.parent && String(r.parent) !== '0') ? String(r.parent_str || r.parent) : null,
    rootId: (r.root && String(r.root) !== '0') ? String(r.root_str || r.root) : null,
    author: { name: m.uname || '', id: m.mid != null ? String(m.mid) : '' },
    text: ((r.content && r.content.message) || '').trim(),
    likeCount: r.like || 0,
    time: r.ctime ? new Date(r.ctime * 1000).toISOString() : undefined,
    ipLocation: (ctrl.location || '').replace(/^IP属地[:：]?/, '').trim(),
    replyCount: r.rcount || 0,
    children: [],
  };
}

function marineBuildBiliComments(captures) {
  const roots = new Map();    // id -> 根评论节点
  const seen = new Set();     // 全局去重（用户反复滚动会重复推送）
  const orphanSubs = [];      // 楼中楼，稍后挂到根
  let total;

  for (const cap of captures) {
    let j;
    try { j = JSON.parse(cap.body); } catch (e) { continue; }
    const data = j && j.data;
    if (!data) continue;
    if (data.cursor && data.cursor.all_count != null) total = data.cursor.all_count;
    else if (data.page && data.page.count != null && total == null) total = data.page.count;

    const isSubEndpoint = /\/reply\/reply(\?|$)/.test(cap.url);
    const list = [].concat(data.top_replies || [], data.replies || []);

    for (const r of list) {
      const node = marineNormBili(r);
      if (node.id && !seen.has(node.id)) {
        seen.add(node.id);
        if (!isSubEndpoint && !node.rootId) roots.set(node.id, node);
        else orphanSubs.push(node);
      }
      // 根评论自带的楼中楼预览（通常前 3 条）
      if (Array.isArray(r.replies)) {
        for (const sr of r.replies) {
          const sn = marineNormBili(sr);
          if (sn.id && !seen.has(sn.id)) { seen.add(sn.id); orphanSubs.push(sn); }
        }
      }
    }
  }

  // 楼中楼挂到对应根（B站是两层扁平模型：所有子评论 root 指向同一根）
  for (const s of orphanSubs) {
    const root = s.rootId && roots.get(s.rootId);
    if (root) root.children.push(s);
    else {
      const key = s.rootId || s.id;
      if (!roots.has(key)) roots.set(key, {
        id: key, parentId: null, rootId: null, author: { name: '' },
        text: '（根评论未捕获）', likeCount: 0, replyCount: 0, children: [],
      });
      roots.get(key).children.push(s);
    }
  }

  const tree = Array.from(roots.values());
  tree.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  for (const r of tree) r.children.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  let subs = 0, maxDepth = tree.length ? 1 : 0;
  for (const r of tree) if (r.children.length) { subs += r.children.length; maxDepth = 2; }
  return {
    comments: tree,
    stats: { count: tree.length + subs, roots: tree.length, subs, maxDepth, total },
  };
}

// ---- 知乎归一化 ----
// 知乎正文/评论都是 HTML 片段，剥成纯文本。
function marineZhihuStrip(html) {
  try {
    const d = document.createElement('div');
    d.innerHTML = String(html || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
function marineZhihuName(author) {
  const a = author || {};
  return a.name || (a.member && a.member.name) || '';
}
// 回答/文章 → 根节点（截流的「靶子」：可评论/引用的既有回答）
function marineNormZhihuAnswer(a) {
  if (!a) return null;
  const author = a.author || {};
  const text = marineZhihuStrip(a.content || a.excerpt || a.excerpt_new || '');
  return {
    id: String(a.id || ''),
    parentId: null, rootId: null,
    author: { name: marineZhihuName(author), id: author.id != null ? String(author.id) : (author.url_token || '') },
    text: text.slice(0, 600),
    likeCount: a.voteup_count != null ? a.voteup_count : (a.voteupCount || 0),
    replyCount: a.comment_count != null ? a.comment_count : (a.commentCount || 0),
    kind: a.type || 'answer',
    children: [],
  };
}
// IP 属地在 comment_tag[] 里（type=ip_info），不是独立字段。
function marineZhihuIp(c) {
  for (const t of (c.comment_tag || [])) if (t && t.type === 'ip_info' && t.text) return t.text;
  return '';
}
function marineNormZhihuComment(c) {
  if (!c) return null;
  const author = c.author || {};
  return {
    id: String(c.id || ''),
    parentId: null, rootId: null,
    author: { name: marineZhihuName(author), id: author.id != null ? String(author.id) : '' },
    text: marineZhihuStrip(c.content || ''),
    likeCount: c.like_count != null ? c.like_count : (c.likeCount || 0),
    time: c.created_time ? new Date(Number(c.created_time) * 1000).toISOString() : undefined,
    ipLocation: marineZhihuIp(c),
    replyCount: c.child_comment_count || 0,
    children: [],
  };
}
function marineBuildZhihuComments(captures) {
  const answers = new Map();   // 回答/文章 id -> 根节点
  const seen = new Set();
  const looseComments = [];    // 未能归到某个已捕获回答的评论，兜底当独立根

  // 1) SSR 初始回答/文章（js-initialData，最稳，含首屏内容）
  try {
    const el = document.getElementById('js-initialData');
    if (el) {
      const ents = (JSON.parse(el.textContent || '{}').initialState || {}).entities || {};
      // 仅「回答」作为评论靶子根（问题页）；专栏「文章」是正文，不作为评论节点——
      // 它下面的评论会作为顶层根出现（给文章发直评由「直评」覆盖）。
      const amap = ents.answers;
      if (amap) for (const k in amap) {
        const n = marineNormZhihuAnswer(amap[k]);
        if (n && n.id && !seen.has('a' + n.id)) { seen.add('a' + n.id); answers.set(n.id, n); }
      }
    }
  } catch (e) {}

  // 2) 被动捕获：feeds/answers → 回答；comment_v5/comments → 评论
  for (const cap of captures || []) {
    let j;
    try { j = JSON.parse(cap.body); } catch (e) { continue; }
    const url = cap.url || '';
    const data = (j && (j.data || j.comments)) || [];
    if (!Array.isArray(data)) continue;

    if (/comment/i.test(url)) {
      const m = url.match(/\/(answers|articles|questions|pins)\/(\d+)\//) || url.match(/resource_id=(\d+)/);
      const hostId = m ? String(m[2] || m[1]) : null;
      for (const c of data) {
        const n = marineNormZhihuComment(c);
        if (!n || !n.id || seen.has('c' + n.id)) continue;
        seen.add('c' + n.id);
        for (const k of (c.child_comments || c.childComments || [])) {
          const kn = marineNormZhihuComment(k);
          if (kn && kn.id && !seen.has('c' + kn.id)) { seen.add('c' + kn.id); n.children.push(kn); }
        }
        if (hostId && answers.has(hostId)) answers.get(hostId).children.push(n);
        else looseComments.push(n);
      }
    } else {
      for (const item of data) {
        const n = marineNormZhihuAnswer(item.target || item);
        if (n && n.id && !seen.has('a' + n.id)) { seen.add('a' + n.id); answers.set(n.id, n); }
      }
    }
  }

  const tree = Array.from(answers.values()).concat(looseComments);
  tree.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  let subs = 0;
  for (const r of tree) subs += r.children.length;
  return {
    comments: tree,
    stats: { count: tree.length + subs, roots: tree.length, subs, maxDepth: subs ? 2 : (tree.length ? 1 : 0) },
  };
}

// ---- 小红书归一化 ----
function marineXhsName(u) { const x = u || {}; return x.nickname || x.name || ''; }
function marineNormXhs(c) {
  if (!c) return null;
  const u = c.user_info || c.user || {};
  return {
    id: String(c.id || c.comment_id || ''),
    parentId: null, rootId: null,
    author: { name: marineXhsName(u), id: u.user_id != null ? String(u.user_id) : '' },
    text: String(c.content || '').trim(),
    likeCount: c.like_count != null ? (Number(c.like_count) || 0) : 0,
    time: c.create_time ? new Date(Number(c.create_time)).toISOString() : undefined,
    ipLocation: String(c.ip_location || '').trim(),
    replyCount: c.sub_comment_count != null ? (Number(c.sub_comment_count) || 0) : 0,
    children: [],
  };
}
function marineBuildXhsComments(captures) {
  const roots = new Map();
  const seen = new Set();
  const orphanSubs = [];

  for (const cap of captures || []) {
    let j;
    try { j = JSON.parse(cap.body); } catch (e) { continue; }
    const data = j && j.data;
    if (!data) continue;
    const list = data.comments || (Array.isArray(data) ? data : []);
    if (!Array.isArray(list)) continue;

    const isSub = /comment\/sub\/page/.test(cap.url || '');
    let subRootId = null;
    if (isSub) { const m = (cap.url || '').match(/root_comment_id=(\w+)/); subRootId = m ? m[1] : null; }

    for (const c of list) {
      const node = marineNormXhs(c);
      if (!node || !node.id || seen.has(node.id)) continue;
      seen.add(node.id);
      if (isSub) {
        node.rootId = subRootId || (c.target_comment && String(c.target_comment.id)) || null;
        orphanSubs.push(node);
      } else {
        roots.set(node.id, node);
        for (const sc of (c.sub_comments || [])) {
          const sn = marineNormXhs(sc);
          if (sn && sn.id && !seen.has(sn.id)) { seen.add(sn.id); sn.rootId = node.id; node.children.push(sn); }
        }
      }
    }
  }

  for (const s of orphanSubs) {
    const root = s.rootId && roots.get(s.rootId);
    if (root) root.children.push(s);
    else {
      const key = s.rootId || s.id;
      if (!roots.has(key)) roots.set(key, { id: key, parentId: null, rootId: null, author: { name: '' }, text: '（根评论未捕获）', likeCount: 0, replyCount: 0, children: [] });
      roots.get(key).children.push(s);
    }
  }

  const tree = Array.from(roots.values());
  tree.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  let subs = 0;
  for (const r of tree) subs += r.children.length;
  return {
    comments: tree,
    stats: { count: tree.length + subs, roots: tree.length, subs, maxDepth: subs ? 2 : (tree.length ? 1 : 0) },
  };
}

// 正文提取：知乎/小红书的「内容」在结构化数据里（feed 响应 / js-initialData），
// 比通用 DOM 提取干净准确。返回 Markdown 字符串（拿不到则空串，交给通用提取兜底）。
function marineExtractNoteText(platform, captures) {
  try {
    if (platform === 'xiaohongshu') {
      for (const cap of (captures || [])) {
        if (!/\/feed(\b|\?)/.test(cap.url || '')) continue;
        let j;
        try { j = JSON.parse(cap.body); } catch (e) { continue; }
        for (const it of ((j.data && j.data.items) || [])) {
          const nc = it && it.note_card;
          if (nc && (nc.title || nc.desc)) {
            const parts = [];
            if (nc.title) parts.push('# ' + nc.title);
            const u = nc.user || {};
            if (u.nickname) parts.push('> 作者：' + u.nickname + (nc.ip_location ? '（' + nc.ip_location + '）' : ''));
            if (nc.desc) parts.push('\n' + String(nc.desc).trim());
            return parts.join('\n');
          }
        }
      }
    } else if (platform === 'zhihu') {
      const el = document.getElementById('js-initialData');
      if (!el) return '';
      const ents = (JSON.parse(el.textContent || '{}').initialState || {}).entities || {};
      for (const k in (ents.articles || {})) {
        const a = ents.articles[k];
        if (a && (a.title || a.content)) return '# ' + (a.title || '') + '\n\n' + marineZhihuStrip(a.content || a.excerpt || '');
      }
      for (const k in (ents.questions || {})) {
        const q = ents.questions[k];
        if (q && (q.title || q.detail)) return '# ' + (q.title || '') + '\n\n' + marineZhihuStrip(q.detail || q.excerpt || '');
      }
    }
  } catch (e) {}
  return '';
}

// 平台分发：知乎走回答/评论解析，小红书走笔记评论解析，其它按 B站结构。
function marineBuildComments(platform, captures) {
  if (platform === 'xiaohongshu') {
    if (!captures || !captures.length) {
      return { ok: false, stats: { count: 0 }, error: '尚未捕获到评论。请在笔记评论区向下滚动几下让评论加载后再试。' };
    }
    let built;
    try { built = marineBuildXhsComments(captures); }
    catch (e) { return { ok: false, stats: { count: 0 }, error: '小红书评论解析出错（结构可能已变）：' + (e && e.message || e) }; }
    built.ok = built.stats.count > 0;
    if (!built.ok) built.error = '捕获到响应但未解析出评论（结构可能已变）。';
    return built;
  }
  if (platform === 'zhihu') {
    let built;
    try {
      built = marineBuildZhihuComments(captures);   // 即使无捕获，也会读 js-initialData
    } catch (e) {
      return { ok: false, stats: { count: 0 }, error: '知乎回答/评论解析出错（结构可能已变）：' + (e && e.message || e) };
    }
    built.ok = built.stats.count > 0;
    if (!built.ok) built.error = '未解析出回答/评论。请在页面向下滚动几下让回答加载，或展开某条回答的评论后再试。';
    return built;
  }
  if (!captures || !captures.length) {
    return { ok: false, stats: { count: 0 }, error: '尚未捕获到评论数据。请在评论区滚动几下、或点「自动滚动加载」，让页面自己加载评论后再试。' };
  }
  const built = marineBuildBiliComments(captures);
  built.ok = built.stats.count > 0;
  if (!built.ok) built.error = '捕获到响应但未解析出评论（结构可能已变）。';
  return built;
}

function marineCommentSnippet(text, max) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max || 60);
}

function marineFlattenComments(tree) {
  const out = [];
  (function walk(list, depth) {
    for (const c of list || []) {
      out.push({
        id: c.id || '',
        parentId: c.parentId || '',
        rootId: c.rootId || '',
        authorName: (c.author && c.author.name) || '',
        authorId: (c.author && c.author.id) || '',
        text: c.text || '',
        snippet: marineCommentSnippet(c.text, 80),
        depth,
      });
      if (c.children && c.children.length) walk(c.children, depth + 1);
    }
  })(tree || [], 0);
  return out;
}

// 给本地智能体看的评论文本：保留页面可定位的 rpid，方便后续一键填入对应回复框。
function marineCommentsForAgent(tree, limit) {
  limit = limit || 100000;
  const lines = [];
  let n = 0;
  (function walk(list, depth) {
    for (const c of list || []) {
      if (n >= limit) return;
      n++;
      const meta = [];
      if (c.id) meta.push('id=' + c.id);
      if (c.likeCount) meta.push(c.likeCount + '赞');
      if (c.ipLocation) meta.push(c.ipLocation);
      lines.push('  '.repeat(depth) + (depth ? '↳ ' : '· ') + '[' + meta.join(' ') + '] ' +
        (c.author.name || '匿名') + '：' + (c.text || '').replace(/\s+/g, ' '));
      if (c.children && c.children.length) walk(c.children, depth + 1);
    }
  })(tree || [], 0);
  if (n >= limit) lines.push('… 仅预览前 ' + limit + ' 条');
  return lines.join('\n');
}

// 缩进预览文本
function marineCommentsPreview(tree, limit) {
  limit = limit || 100;
  const lines = [];
  let n = 0;
  (function walk(list, depth) {
    for (const c of list) {
      if (n >= limit) return;
      n++;
      const meta = [];
      if (c.likeCount) meta.push(c.likeCount + '赞');
      if (c.ipLocation) meta.push(c.ipLocation);
      lines.push('  '.repeat(depth) + (depth ? '↳ ' : '· ') + (c.author.name || '匿名') +
        (meta.length ? ' (' + meta.join(' ') + ')' : '') + '：' + (c.text || '').replace(/\s+/g, ' '));
      if (c.children && c.children.length) walk(c.children, depth + 1);
    }
  })(tree, 0);
  if (n >= limit) lines.push('… 仅预览前 ' + limit + ' 条（完整数据用「下载 JSON」）');
  return lines.join('\n');
}
