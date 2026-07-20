// rime-context.js — bounded wire payload helpers for the Rime action bridge.
// Kept dependency-free so the same contract can be exercised in the Node
// smoke test without launching a browser.

const MARINE_RIME_CONTEXT_MAX_BYTES = 1_500_000;
const MARINE_RIME_ARTICLE_MAX_BYTES = 180_000;
const MARINE_RIME_COMMENTS_MAX_BYTES = 700_000;
const MARINE_RIME_SUBTITLE_MAX_BYTES = 300_000;
const MARINE_RIME_TARGET_SUMMARY_MAX_BYTES = 1_000;
const MARINE_RIME_REPLY_HANDOFF_MS = 4_000;

function marineRimeUtf8Bytes(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

function marineRimeTruncateUtf8(value, maxBytes) {
  const text = String(value || '');
  const budget = Math.max(0, Number(maxBytes) || 0);
  if (!text || marineRimeUtf8Bytes(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (marineRimeUtf8Bytes(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  // Avoid leaving a dangling UTF-16 high surrogate at the boundary.
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

function marineRimeContextString(value) {
  return String(value == null ? '' : value).trim();
}

function marineRimeBuildContextEnvelope(grab, envelope, source) {
  const page = envelope || {};
  const captured = grab || {};
  return {
    platform: marineRimeContextString(page.platform || captured.platform),
    url: marineRimeContextString(page.url || captured.url),
    title: marineRimeContextString(page.title || captured.title),
    mode: page.mode === 'reply' ? 'reply' : 'direct',
    targetSummary: marineRimeTruncateUtf8(
      marineRimeContextString(page.targetSummary),
      MARINE_RIME_TARGET_SUMMARY_MAX_BYTES,
    ),
    source,
  };
}

// Select exactly one page-content source. The small context envelope remains
// alongside it so the agent still knows the page and exact action location.
// Empty/whitespace-only captures are not usable sources and fall through.
function marineRimeBuildPayload(grab, envelope) {
  const platform = marineRimeContextString(
    envelope && envelope.platform || grab && grab.platform,
  );
  const articleText = grab && grab.text && grab.text.md;
  const agentComments = grab && grab.comments && grab.comments.agentMd;
  const markdownComments = grab && grab.comments && grab.comments.md;
  const commentsText = marineRimeContextString(agentComments)
    ? agentComments
    : markdownComments;
  const subtitleText = grab && grab.subtitle && grab.subtitle.text;
  let source = 'none';
  // 知乎回答和小红书笔记的正文，等价于 B 站视频的字幕：它才是直评/回复
  // 的主背景。评论列表不能盖掉正文；精确回复楼层会通过可信 target 单独携带。
  if ((platform === 'zhihu' || platform === 'xiaohongshu') && marineRimeContextString(articleText)) {
    source = 'article';
  } else if (marineRimeContextString(subtitleText)) source = 'subtitle';
  else if (marineRimeContextString(commentsText)) source = 'comments';
  else if (marineRimeContextString(articleText)) source = 'article';

  const payload = {
    context: marineRimeBuildContextEnvelope(grab, envelope, source),
  };
  if (source === 'subtitle') {
    payload.subtitle = {
      text: marineRimeTruncateUtf8(subtitleText, MARINE_RIME_SUBTITLE_MAX_BYTES),
    };
  } else if (source === 'comments') {
    payload.comments = {
      agentMd: marineRimeTruncateUtf8(commentsText, MARINE_RIME_COMMENTS_MAX_BYTES),
    };
  } else if (source === 'article') {
    payload.article = {
      markdown: marineRimeTruncateUtf8(articleText, MARINE_RIME_ARTICLE_MAX_BYTES),
    };
  }
  return payload;
}

function marineRimeBuildReplyTarget(target) {
  const value = target || {};
  return {
    id: marineRimeContextString(value.id),
    authorName: marineRimeContextString(value.authorName),
    text: marineRimeContextString(value.text),
    parentId: marineRimeContextString(value.parentId),
    rootId: marineRimeContextString(value.rootId),
  };
}

function marineRimeContextWireBytes(context) {
  return marineRimeUtf8Bytes(JSON.stringify(context || {}));
}

// Bilibili's current comment Web Components do not expose rpid as a DOM
// attribute.  The page's own comment API does, so we may bind that stable ID
// back to a renderer only when both sides have one unique, exact identity.
// This deliberately rejects snippet/substring matches and duplicate comments.
function marineRimeNormalizeCommentIdentity(value) {
  return String(value || '').replace(/[\s\u00a0]+/g, ' ').trim();
}

function marineRimeResolveExactCapturedTarget(knownTargets, identity, renderedMatchCount) {
  if (renderedMatchCount !== 1) return null;
  const authorName = marineRimeNormalizeCommentIdentity(identity && identity.authorName);
  const text = marineRimeNormalizeCommentIdentity(identity && identity.text);
  if (!authorName || !text) return null;

  const uniqueById = new Map();
  for (const target of knownTargets || []) {
    const id = String(target && target.id || '').trim();
    if (!id) continue;
    if (marineRimeNormalizeCommentIdentity(target.authorName) !== authorName) continue;
    if (marineRimeNormalizeCommentIdentity(target.text) !== text) continue;
    uniqueById.set(id, target);
  }
  return uniqueById.size === 1 ? uniqueById.values().next().value : null;
}

// A renderer may expose its whole accessible text but no dedicated content
// node or rpid. Bind that user-selected renderer back to the captured API only
// when exactly one stable-ID comment by the same author has its complete,
// normalized API text inside the renderer text. The returned target always
// carries the API's exact comment body; the renderer's whole-thread text is
// matching evidence only and must never be sent to the agent as target.text.
function marineRimeResolveContainedCapturedTarget(knownTargets, identity) {
  const authorName = marineRimeNormalizeCommentIdentity(identity && identity.authorName);
  const wholeText = marineRimeNormalizeCommentIdentity(
    (identity && identity.wholeText) || (identity && identity.text),
  );
  const sameAuthorById = new Map();
  const containedById = new Map();
  if (authorName) {
    for (const target of knownTargets || []) {
      const id = String(target && target.id || '').trim();
      const text = marineRimeNormalizeCommentIdentity(target && target.text);
      if (!id || !text) continue;
      if (marineRimeNormalizeCommentIdentity(target.authorName) !== authorName) continue;
      sameAuthorById.set(id, target);
      if (wholeText && wholeText.indexOf(text) >= 0) containedById.set(id, target);
    }
  }
  return {
    target: containedById.size === 1 ? containedById.values().next().value : null,
    sameAuthorCount: sameAuthorById.size,
    containedMatchCount: containedById.size,
  };
}

function marineRimeStableHash(value, seed) {
  let hash = Number(seed) >>> 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// Some Bilibili comments are inserted optimistically and never appear in a
// captured list response.  A page-scoped DOM identity is still a stable reply
// target for the lifetime of the focused editor, and lets the agent echo the
// exact target id without guessing a different comment.
function marineRimeStableDomTargetId(pageKey, identity, elementKey) {
  const authorName = marineRimeNormalizeCommentIdentity(identity && identity.authorName);
  const text = marineRimeNormalizeCommentIdentity(identity && identity.text);
  const path = String(elementKey || '').trim();
  if (!pageKey || !text || !path) return '';
  const source = [String(pageKey), path, authorName, text].join('\n');
  return 'dom-' + marineRimeStableHash(source, 2166136261) + '-' +
    marineRimeStableHash(source.split('').reverse().join(''), 2246822507);
}

function marineRimeReplyPlaceholderAuthor(value) {
  const match = String(value || '').match(/^\s*回复\s*@?\s*(.+?)\s*(?:[：:]\s*)?$/);
  return match ? marineRimeNormalizeCommentIdentity(match[1]) : '';
}

function marineRimeReplyLeaseIsFresh(lease, pageKey, sourceId, now) {
  if (!lease || lease.pageKey !== pageKey || lease.sourceId !== sourceId) return false;
  const expiresAt = Number(lease.expiresAt) || 0;
  return expiresAt > 0 && (Number(now) || 0) <= expiresAt;
}

// A reply click may mount its editor outside the comment renderer.  In that
// case only the next newly-visible reply editor may claim the short hand-off;
// an already-rendered editor in another thread is never eligible.
function marineRimeCanClaimReplyLease(lease, editor, pageKey, sourceId, now) {
  if (!marineRimeReplyLeaseIsFresh(lease, pageKey, sourceId, now)) return false;
  const candidate = editor || {};
  if (!candidate.isReplyEditor) return false;
  if (candidate.structurallyOwned) return true;
  if (!candidate.isNewEditor && !candidate.becameReplyEditor && !candidate.retargetedReplyEditor) return false;
  const expected = marineRimeNormalizeCommentIdentity(lease.authorName);
  const actual = marineRimeNormalizeCommentIdentity(candidate.placeholderAuthor);
  return !expected || !actual || expected === actual;
}
