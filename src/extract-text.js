// extract-text.js — 把网页正文抽取为结构化 Markdown（运行在 ISOLATED world）
// 轻量实现：不依赖 Readability，自行挑选正文容器并遍历语义标签输出 Markdown。
// 如需更强的“正文识别”，可后续引入 @mozilla/readability。

function marinePickContentRoot() {
  const selectors = ['article', 'main', '[role="main"]', '#content', '#main',
    '.post-content', '.article-content', '.markdown-body', '.post', '.article', '.content'];
  let best = null, bestLen = 0;
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      const len = (el.innerText || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    });
  }
  // 容器太小则退回 body
  if (best && bestLen > 200) return best;
  return document.body;
}

function marineDomToMarkdown(root) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'NAV',
    'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'TEMPLATE']);
  const blocks = [];

  function isHidden(el) {
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hidden) return true;
    return false;
  }

  function inline(node) {
    let s = '';
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { s += ch.nodeValue.replace(/\s+/g, ' '); return; }
      if (ch.nodeType !== 1) return;
      const t = ch.tagName;
      if (SKIP.has(t) || isHidden(ch)) return;
      if (t === 'BR') { s += '\n'; return; }
      if (t === 'STRONG' || t === 'B') { const x = inline(ch).trim(); s += x ? '**' + x + '**' : ''; return; }
      if (t === 'EM' || t === 'I') { const x = inline(ch).trim(); s += x ? '*' + x + '*' : ''; return; }
      if (t === 'CODE') { const x = ch.textContent.trim(); s += x ? '`' + x + '`' : ''; return; }
      if (t === 'A') {
        const href = ch.getAttribute('href') || '';
        const x = inline(ch).trim();
        s += (href && x && !href.startsWith('javascript')) ? '[' + x + '](' + href + ')' : x;
        return;
      }
      if (t === 'IMG') {
        const src = ch.getAttribute('src') || '';
        if (src) s += '![' + (ch.getAttribute('alt') || '') + '](' + src + ')';
        return;
      }
      s += inline(ch);
    });
    return s;
  }

  function listToMd(listEl, ordered, depth) {
    let i = 1;
    listEl.querySelectorAll(':scope > li').forEach(li => {
      const marker = ordered ? (i++ + '. ') : '- ';
      const nested = li.querySelectorAll(':scope > ul, :scope > ol');
      // 复制一份去掉嵌套列表，取当前 li 的纯文本
      const clone = li.cloneNode(true);
      clone.querySelectorAll(':scope > ul, :scope > ol').forEach(n => n.remove());
      const txt = inline(clone).trim().replace(/\n+/g, ' ');
      if (txt) blocks.push('  '.repeat(depth) + marker + txt);
      nested.forEach(n => listToMd(n, n.tagName === 'OL', depth + 1));
    });
  }

  function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const matrix = rows.map(r =>
      Array.from(r.querySelectorAll('th,td')).map(c => inline(c).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
    const cols = Math.max.apply(null, matrix.map(r => r.length));
    if (!cols) return '';
    const pad = r => { while (r.length < cols) r.push(''); return r; };
    const head = pad(matrix[0].slice());
    const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
    for (let i = 1; i < matrix.length; i++) lines.push('| ' + pad(matrix[i].slice()).join(' | ') + ' |');
    return lines.join('\n');
  }

  function walk(node) {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) {
        const tx = ch.nodeValue.replace(/\s+/g, ' ').trim();
        if (tx) blocks.push(tx);
        return;
      }
      if (ch.nodeType !== 1) return;
      const t = ch.tagName;
      if (SKIP.has(t) || isHidden(ch)) return;

      if (/^H[1-6]$/.test(t)) {
        const tx = inline(ch).trim();
        if (tx) blocks.push('#'.repeat(+t[1]) + ' ' + tx);
      } else if (t === 'P') {
        const tx = inline(ch).trim();
        if (tx) blocks.push(tx);
      } else if (t === 'UL' || t === 'OL') {
        listToMd(ch, t === 'OL', 0);
      } else if (t === 'BLOCKQUOTE') {
        const tx = inline(ch).trim();
        if (tx) blocks.push(tx.split('\n').map(l => '> ' + l).join('\n'));
      } else if (t === 'PRE') {
        const code = ch.textContent.replace(/\n+$/, '');
        if (code.trim()) blocks.push('```\n' + code + '\n```');
      } else if (t === 'TABLE') {
        const tb = tableToMd(ch);
        if (tb) blocks.push(tb);
      } else if (t === 'HR') {
        blocks.push('---');
      } else if (t === 'FIGURE' || t === 'FIGCAPTION' || t === 'PICTURE') {
        walk(ch);
      } else {
        walk(ch);   // 容器：继续向下
      }
    });
  }

  walk(root);
  // 合并相邻重复空块
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function marineExtractStructuredText() {
  const root = marinePickContentRoot();
  marineLog('info', 'text', '正文容器：' + root.tagName.toLowerCase() + (root.id ? '#' + root.id : ''));
  const body = marineDomToMarkdown(root);
  const title = (document.querySelector('h1') && document.querySelector('h1').textContent.trim())
    || document.title || '';
  const markdown = (title ? '# ' + title.trim() + '\n\n' : '') +
    '> 来源：' + location.href + '\n\n' + body;
  return {
    ok: !!body.trim(),
    title: title.trim(),
    url: location.href,
    chars: body.length,
    markdown,
    error: body.trim() ? undefined : '未能提取到正文文本。'
  };
}
