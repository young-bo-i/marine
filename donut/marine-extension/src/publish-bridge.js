// publish-bridge.js — ISOLATED document_start 私有发布回执桥。
(function () {
  'use strict';

  const HANDSHAKE_EVENT = 'marine-published-receipt-handshake-v1';
  const HANDSHAKE_NONCE_EVENT = 'marine-published-receipt-nonce-v1';
  const HANDSHAKE_REQUEST_EVENT = 'marine-published-receipt-request-v1';
  const HANDSHAKE = 'published-receipt-port-v1';
  const HANDSHAKE_ACK = 'published-receipt-ready-v1';
  const HANDSHAKE_CONNECTED = 'published-receipt-connected-v1';
  const HANDSHAKE_HEALTH_CONFIRMED = 'published-receipt-health-confirmed-v1';
  const HANDSHAKE_PING = 'published-receipt-ping-v1';
  const HANDSHAKE_PONG = 'published-receipt-pong-v1';
  const BRIDGE_STATE_KEY = '__marinePublishedBridgeStateV1';
  const buildPublishedReceipt = globalThis.marineBuildBilibiliPublishedReceipt;
  const buildZhihuReceipt = globalThis.marineBuildZhihuPublishedReceipt;
  const buildXhsReceipt = globalThis.marineBuildXiaohongshuPublishedReceipt;
  const buildDouyinReceipt = globalThis.marineBuildDouyinPublishedReceipt;
  const buildRecoveredReceipts = globalThis.marineBuildBilibiliRecoveredReceipts;
  const buildRefusal = globalThis.marineBuildPublishRefusal;
  try { delete globalThis.marineBuildBilibiliPublishedReceipt; } catch (e) {}
  try { delete globalThis.marineBuildZhihuPublishedReceipt; } catch (e) {}
  try { delete globalThis.marineBuildXiaohongshuPublishedReceipt; } catch (e) {}
  try { delete globalThis.marineBuildDouyinPublishedReceipt; } catch (e) {}
  try { delete globalThis.marineBuildBilibiliRecoveredReceipts; } catch (e) {}
  try { delete globalThis.marineBuildPublishRefusal; } catch (e) {}
  let existingBridgeState = null;
  try { existingBridgeState = globalThis[BRIDGE_STATE_KEY]; } catch (e) {}
  if (existingBridgeState && typeof existingBridgeState.signalReady === 'function') {
    try { existingBridgeState.signalReady(); } catch (e) {}
    return;
  }

  const READY_RETRY_DELAYS = [100, 500, 1500];
  let currentPort = null;
  let pendingNonce = '';
  let readyGeneration = 0;
  let readyAttempts = 0;
  let readyRetryTimer = null;
  let viewerPromise = null;
  const aidPromises = new Map();

  /**
   * 平台评论 id。
   *
   * B 站/知乎是正整数，**小红书是 24 位十六进制字符串**（实测
   * `6a68955200000000230006da`）。只认整数会让小红书的回执在这一步被静默丢掉 ——
   * 而 `diag().built` 里明明已经构造成功了，两者的外部症状完全一样。
   *
   * 这个形态在四个地方各判一次（本文件、sw.js、api_server.rs、构造器自己的
   * `xhsId`），加平台时四处都要看。
   */
  function positiveId(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    }
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    if (/^[1-9]\d*$/.test(normalized)) return normalized;
    if (/^[0-9a-f]{16,32}$/i.test(normalized)) return normalized;
    return '';
  }

  function boundedString(value, maxLength) {
    return typeof value === 'string' && value.length <= maxLength ? value : '';
  }

  function isBilibiliUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        /(^|\.)bilibili\.com$/i.test(parsed.hostname);
    }
    catch (e) { return false; }
  }

  function createNonce() {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    } catch (e) { return ''; }
  }

  function validNonce(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  }

  function stopReadyRetry() {
    if (readyRetryTimer != null) clearTimeout(readyRetryTimer);
    readyRetryTimer = null;
  }

  function scheduleReadyRetry(generation) {
    if (generation !== readyGeneration || readyRetryTimer != null || !pendingNonce) return;
    const delay = READY_RETRY_DELAYS[readyAttempts - 1];
    if (!delay) {
      // 整条链最沉默的一环：握手用尽重试后就**永久**放弃，而 MAIN 侧的
      // postPublishedCandidate 在端口没建起来时是无声丢弃的。这之后这个文档里
      // 发生的每一次发布都不会产生任何回执，也不留任何痕迹 —— 外部只会看到
      // 「未收到平台回执」，和接口形状不对完全无法区分。
      bridgeLog('error', 'MAIN↔ISOLATED 回执端口握手失败，已放弃重试', 'attempts=' + readyAttempts);
      return;
    }
    readyRetryTimer = setTimeout(function () {
      readyRetryTimer = null;
      sendReady(generation);
    }, delay);
  }

  function sendReady(generation) {
    if (generation !== readyGeneration || !pendingNonce) return;
    readyAttempts += 1;
    try {
      chrome.runtime.sendMessage({
        __marinePublishedBridgeReady: true,
        nonce: pendingNonce,
      }, function (response) {
        const error = chrome.runtime.lastError;
        if (generation !== readyGeneration || !pendingNonce) return;
        if (!error && response && response.ok) return;
        scheduleReadyRetry(generation);
      });
    } catch (e) {
      scheduleReadyRetry(generation);
    }
  }

  function signalReady() {
    // 判据必须和 receiptBuilderFor 一致：能构造回执的站点才值得握手，反过来
    // 也一样 —— 这里写死 bilibili 的后果是知乎侧 `readyAttempts` 永远是 0，
    // MessagePort 从不建立，MAIN world 捕获到的发布响应无处可送。表现是
    // 「评论确实发出去了、台账却记 failed」，实测查了很久。
    if (typeof receiptBuilderFor(window.location && window.location.href) !== 'function') return;
    const nonce = createNonce();
    if (!nonce) return;
    readyGeneration += 1;
    readyAttempts = 0;
    stopReadyRetry();
    pendingNonce = nonce;
    window.removeEventListener(HANDSHAKE_EVENT, acceptPort, false);
    window.addEventListener(HANDSHAKE_EVENT, acceptPort, false);
    sendReady(readyGeneration);
  }

  function sanitize(value) {
    // 同上：平台白名单要跟着回执构造器走。只改握手不改这里，会变成「握手通了
    // 但回执在最后一步被静默丢掉」—— 比原来更难查。
    if (!value || value.schema_version !== 1 || !SUPPORTED_RECEIPT_PLATFORMS.has(value.platform)) {
      return null;
    }
    const platformCommentId = positiveId(value.platform_comment_id);
    const rootId = positiveId(value.root_id);
    const parentId = positiveId(value.parent_id);
    const targetCommentId = parentId || rootId;
    const targetUrl = boundedString(value.target_url, 4096);
    const text = boundedString(value.text_snapshot, 20_000);
    const postedAt = Number(value.posted_at);
    // 三处都必须按**声明的平台**判，不能写死。写死的后果特别隐蔽：回执明明已经
    // 构造成功（diag 里 `built: "zhihu:1154..."`），却在这一步被静默丢掉，外部
    // 看到的仍然是「没收到回执」，和「压根没构造出来」完全无法区分。
    const platform = value.platform;
    if (!platformCommentId || value.event_id !== platform + ':' + platformCommentId ||
        !targetUrl || !receiptBuilderFor(targetUrl) || !text.trim() ||
        !Number.isSafeInteger(postedAt) || postedAt <= 0) return null;
    return {
      schema_version: 1,
      event_id: value.event_id,
      platform: platform,
      target_url: targetUrl,
      page_title: typeof value.page_title === 'string' ? value.page_title.slice(0, 512) : '',
      kind: targetCommentId ? 'reply' : 'direct',
      text_snapshot: text,
      posted_at: postedAt,
      site_account_id: positiveId(value.site_account_id) || null,
      site_account_name: boundedString(value.site_account_name, 256).trim() || null,
      platform_comment_id: platformCommentId,
      target_comment_id: targetCommentId || null,
      target_author: null,
      parent_id: parentId || null,
      root_id: rootId || null,
      context_id: null,
    };
  }

  function sendReceipt(receipt) {
    // 给页内一个可等的信号。
    //
    // 自动发送需要知道「平台真的收下了」，而这个判据只有回执有：B 站的
    // /x/v2/reply/add 必须 code===0 且带正数 rpid（HTTP 200 不作数——风控拒绝
    // 时也返回 200）。回执本身走 SW → 本地 API 那条链，编排在页内等不到它，
    // 所以这里额外把最近一条挂到 isolated world 的全局上。
    //
    // 同一个扩展的所有 content script 共享一个 isolated world，所以 content-iso
    // 读得到；页面 JS 读不到（世界隔离）。只留最近一条，够用且不积累。
    try {
      if (typeof window !== 'undefined') {
        window.marineLastPublishedReceipt = {
          eventId: receipt && receipt.event_id,
          platformCommentId: receipt && receipt.platform_comment_id,
          text: receipt && receipt.text_snapshot,
          at: Date.now(),
        };
      }
    } catch (e) {}
    try {
      chrome.runtime.sendMessage({ __marinePublishedComment: true, receipt }, function (response) {
        const error = chrome.runtime.lastError;
        if (error) {
          console.warn('[Marine] 发布记录未能进入本地队列：' + error.message);
          return;
        }
        if (!response || !response.ok) {
          console.warn('[Marine] 发布记录未能进入本地队列：' + ((response && response.error) || '未知错误'));
        } else if (response.queued) {
          console.info('[Marine] 发布记录已进入待同步队列');
        } else {
          console.info('[Marine] 已同步 Bilibili 发布记录');
        }
      });
    } catch (e) {
      console.warn('[Marine] 发布记录未能进入本地队列：' + String(e && e.message || e));
    }
  }

  function videoBvid(targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      if (!isBilibiliUrl(parsed.href)) return '';
      const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)(?:\/|$)/);
      return match ? match[1] : '';
    } catch (e) { return ''; }
  }

  async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  function viewerIdentity() {
    if (!viewerPromise) {
      viewerPromise = fetchJson('https://api.bilibili.com/x/web-interface/nav')
        .then(function (payload) {
          const data = payload && payload.code === 0 && payload.data;
          const id = positiveId(data && (data.mid_str || data.mid));
          if (!data || data.isLogin === false || !id) throw new Error('Bilibili 未登录');
          return { id, name: boundedString(data.uname, 256).trim() };
        })
        .catch(function (error) {
          viewerPromise = null;
          throw error;
        });
    }
    return viewerPromise;
  }

  function videoAid(bvid) {
    if (!aidPromises.has(bvid)) {
      const promise = fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))
        .then(function (payload) {
          const data = payload && payload.code === 0 && payload.data;
          const id = positiveId(data && (data.aid_str || data.aid));
          if (!id) throw new Error('Bilibili 视频 ID 无效');
          return id;
        })
        .catch(function (error) {
          aidPromises.delete(bvid);
          throw error;
        });
      aidPromises.set(bvid, promise);
    }
    return aidPromises.get(bvid);
  }

  function isRecoveryCandidate(value, targetUrl) {
    if (!value || String(value.method || '').toUpperCase() !== 'GET' || !videoBvid(targetUrl)) return false;
    try {
      const endpoint = new URL(String(value.url || ''));
      return endpoint.hostname === 'api.bilibili.com' &&
        (endpoint.pathname === '/x/v2/reply' || endpoint.pathname === '/x/v2/reply/reply' ||
          endpoint.pathname === '/x/v2/reply/wbi/main');
    } catch (e) { return false; }
  }

  async function recoverPublished(value, targetUrl, pageTitle) {
    if (typeof buildRecoveredReceipts !== 'function' || !isRecoveryCandidate(value, targetUrl)) return;
    const bvid = videoBvid(targetUrl);
    const identityAndAid = await Promise.all([viewerIdentity(), videoAid(bvid)]);
    const identity = identityAndAid[0];
    const aid = identityAndAid[1];
    const built = buildRecoveredReceipts({
      pageHostname: new URL(targetUrl).hostname,
      observedAt: value.observedAt,
      url: value.url,
      method: value.method,
      status: value.status,
      ok: value.ok,
      body: value.body,
      viewerId: identity.id,
      expectedOid: aid,
    });
    for (const value of built) {
      const receipt = sanitize(Object.assign({}, value, {
        target_url: targetUrl,
        page_title: pageTitle,
        site_account_name: value.site_account_name || identity.name,
      }));
      if (receipt) sendReceipt(receipt);
    }
  }

  function isZhihuUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        /(^|\.)zhihu\.com$/i.test(parsed.hostname);
    } catch (e) { return false; }
  }

  function isDouyinUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        /(^|\.)douyin\.com$/i.test(parsed.hostname);
    } catch (e) { return false; }
  }

  function isXhsUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        /(^|\.)xiaohongshu\.com$/i.test(parsed.hostname);
    } catch (e) { return false; }
  }

  /** 按页面所在站点挑回执构造器。每个平台的成功判据完全不同，不能共用一个。 */
  function receiptBuilderFor(targetUrl) {
    if (isBilibiliUrl(targetUrl)) return buildPublishedReceipt;
    if (isZhihuUrl(targetUrl)) return buildZhihuReceipt;
    if (isXhsUrl(targetUrl)) return buildXhsReceipt;
    if (isDouyinUrl(targetUrl)) return buildDouyinReceipt;
    return null;
  }

  /** 已实现回执构造器的平台。加平台时和 receiptBuilderFor 一起改。 */
  const SUPPORTED_RECEIPT_PLATFORMS = new Set(['bilibili', 'zhihu', 'xiaohongshu', 'douyin']);

  let forwardCount = 0;
  // 最近几条捕获的评论接口 URL + 构造结果。
  //
  // 用来在**不发任何评论**的前提下摸清某个平台的接口形状：页面自己拉评论列表
  // 时就会产生捕获，看这些 URL 的路径族就能推出「发评论」走的是哪一条，
  // 不必靠发一条真评论去抓包。
  const recentForwards = [];
  let lastPost = null;

  // 回执链上每一环的失败都必须留下**持久**痕迹。
  //
  // 在此之前这个文件一条 marineLog 都没有：六个环里任何一环断掉，外部看到的都是
  // 同一句「已点发送但未收到平台回执（可能被风控拦截）」—— 一个接口形状的 bug 被
  // 说成风控问题，于是它活了下来。唯一的证据 diag() 只活在页面内存里，而收尾动作
  // 恰好是把这个页面导航到 about:blank，等于亲手销毁排查现场。
  //
  // marineLog 由 debug-panel.js 声明，和本文件同属 ISOLATED world、共享全局作用域；
  // 但本文件跑在 document_start 而它在 document_idle，所以加载期它还不存在 ——
  // 必须每次调用前探测，不能在模块顶层缓存引用。
  function bridgeLog(level, msg, data) {
    try {
      if (typeof marineLog === 'function') marineLog(level, 'publish-bridge', msg, data);
    } catch (e) {}
  }

  // 页面自己拉评论列表的 GET 非常密集，全记会把账本冲垮，也会把真正要看的那一条挤掉。
  // 发布必然是 POST，所以只有 POST 的失败才值得留痕。
  function isPost(value) {
    return String((value && value.method) || '').toUpperCase() === 'POST';
  }

  function forward(value) {
    forwardCount += 1;
    try {
      recentForwards.push({
        url: String((value && value.url) || '').slice(0, 160),
        method: String((value && value.method) || ''),
        status: (value && value.status) || 0,
      });
      // POST 单独留一份：页面拉评论列表的 GET 很密集，共用一个队列的话，
      // 真正要看的那次发布 POST 几秒内就被挤掉了 —— 排查时正好什么都看不到。
      if (String((value && value.method) || '').toUpperCase() === 'POST') {
        lastPost = {
          url: String((value && value.url) || '').slice(0, 200),
          status: (value && value.status) || 0,
          ok: !!(value && value.ok),
          // 响应体截断留样：构造失败时唯一能说明「字段长什么样」的东西。
          // 没有它就只能靠再发一条真评论去抓 —— 每次排查都留一条公开痕迹。
          body: String((value && value.body) || '').slice(0, 600),
          built: null,
          at: Date.now(),
        };
      }
      while (recentForwards.length > 12) recentForwards.shift();
    } catch (e) {}
    if (!value || !value.page_context) {
      if (isPost(value)) bridgeLog('warn', 'POST 捕获到了，但 MAIN 侧没带 page_context', value && value.url);
      return;
    }
    const targetUrl = boundedString(value.page_context.target_url, 4096);
    if (!targetUrl) {
      if (isPost(value)) bridgeLog('warn', 'POST 捕获到了，但 page_context 没有 target_url', value.url);
      return;
    }
    const builder = receiptBuilderFor(targetUrl);
    if (typeof builder !== 'function') {
      // 这一条最容易被误读成「没发出去」：请求发了、也成功了，只是这个页面 URL
      // 匹配不到任何平台的回执构造器，于是整条链在这里悄悄断掉。
      if (isPost(value)) bridgeLog('warn', '这个页面没有对应的回执构造器', targetUrl);
      return;
    }
    let pageHostname = '';
    try { pageHostname = new URL(targetUrl).hostname; } catch (e) {
      if (isPost(value)) bridgeLog('warn', 'target_url 解析失败', targetUrl);
      return;
    }
    if (typeof value.body === 'string' && value.body.length > 2_000_000) {
      if (isPost(value)) bridgeLog('warn', '响应体超过 2MB，放弃构造回执', value.url);
      return;
    }
    let built;
    try {
      built = builder({
        pageHostname,
        observedAt: value.observedAt,
        url: value.url,
        method: value.method,
        status: value.status,
        ok: value.ok,
        body: value.body,
      });
      // 记下构造结果：排查时要能分清「MAIN 没推过来」和「推过来了但判据没过」，
      // 这两者的下一步完全不同。
      if (lastPost && String((value && value.method) || '').toUpperCase() === 'POST') {
        lastPost.built = built ? (built.event_id || 'built') : 'null';
      }
    } catch (e) {
      if (isPost(value)) {
        bridgeLog('error', '回执构造器抛异常：' + String(e && e.message || e), value.url);
      }
      return;
    }
    if (!built && isPost(value)) {
      // 先问一句：是不是平台**明确拒绝**了？
      //
      // 实测里 62 条「判据未通过」有一半以上根本不是判据的问题 —— 有的是作者只
      // 允许好友评论、有的是抖音直接回了错误码。这些评论**没有发布**，却因为拿不到
      // 回执被记成 unconfirmed：白占一个公开足迹，还永久烧掉这条候选。
      let refusal = null;
      try {
        refusal = typeof buildRefusal === 'function' ? buildRefusal({
          url: value.url, method: value.method, status: value.status,
          ok: value.ok, body: value.body,
        }) : null;
      } catch (e) {}
      if (refusal) {
        try {
          if (typeof window !== 'undefined') {
            window.marineLastPublishRefusal = Object.assign({ at: Date.now() }, refusal);
          }
        } catch (e) {}
        bridgeLog('warn', '平台拒绝了这条评论：' + refusal.message,
          JSON.stringify({ platform: refusal.platform, code: refusal.code, blocked: refusal.blocked }));
        return;
      }
      // 只对**看起来像发布端点**的 POST 报噪。实测有 6 条是 /api/sns/web/v1/feed
      // ——那是读信息流，本来就不该进这个判定，记进来只会虚增问题规模。
      if (typeof builder === 'function') {
      bridgeLog('error', '发布 POST 已捕获，但回执判据未通过', JSON.stringify({
        url: String(value.url || '').slice(0, 200),
        status: value.status || 0,
        ok: !!value.ok,
        bodySample: String(value.body || '').slice(0, 300),
      }));
      }
    }
    if (built) {
      const receipt = sanitize(Object.assign({}, built, {
        target_url: targetUrl,
        page_title: value.page_context.page_title,
      }));
      if (receipt) {
        bridgeLog('info', '回执已构造并投递', built.event_id || '');
        sendReceipt(receipt);
        return;
      }
      bridgeLog('error', '回执构造成功但被 sanitize 丢弃', built.event_id || '');
    }
    void recoverPublished(value, targetUrl, value.page_context.page_title)
      .catch(function (error) {
        console.info('[Marine] Bilibili 最近发布记录暂未完成对账：' + String(error && error.message || error));
      });
  }

  function acceptPort(event) {
    if (event.source !== window) return;
    const data = event.data;
    const port = event.ports && event.ports[0];
    if (!data || data.__marine !== HANDSHAKE || data.nonce !== pendingNonce || !port) return;
    const previousPort = currentPort;
    port.onmessage = function (message) {
      if (currentPort !== port) return;
      const value = message && message.data;
      if (value && (value.__marine === HANDSHAKE_CONNECTED ||
          value.__marine === HANDSHAKE_HEALTH_CONFIRMED) && value.nonce === pendingNonce) {
        pendingNonce = '';
        stopReadyRetry();
        window.removeEventListener(HANDSHAKE_EVENT, acceptPort, false);
        return;
      }
      if (value && value.__marine === HANDSHAKE_PING && validNonce(value.nonce)) {
        try { port.postMessage({ __marine: HANDSHAKE_PONG, nonce: value.nonce }); } catch (e) {}
        return;
      }
      forward(value);
    };
    port.onmessageerror = function () {
      console.warn('[Marine] Bilibili 发布回执通道收到无效消息');
    };
    if (port.start) port.start();
    currentPort = port;
    try {
      port.postMessage({ __marine: HANDSHAKE_ACK, nonce: data.nonce });
    } catch (e) {
      currentPort = previousPort;
      return;
    }
    try { if (previousPort && previousPort !== port && previousPort.close) previousPort.close(); } catch (e) {}
  }

  function announcePendingNonce(event) {
    if (event.source !== window || !event.data || event.data.__marine !== 'published-receipt-request-v1' ||
        !validNonce(pendingNonce)) return;
    window.dispatchEvent(new MessageEvent(HANDSHAKE_NONCE_EVENT, {
      data: { __marine: 'published-receipt-nonce-v1', nonce: pendingNonce },
      source: window,
    }));
  }

  // 只读诊断出口。
  //
  // 回执链路横跨 MAIN world（劫持 fetch）→ MessagePort 握手 → ISOLATED 桥 →
  // SW → 本地 API，任何一环断了，外部看到的都是同一句「没收到回执」。没有这个
  // 出口就只能靠一次次发真评论去二分，代价太高（实测：为查知乎这条链发了 3 条
  // 真实评论）。
  //
  // 全部只读，且只暴露在 ISOLATED world，页面 JS 看不到。
  // 用一份**已捕获**的响应补构回执 —— 回执链断掉时的兜底。
  //
  // 证据强度和正常路径完全相同：同一个实测过的构造器、同一个 sanitize，一个字段都
  // 没有改写，所以 confirmation_source 仍然是平台自己的接口判断，拿到的也是平台
  // 自己的评论 id。它绕开的只是**投递通道**（MessagePort 握手 → forward），而那正是
  // 会静默失效的那几环。
  //
  // 必须放在这个文件里：publish-bridge 在开头把五个构造器收进闭包后就从 globalThis
  // 删掉了（见上方 delete），document_idle 才加载的 content-iso 根本看不到它们。
  function buildFromCapture(capture, targetUrl, pageTitle) {
    if (!capture || !targetUrl) return null;
    const builder = receiptBuilderFor(targetUrl);
    if (typeof builder !== 'function') return null;
    let pageHostname = '';
    try { pageHostname = new URL(targetUrl).hostname; } catch (e) { return null; }
    let built = null;
    try {
      built = builder({
        pageHostname,
        observedAt: capture.ts || Date.now(),
        url: capture.url,
        method: capture.method,
        status: capture.status,
        ok: capture.ok,
        body: capture.body,
      });
    } catch (e) {
      bridgeLog('error', '回读补构回执时构造器抛异常：' + String(e && e.message || e), capture.url);
      return null;
    }
    if (!built) return null;
    const receipt = sanitize(Object.assign({}, built, {
      target_url: targetUrl,
      page_title: pageTitle,
    }));
    if (!receipt) {
      bridgeLog('error', '回读补构成功但被 sanitize 丢弃', built.event_id || '');
      return null;
    }
    bridgeLog('warn', '回执链断了，改用捕获回读补构成功', built.event_id || '');
    sendReceipt(receipt);
    return { eventId: receipt.event_id, platformCommentId: receipt.platform_comment_id };
  }

  const bridgeState = Object.freeze({
    signalReady,
    buildFromCapture,
    diag: function () {
      return {
        hasPort: !!currentPort,
        pendingNonce: !!pendingNonce,
        readyAttempts: readyAttempts,
        lastReceiptAt: (typeof window !== 'undefined' && window.marineLastPublishedReceipt &&
          window.marineLastPublishedReceipt.at) || null,
        forwards: forwardCount,
        recent: recentForwards.slice(),
        lastPost: lastPost,
        builderFor: (function () {
          try { return typeof receiptBuilderFor(location.href); } catch (e) { return 'err'; }
        })(),
      };
    },
  });
  try {
    Object.defineProperty(globalThis, BRIDGE_STATE_KEY, {
      value: bridgeState,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (e) {
    try { globalThis[BRIDGE_STATE_KEY] = bridgeState; } catch (assignError) {}
  }
  window.addEventListener(HANDSHAKE_REQUEST_EVENT, announcePendingNonce, false);
  signalReady();
})();
