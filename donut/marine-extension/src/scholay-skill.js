// scholay-skill.js — deterministic, context-aware Scholay mother-draft routing.
// Kept dependency-free so popup, MV3 service worker, and smoke tests share one path.

const MARINE_SCHOLAY_MOTHER_PARAGRAPHS = 6;
const MARINE_SCHOLAY_MAX_EXAMPLES = 2;

function marineScholayText(value) {
  return String(value == null ? '' : value).trim();
}

function marineScholayNormalize(value) {
  return marineScholayText(value).normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function marineScholayParseMotherDraft(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

function marineScholayParseIndex(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); }
  catch (error) { throw new Error('Scholay 母稿索引不是有效 JSON'); }
}

function marineScholayValidatedAssets(assets) {
  const value = assets || {};
  const paragraphs = marineScholayParseMotherDraft(value.mother);
  if (paragraphs.length !== MARINE_SCHOLAY_MOTHER_PARAGRAPHS) {
    throw new Error('Scholay 母稿必须保持为 6 段，当前为 ' + paragraphs.length + ' 段');
  }

  const index = marineScholayParseIndex(value.index);
  const source = marineScholayText(index.source);
  if (Number(index.schemaVersion) !== 1 || source !== '母稿.md' || !Array.isArray(index.routes)) {
    throw new Error('Scholay 母稿索引格式不受支持');
  }

  const ids = new Set();
  const paragraphNumbers = new Set();
  const routes = index.routes.map((route, order) => {
    const id = marineScholayText(route && route.id);
    const paragraph = Number(route && route.paragraph);
    const keywords = Array.isArray(route && route.keywords)
      ? route.keywords.map(marineScholayText).filter(Boolean)
      : [];
    if (!id || ids.has(id) || !Number.isInteger(paragraph)
      || paragraph < 1 || paragraph > paragraphs.length
      || paragraphNumbers.has(paragraph) || keywords.length === 0) {
      throw new Error('Scholay 母稿索引包含无效路线');
    }
    ids.add(id);
    paragraphNumbers.add(paragraph);
    return {
      id,
      paragraph,
      label: marineScholayText(route.label) || id,
      keywords,
      order,
    };
  });
  if (routes.length !== paragraphs.length) {
    throw new Error('Scholay 母稿索引必须逐段覆盖 6 段母稿');
  }

  const fallback = Array.isArray(index.fallback)
    ? index.fallback.map(marineScholayText).filter(id => ids.has(id))
    : [];
  if (fallback.length === 0) throw new Error('Scholay 母稿索引缺少有效回退路线');

  return {
    brand: marineScholayText(value.brand),
    execution: marineScholayText(value.execution),
    style: marineScholayText(value.style),
    paragraphs,
    routes,
    fallback,
    maxExamples: Math.min(
      MARINE_SCHOLAY_MAX_EXAMPLES,
      Math.max(1, Number(index.maxExamples) || 1),
    ),
  };
}

function marineScholayResolvePayload(input) {
  const value = input || {};
  const nested = value.payload;
  if (nested && typeof nested === 'object'
    && (nested.context || nested.subtitle || nested.comments || nested.article)) {
    return nested;
  }
  return value;
}

function marineScholayResolveSource(payload) {
  const value = payload || {};
  const declared = marineScholayText(value.context && value.context.source);
  if (declared === 'subtitle' || declared === 'comments' || declared === 'article' || declared === 'none') {
    return declared;
  }
  if (marineScholayText(value.subtitle && value.subtitle.text)) return 'subtitle';
  if (marineScholaySelectedCommentsText(value)) return 'comments';
  if (marineScholayText(value.article && value.article.markdown)) return 'article';
  return 'none';
}

function marineScholaySelectedCommentsText(payload) {
  const comments = payload && payload.comments;
  const agent = marineScholayText(comments && comments.agentMd);
  return agent || marineScholayText(comments && comments.md);
}

function marineScholaySelectedSourceText(payload, source) {
  const value = payload || {};
  if (source === 'subtitle') return marineScholayText(value.subtitle && value.subtitle.text);
  if (source === 'comments') return marineScholaySelectedCommentsText(value);
  if (source === 'article') return marineScholayText(value.article && value.article.markdown);
  return '';
}

function marineScholayOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let offset = 0;
  while (count < 4) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(1, needle.length);
  }
  return count;
}

function marineScholayRoutingFields(input) {
  const outer = input || {};
  const payload = marineScholayResolvePayload(outer);
  const context = payload.context || {};
  const source = marineScholayResolveSource(payload);
  const target = outer.target || payload.target || {};
  return {
    source,
    target: marineScholayNormalize([
      outer.targetSummary,
      context.targetSummary,
      target.authorName,
      target.text,
    ].filter(Boolean).join('\n')),
    title: marineScholayNormalize([
      outer.title,
      context.title,
      outer.platform,
      context.platform,
    ].filter(Boolean).join('\n')),
    content: marineScholayNormalize(marineScholaySelectedSourceText(payload, source)),
  };
}

function marineScholaySelectRoutes(assets, input) {
  const validated = marineScholayValidatedAssets(assets);
  const fields = marineScholayRoutingFields(input);
  const ranked = validated.routes.map(route => {
    let score = 0;
    for (const rawKeyword of route.keywords) {
      const keyword = marineScholayNormalize(rawKeyword);
      const weight = Math.min(8, Math.max(2, Array.from(keyword).length));
      score += marineScholayOccurrences(fields.target, keyword) * weight * 5;
      score += marineScholayOccurrences(fields.title, keyword) * weight * 3;
      score += marineScholayOccurrences(fields.content, keyword) * weight;
    }
    return { ...route, score };
  });
  ranked.sort((left, right) => right.score - left.score || left.order - right.order);

  let selected = ranked.filter(route => route.score > 0).slice(0, validated.maxExamples);
  if (selected.length === 0) {
    selected = validated.fallback
      .map(id => ranked.find(route => route.id === id))
      .filter(Boolean)
      .slice(0, validated.maxExamples);
  }
  return {
    source: fields.source,
    routes: selected.map(route => ({
      id: route.id,
      label: route.label,
      paragraph: route.paragraph,
      score: route.score,
      text: validated.paragraphs[route.paragraph - 1],
    })),
  };
}

function marineScholayBuildSkill(assets, input, customSample) {
  const validated = marineScholayValidatedAssets(assets);
  const selection = marineScholaySelectRoutes(assets, input);
  const parts = [
    validated.brand,
    '',
    '---',
    '',
    validated.execution,
    '',
    '---',
    '',
    '# 本次母稿路由',
    '',
    '- 页面内容来源：' + selection.source,
    '- 命中路线：' + selection.routes.map(route => route.label).join('；'),
    '',
    '# 选中的母稿段落（唯一权威语感）',
  ];
  for (const route of selection.routes) {
    parts.push('', '## ' + route.label, '', route.text);
  }
  if (validated.style) {
    parts.push('', '---', '', '# 风格参数', '```json', validated.style, '```');
  }
  const custom = marineScholayText(customSample);
  if (custom) {
    parts.push(
      '',
      '---',
      '',
      '# 用户主动导入的补充范文（次级参照）',
      '',
      '补充范文不能覆盖母稿语感、执行口径或本次路线。',
      '',
      custom,
    );
  }
  return parts.filter((part, index) => part || index > 0).join('\n');
}
