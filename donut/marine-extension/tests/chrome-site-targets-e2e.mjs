import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extensionIdFromManifest,
  findExtensionTestBrowser,
} from "./extension-test-browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionSource = path.resolve(here, "..");

const xhsNoteId = "abcdef1234567890abcdef12";
const xhsCommentId = "0123456789abcdef01234567";
const zhihuUrl = "https://www.zhihu.com/search?type=content&q=fixture";
const xhsUrl = `https://www.xiaohongshu.com/explore/${xhsNoteId}`;

const zhihuInitialData = JSON.stringify({
  initialState: {
    entities: {
      answers: {
        101: {
          id: 101,
          type: "answer",
          author: { id: "answer-author-101", name: "知答作者" },
          question: { id: 1, title: "Fixture 问题标题" },
          content: "<p>这是回答 101 的精确正文。</p>",
          voteup_count: 12,
          comment_count: 1,
        },
        202: {
          id: 202,
          type: "answer",
          author: { id: "answer-author-202", name: "知答乙" },
          question: { id: 1, title: "Fixture 问题标题" },
          content: "<p>这是回答 202，不能串到 101 的评论框。</p>",
          voteup_count: 4,
          comment_count: 0,
        },
      },
      questions: {
        1: { id: 1, title: "Fixture 问题标题" },
      },
    },
  },
}).replaceAll("<", "\\u003c");

const sharedFixtureStyle = `
  *{box-sizing:border-box}body{font:16px -apple-system,sans-serif;margin:32px;color:#202124}
  button{font:inherit;padding:7px 13px}.fixture-card{max-width:780px;margin:auto;padding:24px;border:1px solid #ddd;border-radius:12px}
  [contenteditable="true"]{display:block;min-height:72px;padding:12px;border:1px solid #bbb;border-radius:8px;background:#fff}
  .fixture-comment{margin-top:20px;padding:16px;border:1px solid #ddd;border-radius:8px}.fixture-author{font-weight:650}
  .fixture-placeholder{margin:6px 0;color:#777}#fixture-outside{display:block;margin:24px auto}
`;

const zhihuFixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture 问题标题 - 知乎</title><style>${sharedFixtureStyle}</style></head>
<body>
  <section class="Card SearchResult-Card AnswerItem-hotLanding fixture-card"
    data-za-extra-module='{"card":{"content":{"type":"Answer","token":"101"}}}'>
    <article class="ContentItem AnswerItem" itemprop="answer" itemscope
      data-za-extra-module='{"card":{"content":{"type":"Question","id":"9001"}}}'>
      <a class="AuthorInfo-name" href="/people/answer-author-101">知答作者</a>
      <a href="/question/1/answer/101">Fixture 问题标题</a>
      <div class="RichContent"><p>这是回答 101 的精确正文。</p></div>
      <button id="open-comments" type="button">评论 1</button>
      <div id="zh-comments-101" class="Comments-container" hidden>
        <form>
          <div id="zh-placeholder" class="public-DraftEditorPlaceholder-root fixture-placeholder">写下你的评论</div>
          <div id="zh-editor" class="notranslate public-DraftEditor-content" role="textbox" contenteditable="true">知乎未发送草稿</div>
          <button data-submit type="submit">发布</button>
        </form>
        <div class="fixture-comment" data-id="zh-comment-42">
          <a class="fixture-avatar" href="/people/zh-commenter-42"><img alt=""></a>
          <a class="fixture-author" href="/people/zh-commenter-42">知乎评论者</a>
          <div class="CommentContent">知乎精确评论正文</div>
          <button id="zh-reply" type="button"><span style="display:inline-flex">&#8203;<svg></svg></span>回复</button>
        </div>
      </div>
    </article>
  </section>
  <section class="Card SearchResult-Card AnswerItem-hotLanding fixture-card"
    data-za-extra-module='{"card":{"content":{"type":"Answer","token":"202"}}}'>
    <article class="ContentItem AnswerItem" itemprop="answer" itemscope>
      <a class="AuthorInfo-name" href="/people/answer-author-202">知答乙</a>
      <a href="/question/1/answer/202">第二条回答</a>
      <div class="RichContent"><p>这是回答 202，不能串到 101 的评论框。</p></div>
      <button id="open-comments-202" type="button">0 条评论</button>
    </article>
  </section>
  <section id="zh-modal" class="Modal-wrapper" hidden>
    <div class="Modal-content fixture-card">
      <h2 class="Modal-title">评论</h2>
    </div>
  </section>
  <section class="Card SearchResult-Card AnswerItem-hotLanding fixture-card"
    data-za-extra-module='{"card":{"content":{"type":"Answer","token":"303"}}}'>
    <article class="ContentItem AnswerItem" itemprop="answer" itemscope
      data-za-extra-module='{"card":{"content":{"type":"Answer","token":"404"}}}'>
      <h2>冲突回答必须保持禁用</h2>
      <button id="open-comments-conflict" type="button">评论</button>
      <div id="zh-comments-conflict" class="Comments-container" hidden>
        <div id="zh-editor-conflict" role="textbox" contenteditable="true"></div>
      </div>
    </article>
  </section>
  <button id="fixture-outside" type="button">离开评论框</button>
  <script id="js-initialData" type="application/json">${zhihuInitialData}</script>
  <script>
    window.fixtureEvents={input:0,change:0,submit:0,submitClick:0};
    document.addEventListener('input',()=>window.fixtureEvents.input++,true);
    document.addEventListener('change',()=>window.fixtureEvents.change++,true);
    document.addEventListener('submit',event=>{window.fixtureEvents.submit++;event.preventDefault()},true);
    document.querySelector('[data-submit]').addEventListener('click',()=>window.fixtureEvents.submitClick++);
    document.querySelector('#open-comments').addEventListener('click',()=>{
      document.querySelector('#zh-comments-101').hidden=false;
      setTimeout(()=>document.querySelector('#zh-editor').focus(),0);
    });
    document.querySelector('#open-comments-202').addEventListener('click',()=>{
      const modal=document.querySelector('#zh-modal');
      modal.querySelector('.Modal-content').appendChild(document.querySelector('#zh-comments-101'));
      modal.hidden=false;
      setTimeout(()=>document.querySelector('#zh-editor').focus(),0);
    });
    document.querySelector('#open-comments-conflict').addEventListener('click',()=>{
      document.querySelector('#zh-comments-conflict').hidden=false;
      setTimeout(()=>document.querySelector('#zh-editor-conflict').focus(),0);
    });
    document.querySelector('#zh-reply').addEventListener('click',()=>{
      const floor=document.querySelector('[data-id="zh-comment-42"]');
      let editor=document.querySelector('#zh-reply-editor');
      if(!editor){
        const box=document.createElement('div');
        box.innerHTML='<div class="CommentEditorV2-placeholder">回复 @知乎评论者 :</div><div id="zh-reply-editor" class="RichTextEditor-content" role="textbox" contenteditable="true"><p>知乎恢复草稿不可进入 target</p></div>';
        floor.appendChild(box);
        editor=box.querySelector('#zh-reply-editor');
      }
      setTimeout(()=>editor.focus(),0);
    });
  </script>
