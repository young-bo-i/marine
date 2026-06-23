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

// 平台分发（Phase 0 仅 bilibili；其它平台先按 B站结构兜底尝试）
function marineBuildComments(platform, captures) {
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
