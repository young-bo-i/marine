import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const helperSource = fs.readFileSync(new URL("../src/publish-receipt.js", import.meta.url), "utf8");
const bridgeSource = fs.readFileSync(new URL("../src/publish-bridge.js", import.meta.url), "utf8");
const contentMainSource = fs.readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8");
const contentIsoSource = fs.readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");
const swSource = fs.readFileSync(new URL("../src/sw.js", import.meta.url), "utf8");
const popupSource = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");

const replyResponse = {
  code: 0,
  data: {
    reply: {
      rpid: 98765,
      rpid_str: "98765",
      root: 12345,
      root_str: "12345",
      parent: 12346,
      parent_str: "12346",
      ctime: 1_721_234_567,
      member: { mid: "7788", uname: "Marine Tester" },
      content: { message: "这是最终上屏的评论。" },
    },
  },
};
const replyBody = JSON.stringify(replyResponse);

const helperSandbox = { URL };
vm.runInNewContext(helperSource, helperSandbox, { filename: "marine-extension/src/publish-receipt.js" });
const buildReceipt = helperSandbox.marineBuildBilibiliPublishedReceipt;
const buildRecoveredReceipts = helperSandbox.marineBuildBilibiliRecoveredReceipts;

function candidate(overrides = {}) {
  return {
    pageHostname: "www.bilibili.com",
    url: "https://api.bilibili.com/x/v2/reply/add?csrf=must-not-cross",
    method: "POST",
    status: 200,
    ok: true,
    body: replyBody,
    observedAt: 1_721_234_999_000,
    requestBody: "csrf=must-not-cross&message=must-not-cross",
    ...overrides,
  };
}

const receipt = JSON.parse(JSON.stringify(buildReceipt(candidate())));
assert.deepEqual(receipt, {
  schema_version: 1,
  event_id: "bilibili:98765",
  platform: "bilibili",
  kind: "reply",
  text_snapshot: "这是最终上屏的评论。",
  posted_at: 1_721_234_567,
  site_account_id: "7788",
  site_account_name: "Marine Tester",
  platform_comment_id: "98765",
  target_comment_id: "12346",
  parent_id: "12346",
  root_id: "12345",
});
assert.equal("body" in receipt, false);
assert.equal("requestBody" in receipt, false);
assert.equal(JSON.stringify(receipt).includes("csrf"), false);

const directResponse = structuredClone(replyResponse);
directResponse.data.reply.root = 0;
directResponse.data.reply.root_str = "0";
directResponse.data.reply.parent = 0;
directResponse.data.reply.parent_str = "0";
assert.equal(buildReceipt(candidate({ body: JSON.stringify(directResponse) })).kind, "direct");
assert.equal(buildReceipt(candidate({ pageHostname: "bilibili.com.evil.test" })), null);
assert.equal(buildReceipt(candidate({ url: "https://api.bilibili.com/x/v2/reply/additional" })), null);
assert.equal(buildReceipt(candidate({ url: "https://space.bilibili.com/x/v2/reply/add" })), null);
assert.equal(buildReceipt(candidate({ url: "https://evil.test/x/v2/reply/add" })), null);
assert.equal(buildReceipt(candidate({ method: "GET" })), null);
assert.equal(buildReceipt(candidate({ status: 500, ok: false })), null);
assert.equal(buildReceipt(candidate({ ok: false })), null);
assert.equal(buildReceipt(candidate({ body: "not-json" })), null);
assert.equal(buildReceipt(candidate({ body: JSON.stringify({ ...replyResponse, code: -400 }) })), null);
const missingReplyId = structuredClone(replyResponse);
missingReplyId.data.reply.rpid = 0;
missingReplyId.data.reply.rpid_str = "0";
assert.equal(buildReceipt(candidate({ body: JSON.stringify(missingReplyId) })), null);
const mismatchedReplyId = structuredClone(replyResponse);
mismatchedReplyId.data.reply.rpid_str = "98766";
assert.equal(buildReceipt(candidate({ body: JSON.stringify(mismatchedReplyId) })), null);
const mismatchedRootId = structuredClone(replyResponse);
mismatchedRootId.data.reply.root_str = "12344";
assert.equal(buildReceipt(candidate({ body: JSON.stringify(mismatchedRootId) })), null);
const mismatchedParentId = structuredClone(replyResponse);
mismatchedParentId.data.reply.parent_str = "12347";
assert.equal(buildReceipt(candidate({ body: JSON.stringify(mismatchedParentId) })), null);

