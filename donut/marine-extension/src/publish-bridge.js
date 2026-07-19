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
  const buildRecoveredReceipts = globalThis.marineBuildBilibiliRecoveredReceipts;
  try { delete globalThis.marineBuildBilibiliPublishedReceipt; } catch (e) {}
  try { delete globalThis.marineBuildBilibiliRecoveredReceipts; } catch (e) {}
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

  function positiveId(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    }
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : '';
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
    if (!delay) return;
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
    if (!isBilibiliUrl(window.location && window.location.href)) return;
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
    if (!value || value.schema_version !== 1 || value.platform !== 'bilibili') return null;
    const platformCommentId = positiveId(value.platform_comment_id);
    const rootId = positiveId(value.root_id);
    const parentId = positiveId(value.parent_id);
    const targetCommentId = parentId || rootId;
    const targetUrl = boundedString(value.target_url, 4096);
    const text = boundedString(value.text_snapshot, 20_000);
    const postedAt = Number(value.posted_at);
    if (!platformCommentId || value.event_id !== 'bilibili:' + platformCommentId ||
        !targetUrl || !isBilibiliUrl(targetUrl) || !text.trim() ||
        !Number.isSafeInteger(postedAt) || postedAt <= 0) return null;
    return {
      schema_version: 1,
      event_id: value.event_id,
      platform: 'bilibili',
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

  function forward(value) {
    if (typeof buildPublishedReceipt !== 'function' || !value || !value.page_context) return;
    const targetUrl = boundedString(value.page_context.target_url, 4096);
    if (!targetUrl || !isBilibiliUrl(targetUrl)) return;
    let pageHostname = '';
    try { pageHostname = new URL(targetUrl).hostname; } catch (e) { return; }
    if (typeof value.body === 'string' && value.body.length > 2_000_000) return;
    let built;
    try {
      built = buildPublishedReceipt({
        pageHostname,
        observedAt: value.observedAt,
        url: value.url,
        method: value.method,
        status: value.status,
        ok: value.ok,
        body: value.body,
      });
    } catch (e) { return; }
    if (built) {
      const receipt = sanitize(Object.assign({}, built, {
        target_url: targetUrl,
        page_title: value.page_context.page_title,
      }));
      if (receipt) {
        sendReceipt(receipt);
        return;
      }
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

  const bridgeState = Object.freeze({ signalReady });
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
