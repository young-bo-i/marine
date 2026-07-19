// content-main.js — 运行在页面的 MAIN world（document_start）
// 作用：
//  1) 钩住 fetch / XMLHttpRequest，被动捕获字幕类请求的响应体（Netflix / 通用 .vtt 等）。
//  2) 应 ISOLATED 世界的请求，读取页面全局变量（YouTube 的 ytInitialPlayerResponse）。
// MAIN world 没有 chrome.* API：普通捕获走 window.postMessage，发布回执走一次性私有 MessagePort。
(function () {
  'use strict';
  const MAIN_STATE_KEY = '__marinePublishedMainStateV1';
  let existingMainState = null;
  try { existingMainState = window[MAIN_STATE_KEY]; } catch (e) {}
  if (existingMainState && typeof existingMainState.ensurePort === 'function') {
    return;
  }

  const nativeApply = Reflect.apply;
  const nativeConstruct = Reflect.construct;
  const nativeDefineProperty = Object.defineProperty;
  const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeGetPrototypeOf = Object.getPrototypeOf;
  const nativeArrayPush = Array.prototype.push;
  const nativeString = String;
  const nativeNumber = Number;
  const nativeDateNow = Date.now;
  const nativeJsonStringify = JSON.stringify;
  const nativeRegExpTest = RegExp.prototype.test;
  const nativeStringSlice = String.prototype.slice;
  const nativeStringSplit = String.prototype.split;
  const nativeStringToUpperCase = String.prototype.toUpperCase;
  const nativePromiseThen = Promise.prototype.then;
  const nativeWeakMapGet = WeakMap.prototype.get;
  const nativeWeakMapSet = WeakMap.prototype.set;
  const NativeURL = URL;
  const NativeRequest = Request;

  function findDescriptor(value, name) {
    for (let current = value; current; current = nativeGetPrototypeOf(current)) {
      const descriptor = nativeGetOwnPropertyDescriptor(current, name);
      if (descriptor) return descriptor;
    }
    return null;
  }

  function getter(value, name) {
    const descriptor = findDescriptor(value, name);
    return descriptor && descriptor.get;
  }

  function method(value, name) {
    const descriptor = findDescriptor(value, name);
    return descriptor && descriptor.value;
  }

  function call(fn, receiver, args) {
    return nativeApply(fn, receiver, args || []);
  }

  function string(value) { return nativeString(value); }
  function upper(value) { return call(nativeStringToUpperCase, string(value), []); }
  function slice(value, start, end) { return call(nativeStringSlice, string(value), [start, end]); }
  function test(regex, value) { return call(nativeRegExpTest, regex, [value]); }
  function then(promise, onFulfilled, onRejected) {
    return call(nativePromiseThen, promise, [onFulfilled, onRejected]);
  }
  function copyArguments(values) {
    const result = [];
    for (let index = 0; index < values.length; index++) result[index] = values[index];
    return result;
  }

  const locationOriginGet = getter(location, 'origin');
  const locationHrefGet = getter(location, 'href');
  const documentTitleGet = getter(document, 'title');
  const requestMethodGet = getter(NativeRequest.prototype, 'method');
  const responseUrlGet = getter(Response.prototype, 'url');
  const responseStatusGet = getter(Response.prototype, 'status');
  const responseOkGet = getter(Response.prototype, 'ok');
  const responseHeadersGet = getter(Response.prototype, 'headers');
  const responseClone = method(Response.prototype, 'clone');
  const responseText = method(Response.prototype, 'text');
  const headersGet = method(Headers.prototype, 'get');
  const xhrResponseUrlGet = getter(XMLHttpRequest.prototype, 'responseURL');
  const xhrReadyStateGet = getter(XMLHttpRequest.prototype, 'readyState');
  const xhrResponseTypeGet = getter(XMLHttpRequest.prototype, 'responseType');
  const xhrResponseTextGet = getter(XMLHttpRequest.prototype, 'responseText');
  const xhrResponseGet = getter(XMLHttpRequest.prototype, 'response');
  const xhrStatusGet = getter(XMLHttpRequest.prototype, 'status');
  const xhrGetResponseHeader = method(XMLHttpRequest.prototype, 'getResponseHeader');
  const eventTargetAddEventListener = method(EventTarget.prototype, 'addEventListener');
  const messagePortPostMessage = method(MessagePort.prototype, 'postMessage');
  const messagePortClose = method(MessagePort.prototype, 'close');
  const urlHostnameGet = getter(NativeURL.prototype, 'hostname');
  const urlPathnameGet = getter(NativeURL.prototype, 'pathname');
  const urlOriginGet = getter(NativeURL.prototype, 'origin');
  const urlHrefGet = getter(NativeURL.prototype, 'href');
  const urlHashSet = (findDescriptor(NativeURL.prototype, 'hash') || {}).set;
  const urlSearchParamsGet = getter(NativeURL.prototype, 'searchParams');
  const urlSearchParamsForEach = method(URLSearchParams.prototype, 'forEach');
  const urlSearchParamsSet = method(URLSearchParams.prototype, 'set');
  const nativeFetch = window.fetch;
  const xhrOpen = method(XMLHttpRequest.prototype, 'open');
  const xhrSend = method(XMLHttpRequest.prototype, 'send');
  const ORIGIN = locationOriginGet ? call(locationOriginGet, location) : location.origin;
  const PUBLISHED_RECEIPT_NONCE_EVENT = 'marine-published-receipt-nonce-v1';
  const PUBLISHED_RECEIPT_REQUEST_EVENT = 'marine-published-receipt-request-v1';
  const PUBLISHED_RECEIPT_ACK = 'published-receipt-ready-v1';
  const PUBLISHED_RECEIPT_CONNECTED = 'published-receipt-connected-v1';
  const PUBLISHED_RECEIPT_HEALTH_CONFIRMED = 'published-receipt-health-confirmed-v1';
  const PUBLISHED_RECEIPT_PING = 'published-receipt-ping-v1';
  const PUBLISHED_RECEIPT_PONG = 'published-receipt-pong-v1';
  const PUBLISHED_RECEIPT_RETRY_DELAYS = [50, 250, 1000];
  let publishedReceiptPort = null;
  let publishedReceiptReady = false;
  let publishedReceiptAttempts = 0;
  let publishedReceiptRetryTimer = null;
  let publishedReceiptHealthTimer = null;
  let publishedReceiptHandshakeNonce = '';
  let publishedReceiptHealthNonce = '';

  function validPublishedReceiptNonce(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  }

  function clearPublishedReceiptHealthCheck() {
    if (publishedReceiptHealthTimer != null) clearTimeout(publishedReceiptHealthTimer);
    publishedReceiptHealthTimer = null;
    publishedReceiptHealthNonce = '';
  }

  function closePublishedReceiptPort() {
    try {
      if (publishedReceiptPort && messagePortClose) call(messagePortClose, publishedReceiptPort);
    } catch (closeError) {}
    publishedReceiptPort = null;
    publishedReceiptReady = false;
    clearPublishedReceiptHealthCheck();
  }

  function schedulePublishedReceiptRetry() {
    if (publishedReceiptReady || publishedReceiptRetryTimer != null) return;
    const delay = PUBLISHED_RECEIPT_RETRY_DELAYS[publishedReceiptAttempts - 1];
    if (!delay) return;
    publishedReceiptRetryTimer = setTimeout(function () {
      publishedReceiptRetryTimer = null;
      if (!publishedReceiptReady) openPublishedReceiptPort(publishedReceiptHandshakeNonce);
    }, delay);
  }

  function openPublishedReceiptPort(nonce) {
    if (publishedReceiptReady || !validPublishedReceiptNonce(nonce)) return;
    closePublishedReceiptPort();
    publishedReceiptHandshakeNonce = nonce;
    publishedReceiptAttempts += 1;
    try {
      const channel = new MessageChannel();
      publishedReceiptPort = channel.port1;
      publishedReceiptPort.onmessage = function (event) {
        const data = event && event.data;
        if (!data) return;
        if (data.__marine === PUBLISHED_RECEIPT_ACK && data.nonce === publishedReceiptHandshakeNonce) {
          publishedReceiptReady = true;
          publishedReceiptAttempts = 0;
          if (publishedReceiptRetryTimer != null) {
            clearTimeout(publishedReceiptRetryTimer);
            publishedReceiptRetryTimer = null;
          }
          try {
            call(messagePortPostMessage, publishedReceiptPort, [{
              __marine: PUBLISHED_RECEIPT_CONNECTED,
              nonce: data.nonce,
            }]);
          } catch (e) {}
          return;
        }
        if (data.__marine === PUBLISHED_RECEIPT_PONG && data.nonce === publishedReceiptHealthNonce) {
          const confirmedNonce = data.nonce;
          clearPublishedReceiptHealthCheck();
          try {
            call(messagePortPostMessage, publishedReceiptPort, [{
              __marine: PUBLISHED_RECEIPT_HEALTH_CONFIRMED,
              nonce: confirmedNonce,
            }]);
          } catch (e) {}
        }
      };
      if (publishedReceiptPort.start) publishedReceiptPort.start();
      window.dispatchEvent(new MessageEvent('marine-published-receipt-handshake-v1', {
        data: { __marine: 'published-receipt-port-v1', nonce },
        source: window,
        ports: [channel.port2],
      }));
    } catch (e) {
      closePublishedReceiptPort();
    }
    schedulePublishedReceiptRetry();
  }

  function probePublishedReceiptPort(nonce) {
    clearPublishedReceiptHealthCheck();
    publishedReceiptHealthNonce = nonce;
    try {
      call(messagePortPostMessage, publishedReceiptPort, [{
        __marine: PUBLISHED_RECEIPT_PING,
        nonce,
      }]);
    } catch (e) {}
    publishedReceiptHealthTimer = setTimeout(function () {
      if (publishedReceiptHealthNonce !== nonce) return;
      closePublishedReceiptPort();
      publishedReceiptAttempts = 0;
      openPublishedReceiptPort(nonce);
    }, 200);
  }

  function ensurePublishedReceiptPort(nonce) {
    if (!validPublishedReceiptNonce(nonce)) return false;
    if (publishedReceiptReady && publishedReceiptPort) {
      probePublishedReceiptPort(nonce);
      return true;
    }
    if (publishedReceiptHandshakeNonce === nonce && publishedReceiptRetryTimer != null) return true;
    if (publishedReceiptHandshakeNonce !== nonce) {
      if (publishedReceiptRetryTimer != null) clearTimeout(publishedReceiptRetryTimer);
      publishedReceiptRetryTimer = null;
      publishedReceiptAttempts = 0;
      publishedReceiptHandshakeNonce = nonce;
    }
    if (publishedReceiptAttempts > PUBLISHED_RECEIPT_RETRY_DELAYS.length) {
      publishedReceiptAttempts = 0;
    }
    openPublishedReceiptPort(nonce);
    return true;
  }

  const publishedMainState = Object.freeze({ ensurePort: ensurePublishedReceiptPort });
  try {
    call(nativeDefineProperty, Object, [window, MAIN_STATE_KEY, {
      value: publishedMainState,
      configurable: false,
      enumerable: false,
      writable: false,
    }]);
  } catch (e) {
    try { window[MAIN_STATE_KEY] = publishedMainState; } catch (assignError) {}
  }

  function acceptInitialPublishedReceiptNonce(event) {
    if (event.source !== window || !event.data || event.data.__marine !== 'published-receipt-nonce-v1') return;
    window.removeEventListener(PUBLISHED_RECEIPT_NONCE_EVENT, acceptInitialPublishedReceiptNonce, false);
    ensurePublishedReceiptPort(event.data.nonce);
  }
  window.addEventListener(PUBLISHED_RECEIPT_NONCE_EVENT, acceptInitialPublishedReceiptNonce, false);
  window.dispatchEvent(new MessageEvent(PUBLISHED_RECEIPT_REQUEST_EVENT, {
    data: { __marine: 'published-receipt-request-v1' },
    source: window,
  }));

  // 仅匹配“明确是字幕”的 URL，避免捕获巨大的清单/视频流响应。
  const SUB_RE = /(\.vtt|\.srt|\.ass|\.dfxp|\.ttml)(\?|#|$)|timedtext|aisubtitle|webvtt|\/subtitle|subtitles?\?|\/captions?\b|caption\.|dfxp|ttml/i;

  // 评论类接口。被动捕获页面自己发出的、已签名的评论/回答请求响应。
  // B站：/x/v2/reply。知乎：回答列表(feeds/answers) + 评论(comment_v5 / root_comment / comments)。
  const COMMENT_RE = /\/x\/v2\/reply(?:\/wbi\/main|\/reply|\/add)?(\?|$)/i;
  const ZHIHU_RE = /\/api\/v4\/(comment_v5\/|questions\/\d+\/(feeds|answers)|answers\/\d+(\/|\?|$)|articles\/\d+(\/|\?|$)|[^?]*\/(root_comment|child_comment|comments))/i;
  // 小红书：评论 comment/page + comment/sub/page；笔记详情 feed。
  const XHS_RE = /\/api\/sns\/web\/v\d+\/(comment\/(sub\/)?page|feed)/i;

  function matchKind(url) {
    if (test(COMMENT_RE, url) || test(ZHIHU_RE, url) || test(XHS_RE, url)) return 'comment';
    if (test(SUB_RE, url)) return 'subtitle';
    return null;
  }

  function post(payload) {
    try { window.postMessage(Object.assign({ __marine: 'net-capture' }, payload), ORIGIN); }
    catch (e) { /* 结构化克隆失败等，忽略 */ }
  }

  function pageContextSnapshot() {
    let targetUrl = '';
    let pageTitle = '';
    try {
      if (locationHrefGet) targetUrl = string(call(locationHrefGet, location));
      if (documentTitleGet) pageTitle = string(call(documentTitleGet, document));
    } catch (e) {
      return { target_url: '', page_title: '' };
    }
    return {
      target_url: targetUrl.length <= 4096 ? targetUrl : '',
      page_title: slice(pageTitle, 0, 512),
    };
  }

  function capturedUrl(value) {
    try {
      const pageUrl = locationHrefGet ? string(call(locationHrefGet, location)) : '';
      const parsed = nativeConstruct(NativeURL, [string(value || ''), pageUrl]);
      const hostname = urlHostnameGet ? string(call(urlHostnameGet, parsed)) : '';
      const pathname = urlPathnameGet ? string(call(urlPathnameGet, parsed)) : '';
      const origin = urlOriginGet ? string(call(urlOriginGet, parsed)) : '';
      if (test(/(^|\.)bilibili\.com$/i, hostname) && pathname === '/x/v2/reply/add') {
        return origin + pathname;
      }
      const params = urlSearchParamsGet && call(urlSearchParamsGet, parsed);
      const keys = [];
      if (params && urlSearchParamsForEach) {
        call(urlSearchParamsForEach, params, [function (_value, key) {
          call(nativeArrayPush, keys, [string(key)]);
        }]);
      }
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (test(/(csrf|token|sessdata|authorization|access[_-]?key|cookie|session)/i, key)) {
          if (urlSearchParamsSet) call(urlSearchParamsSet, params, [key, '[redacted]']);
        }
      }
      if (urlHashSet) call(urlHashSet, parsed, ['']);
      return urlHrefGet ? string(call(urlHrefGet, parsed)) : '';
    } catch (e) {
      return call(nativeStringSplit, string(value || ''), ['#'])[0];
    }
  }

  function postPublishedCandidate(input, pageContext) {
    try {
      if (!publishedReceiptReady || !publishedReceiptPort || !messagePortPostMessage) return;
      call(messagePortPostMessage, publishedReceiptPort, [{
        observedAt: call(nativeDateNow, null),
        url: input.url,
        method: input.method,
        status: input.status,
        ok: input.ok,
        body: input.body,
        page_context: {
          target_url: pageContext.target_url,
          page_title: pageContext.page_title,
        },
      }]);
    } catch (e) {}
  }

  function observedFetchMethod(input, init, hasInit) {
    try {
      if (hasInit && init && init.method != null) return upper(init.method);
      if (requestMethodGet && input && typeof input === 'object') {
        return upper(call(requestMethodGet, input));
      }
    } catch (e) { return ''; }
    return 'GET';
  }

  // 把日志桥接到 ISOLATED 世界的调试面板
  function mlog(level, msg, data) {
    try { window.postMessage({ __marine: 'log', level: level, tag: 'main', msg: msg, data: data }, ORIGIN); }
    catch (e) {}
  }
  function shortUrl(u) {
    try { const x = new URL(u, location.href); return (x.pathname.split('/').pop() || x.hostname) + ' @' + x.hostname; }
    catch (e) { return String(u).slice(0, 70); }
  }

  // Bilibili uses history.pushState for in-page video changes.  Surface those
  // transitions to the isolated content script so a comment target from the
  // previous video can be invalidated immediately, without polling location.
  function postNavigation(kind) {
    try {
      window.postMessage({
        __marine: 'navigation',
        kind: kind,
        url: location.href,
      }, ORIGIN);
    } catch (e) {}
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    if (typeof original !== 'function') continue;
    try {
      history[name] = function () {
        const result = call(original, this, copyArguments(arguments));
        postNavigation(name);
        return result;
      };
    } catch (e) {}
  }
  window.addEventListener('popstate', function () { postNavigation('popstate'); });
  window.addEventListener('hashchange', function () { postNavigation('hashchange'); });

  // ---- fetch 钩子 ----
  if (typeof nativeFetch === 'function') {
    window.fetch = function () {
      const originalArgs = copyArguments(arguments);
      const pageContext = pageContextSnapshot();
      // Native fetch consumes RequestInit synchronously. Observe the method
      // only afterwards so an accessor/Proxy cannot change the real request.
      const p = call(nativeFetch, this, originalArgs);
      const observedMethod = observedFetchMethod(
        originalArgs[0],
        originalArgs[1],
        arguments.length > 1,
      );
      try {
        then(p, res => {
          try {
            if (!responseClone || !responseText || !responseStatusGet || !responseUrlGet) return;
            const responseUrl = string(call(responseUrlGet, res));
            const kind = responseUrl && matchKind(responseUrl);
            if (!kind) return;
            mlog('net', kind + ' fetch ⇢ ' + shortUrl(responseUrl));
            const status = nativeNumber(call(responseStatusGet, res)) || 0;
            const ok = responseOkGet
              ? call(responseOkGet, res) === true
              : status >= 200 && status < 300;
            let ct = '';
            if (responseHeadersGet && headersGet) {
              const headers = call(responseHeadersGet, res);
              ct = string(call(headersGet, headers, ['content-type']) || '');
            }
            const cloned = call(responseClone, res);
            const bodyPromise = call(responseText, cloned);
            then(bodyPromise, body => {
              if (!body) return;
              post({ url: capturedUrl(responseUrl), body, ct, kind, method: observedMethod, status, ok });
              if (kind === 'comment') postPublishedCandidate({
                url: responseUrl,
                body,
                method: observedMethod,
                status,
                ok,
              }, pageContext);
            }, () => {});
          } catch (e) {}
        }, () => {});
      } catch (e) {}
      return p;          // 永远返回原始响应，绝不影响页面
    };
  }

  // ---- XHR 钩子 ----
  const xhrRequests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    const args = copyArguments(arguments);
    try {
      const normalizedMethod = string(method || 'GET');
      const normalizedUrl = string(url || '');
      args[0] = normalizedMethod;
      args[1] = normalizedUrl;
      call(nativeWeakMapSet, xhrRequests, [this, {
        url: normalizedUrl,
        method: upper(normalizedMethod),
      }]);
    } catch (e) {}
    return call(xhrOpen, this, args);
  };
  XMLHttpRequest.prototype.send = function () {
    const args = copyArguments(arguments);
    try {
      const xhr = this;
      const request = call(nativeWeakMapGet, xhrRequests, [xhr]) || {};
      const url = request.url;
      const method = request.method || 'GET';
      const kind = url && matchKind(string(url));
      if (kind) {
        const pageContext = pageContextSnapshot();
        mlog('net', kind + ' xhr ⇢ ' + shortUrl(url));
        call(eventTargetAddEventListener, xhr, ['load', function () {
          try {
            if (xhrReadyStateGet && nativeNumber(call(xhrReadyStateGet, xhr)) !== 4) return;
            const rt = xhrResponseTypeGet ? string(call(xhrResponseTypeGet, xhr) || '') : '';
            let body = '';
            let publishableBody = '';
            if (rt === '' || rt === 'text') {
              body = xhrResponseTextGet ? string(call(xhrResponseTextGet, xhr) || '') : '';
              publishableBody = body;
            } else if (rt === 'json' && xhrResponseGet) {
              const responseValue = call(xhrResponseGet, xhr);
              body = responseValue == null ? '' : string(call(nativeJsonStringify, null, [responseValue]));
              publishableBody = body;
            }
            if (!body) return;
            const status = xhrStatusGet ? nativeNumber(call(xhrStatusGet, xhr)) || 0 : 0;
            const ok = status >= 200 && status < 300;
            const responseUrl = xhrResponseUrlGet ? string(call(xhrResponseUrlGet, xhr) || '') : '';
            let ct = '';
            try {
              if (xhrGetResponseHeader) ct = string(call(xhrGetResponseHeader, xhr, ['content-type']) || '');
            } catch (e) {}
            post({ url: capturedUrl(responseUrl || url), body, ct, kind, method, status, ok });
            if (kind === 'comment' && responseUrl && publishableBody) postPublishedCandidate({
              url: responseUrl,
              body: publishableBody,
              method,
              status,
              ok,
            }, pageContext);
          } catch (e) {}
        }, false]);
      }
    } catch (e) {}
    return call(xhrSend, this, args);
  };

  // ---- 应请求读取 YouTube 页面全局 ----
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__marine !== 'get-yt-tracks') return;
    mlog('info', '收到 YouTube 字幕轨请求');
    let tracks = null;
    try {
      const pr = window.ytInitialPlayerResponse;
      const want = new URLSearchParams(location.search).get('v');
      const vid = pr && pr.videoDetails && pr.videoDetails.videoId;
      // 仅当播放器响应与当前 URL 视频一致时才采用（SPA 切换后可能过期）
      if (pr && (!want || !vid || vid === want)) {
        const r = pr.captions
          && pr.captions.playerCaptionsTracklistRenderer
          && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (r && r.length) {
          // 只挑可序列化的字段，避免 postMessage 克隆问题
          tracks = r.map(t => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode,
            kind: t.kind || '',
            name: (t.name && (t.name.simpleText
              || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode
          }));
        }
      }
    } catch (err) { mlog('error', 'YouTube 读取失败', String(err && err.message || err)); }
    mlog(tracks ? 'ok' : 'warn', 'YouTube 字幕轨 → ' + (tracks ? tracks.length + ' 条' : '无/播放器数据过期'));
    window.postMessage({ __marine: 'yt-tracks-result', reqId: d.reqId, tracks }, ORIGIN);
  }, false);

  mlog('info', '已注入 fetch/XHR 钩子 @ ' + location.host);
})();