const recoveryNowSeconds = Math.floor(Date.now() / 1000);
const recoveredOwnReply = structuredClone(replyResponse.data.reply);
recoveredOwnReply.oid = 445566;
recoveredOwnReply.oid_str = "445566";
recoveredOwnReply.ctime = recoveryNowSeconds - 60;
const recoveredOtherReply = structuredClone(recoveredOwnReply);
recoveredOtherReply.rpid = 98766;
recoveredOtherReply.rpid_str = "98766";
recoveredOtherReply.member = { mid: "9999", uname: "Other user" };
const recoveredOldReply = structuredClone(recoveredOwnReply);
recoveredOldReply.rpid = 98767;
recoveredOldReply.rpid_str = "98767";
recoveredOldReply.ctime = recoveryNowSeconds - (8 * 24 * 60 * 60);
const recoveredResponse = {
  code: 0,
  data: {
    replies: [recoveredOwnReply, recoveredOtherReply, recoveredOldReply],
  },
};
const recoveredBody = JSON.stringify(recoveredResponse);
function recoveredCandidate(overrides = {}) {
  return {
    pageHostname: "www.bilibili.com",
    url: "https://api.bilibili.com/x/v2/reply/wbi/main?oid=445566&type=1",
    method: "GET",
    status: 200,
    ok: true,
    body: recoveredBody,
    observedAt: recoveryNowSeconds * 1000,
    viewerId: "7788",
    expectedOid: "445566",
    ...overrides,
  };
}
const recoveredReceipts = JSON.parse(JSON.stringify(buildRecoveredReceipts(recoveredCandidate())));
assert.equal(recoveredReceipts.length, 1);
assert.deepEqual(recoveredReceipts[0], {
  schema_version: 1,
  event_id: "bilibili:98765",
  platform: "bilibili",
  kind: "reply",
  text_snapshot: "这是最终上屏的评论。",
  posted_at: recoveredOwnReply.ctime,
  site_account_id: "7788",
  site_account_name: "Marine Tester",
  platform_comment_id: "98765",
  target_comment_id: "12346",
  parent_id: "12346",
  root_id: "12345",
});
assert.deepEqual([...buildRecoveredReceipts(recoveredCandidate({ viewerId: "9999" }))].map(item => item.event_id), ["bilibili:98766"]);
assert.equal(buildRecoveredReceipts(recoveredCandidate({ expectedOid: "445567" })).length, 0);
assert.equal(buildRecoveredReceipts(recoveredCandidate({ method: "POST" })).length, 0);
assert.equal(buildRecoveredReceipts(recoveredCandidate({ url: "https://evil.test/x/v2/reply/wbi/main?oid=445566" })).length, 0);

