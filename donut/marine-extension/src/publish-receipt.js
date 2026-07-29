// publish-receipt.js — 从 Bilibili 发布接口响应中提取最小成功回执。
(function (root) {
  'use strict';

  const BILIBILI_HOST_RE = /(^|\.)bilibili\.com$/i;
  const PUBLISH_HOST = 'api.bilibili.com';
  const PUBLISH_PATH = '/x/v2/reply/add';
  const ZHIHU_HOST_RE = /(^|\.)zhihu\.com$/i;
  // 实测命中：/api/v4/comment_v5/articles/{id}/comment
  // answers/questions 走同一族路径，一并认。
  const ZHIHU_PUBLISH_PATH_RE = /^\/api\/v4\/comment_v5\/(articles|answers|questions|pins)\/\d+\/comment$/i;
  const XHS_HOST_RE = /(^|\.)xiaohongshu\.com$/i;
  // 实测：笔记页读列表走 GET /api/sns/web/v2/comment/page。写操作在同族
  // `comment/` 下，首次真实发送后用 diag().lastPost 收紧成确切路径。
  const XHS_PUBLISH_PATH_RE = /^\/api\/sns\/web\/v\d+\/comment\/(post|create|add)$/i;
  // 已知的读接口，永远不能被当成发布。
  const XHS_READ_PATH_RE = /\/comment\/(page|sub\/page|list)$/i;
  const DOUYIN_HOST_RE = /(^|\.)douyin\.com$/i;
  // 实测：视频页读评论走 GET /aweme/v1/web/comment/list/。写操作在同族。
  const DOUYIN_PUBLISH_PATH_RE = /^\/aweme\/v\d+\/web\/comment\/(publish|create|post)\/?$/i;
  const DOUYIN_READ_PATH_RE = /\/comment\/list(\/reply)?\/?$/i;
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

  /**
   * 知乎的发布回执。
   *
   * 判据全部来自实测（2026-07-28，专栏文章直评）：
   *   POST https://www.zhihu.com/api/v4/comment_v5/articles/{id}/comment  → 200
   *   {"id":"11541384708","type":"comment","resource_type":"article",
   *    "member_id":824201953,"content":"<p>…</p>"}
   *
   * 和 B 站的对应关系：`id` ↔ `rpid`，`member_id` ↔ `member.mid`。
   * 知乎这个接口没有 B 站那种 `code` 字段——HTTP 2xx + 一个正数 `id` 就是成功
   * 的全部证据，所以 `id` 必须严格校验：没有它就没有「真的上线了」的凭据。
   *
   * `content` 是 HTML（`<p>…</p>`），落账前剥掉标签 —— 台账里存的是给人看的
   * 文本快照，不是待渲染的富文本。
   */
  function marineBuildZhihuPublishedReceipt(input) {
    input = input || {};
    if (!ZHIHU_HOST_RE.test(String(input.pageHostname || ''))) return null;
    if (String(input.method || '').toUpperCase() !== 'POST') return null;
    const status = Number(input.status);
    if (input.ok !== true || !Number.isInteger(status) || status < 200 || status >= 300) return null;

    let endpoint;
    try { endpoint = new URL(String(input.url || ''), 'https://www.zhihu.com/'); }
    catch (e) { return null; }
    if (!ZHIHU_HOST_RE.test(endpoint.hostname)) return null;
    // 只认「新建评论」这一个动作。评论列表 / 子评论 / 点赞都在 comment_v5 下面，
    // 放宽路径会把「读到了别人的评论」当成「我发出去了」。
    if (!ZHIHU_PUBLISH_PATH_RE.test(endpoint.pathname)) return null;

    let payload;
    try { payload = typeof input.body === 'string' ? JSON.parse(input.body) : input.body; }
    catch (e) { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (String(payload.type || '') !== 'comment') return null;

    const commentId = positiveId(payload.id);
    if (!commentId) return null;

    const text = boundedString(zhihuPlainText(payload.content), 20_000);
    if (!text.trim()) return null;

    // 回复别人时才有 reply_comment_id / parent；直评两者都空。
    const replyTo = positiveId(payload.reply_comment_id) ||
      (payload.reply_to_comment && positiveId(payload.reply_to_comment.id)) || '';

    return {
      schema_version: 1,
      event_id: 'zhihu:' + commentId,
      platform: 'zhihu',
      kind: replyTo ? 'reply' : 'direct',
      text_snapshot: text,
      posted_at: publishedAt(payload.created_time, input.observedAt),
      site_account_id: positiveId(payload.member_id) || null,
      site_account_name: (payload.author && boundedString(payload.author.name, 256).trim()) || null,
      platform_comment_id: commentId,
      target_comment_id: replyTo || null,
      parent_id: replyTo || null,
      root_id: null,
    };
  }

  /**
   * 小红书的发布回执。
   *
   * # 判据来自哪里
   *
   * 路径族是实测的：笔记页会发 `GET /api/sns/web/v2/comment/page` 读评论列表，
   * 同族的写操作即 `comment/post`。但**发布响应的字段还没有实测样本** —— 首次
   * 真实发送时用 `diag().lastPost` 记下确切路径和构造结果，再回来收紧这里。
   *
   * # 因此这里刻意保守
   *
   * 宁可漏判（记 `failed`，人工可查）也不能误判（记 `posted` 却其实没发出去，
   * 那会消耗 per-item cap 并让报表虚高）。所以：
   *   · 路径必须是 `comment/` 下的写操作，且不是已知的读接口（page/sub 等）
   *   · 必须能取到一个正数评论 id —— 没有它就没有「真的上线了」的凭据
   *
   * 小红书的响应外层通常是 `{success, code, data:{...}}`，评论 id 在
   * `data.comment.id`；也见过直接放在 `data.id`。两种都试，都取不到就返回 null。
   */
  /**
   * 抖音的发布回执。
   *
   * 路径族实测：视频页读评论走 `GET /aweme/v1/web/comment/list/`，同族的写操作
   * 即 `comment/publish/`。**响应字段还没有实测样本** —— 首次真实发送时用
   * `diag().lastPost.body` 记下来再回来收紧。
   *
   * 抖音的响应惯例是 `{status_code:0, comment:{cid, text, user:{uid,nickname}}}`，
   * `cid` 是 19 位十进制字符串，能被 `positiveId` 接住。
   *
   * 保守优先：拿不到评论 id 就返回 null（记 failed，人工可查），绝不虚报。
   */
  function marineBuildDouyinPublishedReceipt(input) {
    input = input || {};
    if (!DOUYIN_HOST_RE.test(String(input.pageHostname || ''))) return null;
    if (String(input.method || '').toUpperCase() !== 'POST') return null;
    const status = Number(input.status);
    if (input.ok !== true || !Number.isInteger(status) || status < 200 || status >= 300) return null;

    let endpoint;
    try { endpoint = new URL(String(input.url || ''), 'https://www.douyin.com/'); }
    catch (e) { return null; }
    if (!DOUYIN_HOST_RE.test(endpoint.hostname)) return null;
    if (!DOUYIN_PUBLISH_PATH_RE.test(endpoint.pathname)) return null;
    if (DOUYIN_READ_PATH_RE.test(endpoint.pathname)) return null;

    let payload;
    try { payload = typeof input.body === 'string' ? JSON.parse(input.body) : input.body; }
    catch (e) { return null; }
    if (!payload || typeof payload !== 'object') return null;
    // status_code 非 0 是业务失败（风控等），HTTP 仍然是 200。
    if (payload.status_code !== undefined && payload.status_code !== 0) return null;

    const comment = (payload.comment && typeof payload.comment === 'object') ? payload.comment : payload;
    const commentId = positiveId(comment.cid) || positiveId(comment.comment_id) || positiveId(comment.id);
    if (!commentId) return null;

    const text = boundedString(String(comment.text || comment.content || ''), 20_000);
    if (!text.trim()) return null;

    const replyTo = positiveId(comment.reply_id) || positiveId(comment.reply_to_reply_id) || '';
    const user = (comment.user && typeof comment.user === 'object') ? comment.user : {};

    return {
      schema_version: 1,
      event_id: 'douyin:' + commentId,
      platform: 'douyin',
      kind: replyTo ? 'reply' : 'direct',
      text_snapshot: text,
      posted_at: publishedAt(comment.create_time, input.observedAt),
      site_account_id: positiveId(user.uid) || null,
      site_account_name: boundedString(user.nickname, 256).trim() || null,
      platform_comment_id: commentId,
      target_comment_id: replyTo || null,
      parent_id: replyTo || null,
      root_id: null,
    };
  }

  /**
   * 小红书的 id 是 **24 位十六进制字符串**，不是正整数。
   *
   * 实测响应：`user_id: "69c0fa620000000033037ae5"`、
   * `note_id: "6a5b0f18000000001c00fb2c"`。评论 id 同族。
   * 用通用的 `positiveId()`（只认正整数）会一律返回空 —— 表现是回执明明推到了
   * 桥这边、路径和状态码都对，`built` 却始终是 `null`。
   */
  function xhsId(value) {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    return /^[0-9a-f]{16,32}$/i.test(v) ? v : '';
  }

  function marineBuildXiaohongshuPublishedReceipt(input) {
    input = input || {};
    if (!XHS_HOST_RE.test(String(input.pageHostname || ''))) return null;
    if (String(input.method || '').toUpperCase() !== 'POST') return null;
    const status = Number(input.status);
    if (input.ok !== true || !Number.isInteger(status) || status < 200 || status >= 300) return null;

    let endpoint;
    try { endpoint = new URL(String(input.url || ''), 'https://www.xiaohongshu.com/'); }
    catch (e) { return null; }
    if (!XHS_HOST_RE.test(endpoint.hostname)) return null;
    if (!XHS_PUBLISH_PATH_RE.test(endpoint.pathname)) return null;
    // 读接口即使被误当成 POST 也不能进来 —— 「读到了别人的评论」变成
    // 「我发出去了」是这条链上最坏的一种错。
    if (XHS_READ_PATH_RE.test(endpoint.pathname)) return null;

    let payload;
    try { payload = typeof input.body === 'string' ? JSON.parse(input.body) : input.body; }
    catch (e) { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (payload.success === false) return null;

    const data = (payload.data && typeof payload.data === 'object') ? payload.data : payload;
    const comment = (data.comment && typeof data.comment === 'object') ? data.comment : data;
    const commentId = xhsId(comment.id) || xhsId(data.id);
    if (!commentId) return null;

    const text = boundedString(String(comment.content || data.content || ''), 20_000);
    if (!text.trim()) return null;

    const targetComment = xhsId(comment.target_comment_id) ||
      (comment.target_comment && xhsId(comment.target_comment.id)) || '';
    const user = (comment.user_info && typeof comment.user_info === 'object') ? comment.user_info : {};

    return {
      schema_version: 1,
      event_id: 'xiaohongshu:' + commentId,
      platform: 'xiaohongshu',
      kind: targetComment ? 'reply' : 'direct',
      text_snapshot: text,
      posted_at: publishedAt(comment.create_time, input.observedAt),
      site_account_id: xhsId(user.user_id) || null,
      site_account_name: boundedString(user.nickname, 256).trim() || null,
      platform_comment_id: commentId,
      target_comment_id: targetComment || null,
      parent_id: targetComment || null,
      root_id: null,
    };
  }

  /** 知乎的 content 是 HTML，落账前剥成纯文本。 */
  function zhihuPlainText(value) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
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
  root.marineBuildZhihuPublishedReceipt = marineBuildZhihuPublishedReceipt;
  root.marineBuildXiaohongshuPublishedReceipt = marineBuildXiaohongshuPublishedReceipt;
  root.marineBuildDouyinPublishedReceipt = marineBuildDouyinPublishedReceipt;
  root.marineBuildBilibiliRecoveredReceipts = marineBuildBilibiliRecoveredReceipts;
})(globalThis);
