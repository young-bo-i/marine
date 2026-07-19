import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionSource = path.resolve(here, "..");
const chromeCandidates = [
  process.env.MARINE_CHROME_BINARY,
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const artifactPath = "/private/tmp/marine-rime-target-e2e.png";

const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Marine Rime Fixture</title>
<style>
body{font:16px -apple-system,sans-serif;margin:40px;background:#f7f8fa;color:#18191c}
bili-comments{display:block;max-width:820px;margin:auto;background:white;padding:24px;border-radius:14px}
textarea{box-sizing:border-box;width:100%;min-height:88px;padding:14px;border:1px solid #c9ccd0;border-radius:8px;font:inherit}
bili-comment-thread-renderer{display:block;margin-top:24px;padding:18px;border:1px solid #e3e5e7;border-radius:10px}
bili-comment-renderer,bili-comment-reply-renderer{display:block}
bili-rich-text{display:block;margin:10px 0 14px}
.user-name{font-weight:650;color:#00aeec}.reply-content{margin:10px 0 14px}.reply{padding:7px 15px}
.detached-reply-box{margin:10px 0 22px;padding:10px;background:#f7f8fa;border-radius:8px}.reply-label{margin-bottom:6px}
#outside{display:block;margin:28px auto;padding:8px 18px}
</style></head><body>
<bili-comments>
  <h2>评论区</h2>
  <textarea id="direct" placeholder="发一条友善的评论">保留用户尚未发送的直评草稿</textarea>
  <bili-comment-thread-renderer id="comment-42">
    <bili-comment-renderer id="comment" data-id="999">
      <span class="user-name">Alice</span>
      <div class="opaque-body-copy">这个设计岗位真的这么难吗？</div>
      <button class="reply" type="button">回复</button>
      <bili-comment-reply-renderer>
        <span class="user-name">Eve</span>
        <div class="reply-content">嵌套楼层不能污染 Alice 的正文。</div>
      </bili-comment-reply-renderer>
    </bili-comment-renderer>
  </bili-comment-thread-renderer>
  <div id="reply-slot"></div>
  <bili-comment-thread-renderer id="comment-44">
    <bili-comment-renderer id="comment-bob-old">
      <span class="user-name">Bob</span>
      <div class="reply-content">更早的一条同作者评论，不能因为作者相同就串过来。</div>
    </bili-comment-renderer>
  </bili-comment-thread-renderer>
  <bili-comment-thread-renderer id="comment-43">
    <bili-comment-renderer id="comment-bob">
      <span class="user-name">Bob</span>
      <div class="reply-content">另一条评论不应该继承 Alice 的回复目标。</div>
    </bili-comment-renderer>
  </bili-comment-thread-renderer>
  <div id="bob-reply-box" class="detached-reply-box">
    <div class="reply-label">回复 @Bob :</div>
    <textarea id="bob-editor"></textarea>
    <button type="button">发布</button>
  </div>
  <div id="orphan-reply-box" class="detached-reply-box">
    <div class="reply-label">回复 @Nobody :</div>
    <textarea id="orphan-editor"></textarea>
    <button type="button">发布</button>
  </div>
  <bili-comment-thread-renderer id="comment-45">
    <bili-comment-renderer id="comment-closed-shadow">
      <span class="user-name">Carol</span>
      <bili-rich-text
        data-before="closed Shadow DOM 里的精确楼层正文"
        data-emoji="[笑哭]"
        data-after="尾句。"
      ></bili-rich-text>
      <button class="closed-reply" type="button">回复</button>
    </bili-comment-renderer>
  </bili-comment-thread-renderer>
  <div id="closed-reply-slot"></div>
</bili-comments>
<button id="outside" type="button">离开评论框</button>
<script>
window.fixtureInputCount=0;window.fixtureSubmitCount=0;
window.fixtureHandshakePortCount=0;
window.fixturePoisonPublishedIntrinsics=()=>{
  const forgedBody='{"code":0,"data":{"reply":{"rpid":90001,"rpid_str":"90001","root":42,"root_str":"42","parent":42,"parent_str":"42","ctime":1721234567,"member":{"uname":"Fixture Account","mid":"77"},"content":{"message":"真实发布回执测试"}}}}';
  const saved={
    portPost:MessagePort.prototype.postMessage,
    responseClone:Response.prototype.clone,
    responseText:Response.prototype.text,
    responseUrl:Object.getOwnPropertyDescriptor(Response.prototype,'url'),
    responseStatus:Object.getOwnPropertyDescriptor(Response.prototype,'status'),
    responseOk:Object.getOwnPropertyDescriptor(Response.prototype,'ok'),
    headersGet:Headers.prototype.get,
    promiseThen:Promise.prototype.then,
    promiseCatch:Promise.prototype.catch,
    jsonParse:JSON.parse,
    eventAdd:EventTarget.prototype.addEventListener,
    requestUrl:Object.getOwnPropertyDescriptor(Request.prototype,'url'),
    requestMethod:Object.getOwnPropertyDescriptor(Request.prototype,'method'),
    reflectApply:Reflect.apply,
    functionApply:Function.prototype.apply,
    dateNow:Date.now,
  };
  const forgedCandidate={
    observedAt:1721234999000,url:'https://api.bilibili.com/x/v2/reply/add',
    method:'POST',status:200,ok:true,body:forgedBody,
    page_context:{target_url:'https://www.bilibili.com/video/BV_FORGED',page_title:'伪造标题'}
  };
  MessagePort.prototype.postMessage=function(){return saved.portPost.call(this,forgedCandidate)};
  Response.prototype.clone=function(){return new Response(forgedBody,{status:200,headers:{'content-type':'application/json'}})};
  Response.prototype.text=function(){return Promise.resolve(forgedBody)};
  Object.defineProperty(Response.prototype,'url',{configurable:true,get:()=>forgedCandidate.url});
  Object.defineProperty(Response.prototype,'status',{configurable:true,get:()=>200});
  Object.defineProperty(Response.prototype,'ok',{configurable:true,get:()=>true});
  Headers.prototype.get=()=> 'application/json';
  Promise.prototype.then=function(onFulfilled,onRejected){
    return saved.promiseThen.call(this,onFulfilled,onRejected);
  };
  Promise.prototype.catch=function(){throw new Error('poisoned Promise.catch')};
  JSON.parse=()=>({code:0,data:{reply:{
    rpid:90001,rpid_str:'90001',root:42,root_str:'42',parent:42,parent_str:'42',
    ctime:1721234567,member:{uname:'Fixture Account',mid:'77'},
    content:{message:'真实发布回执测试'}
  }}});
  EventTarget.prototype.addEventListener=function(){throw new Error('poisoned addEventListener')};
  Object.defineProperty(Request.prototype,'url',{configurable:true,get:()=>forgedCandidate.url});
  Object.defineProperty(Request.prototype,'method',{configurable:true,get:()=> 'POST'});
  Reflect.apply=()=>{throw new Error('poisoned Reflect.apply')};
  Function.prototype.apply=function(){throw new Error('poisoned Function.apply')};
  Date.now=()=>1;
  window.fixtureRestorePublishedIntrinsics=()=>{
    MessagePort.prototype.postMessage=saved.portPost;
    Response.prototype.clone=saved.responseClone;
    Response.prototype.text=saved.responseText;
    Object.defineProperty(Response.prototype,'url',saved.responseUrl);
    Object.defineProperty(Response.prototype,'status',saved.responseStatus);
    Object.defineProperty(Response.prototype,'ok',saved.responseOk);
    Headers.prototype.get=saved.headersGet;
    Promise.prototype.then=saved.promiseThen;
    Promise.prototype.catch=saved.promiseCatch;
    JSON.parse=saved.jsonParse;
    EventTarget.prototype.addEventListener=saved.eventAdd;
    Object.defineProperty(Request.prototype,'url',saved.requestUrl);
    Object.defineProperty(Request.prototype,'method',saved.requestMethod);
    Reflect.apply=saved.reflectApply;
    Function.prototype.apply=saved.functionApply;
    Date.now=saved.dateNow;
  };
};
window.addEventListener('marine-published-receipt-handshake-v1',event=>{
  window.fixtureHandshakePortCount+=event.ports&&event.ports.length||0;
});
customElements.define('bili-rich-text',class extends HTMLElement{
  constructor(){
    super();
    const root=this.attachShadow({mode:'closed'});
    const before=document.createElement('span');
    before.textContent=this.dataset.before||'';
    const emoji=document.createElement('img');
    emoji.alt=this.dataset.emoji||'';
    const after=document.createElement('span');
    after.textContent=this.dataset.after||'';
    root.append(before,emoji,after);
  }
});
document.querySelector('#comment-bob').data={rpid_str:'43'};
document.querySelector('#comment-bob-old').data={rpid_str:'44'};
document.addEventListener('input',()=>window.fixtureInputCount++,true);
document.addEventListener('submit',e=>{window.fixtureSubmitCount++;e.preventDefault()},true);
document.querySelector('.reply').addEventListener('click',()=>{
  const slot=document.querySelector('#reply-slot');
  let editor=document.querySelector('#reply-editor');
  setTimeout(()=>{
    if(!editor){
      const label=document.createElement('div');label.className='reply-label';label.textContent='回复 @Alice :';
      editor=document.createElement('textarea');editor.id='reply-editor';
      const publish=document.createElement('button');publish.type='button';publish.textContent='发布';
      slot.className='detached-reply-box';slot.append(label,editor,publish);
    }
    editor.focus();
    window.fixtureReplyFocused=true;
    if(!window.fixtureCaptureStarted){
      window.fixtureCaptureStarted=true;
      setTimeout(()=>{
        fetch('https://api.bilibili.com/x/v2/reply/wbi/main?oid=fixture')
          .then(()=>{window.fixtureCaptureFetched=true})
          .catch(()=>{});
      },600);
    }
  },250);
});
document.querySelector('.closed-reply').addEventListener('click',()=>{
  const slot=document.querySelector('#closed-reply-slot');
  let editor=document.querySelector('#closed-reply-editor');
  setTimeout(()=>{
    if(!editor){
      const label=document.createElement('div');label.className='reply-label';label.textContent='回复 @Carol :';
      editor=document.createElement('textarea');editor.id='closed-reply-editor';
      const publish=document.createElement('button');publish.type='button';publish.textContent='发布';
      slot.className='detached-reply-box';slot.append(label,editor,publish);
    }
    editor.focus();
    window.fixtureClosedReplyFocused=true;
  },50);
});
</script></body></html>`;

const fixtureComments = JSON.stringify({
  code: 0,
  data: {
    cursor: { all_count: 4 },
    replies: [{
      rpid_str: "42",
      root: 0,
      parent: 0,
      member: { uname: "Alice", mid: "7" },
      content: { message: "这个设计岗位真的这么难吗？" },
      like: 0,
      rcount: 0,
    }, {
      rpid_str: "43",
      root: 0,
      parent: 0,
      member: { uname: "Bob", mid: "8" },
      content: { message: "另一条评论不应该继承 Alice 的回复目标。" },
      like: 0,
      rcount: 0,
    }, {
      rpid_str: "44",
      root: 0,
      parent: 0,
      member: { uname: "Bob", mid: "8" },
      content: { message: "更早的一条同作者评论，不能因为作者相同就串过来。" },
      like: 0,
      rcount: 0,
    }, {
      rpid_str: "45",
      root: 0,
      parent: 0,
      member: { uname: "Carol", mid: "9" },
      content: { message: "closed Shadow DOM 里的精确楼层正文[笑哭]尾句。" },
      like: 0,
      rcount: 0,
    }],
  },
});

const fixturePublishedReply = JSON.stringify({
  code: 0,
  data: {
    reply: {
      rpid: 90001,
      rpid_str: "90001",
      root: 42,
      root_str: "42",
      parent: 42,
      parent_str: "42",
      ctime: 1_721_234_567,
      member: { uname: "Fixture Account", mid: "77" },
      content: { message: "真实发布回执测试" },
    },
  },
});

const fixtureRejectedReply = JSON.stringify({
  code: -400,
  message: "fixture publish rejected",
  data: null,
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

class CDPClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        Promise.resolve(listener(message.params || {})).catch(() => {});
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
  return result.result?.value;
}

async function clickSelector(client, selector) {
  const point = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`click target not found: ${selector}`);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
}

async function pressTab(client, shift = false) {
  const key = {
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: shift ? 8 : 0,
  };
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

async function main() {
  let chromeBinary;
  for (const candidate of chromeCandidates) {
    try {
      await fs.access(candidate);
      chromeBinary = candidate;
      break;
    } catch {}
  }
  if (!chromeBinary) throw new Error("Chrome for Testing/Chromium was not found");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "marine-chrome-rime-"));
  const extensionDir = path.join(tempRoot, "extension");
  const userDataDir = path.join(tempRoot, "chrome-profile");
  const apiCalls = [];
  const token = crypto.randomBytes(32).toString("hex");

  const apiServer = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
      });
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch {}
    const url = new URL(request.url, "http://127.0.0.1");
    apiCalls.push({
      method: request.method,
      path: url.pathname,
      contextId: body?.contextId || url.searchParams.get("contextId") || "",
      body,
      authOk: request.headers.authorization === `Bearer ${token}`,
    });
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    response.end("{}");
  });
  const apiPort = await listen(apiServer);

  let chrome;
  let client;
  let debugPort;
  let chromeStderr = "";
  const runtimeIssues = [];
  try {
    await fs.cp(extensionSource, extensionDir, { recursive: true });
    await fs.writeFile(
      path.join(extensionDir, "marine-runtime-config.json"),
      JSON.stringify({
        apiBase: `http://127.0.0.1:${apiPort}/v1/marine`,
        token,
        profileId: "fixture-profile",
      }),
      { mode: 0o600 },
    );
    await fs.mkdir(userDataDir, { recursive: true });

    const chromeArgs = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1180,900",
      "about:blank",
    ];
    if (process.env.MARINE_CHROME_HEADLESS === "1") chromeArgs.unshift("--headless=new");
    chrome = spawn(chromeBinary, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr.on("data", (chunk) => {
      chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-8000);
    });

    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const portText = await waitFor(async () => {
      try { return await fs.readFile(portFile, "utf8"); } catch { return null; }
    }, "Chrome did not expose a DevTools port");
    debugPort = Number(portText.split(/\r?\n/)[0]);
    const targets = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await response.json();
      return list.find((target) => target.type === "page");
    }, "Chrome page target was not created");

    client = new CDPClient(targets.webSocketDebuggerUrl);
    await client.open();
    client.on("Runtime.exceptionThrown", (event) => {
      const details = event.exceptionDetails || {};
      runtimeIssues.push({
        text: details.text || "exception",
        description: details.exception?.description || "",
        url: details.url || "",
        line: details.lineNumber,
        column: details.columnNumber,
      });
    });
    client.on("Fetch.requestPaused", async (event) => {
      const isDocument = event.resourceType === "Document";
      const isPublishApi = event.request.url.includes("/x/v2/reply/add");
      const isRejectedPublish = isPublishApi && event.request.url.includes("fixture_fail=1");
      const isCommentApi = event.request.url.includes("/x/v2/reply/");
      const body = isDocument ? fixtureHtml : (isPublishApi
        ? (isRejectedPublish ? fixtureRejectedReply : fixturePublishedReply)
        : isCommentApi ? fixtureComments
        : JSON.stringify({ code: -404, message: "fixture", data: null }));
      await client.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{
          name: "Content-Type",
          value: isDocument ? "text/html; charset=utf-8" : "application/json",
        }, { name: "Access-Control-Allow-Origin", value: "*" }],
        body: Buffer.from(body).toString("base64"),
      });
    });
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Fetch.enable", {
      patterns: [
        { urlPattern: "https://www.bilibili.com/video/*", resourceType: "Document" },
        { urlPattern: "https://api.bilibili.com/*" },
      ],
    });
    await client.send("Page.navigate", {
      url: "https://www.bilibili.com/video/BVFIXTURE",
    });
    await waitFor(
      () => evaluate(client, "document.readyState === 'complete'"),
      "fixture document did not load",
    );
    await waitFor(
      () => evaluate(client, "document.documentElement.getAttribute('data-marine-rime-ready') === '1'"),
      "Marine Rime content script did not become ready",
    );
    assert.equal(await evaluate(client, "window.fixtureHandshakePortCount"), 0,
      "the page observed the private published-receipt MessagePort handshake");
    await evaluate(client, `(() => {
      const forged={
        schema_version:1,event_id:'bilibili:80001',platform:'bilibili',
        target_url:location.href,page_title:document.title,kind:'direct',
        text_snapshot:'forged-page-receipt',posted_at:1721234567,
        site_account_id:'77',site_account_name:'Fixture Account',
        platform_comment_id:'80001',target_comment_id:null,parent_id:null,root_id:null
      };
      window.postMessage({__marine:'published-comment',receipt:forged},'*');
      const channel=new MessageChannel();
      window.dispatchEvent(new MessageEvent('marine-published-receipt-handshake-v1',{
        data:{__marine:'published-receipt-port-v1'},source:window,ports:[channel.port2]
      }));
      channel.port1.postMessage(forged);
      return true;
    })()`);
    await delay(250);
    assert.equal(apiCalls.some((call) => call.path === "/v1/marine/history/published"), false,
      "ordinary page messages acquired or forged the published-receipt channel");

    await evaluate(client, "window.fixturePoisonPublishedIntrinsics(); true");
    await evaluate(client, `(async()=>{
      await fetch('https://api.bilibili.com/x/v2/reply/add?fixture_fail=1&csrf=private-token',{
        method:'POST',body:'csrf=private-token&message=必须失败'
      });
      return true;
    })()`);
    await delay(300);
    assert.equal(apiCalls.some((call) => call.path === "/v1/marine/history/published"), false,
      "MAIN-world prototype poisoning turned a rejected publish response into a ledger entry");

    await evaluate(client, `(async()=>{
      let reads=0;
      const mutableInput={toString(){reads++;return reads===1
        ?'https://api.bilibili.com/x/v2/reply/add?fixture_success=1&csrf=private-token'
        :'https://evil.test/x/v2/reply/add'}};
      const request=fetch(mutableInput,{
        method:'POST',body:'csrf=private-token&message=真实发布回执测试'
      });
      if(reads!==1) throw new Error('publish request URL was stringified more than once: '+reads);
      document.title='响应时错误标题';
      history.replaceState({},'', '/video/BVRESPONSE');
      await request;
      history.replaceState({},'', '/video/BVFIXTURE');
      document.title='Marine Rime Fixture';
      return true;
    })()`);
    const publishedCall = await waitFor(
      () => apiCalls.find((call) => call.path === "/v1/marine/history/published"),
      "the real Bilibili publish response did not cross the isolated MessagePort bridge",
    );
    assert.equal(publishedCall.authOk, true);
    assert.equal(publishedCall.body.profile_id, "fixture-profile");
    assert.equal(publishedCall.body.platform_comment_id, "90001");
    assert.equal(publishedCall.body.text_snapshot, "真实发布回执测试");
    assert.equal(publishedCall.body.target_url, "https://www.bilibili.com/video/BVFIXTURE");
    assert.equal(publishedCall.body.page_title, "Marine Rime Fixture");
    assert.equal(publishedCall.body.parent_id, "42");
    assert.equal(JSON.stringify(publishedCall.body).includes("private-token"), false);
    await evaluate(client, "window.fixtureRestorePublishedIntrinsics(); true");
    // Let extension content scripts and the injected panel settle first.  A
    // headless Chrome window can emit an initial blur while those targets are
    // being created; force a fresh focus transition afterwards.
    await delay(500);
    await clickSelector(client, "#outside");
    await clickSelector(client, "#direct");
    await waitFor(
      () => evaluate(client, "document.querySelectorAll('[data-marine-rime-target]').length === 3"),
      "Marine target overlay was not injected after editor focus",
    );
    const directPut = await waitFor(
      () => apiCalls.find((call) => call.method === "PUT" && call.body?.mode === "direct"),
      "direct target was not published",
      20000,
    );
    assert.equal(directPut.authOk, true);
    assert.equal(directPut.body.actionId, "marine.generate-direct");
    assert.equal(directPut.body.target, null);
    assert.equal(directPut.body.updatedAt > 1_000_000_000_000, true);
    assert.equal(directPut.contextId.includes("fixture-profile"), false);
    assert.deepEqual(Object.keys(directPut.body.payload), ["context", "article"]);
    assert.equal(directPut.body.payload.context.source, "article");
    assert.equal(directPut.body.payload.context.mode, "direct");
    assert.equal(directPut.body.payload.context.platform, "bilibili");
    assert.equal(directPut.body.payload.context.url, "https://www.bilibili.com/video/BVFIXTURE");
    assert.equal(directPut.body.payload.context.title, "Marine Rime Fixture");
    assert.deepEqual(await evaluate(client, `(() => {
      const editor=document.querySelector('[data-marine-rime-target="editor"]');
      const comment=document.querySelector('[data-marine-rime-target="comment"]');
      const badge=document.querySelector('[data-marine-rime-target="badge"]');
      return {editor:editor.style.display,comment:comment.style.display,badge:badge.style.display,text:badge.textContent};
    })()`), {
      editor: "block",
      comment: "none",
      badge: "block",
      text: "Marine · 直评",
    });

    await clickSelector(client, ".reply");
    await waitFor(
      () => apiCalls.some((call) => call.method === "DELETE" && call.contextId === directPut.contextId),
      "the old direct lease survived after an explicit reply click",
    );
    assert.equal(apiCalls.some((call) => call.method === "PUT" && call.body?.mode === "reply"), false,
      "reply context must not publish before the delayed editor claims its hand-off");
    await waitFor(
      () => evaluate(client, "window.fixtureReplyFocused === true"),
      "the delayed globally-mounted reply editor was not focused",
    );
    const replyPut = await waitFor(
      () => apiCalls.find((call) => call.method === "PUT" && call.body?.mode === "reply"),
      "reply target was not published",
    );
    assert.equal(replyPut.authOk, true);
    assert.equal(replyPut.body.actionId, "marine.generate-reply");
    assert.equal(replyPut.body.target.id, "42");
    assert.equal(replyPut.body.target.authorName, "Alice");
    assert.equal(replyPut.body.target.text, "这个设计岗位真的这么难吗？");
    assert.equal(replyPut.body.target.parentId, "");
    assert.equal(replyPut.body.target.rootId, "");
    assert.deepEqual(Object.keys(replyPut.body.target), ["id", "authorName", "text", "parentId", "rootId"]);
    assert.deepEqual(Object.keys(replyPut.body.payload), ["context", "comments"]);
    assert.equal(replyPut.body.payload.context.source, "comments");
    assert.equal(replyPut.body.payload.context.mode, "reply");
    assert.match(replyPut.body.payload.comments.agentMd, /\[id=42\] Alice：这个设计岗位真的这么难吗？/);
    assert.equal(replyPut.body.payload.article, undefined);
    assert.equal(replyPut.body.payload.subtitle, undefined);
    assert.doesNotMatch(replyPut.body.target.text, /嵌套楼层/);
    assert.doesNotMatch(replyPut.body.target.text, /Alice|回复|点赞/);

    const directDeleteIndex = apiCalls.findIndex((call) =>
      call.method === "DELETE" && call.contextId === directPut.contextId);
    const replyPutIndex = apiCalls.indexOf(replyPut);
    assert.equal(directDeleteIndex >= 0 && directDeleteIndex < replyPutIndex, true,
      "the direct lease must be revoked before the reply context is published");
    assert.deepEqual(await evaluate(client, `(() => {
      const editor=document.querySelector('[data-marine-rime-target="editor"]');
      const comment=document.querySelector('[data-marine-rime-target="comment"]');
      const badge=document.querySelector('[data-marine-rime-target="badge"]');
      return {editor:editor.style.display,comment:comment.style.display,badge:badge.style.display,text:badge.textContent};
    })()`), {
      editor: "block",
      comment: "block",
      badge: "block",
      text: "Marine · 回复 @Alice",
    });

    // The editor appears before the comment API response. The bounded pending
    // hand-off waits for the unique captured floor instead of publishing the
    // renderer's whole author/action/nested-thread text as target.text.
    await waitFor(
      () => evaluate(client, "window.fixtureCaptureFetched === true"),
      "fixture comment response was not captured after reply focus",
    );

    // The pending reply hand-off must be consumed once it binds Alice's
    // editor. Keyboard focus can then move back to the direct editor without
    // reusing Alice as a page-wide reply hint.
    const callsBeforeKeyboardDirect = apiCalls.length;
    await pressTab(client, true);
    await pressTab(client, true);
    await waitFor(
      () => evaluate(client, "document.activeElement && document.activeElement.id === 'direct'"),
      "keyboard focus did not reach the direct editor",
    );
    const keyboardDirectPut = await waitFor(
      () => apiCalls.slice(callsBeforeKeyboardDirect).find((call) => call.method === "PUT" && call.body?.mode === "direct"),
      "the consumed reply pending state was reused by the direct editor",
    );
    assert.equal(keyboardDirectPut.body.target, null);

    // Re-arm Alice, then Tab into Bob's already-rendered reply editor. The
    // editor-specific binding must not leak into a different renderer/thread.
    const callsBeforeAliceRearm = apiCalls.length;
    await clickSelector(client, ".reply");
    const aliceRearmedPut = await waitFor(
      () => apiCalls.slice(callsBeforeAliceRearm).find((call) =>
        call.method === "PUT" && call.body?.mode === "reply" && call.body?.target?.authorName === "Alice"),
      "Alice reply target was not re-armed",
    );
    const callsBeforeBobFocus = apiCalls.length;
    await pressTab(client);
    await pressTab(client);
    await waitFor(
      () => evaluate(client, "document.activeElement && document.activeElement.id === 'bob-editor'"),
      "keyboard focus did not reach Bob's reply editor",
    );
    const bobPut = await waitFor(
      () => apiCalls.slice(callsBeforeBobFocus).find((call) =>
        call.method === "PUT" && call.body?.mode === "reply" && call.body?.target?.id === "43"),
      "another reply editor reused Alice's pending target",
    );
    assert.equal(bobPut.body.target.authorName, "Bob");
    assert.match(bobPut.body.target.text, /另一条评论/);
    assert.doesNotMatch(bobPut.body.target.text, /更早的一条/);
    assert.notEqual(bobPut.contextId, aliceRearmedPut.contextId);

    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(artifactPath, Buffer.from(screenshot.data, "base64"));

    // A detached reply label with no exact rendered floor must fail closed;
    // it must never silently fall back to the direct action.
    const callsBeforeOrphan = apiCalls.length;
    await clickSelector(client, "#orphan-editor");
    await waitFor(
      () => apiCalls.slice(callsBeforeOrphan).some((call) =>
        call.method === "DELETE" && call.contextId === bobPut.contextId),
      "an unresolved detached reply editor did not revoke the previous reply lease",
    );
    await delay(250);
    assert.equal(apiCalls.slice(callsBeforeOrphan).some((call) => call.method === "PUT"), false,
      "an unresolved reply label must not be published as direct or arbitrary reply context");

    await clickSelector(client, "#outside");
    await waitFor(
      () => apiCalls.some((call) => call.method === "DELETE" && call.contextId === bobPut.contextId),
      "reply target was not cleared on blur",
    );
    await waitFor(async () => (await evaluate(client,
      "document.querySelector('[data-marine-rime-target=badge]').style.display")) === "none",
    "reply target badge remained visible after blur");

    // The live Bilibili renderer keeps its visible body under nested closed
    // Shadow DOM, leaving host innerText/textContent empty. The composed text
    // is only evidence: the published target must still be the exact captured
    // API record, never the renderer's author/action/thread aggregate.
    const callsBeforeClosedShadow = apiCalls.length;
    await clickSelector(client, ".closed-reply");
    await waitFor(
      () => evaluate(client, "window.fixtureClosedReplyFocused === true"),
      "the closed-shadow reply editor was not focused",
    );
    const closedShadowPut = await waitFor(
      () => apiCalls.slice(callsBeforeClosedShadow).find((call) =>
        call.method === "PUT" && call.body?.mode === "reply" && call.body?.target?.id === "45"),
      "closed-shadow floor did not bind to its captured API target",
    );
    assert.equal(closedShadowPut.body.target.authorName, "Carol");
    assert.equal(closedShadowPut.body.target.text, "closed Shadow DOM 里的精确楼层正文[笑哭]尾句。");
    assert.doesNotMatch(closedShadowPut.body.target.text, /Carol|回复|发布/);
    await clickSelector(client, "#outside");
    await waitFor(
      () => apiCalls.some((call) => call.method === "DELETE" && call.contextId === closedShadowPut.contextId),
      "closed-shadow reply target was not cleared",
    );

    const putsBeforeNavigation = apiCalls.length;
    await clickSelector(client, "#direct");
    const navigationPut = await waitFor(
      () => apiCalls.slice(putsBeforeNavigation).find((call) => call.method === "PUT"),
      "context before SPA navigation was not published",
    );
    await evaluate(client, "history.pushState({}, '', '/video/BVNEW'); true");
    await waitFor(
      () => apiCalls.some((call) => call.method === "DELETE" && call.contextId === navigationPut.contextId),
      "SPA navigation did not clear the active context",
    );
    await waitFor(async () => (await evaluate(client,
      "document.querySelector('[data-marine-rime-target=badge]').style.display")) === "none",
    "SPA navigation left a visible target badge");
    const callsBeforeNavigationRearm = apiCalls.length;
    await clickSelector(client, "#outside");
    await clickSelector(client, "#direct");
    const rearmedAfterNavigation = await waitFor(
      () => apiCalls.slice(callsBeforeNavigationRearm).find((call) =>
        call.method === "PUT" && call.body?.url?.endsWith("/video/BVNEW")),
      "a fresh user click did not re-arm the target after SPA navigation",
    );
    await clickSelector(client, "#outside");
    await waitFor(
      () => apiCalls.some((call) =>
        call.method === "DELETE" && call.contextId === rearmedAfterNavigation.contextId),
      "the re-armed SPA target was not cleared",
    );
    assert.deepEqual(await evaluate(client,
      "({inputs:window.fixtureInputCount,submits:window.fixtureSubmitCount,direct:document.querySelector('#direct').value})"),
    { inputs: 0, submits: 0, direct: "保留用户尚未发送的直评草稿" },
    "the extension must never alter a draft, type, or submit automatically");
    assert.equal(apiCalls.every((call) => call.authOk), true);

    console.log("Marine Chrome Rime target e2e: OK");
    console.log(`Visual artifact: ${artifactPath}`);
  } catch (error) {
    if (client) {
      try {
        console.error("Page diagnostic:", JSON.stringify(await evaluate(client,
          `(() => {
            const badge = document.querySelector('[data-marine-rime-target="badge"]');
            return {
              url: location.href,
              title: document.title,
              ready: document.readyState,
              overlays: document.querySelectorAll('[data-marine-rime-target]').length,
              badgeText: badge && badge.textContent,
              badgeDisplay: badge && badge.style.display,
              focused: document.activeElement && document.activeElement.id,
            };
          })()`)));
      } catch {}
    }
    if (debugPort) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const list = await response.json();
        console.error("CDP targets:", JSON.stringify(list.map(({ type, url }) => ({ type, url }))));
        const popup = list.find((target) =>
          target.type === "iframe" && String(target.url || "").includes("popup.html?tabId="));
        if (popup?.webSocketDebuggerUrl) {
          const popupClient = new CDPClient(popup.webSocketDebuggerUrl);
          try {
            await popupClient.open();
            await popupClient.send("Runtime.enable");
            const diagnostics = await evaluate(popupClient,
              "send('GET_RIME_DIAGNOSTICS').then((result) => result && result.events)");
            console.error("Rime diagnostics:", JSON.stringify((diagnostics || []).slice(-30)));
          } finally {
            popupClient.close();
          }
        }
      } catch {}
    }
    if (chromeStderr.trim()) console.error(chromeStderr.trim());
    console.error("API calls:", JSON.stringify(apiCalls.slice(-30)));
    if (runtimeIssues.length) console.error("Runtime issues:", JSON.stringify(runtimeIssues.slice(-20)));
    throw error;
  } finally {
    client?.close();
    if (chrome && chrome.exitCode == null) chrome.kill("SIGTERM");
    await new Promise((resolve) => apiServer.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