function contentMainHarness(options = {}) {
  const messages = [];
  const runtimeCalls = [];
  const bridgeReadyCalls = [];
  const bridgeReadyOutcomes = [...(options.bridgeReadyOutcomes || [])];
  const dropBridgeMessages = [...(options.dropBridgeMessages || [])];
  const bridgeLogs = [];
  const bridgeFetchCalls = [];
  const listeners = new Map();
  const fetchResolvers = [];
  const nativeFetchMethods = [];
  const messageChannels = [];
  class FakeEventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
      const values = this.listeners.get(type) || [];
      values.push(listener);
      this.listeners.set(type, values);
    }
  }
  class FakeHeaders {
    get() { return "application/json"; }
  }
  class FakeRequest {
    constructor(input, init = {}) {
      const sourceUrl = input instanceof FakeRequest ? input._url : String(input || "");
      const sourceMethod = input instanceof FakeRequest ? input._method : "GET";
      this._url = new URL(sourceUrl, "https://www.bilibili.com/").href;
      this._method = String(init?.method || sourceMethod).toUpperCase();
    }
    get url() { return this._url; }
    get method() { return this._method; }
  }
  class FakeResponse {
    constructor(url, body = replyBody, status = 201) {
      this._url = url;
      this._body = body;
      this._status = status;
      this._headers = new FakeHeaders();
    }
    get url() { return this._url; }
    get status() { return this._status; }
    get ok() { return this._status >= 200 && this._status < 300; }
    get headers() { return this._headers; }
    clone() { return new FakeResponse(this._url, this._body, this._status); }
    async text() { return this._body; }
  }
  class FakeMessagePort {
    constructor() {
      this.other = null;
      this.onmessage = null;
      this.onmessageerror = null;
      this.closed = false;
      this.role = "";
    }
    postMessage(data) {
      if (this.closed || !this.other || this.other.closed) return;
      if (this.role === "bridge" && dropBridgeMessages[0] === data?.__marine) {
        dropBridgeMessages.shift();
        return;
      }
      const target = this.other;
      const cloned = structuredClone(data);
      queueMicrotask(() => {
        if (!target.closed && target.onmessage) target.onmessage({ data: cloned });
      });
    }
    start() {}
    close() { this.closed = true; }
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakeMessagePort();
      this.port2 = new FakeMessagePort();
      this.port1.other = this.port2;
      this.port2.other = this.port1;
      this.port1.role = "main";
      this.port2.role = "bridge";
      messageChannels.push(this);
    }
  }
  class FakeMessageEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.data = init.data;
      this.source = init.source;
      this.ports = init.ports || [];
    }
  }
  class FakeLocation {
    constructor(href) { this._href = href; }
    get href() { return this._href; }
    set href(value) { this._href = String(value); }
    get origin() { return new URL(this._href).origin; }
    get hostname() { return new URL(this._href).hostname; }
    get host() { return new URL(this._href).host; }
    get search() { return new URL(this._href).search; }
  }
  class FakeDocument {
    constructor(title) { this._title = title; }
    get title() { return this._title; }
    set title(value) { this._title = String(value); }
  }
  const location = new FakeLocation("https://www.bilibili.com/video/BV1");
  const document = new FakeDocument("请求时标题");
  const window = {
    location,
    fetch(input, init) {
      const method = init?.method || (input instanceof FakeRequest ? input._method : "GET");
      nativeFetchMethods.push(String(method).toUpperCase());
      const responseUrl = input instanceof FakeRequest ? input._url : String(input || "");
      return new Promise((resolve) => fetchResolvers.push((options = {}) => resolve(new FakeResponse(
        options.url || responseUrl,
        options.body || replyBody,
        options.status || 201,
      ))));
    },
    postMessage(message) {
      messages.push(JSON.parse(JSON.stringify(message)));
      this.dispatchEvent(new FakeMessageEvent("message", {
        data: message,
        source: this,
      }));
    },
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((value) => value !== listener));
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) listener.call(this, event);
      return true;
    },
  };
  class FakeXMLHttpRequest extends FakeEventTarget {
    constructor() {
      super();
      this._responseType = "";
      this._responseText = replyBody;
      this._response = replyBody;
      this._status = 201;
      this._responseURL = "";
      this._readyState = 1;
    }
    get responseType() { return this._responseType; }
    get responseText() { return this._responseText; }
    get response() { return this._response; }
    get status() { return this._status; }
    get responseURL() { return this._responseURL; }
    get readyState() { return this._readyState; }
    open(_method, url) {
      this._responseURL = new URL(String(url), location.href).href;
      this._readyState = 1;
    }
    send() {
      queueMicrotask(() => {
        this._readyState = 4;
        for (const listener of this.listeners.get("load") || []) listener.call(this);
      });
    }
    getResponseHeader() { return "application/json"; }
  }
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message && message.__marinePublishedBridgeReady) {
          bridgeReadyCalls.push(structuredClone(message));
          const outcome = bridgeReadyOutcomes.length ? bridgeReadyOutcomes.shift() : true;
          if (outcome === true) {
            const state = window.__marinePublishedMainStateV1;
            if (state && typeof state.ensurePort === "function") state.ensurePort(message.nonce);
            callback({ ok: true });
          } else {
            callback({ ok: false, error: "injected MAIN failure" });
          }
          return;
        }
        runtimeCalls.push(structuredClone(message));
        callback({ ok: true, queued: true, synced: false });
      },
    },
  };
  async function bridgeFetch(url) {
    const value = String(url);
    bridgeFetchCalls.push(value);
    if (value === "https://api.bilibili.com/x/web-interface/nav") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, data: { isLogin: true, mid: 7788, uname: "Marine Tester" } };
        },
      };
    }
    if (value.startsWith("https://api.bilibili.com/x/web-interface/view?bvid=")) {
      return {
        ok: true,
        status: 200,
        async json() { return { code: 0, data: { aid: 445566 } }; },
      };
    }
    throw new Error("unexpected bridge fetch: " + value);
  }
  const bridgeSandbox = {
    clearTimeout,
    crypto: webcrypto,
    URL,
    chrome,
    console: {
      info(value) { bridgeLogs.push(String(value)); },
      warn(value) { bridgeLogs.push(String(value)); },
    },
    fetch: bridgeFetch,
    location,
    MessageEvent: FakeMessageEvent,
    setTimeout,
    window,
  };
  const bridgeContext = vm.createContext(bridgeSandbox);
  function injectBridge() {
    vm.runInContext(helperSource + "\n" + bridgeSource, bridgeContext, {
      filename: "marine-extension/src/publish-bridge.js",
    });
  }
  if (options.bridgeFirst !== false) injectBridge();
  const sandbox = {
    clearTimeout,
    Date,
    EventTarget: FakeEventTarget,
    Headers: FakeHeaders,
    MessageChannel: FakeMessageChannel,
    MessageEvent: FakeMessageEvent,
    MessagePort: FakeMessagePort,
    Request: FakeRequest,
    Response: FakeResponse,
    URL,
    URLSearchParams,
    XMLHttpRequest: FakeXMLHttpRequest,
    document,
    globalThis: null,
    history: { pushState() {}, replaceState() {} },
    location,
    setTimeout,
    window,
  };
  sandbox.globalThis = sandbox;
  const mainContext = vm.createContext(sandbox);
  vm.runInContext(contentMainSource, mainContext, {
    filename: "marine-extension/src/content-main.js",
  });
  const initialReady = bridgeReadyCalls.at(-1);
  if (initialReady && window.__marinePublishedMainStateV1) {
    window.__marinePublishedMainStateV1.ensurePort(initialReady.nonce);
  }
  if (options.bridgeFirst === false) injectBridge();
  return {
    bridgeFetchCalls,
    bridgeLogs,
    bridgeReadyCalls,
    document,
    disconnectBridge() {
      const channel = messageChannels.at(-1);
      assert.ok(channel, "an active MessageChannel must exist");
      channel.port2.close();
    },
    FakeMessageChannel,
    FakeMessageEvent,
    FakeXMLHttpRequest,
    listeners,
    location,
    messages,
    nativeFetchMethods,
    poisonMainWorld() {
      FakeMessagePort.prototype.postMessage = function () {
        throw new Error("poisoned MessagePort.postMessage");
      };
      FakeResponse.prototype.clone = function () {
        return new FakeResponse("https://api.bilibili.com/x/v2/reply/add", replyBody, 201);
      };
      FakeResponse.prototype.text = async function () { return replyBody; };
      Object.defineProperties(FakeResponse.prototype, {
        url: { configurable: true, get: () => "https://api.bilibili.com/x/v2/reply/add" },
        status: { configurable: true, get: () => 201 },
        ok: { configurable: true, get: () => true },
        headers: { configurable: true, get: () => new FakeHeaders() },
      });
      FakeHeaders.prototype.get = () => "text/plain";
      Object.defineProperties(FakeRequest.prototype, {
        url: { configurable: true, get: () => "https://evil.test/x/v2/reply/add" },
        method: { configurable: true, get: () => "GET" },
      });
      FakeEventTarget.prototype.addEventListener = function () {
        throw new Error("poisoned addEventListener");
      };
      Object.defineProperties(FakeXMLHttpRequest.prototype, {
        responseURL: { configurable: true, get: () => "https://api.bilibili.com/x/v2/reply/add" },
        readyState: { configurable: true, get: () => 4 },
        responseType: { configurable: true, get: () => "" },
        responseText: { configurable: true, get: () => replyBody },
        status: { configurable: true, get: () => 201 },
      });
      FakeXMLHttpRequest.prototype.getResponseHeader = () => "text/plain";
      Object.defineProperties(FakeLocation.prototype, {
        href: {
          configurable: true,
          get: () => "https://www.bilibili.com/video/BV_FORGED",
          set(value) { this._href = String(value); },
        },
      });
      Object.defineProperties(FakeDocument.prototype, {
        title: {
          configurable: true,
          get: () => "伪造标题",
          set(value) { this._title = String(value); },
        },
      });
    },
    reinjectBridge: injectBridge,
    reinjectMain() {
      vm.runInContext(contentMainSource, mainContext, {
        filename: "marine-extension/src/content-main.js",
      });
    },
    resolveNextFetch(options) {
      const resolve = fetchResolvers.shift();
      assert.ok(resolve, "a pending fetch must exist");
      resolve(options);
    },
    runtimeCalls,
    window,
  };
}