</body></html>`;

const xhsFixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture 小红书笔记 - 小红书</title><style>${sharedFixtureStyle}</style></head>
<body>
  <main id="noteContainer" class="note-detail-mask note-container fixture-card"
    data-note-id="${xhsNoteId}" data-note-title="Fixture 小红书笔记" data-note-author="笔记作者">
    <div class="note-content">
      <h1 class="title">Fixture 小红书笔记</h1>
      <p>这是笔记的精确正文。</p>
    </div>
    <div class="note-scroller">
      <div class="comments-container">
        <div class="comment-item comment-item-sub fixture-comment" id="comment-${xhsCommentId}">
          <span class="name fixture-author">薯友 Alpha</span>
          <p class="note-text">小红书精确评论正文</p>
          <button id="xhs-reply" type="button">回复</button>
        </div>
      </div>
    </div>
    <div class="interaction-container">
      <div class="interactions engage-bar">
        <form class="engage-bar-container">
          <div class="engage-bar active">
            <div class="input-box">
              <div id="xhs-label" class="fixture-placeholder">说点什么</div>
              <div class="content-edit">
                <p id="content-textarea" class="content-input" contenteditable="true"
                  data-placeholder="说点什么">小红书未发送草稿</p>
              </div>
            </div>
          </div>
          <button id="xhs-cancel" type="button" hidden>取消</button>
          <button data-submit type="submit">发布</button>
        </form>
      </div>
    </div>
  </main>
  <button id="fixture-outside" type="button">离开评论框</button>
  <script>
    window.fixtureEvents={input:0,change:0,submit:0,submitClick:0};
    document.addEventListener('input',()=>window.fixtureEvents.input++,true);
    document.addEventListener('change',()=>window.fixtureEvents.change++,true);
    document.addEventListener('submit',event=>{window.fixtureEvents.submit++;event.preventDefault()},true);
    document.querySelector('[data-submit]').addEventListener('click',()=>window.fixtureEvents.submitClick++);
    document.querySelector('#xhs-reply').addEventListener('click',()=>{
      document.querySelector('#xhs-label').textContent='回复 薯友 Alpha';
      document.querySelector('#xhs-cancel').hidden=false;
      setTimeout(()=>document.querySelector('#content-textarea').focus(),0);
    });
    document.querySelector('#xhs-cancel').addEventListener('click',()=>{
      document.querySelector('#xhs-label').textContent='说点什么';
      document.querySelector('#xhs-cancel').hidden=true;
    });
  </script>
</body></html>`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 15000) {
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
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed",
    );
  }
  return result.result?.value;
}

