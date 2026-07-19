// publish-receipt.js — 从 Bilibili 发布接口响应中提取最小成功回执。
(function (root) {
  'use strict';

  const BILIBILI_HOST_RE = /(^|\.)bilibili\.com$/i;
  const PUBLISH_HOST = 'api.bilibili.com';
  const PUBLISH_PATH = '/x/v2/reply/add';
  const RECOVERY_PATHS = new Set([
    '/x/v2/reply',
    '/x/v2/reply/reply',
    '/x/v2/reply/wbi/main',
  ]);
  const RECOVERY_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
  const INVALID_ID = Symbol('invalid-bilibili-id');

  function positiveId(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    }
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : '';
  }

  function replyId(reply, name) {
    const exact = positiveId(reply && reply[name + '_str']);
    const fallback = positiveId(reply && reply[name]);
    return exact && fallback && exact !== fallback ? INVALID_ID : (exact || fallback);
  }

  function validRpid(reply) {
    if (!reply || !Object.prototype.hasOwnProperty.call(reply, 'rpid')) return '';
    const stringId = positiveId(reply.rpid_str);
    const fallback = positiveId(reply.rpid);
    if (stringId && fallback && stringId !== fallback) return '';
    const exact = stringId || fallback;
    if (!exact) return '';
    if (typeof reply.rpid === 'number') return Number.isFinite(reply.rpid) && reply.rpid > 0 ? exact : '';
    return positiveId(reply.rpid) ? exact : '';
  }

  function boundedString(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.length <= maxLength ? value : '';
  }

  function publishedAt(value, observedAt) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    const observed = Number(observedAt);
    return Number.isSafeInteger(observed) && observed > 0
      ? Math.floor(observed / 1000)
      : Math.floor(Date.now() / 1000);
  }

  function marineBuildBilibiliPublishedReceipt(input) {
    input = input || {};
    if (!BILIBILI_HOST_RE.test(String(input.pageHostname || ''))) return null;
    if (String(input.method || '').toUpperCase() !== 'POST') return null;
    const status = Number(input.status);
    if (input.ok !== true || !Number.isInteger(status) || status < 200 || status >= 300) return null;

    let endpoint;
    try { endpoint = new URL(String(input.url || ''), 'https://www.bilibili.com/'); }
    catch (e) { return null; }
    if (endpoint.hostname.toLowerCase() !== PUBLISH_HOST || endpoint.pathname !== PUBLISH_PATH) return null;

    let payload;
    try { payload = typeof input.body === 'string' ? JSON.parse(input.body) : input.body; }
    catch (e) { return null; }
    if (!payload || payload.code !== 0 || !payload.data || !payload.data.reply) return null;

    const reply = payload.data.reply;
    const rpid = validRpid(reply);
    const text = boundedString(reply.content && reply.content.message, 20_000);
    if (!rpid || !text.trim()) return null;

    const rootId = replyId(reply, 'root');
    const parentId = replyId(reply, 'parent');
    if (rootId === INVALID_ID || parentId === INVALID_ID) return null;
    const member = reply.member && typeof reply.member === 'object' ? reply.member : {};
    const siteAccountId = positiveId(member.mid_str) || positiveId(member.mid);
    const siteAccountName = boundedString(member.uname, 256).trim();

    return {
      schema_version: 1,
      event_id: 'bilibili:' + rpid,
      platform: 'bilibili',
      kind: rootId || parentId ? 'reply' : 'direct',
      text_snapshot: text,
      posted_at: publishedAt(reply.ctime, input.observedAt),
      site_account_id: siteAccountId || null,
      site_account_name: siteAccountName || null,
      platform_comment_id: rpid,
      target_comment_id: parentId || rootId || null,
      parent_id: parentId || null,
      root_id: rootId || null,
    };
  }

  function exactId(value, name, allowZero) {
    if (!value || typeof value !== 'object') return '';
    const stringId = positiveId(value[name + '_str']);
    let fallback = positiveId(value[name]);
    if (allowZero) {
      const numeric = value[name];
      const stringValue = value[name + '_str'];
      if (numeric === 0 || stringValue === '0') fallback = '0';
    }
    if (stringId && fallback && stringId !== fallback) return INVALID_ID;
    return stringId || fallback;
  }

  function recoveryReplies(data) {
    const replies = [];
    const seenObjects = new Set();
    function append(values, depth) {
      if (!Array.isArray(values) || depth > 2 || replies.length >= 400) return;
      for (const reply of values) {
        if (!reply || typeof reply !== 'object' || seenObjects.has(reply)) continue;
        seenObjects.add(reply);
        replies.push(reply);
        append(reply.replies, depth + 1);
        if (replies.length >= 400) break;
      }
    }
    append(data && data.top_replies, 0);
    append(data && data.replies, 0);
    append(data && data.reply, 0);
    return replies;
  }

  // Reconcile comments which already exist in Bilibili's own comment-list
  // response. This is deliberately separate from the live /add receipt: it is
  // used when Marine starts after the user posted, or when the page used a
  // network primitive that was not observable at publish time.
  function marineBuildBilibiliRecoveredReceipts(input) {
    input = input || {};
    if (!BILIBILI_HOST_RE.test(String(input.pageHostname || ''))) return [];
    if (String(input.method || '').toUpperCase() !== 'GET') return [];
    const status = Number(input.status);
    if (input.ok !== true || !Number.isInteger(status) || status < 200 || status >= 300) return [];

    let endpoint;
    try { endpoint = new URL(String(input.url || ''), 'https://www.bilibili.com/'); }
    catch (e) { return []; }
    if (endpoint.hostname.toLowerCase() !== PUBLISH_HOST || !RECOVERY_PATHS.has(endpoint.pathname)) {
      return [];
    }
    const expectedOid = positiveId(input.expectedOid);
    const responseOid = positiveId(endpoint.searchParams.get('oid'));
    const viewerId = positiveId(input.viewerId);
    if (!expectedOid || responseOid !== expectedOid || !viewerId) return [];

    let payload;
    try { payload = typeof input.body === 'string' ? JSON.parse(input.body) : input.body; }
    catch (e) { return []; }
    if (!payload || payload.code !== 0 || !payload.data) return [];

    const observedAt = Number(input.observedAt);
    const observedSeconds = Number.isSafeInteger(observedAt) && observedAt > 0
      ? Math.floor(observedAt / 1000)
      : Math.floor(Date.now() / 1000);
    const result = [];
    const seenIds = new Set();
    for (const reply of recoveryReplies(payload.data)) {
      const rpid = validRpid(reply);
      if (!rpid || seenIds.has(rpid)) continue;
      const member = reply.member && typeof reply.member === 'object' ? reply.member : {};
      const memberId = exactId(member, 'mid', false);
      if (memberId === INVALID_ID || memberId !== viewerId) continue;
      const replyOid = exactId(reply, 'oid', false);
      if (replyOid === INVALID_ID || (replyOid && replyOid !== expectedOid)) continue;
      const postedAt = Number(reply.ctime);
      if (!Number.isSafeInteger(postedAt) || postedAt <= 0 || postedAt > observedSeconds + 300 ||
          observedSeconds - postedAt > RECOVERY_LOOKBACK_SECONDS) continue;
      const text = boundedString(reply.content && reply.content.message, 20_000);
      if (!text.trim()) continue;
      const rootId = exactId(reply, 'root', true);
      const parentId = exactId(reply, 'parent', true);
      if (rootId === INVALID_ID || parentId === INVALID_ID) continue;
      const normalizedRoot = rootId && rootId !== '0' ? rootId : '';
      const normalizedParent = parentId && parentId !== '0' ? parentId : '';
      seenIds.add(rpid);
      result.push({
        schema_version: 1,
        event_id: 'bilibili:' + rpid,
        platform: 'bilibili',
        kind: normalizedRoot || normalizedParent ? 'reply' : 'direct',
        text_snapshot: text,
        posted_at: postedAt,
        site_account_id: memberId,
        site_account_name: boundedString(member.uname, 256).trim() || null,
        platform_comment_id: rpid,
        target_comment_id: normalizedParent || normalizedRoot || null,
        parent_id: normalizedParent || null,
        root_id: normalizedRoot || null,
      });
    }
    return result;
  }

  root.marineBuildBilibiliPublishedReceipt = marineBuildBilibiliPublishedReceipt;
  root.marineBuildBilibiliRecoveredReceipts = marineBuildBilibiliRecoveredReceipts;
})(globalThis);