const mainHarness = contentMainHarness();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  (mainHarness.listeners.get("marine-published-receipt-handshake-v1") || []).length,
  0,
  "the isolated bridge must synchronously consume one port and remove its handshake listener",
);
assert.equal(mainHarness.bridgeReadyCalls.length, 1);
assert.match(mainHarness.bridgeReadyCalls[0].nonce, /^[0-9a-f]{32}$/);
const fetchWrapperBeforeReinjection = mainHarness.window.fetch;
const xhrOpenBeforeReinjection = mainHarness.FakeXMLHttpRequest.prototype.open;
mainHarness.reinjectMain();
assert.equal(mainHarness.window.fetch, fetchWrapperBeforeReinjection, "MAIN reinjection must not wrap fetch twice");
assert.equal(
  mainHarness.FakeXMLHttpRequest.prototype.open,
  xhrOpenBeforeReinjection,
  "MAIN reinjection must not wrap XHR twice",
);
mainHarness.reinjectBridge();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(mainHarness.bridgeReadyCalls.length, 2, "bridge reinjection must request MAIN self-healing again");
assert.equal(
  (mainHarness.listeners.get("marine-published-receipt-handshake-v1") || []).length,
  0,
  "an accepted bridge must not reopen its page-visible handshake listener",
);
mainHarness.location.href = "https://www.bilibili.com/video/BV_REQUEST_FETCH";
mainHarness.document.title = "请求时标题 Fetch";
const fetchRequest = mainHarness.window.fetch("https://api.bilibili.com/x/v2/reply/add?csrf=private&token=private", {
  method: "POST",
  body: "csrf=private&message=private",
});
mainHarness.location.href = "https://www.bilibili.com/video/BV_RESPONSE_FETCH";
mainHarness.document.title = "响应时标题 Fetch";
mainHarness.resolveNextFetch();
await fetchRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
const xhr = new mainHarness.FakeXMLHttpRequest();
xhr.open("POST", "https://api.bilibili.com/x/v2/reply/add?csrf=private");
mainHarness.location.href = "https://www.bilibili.com/video/BV_REQUEST_XHR";
mainHarness.document.title = "请求时标题 XHR";
xhr.send("csrf=private&message=private");
mainHarness.location.href = "https://www.bilibili.com/video/BV_RESPONSE_XHR";
mainHarness.document.title = "响应时标题 XHR";
await new Promise((resolve) => setTimeout(resolve, 0));

const captures = mainHarness.messages.filter((item) => item.__marine === "net-capture" && item.kind === "comment");
assert.equal(captures.length, 2);
assert.equal(mainHarness.runtimeCalls.length, 2);
for (const capture of captures) {
  assert.equal(capture.method, "POST");
  assert.equal(capture.status, 201);
  assert.equal(capture.ok, true);
  assert.equal(capture.url, "https://api.bilibili.com/x/v2/reply/add");
  assert.equal("requestBody" in capture, false);
  assert.equal(JSON.stringify(capture).includes("private"), false);
}
for (const message of mainHarness.runtimeCalls) {
  assert.equal(message.receipt.event_id, "bilibili:98765");
  assert.equal("body" in message.receipt, false);
  assert.equal(JSON.stringify(message.receipt).includes("csrf"), false);
}
assert.equal(mainHarness.runtimeCalls[0].receipt.target_url, "https://www.bilibili.com/video/BV_REQUEST_FETCH");
assert.equal(mainHarness.runtimeCalls[0].receipt.page_title, "请求时标题 Fetch");
assert.equal(mainHarness.runtimeCalls[1].receipt.target_url, "https://www.bilibili.com/video/BV_REQUEST_XHR");
assert.equal(mainHarness.runtimeCalls[1].receipt.page_title, "请求时标题 XHR");
assert.ok(mainHarness.bridgeLogs.some((value) => value.includes("待同步队列")));

const genericRequest = mainHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply?type=1&csrf_token=secret&token=abc&SESSDATA=cookie-value",
  { method: "GET" },
);
mainHarness.resolveNextFetch();
await genericRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
const genericCapture = mainHarness.messages.filter((item) => item.__marine === "net-capture").at(-1);
assert.match(genericCapture.url, /type=1/);
assert.doesNotMatch(genericCapture.url, /secret|abc|cookie-value/);
assert.match(genericCapture.url, /%5Bredacted%5D/);
assert.equal(
  mainHarness.runtimeCalls.length,
  2,
  "a GET response without a platform-confirmed own comment must not become a published receipt",
);