async function clickSelector(client, selector) {
  const point = await evaluate(
    client,
    `(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)return null;
    element.scrollIntoView({block:'center',inline:'center'});
    const rect=element.getBoundingClientRect();
    return{x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`,
  );
  if (!point) throw new Error(`click target not found: ${selector}`);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function navigateFixture(client, url, expectedExtensionId) {
  await client.send("Page.navigate", { url });
  await waitFor(
    () => evaluate(client, "document.readyState === 'complete'"),
    `fixture document did not load: ${url}`,
  );
  await waitFor(
    () =>
      evaluate(
        client,
        "document.documentElement.getAttribute('data-marine-rime-ready') === '1'",
      ),
    `Marine target tracker did not become ready: ${url} (expected extension ${expectedExtensionId})`,
  );
}

async function badgeState(client) {
  return evaluate(
    client,
    `(() => {
    const badge=document.querySelector('[data-marine-rime-target="badge"]');
    return badge&&{text:badge.textContent,display:badge.style.display,color:getComputedStyle(badge).backgroundColor};
  })()`,
  );
}

async function visibleBadgeState(client, message) {
  return waitFor(async () => {
    const state = await badgeState(client);
    return state?.display === "block" ? state : null;
  }, message);
}

async function assertFixtureUntouched(client, editorSelector, expectedDraft) {
  assert.deepEqual(
    await evaluate(
      client,
      `(() => ({
    events:window.fixtureEvents,
    draft:document.querySelector(${JSON.stringify(editorSelector)}).textContent
  }))()`,
    ),
    {
      events: { input: 0, change: 0, submit: 0, submitClick: 0 },
      draft: expectedDraft,
    },
    "Marine may observe the editor, but must not type, dispatch edit events, or submit",
  );
}

async function main() {
  const { binary: chromeBinary, version: chromeVersion } =
    await findExtensionTestBrowser({ edgeEnvironment: true });
  console.log(`Marine E2E browser: ${chromeVersion} (${chromeBinary})`);

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "marine-site-targets-"),
  );
  const extensionDir = path.join(tempRoot, "extension");
  const userDataDir = path.join(tempRoot, "browser-profile");
  const token = crypto.randomBytes(32).toString("hex");
  const apiCalls = [];
  const runtimeIssues = [];
  let browser;
  let client;
  let browserStderr = "";
  let expectedExtensionId = "";
  const executionContexts = new Map();

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
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {}
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

  try {
    await fs.cp(extensionSource, extensionDir, { recursive: true });
    expectedExtensionId = await extensionIdFromManifest(extensionDir);
    await fs.writeFile(
      path.join(extensionDir, "marine-runtime-config.json"),
      JSON.stringify({
        apiBase: `http://127.0.0.1:${apiPort}/v1/marine`,
        token,
        profileId: "site-fixture-profile",
      }),
      { mode: 0o600 },
    );
    await fs.mkdir(userDataDir, { recursive: true });

    const browserArgs = [
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
    if (process.env.MARINE_CHROME_HEADLESS === "1")
      browserArgs.unshift("--headless=new");
    browser = spawn(chromeBinary, browserArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    browser.stderr.on("data", (chunk) => {
      browserStderr = (browserStderr + chunk.toString("utf8")).slice(-8000);
    });

    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const portText = await waitFor(async () => {
      try {
        return await fs.readFile(portFile, "utf8");
      } catch {
        return null;
      }
    }, "browser did not expose a DevTools port");
    const debugPort = Number(portText.split(/\r?\n/)[0]);
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === "page");
    }, "browser page target was not created");

    client = new CDPClient(target.webSocketDebuggerUrl);
    await client.open();
    client.on("Runtime.exceptionThrown", (event) => {
      const details = event.exceptionDetails || {};
      runtimeIssues.push(
        details.exception?.description || details.text || "runtime exception",
      );
    });
    client.on("Runtime.executionContextCreated", (event) => {
      const context = event.context;
      if (context?.id) executionContexts.set(context.id, context);
    });
    client.on("Runtime.executionContextDestroyed", (event) => {
      executionContexts.delete(event.executionContextId);
    });
    client.on("Runtime.executionContextsCleared", () => {
      executionContexts.clear();
    });
    client.on("Fetch.requestPaused", async (event) => {
      const url = event.request.url;
      const body = url.startsWith(zhihuUrl) ? zhihuFixtureHtml : xhsFixtureHtml;
      await client.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
        ],
        body: Buffer.from(body).toString("base64"),
      });
    });
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.bringToFront");
    await client.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "https://www.zhihu.com/search*",
          resourceType: "Document",
        },
        {
          urlPattern: `https://www.xiaohongshu.com/explore/${xhsNoteId}*`,
          resourceType: "Document",
        },
      ],
    });

    await navigateFixture(client, zhihuUrl, expectedExtensionId);
    await delay(500);
    let checkpoint = apiCalls.length;
    await clickSelector(client, "#open-comments");
    let zhihuDirect = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "direct" &&
              call.body?.platform === "zhihu",
          ),
      "知乎 direct target was not published",
    );
    assert.equal(zhihuDirect.authOk, true);
    assert.equal(zhihuDirect.body.actionId, "marine.generate-direct");
    assert.equal(zhihuDirect.body.target, null);
    assert.equal(
      zhihuDirect.body.targetSummary,
      "直评回答 @知答作者 · Fixture 问题标题",
    );
    assert.equal(zhihuDirect.body.payload.context.platform, "zhihu");
    assert.equal(zhihuDirect.body.payload.context.source, "article");
    assert.match(
      zhihuDirect.body.payload.article.markdown,
      /回答 101 的精确正文/,
    );
    assert.deepEqual(
      await visibleBadgeState(client, "知乎 direct badge was not visible"),
      {
        text: "Marine · 知乎直评",
        display: "block",
        color: "rgb(23, 114, 246)",
      },
    );
    checkpoint = apiCalls.length;
    await evaluate(client, "window.dispatchEvent(new Event('blur')); true");
    await delay(250);
    assert.equal(
      apiCalls.slice(checkpoint).some((call) =>
        call.method === "DELETE" && call.contextId === zhihuDirect.body.contextId),
      false,
      "知乎 direct target must survive an application-level window blur",
    );
    const zhihuDirectBeforeForegroundReturn = zhihuDirect;
    const callsBeforeZhihuDirectForegroundReturn = apiCalls.length;
    await evaluate(client, "window.dispatchEvent(new Event('focus')); true");
    zhihuDirect = await waitFor(
      () => apiCalls.slice(callsBeforeZhihuDirectForegroundReturn).find((call) =>
        call.method === "PUT" && call.body?.mode === "direct" &&
        call.body?.platform === "zhihu" &&
        call.body?.contextId !== zhihuDirectBeforeForegroundReturn.body.contextId),
      "知乎 direct target 前台恢复后没有建立新 activation",
    );
    assert.equal(
      apiCalls.slice(callsBeforeZhihuDirectForegroundReturn).some((call) =>
        call.method === "DELETE" &&
        call.contextId === zhihuDirectBeforeForegroundReturn.body.contextId),
      true,
      "知乎 direct 前台恢复必须先撤销旧 activation",
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#zh-reply");
    let zhihuReply = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "reply" &&
              call.body?.platform === "zhihu",
          ),
      "知乎 classless data-id comment reply target was not published",
    );
    assert.equal(zhihuReply.body.actionId, "marine.generate-reply");
    assert.deepEqual(zhihuReply.body.target, {
      id: "zh-comment-42",
      authorName: "知乎评论者",
      text: "知乎精确评论正文",
      parentId: "",
      rootId: "",
    });
    assert.equal(zhihuReply.body.payload.context.source, "article");
    assert.match(zhihuReply.body.payload.article.markdown, /回答 101 的精确正文/);
    assert.doesNotMatch(zhihuReply.body.payload.article.markdown, /回答 202/);
    assert.deepEqual(
      await visibleBadgeState(client, "知乎 reply badge was not visible"),
      {
        text: "Marine · 知乎回复 @知乎评论者",
        display: "block",
        color: "rgb(23, 114, 246)",
      },
    );
    await assertFixtureUntouched(client, "#zh-editor", "知乎未发送草稿");
    await assertFixtureUntouched(
      client,
      "#zh-reply-editor",
      "知乎恢复草稿不可进入 target",
    );
    checkpoint = apiCalls.length;
    await evaluate(client, "window.dispatchEvent(new Event('blur')); true");
    await delay(250);
    assert.equal(
      apiCalls.slice(checkpoint).some((call) =>
        call.method === "DELETE" && call.contextId === zhihuReply.body.contextId),
      false,
      "知乎 exact reply target must survive an application-level window blur",
    );
    const zhihuReplyBeforeForegroundReturn = zhihuReply;
    const callsBeforeZhihuReplyForegroundReturn = apiCalls.length;
    await evaluate(client, "window.dispatchEvent(new Event('focus')); true");
    zhihuReply = await waitFor(
      () => apiCalls.slice(callsBeforeZhihuReplyForegroundReturn).find((call) =>
        call.method === "PUT" && call.body?.mode === "reply" &&
        call.body?.platform === "zhihu" &&
        call.body?.contextId !== zhihuReplyBeforeForegroundReturn.body.contextId),
      "知乎 reply target 前台恢复后没有建立新 activation",
    );
    assert.equal(
      apiCalls.slice(callsBeforeZhihuReplyForegroundReturn).some((call) =>
        call.method === "DELETE" &&
        call.contextId === zhihuReplyBeforeForegroundReturn.body.contextId),
      true,
      "知乎 reply 前台恢复必须先撤销旧 activation",
    );
    await clickSelector(client, "#fixture-outside");
    await waitFor(
      () => evaluate(client, `(() => {
        const badge=document.querySelector('[data-marine-rime-target="badge"]');
        return document.activeElement?.id==='fixture-outside' && badge?.style.display==='none';
      })()`),
      "知乎 reply target did not fully clear before switching answers",
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#open-comments-202");
    const zhihuSecondDirect = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "direct" &&
              call.body?.platform === "zhihu",
          ),
      "知乎 reused portal did not switch to the second answer scope",
    );
    assert.equal(
      zhihuSecondDirect.body.targetSummary,
      "直评回答 @知答乙 · 第二条回答",
    );
    assert.match(
      zhihuSecondDirect.body.payload.article.markdown,
      /回答 202，不能串到 101/,
    );
    assert.doesNotMatch(
      zhihuSecondDirect.body.payload.article.markdown,
      /回答 101 的精确正文/,
    );
    await clickSelector(client, "#fixture-outside");
    await waitFor(
      () => evaluate(client, `(() => {
        const badge=document.querySelector('[data-marine-rime-target="badge"]');
        return document.activeElement?.id==='fixture-outside' && badge?.style.display==='none';
      })()`),
      "知乎 second direct target did not clear before the conflict check",
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#open-comments-conflict");
    await delay(700);
    assert.equal(
      apiCalls.slice(checkpoint).some((call) =>
        call.method === "PUT" && call.body?.platform === "zhihu"),
      false,
      "知乎 conflicting analytics answer ids must fail closed",
    );
    assert.equal(
      await evaluate(client, `(() => {
        const badge=document.querySelector('[data-marine-rime-target="badge"]');
        return badge?.style.display || 'none';
      })()`),
      "none",
      "知乎 ambiguous answer must not expose an active target badge",
    );
    await clickSelector(client, "#fixture-outside");

    await navigateFixture(client, xhsUrl, expectedExtensionId);
    await delay(500);
    await clickSelector(client, "#fixture-outside");
    checkpoint = apiCalls.length;
    await clickSelector(client, "#content-textarea");
    const xhsDirect = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "direct" &&
              call.body?.platform === "xiaohongshu",
          ),
      "小红书 direct target was not published",
    );
    assert.equal(xhsDirect.authOk, true);
    assert.equal(xhsDirect.body.actionId, "marine.generate-direct");
    assert.equal(xhsDirect.body.target, null);
    assert.equal(xhsDirect.body.targetSummary, "直评笔记 · Fixture 小红书笔记");
    assert.equal(xhsDirect.body.payload.context.platform, "xiaohongshu");
    assert.deepEqual(
      await visibleBadgeState(client, "小红书 direct badge was not visible"),
      {
        text: "Marine · 小红书直评",
        display: "block",
        color: "rgb(255, 36, 66)",
      },
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#xhs-reply");
    const xhsReply = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "reply" &&
              call.body?.platform === "xiaohongshu",
          ),
      "小红书 reply target was not published after the editor switched labels",
    );
    assert.equal(xhsReply.body.actionId, "marine.generate-reply");
    assert.deepEqual(xhsReply.body.target, {
      id: xhsCommentId,
      authorName: "薯友 Alpha",
      text: "小红书精确评论正文",
      parentId: "",
      rootId: "",
    });
    assert.deepEqual(
      await visibleBadgeState(client, "小红书 reply badge was not visible"),
      {
      text: "Marine · 小红书回复 @薯友 Alpha",
        display: "block",
        color: "rgb(255, 36, 66)",
      },
    );
    await assertFixtureUntouched(
      client,
      "#content-textarea",
      "小红书未发送草稿",
    );

    // Real XHS keeps comments inside `.note-scroller` while the shared editor
    // is a sibling bottom bar. A harmless comment mutation must not make the
    // lifecycle observer compare those two nearest roots and revoke the lease.
    checkpoint = apiCalls.length;
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(`#comment-${xhsCommentId}`)}).classList.add('fixture-live-update')`,
    );
    await delay(200);
    assert.equal(
      apiCalls.slice(checkpoint).some(
        (call) =>
          call.method === "DELETE" && call.contextId === xhsReply.body.contextId,
      ),
      false,
      "小红书评论滚动区更新时不得误判共享回复目标已关闭",
    );
    assert.deepEqual(
      await visibleBadgeState(client, "小红书滚动区更新后 reply badge 不应消失"),
      {
        text: "Marine · 小红书回复 @薯友 Alpha",
        display: "block",
        color: "rgb(255, 36, 66)",
      },
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#fixture-outside");
    await evaluate(client, "window.dispatchEvent(new Event('blur'))");
    await delay(300);
    assert.equal(
      apiCalls.slice(checkpoint).some(
        (call) =>
          call.method === "DELETE" && call.contextId === xhsReply.body.contextId,
      ),
      false,
      "小红书共享回复框失焦时仍显示选中目标，不得撤销 context",
    );
    assert.deepEqual(
      await visibleBadgeState(client, "小红书失焦后 reply badge 不应消失"),
      {
        text: "Marine · 小红书回复 @薯友 Alpha",
        display: "block",
        color: "rgb(255, 36, 66)",
      },
    );
    await assertFixtureUntouched(
      client,
      "#content-textarea",
      "小红书未发送草稿",
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#xhs-cancel");
    await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "DELETE" &&
              call.contextId === xhsReply.body.contextId,
          ),
      "小红书显式取消回复后没有撤销 context",
    );
    await waitFor(
      () =>
        evaluate(client, `(() => {
          const badge=document.querySelector('[data-marine-rime-target="badge"]');
          return badge?.style.display==='none';
        })()`),
      "小红书显式取消回复后 badge 没有隐藏",
    );

    checkpoint = apiCalls.length;
    await clickSelector(client, "#xhs-reply");
    const reopenedXhsReply = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "reply" &&
              call.body?.platform === "xiaohongshu",
          ),
      "小红书取消后重新选择回复目标失败",
    );
    checkpoint = apiCalls.length;
    await evaluate(
      client,
      `document.querySelector(${JSON.stringify(`#comment-${xhsCommentId}`)}).remove()`,
    );
    await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "DELETE" &&
              call.contextId === reopenedXhsReply.body.contextId,
          ),
      "小红书回复目标节点真正关闭后没有撤销 context",
    );
    await waitFor(
      () =>
        evaluate(client, `(() => {
          const badge=document.querySelector('[data-marine-rime-target="badge"]');
          return badge?.style.display==='none';
        })()`),
      "小红书回复目标节点移除后 badge 没有隐藏",
    );
    assert.equal(
      apiCalls.every((call) => call.authOk),
      true,
    );
    assert.deepEqual(runtimeIssues, []);

    console.log("Marine Chrome multi-site target e2e: OK");
  } catch (error) {
    if (expectedExtensionId) {
      console.error(`Expected Marine extension ID: ${expectedExtensionId}`);
    }
    if (client) {
      try {
        console.error(
          "Page diagnostic:",
          JSON.stringify(
            await evaluate(
              client,
              `(() => ({
          url:location.href,
          ready:document.documentElement.getAttribute('data-marine-rime-ready'),
          focused:document.activeElement&&document.activeElement.id,
          badge:document.querySelector('[data-marine-rime-target="badge"]')?.textContent||'',
          overlays:document.querySelectorAll('[data-marine-rime-target]').length
        }))()`,
            ),
          ),
        );
      } catch {}
      try {
        const extensionContext = Array.from(executionContexts.values()).find(
          (context) =>
            context.origin === `chrome-extension://${expectedExtensionId}` ||
            String(context.name || "").includes(expectedExtensionId),
        );
        const isolatedResult = extensionContext
          ? await client.send("Runtime.evaluate", {
              expression:
                "typeof marineDebug === 'object' ? marineDebug.buffer().filter((entry) => String(entry?.tag || '').startsWith('rime-')).slice(-80) : []",
              contextId: extensionContext.id,
              returnByValue: true,
            })
          : null;
        console.error(
          "Rime target diagnostics:",
          JSON.stringify(isolatedResult?.result?.value || []),
          "contexts:",
          JSON.stringify(Array.from(executionContexts.values()).map((context) => ({
            id: context.id,
            name: context.name,
            origin: context.origin,
            auxData: context.auxData,
          }))),
        );
      } catch {}
    }
    if (browserStderr.trim()) console.error(browserStderr.trim());
    console.error(
      "API calls:",
      JSON.stringify(
        apiCalls.slice(-30).map((call) => ({
          method: call.method,
          path: call.path,
          contextId: call.contextId,
          authOk: call.authOk,
          mode: call.body?.mode,
          platform: call.body?.platform,
          targetSummary: call.body?.targetSummary,
          target: call.body?.target,
        })),
      ),
    );
    if (runtimeIssues.length)
      console.error("Runtime issues:", JSON.stringify(runtimeIssues));
    throw error;
  } finally {
    client?.close();
    if (browser && browser.exitCode == null) {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      await Promise.race([exited, delay(3000)]);
    }
    await new Promise((resolve) => apiServer.close(resolve));
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

await main();