mainHarness.location.href = "https://www.bilibili.com/video/BV1Recovery9";
mainHarness.document.title = "平台回查标题";
const recoveryRequest = mainHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/wbi/main?oid=445566&type=1",
  { method: "GET" },
);
mainHarness.resolveNextFetch({ body: recoveredBody, status: 200 });
await recoveryRequest;
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(
  mainHarness.runtimeCalls.length,
  3,
  "a recent comment confirmed by Bilibili must be reconciled: " +
    JSON.stringify({ bridgeFetchCalls: mainHarness.bridgeFetchCalls, bridgeLogs: mainHarness.bridgeLogs }),
);
assert.equal(mainHarness.runtimeCalls.at(-1).receipt.event_id, "bilibili:98765");
assert.equal(mainHarness.runtimeCalls.at(-1).receipt.target_url, "https://www.bilibili.com/video/BV1Recovery9");
assert.ok(mainHarness.bridgeFetchCalls.some((url) => url.endsWith("/x/web-interface/nav")));
assert.ok(mainHarness.bridgeFetchCalls.some((url) => url.includes("/x/web-interface/view?bvid=BV1Recovery9")));

const jsonXhr = new mainHarness.FakeXMLHttpRequest();
jsonXhr._responseType = "json";
jsonXhr._response = structuredClone(replyResponse);
jsonXhr._responseText = "";
jsonXhr.open("POST", "https://api.bilibili.com/x/v2/reply/add");
jsonXhr.send();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(mainHarness.runtimeCalls.length, 4, "XHR responseType=json must retain the platform receipt body");
assert.equal(mainHarness.runtimeCalls.at(-1).receipt.event_id, "bilibili:98765");

let methodGetterReads = 0;
const accessorInit = {};
Object.defineProperty(accessorInit, "method", {
  get() {
    methodGetterReads += 1;
    if (methodGetterReads === 1) return "POST";
    throw new Error("one-shot method getter");
  },
});
const callsBeforeAccessor = mainHarness.runtimeCalls.length;
const accessorRequest = mainHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add?csrf=accessor",
  accessorInit,
);
assert.equal(mainHarness.nativeFetchMethods.at(-1), "POST");
assert.equal(methodGetterReads, 2, "the extension may observe only after native fetch consumes RequestInit");
mainHarness.resolveNextFetch({ body: replyBody, status: 201 });
await accessorRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  mainHarness.runtimeCalls.length,
  callsBeforeAccessor,
  "an unstable method accessor must fail closed without changing the native request",
);

const callsBeforeForgery = mainHarness.runtimeCalls.length;
const forgedReceipt = {
  ...receipt,
  target_url: "https://www.bilibili.com/video/BV_FORGED",
  page_title: "伪造页面",
};
mainHarness.window.postMessage({ __marine: "published-comment", receipt: forgedReceipt }, "*");
const attackerChannel = new mainHarness.FakeMessageChannel();
mainHarness.window.dispatchEvent(new mainHarness.FakeMessageEvent(
  "marine-published-receipt-handshake-v1",
  {
    data: { __marine: "published-receipt-port-v1" },
    source: mainHarness.window,
    ports: [attackerChannel.port2],
  },
));
attackerChannel.port1.postMessage(forgedReceipt);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  mainHarness.runtimeCalls.length,
  callsBeforeForgery,
  "ordinary page messages and later ports must not reach the history API bridge",
);

mainHarness.poisonMainWorld();
const callsBeforePoisonedFailures = mainHarness.runtimeCalls.length;
mainHarness.location.href = "https://www.bilibili.com/video/BV_POISON_FAIL";
mainHarness.document.title = "原型污染失败请求";
const poisonedFailure = mainHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add?csrf=poisoned",
  { method: "POST" },
);
mainHarness.resolveNextFetch({
  body: JSON.stringify({ code: -400, message: "publish rejected", data: null }),
  status: 200,
});
await poisonedFailure;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  mainHarness.runtimeCalls.length,
  callsBeforePoisonedFailures,
  "poisoned Response/MessagePort prototypes must not turn a failed response into published",
);

const poisonedRedirect = mainHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add?csrf=redirected",
  { method: "POST" },
);
mainHarness.resolveNextFetch({
  url: "https://evil.test/x/v2/reply/add",
  body: replyBody,
  status: 200,
});
await poisonedRedirect;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  mainHarness.runtimeCalls.length,
  callsBeforePoisonedFailures,
  "the captured native response URL must win over a poisoned Response.url getter",
);

let mutableInputReads = 0;
const mutableInput = {
  toString() {
    mutableInputReads += 1;
    return mutableInputReads === 1
      ? "https://api.bilibili.com/x/v2/reply/add?csrf=single-read"
      : "https://evil.test/x/v2/reply/add";
  },
};
mainHarness.location.href = "https://www.bilibili.com/video/BV_POISON_SUCCESS";
mainHarness.document.title = "原型污染后真实成功";
const poisonedSuccess = mainHarness.window.fetch(mutableInput, { method: "POST" });
assert.equal(mutableInputReads, 1, "the request URL must be normalized exactly once");
mainHarness.resolveNextFetch({ body: replyBody, status: 201 });
await poisonedSuccess;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(mainHarness.runtimeCalls.length, callsBeforePoisonedFailures + 1);
assert.equal(
  mainHarness.runtimeCalls.at(-1).receipt.target_url,
  "https://www.bilibili.com/video/BV_POISON_SUCCESS",
  "captured Location/Document getters must preserve request-time context after prototype poisoning",
);
assert.equal(mainHarness.runtimeCalls.at(-1).receipt.page_title, "原型污染后真实成功");

mainHarness.location.href = "https://www.bilibili.com/video/BV_POISON_XHR";
mainHarness.document.title = "原型污染后 XHR 成功";
const poisonedXhr = new mainHarness.FakeXMLHttpRequest();
poisonedXhr.open("POST", "https://api.bilibili.com/x/v2/reply/add?csrf=poisoned-xhr");
poisonedXhr.send("csrf=poisoned-xhr");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(mainHarness.runtimeCalls.length, callsBeforePoisonedFailures + 2);
assert.equal(mainHarness.runtimeCalls.at(-1).receipt.target_url, "https://www.bilibili.com/video/BV_POISON_XHR");
assert.equal(mainHarness.runtimeCalls.at(-1).receipt.page_title, "原型污染后 XHR 成功");

const lateBridgeHarness = contentMainHarness({ bridgeFirst: false });
await new Promise((resolve) => setTimeout(resolve, 10));
lateBridgeHarness.location.href = "https://www.bilibili.com/video/BV_LATE_BRIDGE";
lateBridgeHarness.document.title = "后到桥接";
const lateBridgeRequest = lateBridgeHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add",
  { method: "POST" },
);
lateBridgeHarness.resolveNextFetch({ body: replyBody, status: 201 });
await lateBridgeRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(lateBridgeHarness.runtimeCalls.length, 1, "a MAIN-first injection must recover after the bridge arrives");
assert.equal(lateBridgeHarness.runtimeCalls[0].receipt.target_url, "https://www.bilibili.com/video/BV_LATE_BRIDGE");

const retryingBridgeHarness = contentMainHarness({
  bridgeFirst: false,
  bridgeReadyOutcomes: [false, true],
});
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(retryingBridgeHarness.bridgeReadyCalls.length, 2, "a rejected MAIN injection must be retried");
const retryingRequest = retryingBridgeHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add",
  { method: "POST" },
);
retryingBridgeHarness.resolveNextFetch({ body: replyBody, status: 201 });
await retryingRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(retryingBridgeHarness.runtimeCalls.length, 1);

const reconnectedHarness = contentMainHarness();
await new Promise((resolve) => setTimeout(resolve, 0));
reconnectedHarness.disconnectBridge();
reconnectedHarness.reinjectBridge();
await new Promise((resolve) => setTimeout(resolve, 250));
const reconnectedRequest = reconnectedHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add",
  { method: "POST" },
);
reconnectedHarness.resolveNextFetch({ body: replyBody, status: 201 });
await reconnectedRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(reconnectedHarness.runtimeCalls.length, 1, "a dead ACKed port must reconnect after bootstrap");

const lostAckHarness = contentMainHarness({
  dropBridgeMessages: ["published-receipt-ready-v1"],
});
await new Promise((resolve) => setTimeout(resolve, 80));
const lostAckRequest = lostAckHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add",
  { method: "POST" },
);
lostAckHarness.resolveNextFetch({ body: replyBody, status: 201 });
await lostAckRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(lostAckHarness.runtimeCalls.length, 1, "a silently dropped ACK must retry the handshake");

const lostPongHarness = contentMainHarness({
  dropBridgeMessages: ["published-receipt-pong-v1"],
});
await new Promise((resolve) => setTimeout(resolve, 0));
lostPongHarness.reinjectBridge();
await new Promise((resolve) => setTimeout(resolve, 250));
const lostPongRequest = lostPongHarness.window.fetch(
  "https://api.bilibili.com/x/v2/reply/add",
  { method: "POST" },
);
lostPongHarness.resolveNextFetch({ body: replyBody, status: 201 });
await lostPongRequest;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(lostPongHarness.runtimeCalls.length, 1, "a silently dropped PONG must rebuild the channel");

function eventSource() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
    first() {
      assert.equal(listeners.length, 1);
      return listeners[0];
    },
  };
}

function serviceWorkerHarness(options = {}) {
  const profileId = options.profileId || "";
  const apiBase = options.apiBase || "http://127.0.0.1:10108/v1/marine";
  const token = options.token || "test-token";
  const localState = options.localState || {};
  const historyOutcomes = [...(options.historyOutcomes || ["success"])];
  const runtimeMessages = eventSource();
  const historyCalls = [];
  const warnings = [];
  const infoLogs = [];
  const alarmCreated = [];
  const alarms = eventSource();
  const scriptingCalls = [];
  const existingTabs = options.existingTabs || [];
  const chrome = {
    runtime: {
      onInstalled: eventSource(),
      onStartup: eventSource(),
      onMessage: runtimeMessages,
      getURL(relative) { return `chrome-extension://test/${relative}`; },
    },
    sidePanel: { async setPanelBehavior() {} },
    scripting: {
      async executeScript(details) {
        scriptingCalls.push({
          target: structuredClone(details.target),
          world: details.world,
          ...(details.files ? { files: structuredClone(details.files) } : {}),
          ...(typeof details.func === "function" ? { hasFunc: true, args: structuredClone(details.args) } : {}),
        });
        if (options.scriptingError) throw new Error(options.scriptingError);
        return typeof details.func === "function" ? [{ result: true }] : [];
      },
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            return Object.hasOwn(localState, key) ? { [key]: structuredClone(localState[key]) } : {};
          }
          const result = {};
          for (const item of Array.isArray(key) ? key : []) {
            if (Object.hasOwn(localState, item)) result[item] = structuredClone(localState[item]);
          }
          return result;
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) localState[key] = structuredClone(value);
        },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete localState[item];
        },
      },
      session: { async get() { return {}; }, async set() {} },
      onChanged: eventSource(),
    },
    tabs: {
      onActivated: eventSource(),
      onUpdated: eventSource(),
      onRemoved: eventSource(),
      async query(queryInfo = {}) {
        return queryInfo.url ? structuredClone(existingTabs) : [];
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: eventSource(),
      async get() { return { focused: true }; },
    },
    alarms: {
      create(name, alarmOptions) { alarmCreated.push({ name, options: alarmOptions }); },
      onAlarm: alarms,
    },
  };
  async function fetchMock(url, options = {}) {
    const value = String(url);
    if (value.endsWith("marine-runtime-config.json")) {
      return {
        ok: true,
        async json() {
          return {
            apiBase,
            token,
            profileId,
          };
        },
      };
    }
    if (value === apiBase + "/history/published") {
      historyCalls.push({ url: value, options, body: JSON.parse(options.body) });
      const outcome = historyOutcomes.length ? historyOutcomes.shift() : "success";
      if (outcome === "network-error") throw new Error("injected network failure");
      if (typeof outcome === "number") {
        return { ok: false, status: outcome, async text() { return "injected HTTP failure"; } };
      }
      return { ok: true, status: 200, async text() { return ""; } };
    }
    throw new Error("unexpected fetch: " + value);
  }
  vm.runInNewContext(swSource, {
    AbortController,
    URL,
    chrome,
    clearTimeout,
    console: {
      info(value) { infoLogs.push(String(value)); },
      warn(value) { warnings.push(String(value)); },
    },
    fetch: fetchMock,
    importScripts() {},
    Map,
    Promise,
    setTimeout,
    TextEncoder,
  }, { filename: "marine-extension/src/sw.js" });
  const onMessage = runtimeMessages.first();
  function sendPublished(messageReceipt, sender = {}) {
    return new Promise((resolve) => {
      const asynchronous = onMessage(
        { __marinePublishedComment: true, receipt: messageReceipt },
        {
          frameId: 0,
          url: "https://www.bilibili.com/video/BV1",
          tab: { id: 7, url: "https://www.bilibili.com/video/BV1" },
          ...sender,
        },
        resolve,
      );
      assert.equal(asynchronous, true);
    });
  }
  function sendBridgeReady(sender = {}, nonce = "0123456789abcdef0123456789abcdef") {
    return new Promise((resolve) => {
      const asynchronous = onMessage(
        { __marinePublishedBridgeReady: true, nonce },
        {
          frameId: 0,
          url: "https://www.bilibili.com/video/BV1",
          tab: { id: 7, url: "https://www.bilibili.com/video/BV1" },
          ...sender,
        },
        resolve,
      );
      assert.equal(asynchronous, true);
    });
  }
  async function settle() {
    for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    alarmCreated,
    alarms,
    historyCalls,
    infoLogs,
    localState,
    scriptingCalls,
    sendBridgeReady,
    sendPublished,
    settle,
    warnings,
  };
}

const restoredTabHarness = serviceWorkerHarness({
  profileId: "restored-profile",
  existingTabs: [
    { id: 41, url: "https://www.bilibili.com/video/BV_RESTORED" },
    { id: 42, url: "https://evil.test/x/v2/reply/add" },
  ],
});
await restoredTabHarness.settle();
assert.deepEqual(JSON.parse(JSON.stringify(restoredTabHarness.scriptingCalls)), [{
  target: { tabId: 41, allFrames: true },
  world: "ISOLATED",
  files: ["src/publish-receipt.js", "src/publish-bridge.js"],
}]);
assert.deepEqual(JSON.parse(JSON.stringify(await restoredTabHarness.sendBridgeReady({
  documentId: "restored-document-41",
  frameId: 3,
  url: "https://player.bilibili.com/player.html",
  tab: { id: 41, url: "https://www.bilibili.com/video/BV_RESTORED" },
}))), { ok: true });
assert.deepEqual(JSON.parse(JSON.stringify(restoredTabHarness.scriptingCalls.at(-2))), {
  target: { tabId: 41, documentIds: ["restored-document-41"] },
  world: "MAIN",
  files: ["src/content-main.js"],
});
assert.deepEqual(JSON.parse(JSON.stringify(restoredTabHarness.scriptingCalls.at(-1))), {
  target: { tabId: 41, documentIds: ["restored-document-41"] },
  world: "MAIN",
  hasFunc: true,
  args: ["0123456789abcdef0123456789abcdef"],
});
const callsBeforeInvalidBridge = restoredTabHarness.scriptingCalls.length;
assert.deepEqual(JSON.parse(JSON.stringify(await restoredTabHarness.sendBridgeReady({
  url: "https://evil.test/",
  tab: { id: 41, url: "https://evil.test/" },
}))), { ok: false, error: "无效的 Bilibili 发布桥来源" });
assert.equal(restoredTabHarness.scriptingCalls.length, callsBeforeInvalidBridge);

const serializedInjectionHarness = serviceWorkerHarness({ profileId: "serialized-profile" });
await serializedInjectionHarness.settle();
serializedInjectionHarness.scriptingCalls.length = 0;
const serializedSender = {
  documentId: "same-document",
  frameId: 0,
  url: "https://www.bilibili.com/video/BV_SERIALIZED",
  tab: { id: 73, url: "https://www.bilibili.com/video/BV_SERIALIZED" },
};
const oldNonce = "11111111111111111111111111111111";
const latestNonce = "22222222222222222222222222222222";
const oldReady = serializedInjectionHarness.sendBridgeReady(serializedSender, oldNonce);
const latestReady = serializedInjectionHarness.sendBridgeReady(serializedSender, latestNonce);
await Promise.all([oldReady, latestReady]);
assert.deepEqual(
  serializedInjectionHarness.scriptingCalls.filter((call) => call.hasFunc).map((call) => call.args[0]),
  [latestNonce],
  "only the latest nonce for one document may reach MAIN when ready messages race",
);

const trustedProfileId = "2f7d1ea2-2b10-43db-94fa-88cf35f20e60";
const swHarness = serviceWorkerHarness({ profileId: trustedProfileId });
const isoReceipt = {
  ...receipt,
  target_url: "https://www.bilibili.com/video/BV1",
  page_title: "题".repeat(600),
  target_author: "被回复者",
  context_id: "marine:bilibili:context",
  profile_id: "page-controlled-profile",
  brand_id: "page-controlled-brand",
  csrf: "must-not-cross",
};
assert.deepEqual(JSON.parse(JSON.stringify(await swHarness.sendPublished(isoReceipt))), {
  ok: true,
  queued: false,
  synced: true,
});
assert.equal(swHarness.historyCalls.length, 1);
const historyCall = swHarness.historyCalls[0];
assert.equal(historyCall.url, "http://127.0.0.1:10108/v1/marine/history/published");
assert.equal(historyCall.options.method, "POST");
assert.equal(historyCall.options.headers.Authorization, "Bearer test-token");
assert.equal(historyCall.body.profile_id, trustedProfileId);
assert.equal(historyCall.body.brand_id, "scholay");
assert.equal(historyCall.body.text_snapshot, "这是最终上屏的评论。");
assert.equal(historyCall.body.target_comment_id, "12346");
assert.equal(historyCall.body.page_title, "题".repeat(512));
assert.equal("csrf" in historyCall.body, false);
assert.equal(JSON.stringify(historyCall.body).includes("page-controlled"), false);
assert.deepEqual(JSON.parse(JSON.stringify(await swHarness.sendPublished(isoReceipt))), {
  ok: true,
  queued: false,
  synced: true,
});
assert.equal(swHarness.historyCalls.length, 1, "duplicate receipt must not trigger a second POST");
assert.equal("marinePublishedReceiptOutboxV1" in swHarness.localState, false);
assert.ok(swHarness.alarmCreated.some((item) => item.name === "marinePublishedReceiptRetryV1"));

const missingProfileHarness = serviceWorkerHarness({ profileId: "" });
const missingProfileResult = await missingProfileHarness.sendPublished(isoReceipt);
assert.equal(missingProfileResult.ok, false);
assert.match(missingProfileResult.error, /未选择 Marine 发布身份/);
assert.equal(missingProfileHarness.historyCalls.length, 0);
assert.equal(missingProfileHarness.warnings.length, 1);

const invalidSenderHarness = serviceWorkerHarness({ profileId: trustedProfileId });
const invalidSenderResult = await invalidSenderHarness.sendPublished(isoReceipt, {
  url: "https://evil.test/",
  tab: { id: 8, url: "https://evil.test/" },
});
assert.equal(invalidSenderResult.ok, false);
assert.equal(invalidSenderHarness.historyCalls.length, 0);

const longUrlHarness = serviceWorkerHarness({ profileId: trustedProfileId });
const longUrlResult = await longUrlHarness.sendPublished({
  ...isoReceipt,
  target_url: "https://www.bilibili.com/video/BV1?value=" + "x".repeat(4096),
});
assert.equal(longUrlResult.ok, false);
assert.equal(longUrlHarness.historyCalls.length, 0);

const sharedOutboxState = {};
const failedSyncHarness = serviceWorkerHarness({
  profileId: trustedProfileId,
  localState: sharedOutboxState,
  historyOutcomes: ["network-error"],
  token: "first-token",
});
assert.deepEqual(JSON.parse(JSON.stringify(await failedSyncHarness.sendPublished(isoReceipt))), {
  ok: true,
  queued: true,
  synced: false,
});
assert.equal(failedSyncHarness.historyCalls.length, 1);
const persistedOutbox = sharedOutboxState.marinePublishedReceiptOutboxV1;
assert.equal(persistedOutbox.items.length, 1);
assert.equal(persistedOutbox.items[0].profile_id, trustedProfileId);
assert.equal(persistedOutbox.items[0].key, trustedProfileId + "|bilibili:98765");
assert.equal(persistedOutbox.items[0].receipt.text_snapshot, "这是最终上屏的评论。");
assert.doesNotMatch(JSON.stringify(persistedOutbox), /first-token|127\.0\.0\.1|csrf|page-controlled/);

const retryHarness = serviceWorkerHarness({
  profileId: trustedProfileId,
  localState: sharedOutboxState,
  apiBase: "http://127.0.0.1:20202/v1/marine",
  token: "retry-token",
  historyOutcomes: ["success"],
});
for (let i = 0; i < 50 && sharedOutboxState.marinePublishedReceiptOutboxV1; i++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(retryHarness.historyCalls.length, 1, "worker startup must retry the persisted receipt");
assert.equal(retryHarness.historyCalls[0].url, "http://127.0.0.1:20202/v1/marine/history/published");
assert.equal(retryHarness.historyCalls[0].options.headers.Authorization, "Bearer retry-token");
assert.equal("marinePublishedReceiptOutboxV1" in sharedOutboxState, false, "successful retry must clear the outbox");

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.ok(manifest.permissions.includes("alarms"));
assert.deepEqual(manifest.content_scripts[0].js, ["src/publish-receipt.js", "src/publish-bridge.js"]);
assert.equal(manifest.content_scripts[0].run_at, "document_start");
assert.equal(manifest.content_scripts[0].world, "ISOLATED");
assert.deepEqual(manifest.content_scripts[1].js, ["src/content-main.js"]);
assert.equal(manifest.content_scripts[1].run_at, "document_start");
assert.equal(manifest.content_scripts[1].world, "MAIN");
assert.doesNotMatch(contentIsoSource, /published-comment|__marinePublishedComment/);
assert.match(popupSource, /lastGrab\.platform === 'bilibili'/);
assert.match(popupSource, /window\.prompt\('请确认实际发布的文字/);
assert.doesNotMatch(popupSource, /post\.textContent = '标记已发'/);

console.log("Marine extension published receipt smoke: OK");
