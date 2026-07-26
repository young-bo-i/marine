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
  process.env.MARINE_EDGE_BINARY,
  path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
].filter(Boolean);

const xhsNoteId = "abcdef1234567890abcdef12";
const xhsCommentId = "0123456789abcdef01234567";
const zhihuUrl = "https://www.zhihu.com/question/1";
const xhsUrl = `https://www.xiaohongshu.com/explore/${xhsNoteId}`;
// 知乎专栏文章页。回答页和文章页共用同一套 data-zop 元信息，只是挂载点是
// `.Post-content` 且 type=article —— 以前只认 `.AnswerItem[data-zop]`，
// 于是文章页一个作用域都解析不出来，直评目标建不起来（搜索点进去的结果
// 大量是专栏，用户看到的就是「知乎识别不了」）。
const zhihuArticleUrl = "https://zhuanlan.zhihu.com/p/9001";
// 知乎搜索列表页：一页里有多张卡片（回答卡 + 文章卡），作用域不唯一，
// 只能靠「编辑器自己所属的那张卡」来解析。文章卡在列表里是 `.ArticleItem`，
// 不是专栏页的 `.Post-content` —— 这正是截图里识别不到的那种。
const zhihuListUrl = "https://www.zhihu.com/search?q=fixture";
// 2026 起的搜索页：卡片不再带 data-zop（实测同一个搜索页当天从 12 个变成 0 个），
// 身份只剩标题链接的 href。这是用户截图里那种页面。
const zhihuHrefListUrl = "https://www.zhihu.com/search?q=hreffixture";

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

const zhihuHrefListFixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>搜索 - 知乎</title><style>${sharedFixtureStyle}</style></head>
<body>
  <div class="ContentItem AnswerItem fixture-card" itemprop="answer">
    <h2 class="ContentItem-title"><a href="/question/7001/answer/7002">列表里的回答标题</a></h2>
    <div class="RichContent"><p>这是无 data-zop 的回答卡 7002。</p></div>
  </div>
  <div class="ContentItem ArticleItem fixture-card" itemprop="article">
    <h2 class="ContentItem-title"><a href="//zhuanlan.zhihu.com/p/7003?zpf=x">列表里的文章标题</a></h2>
    <div class="RichContent"><p>这是无 data-zop 的文章卡 7003 的正文。</p></div>
    <div class="Comments-container">
      <div class="InputLike Editable">
        <div id="zh-href-placeholder" class="public-DraftEditorPlaceholder-root fixture-placeholder">理性发言，友善互动</div>
        <div id="zh-href-editor" class="public-DraftEditor-content" role="textbox" contenteditable="true"></div>
      </div>
    </div>
  </div>
  <div class="ContentItem AnswerItem fixture-card" itemprop="answer">
    <h2 class="ContentItem-title"><a href="/question/7004/answer/7005">干扰回答标题</a></h2>
    <div class="RichContent"><p>这是无 data-zop 的回答卡 7005，不能被串到。</p></div>
  </div>
  <button id="fixture-outside" type="button">离开评论框</button>
</body></html>`;

const zhihuListFixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>搜索 - 知乎</title><style>${sharedFixtureStyle}</style></head>
<body>
  <div class="ContentItem AnswerItem fixture-card" data-zop='{"type":"answer","itemId":"5001","title":"列表里的回答","authorName":"列表回答作者"}'>
    <div class="RichContent"><p>这是列表里的回答 5001。</p></div>
  </div>
  <div class="ContentItem ArticleItem fixture-card" data-zop='{"type":"article","itemId":"5002","title":"列表里的文章","authorName":"列表文章作者"}'>
    <div class="RichContent"><p>这是列表里的文章 5002 的正文。</p></div>
    <div class="Comments-container">
      <div class="InputLike Editable">
        <div id="zh-list-placeholder" class="public-DraftEditorPlaceholder-root fixture-placeholder">理性发言，友善互动</div>
        <div id="zh-list-editor" class="public-DraftEditor-content" role="textbox" contenteditable="true"></div>
      </div>
    </div>
  </div>
  <div class="ContentItem AnswerItem fixture-card" data-zop='{"type":"answer","itemId":"5003","title":"另一个回答","authorName":"干扰项作者"}'>
    <div class="RichContent"><p>这是列表里的回答 5003，不能被串到。</p></div>
  </div>
  <button id="fixture-outside" type="button">离开评论框</button>
</body></html>`;

const zhihuArticleFixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>专栏文章标题 - 知乎</title><style>${sharedFixtureStyle}</style></head>
<body>
  <article class="Post-Main">
    <h1 class="Post-Title">专栏文章标题</h1>
    <div class="Post-content" data-zop='{"type":"article","itemId":"9001","title":"专栏文章标题","authorName":"专栏作者"}'>
      <div class="RichText"><p>这是专栏文章 9001 的正文。</p></div>
    </div>
  </article>
  <div class="Comments-container">
    <div class="InputLike Editable">
      <div id="zh-article-placeholder" class="public-DraftEditorPlaceholder-root fixture-placeholder">理性发言，友善互动</div>
      <div id="zh-article-editor" class="public-DraftEditor-content" role="textbox" contenteditable="true"></div>
    </div>
    <div class="fixture-comment" data-id="zh-article-comment-7">
      <a class="fixture-author" href="/people/zh-article-commenter">专栏评论者</a>
      <div class="CommentContent"><p>专栏评论正文</p></div>
    </div>
  </div>
  <button id="fixture-outside" type="button">离开评论框</button>
</body></html>`;

const zhihuFixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture 问题标题 - 知乎</title><style>${sharedFixtureStyle}</style></head>
<body>
  <article class="AnswerItem fixture-card" data-zop='{"type":"answer","itemId":"101","title":"Fixture 问题标题","authorName":"知答作者"}'>
    <h1>Fixture 问题标题</h1>
    <div class="RichContent"><p>这是回答 101 的精确正文。</p></div>
    <button id="open-comments" type="button">评论 1</button>
  </article>
  <article class="AnswerItem fixture-card" data-zop='{"type":"answer","itemId":"202","title":"Fixture 问题标题","authorName":"知答乙"}'>
    <div class="RichContent"><p>这是回答 202，不能串到 101 的评论框。</p></div>
    <button id="open-comments-202" type="button">0 条评论</button>
  </article>
  <section id="zh-modal" class="Modal-wrapper" hidden>
    <div class="Modal-content fixture-card">
      <h2 class="Modal-title">评论</h2>
      <div class="Comments-container">
        <form class="CommentBox CommentEditorV2">
          <div id="zh-placeholder" class="public-DraftEditorPlaceholder-root fixture-placeholder">写下你的评论</div>
          <div id="zh-editor" class="public-DraftEditor-content" role="textbox" contenteditable="true">知乎未发送草稿</div>
          <button data-submit type="submit">发布</button>
        </form>
        <div class="fixture-comment" data-id="zh-comment-42">
          <a class="fixture-author" href="/people/zh-commenter-42">知乎评论者</a>
          <p>知乎精确评论正文</p>
          <button id="zh-reply" type="button">回复</button>
        </div>
      </div>
    </div>
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
      document.querySelector('#zh-modal').hidden=false;
      setTimeout(()=>document.querySelector('#zh-editor').focus(),0);
    });
    document.querySelector('#open-comments-202').addEventListener('click',()=>{
      document.querySelector('#zh-modal').hidden=false;
      setTimeout(()=>document.querySelector('#zh-editor').focus(),0);
    });
    document.querySelector('#zh-reply').addEventListener('click',()=>{
      const floor=document.querySelector('[data-id="zh-comment-42"]');
      let editor=document.querySelector('#zh-reply-editor');
      if(!editor){
        const box=document.createElement('div');
        box.className='CommentEditorV2';
        box.innerHTML='<div class="public-DraftEditorPlaceholder-root">回复 @知乎评论者 :</div><div id="zh-reply-editor" class="public-DraftEditor-content" role="textbox" contenteditable="true" aria-label="回复 @知乎评论者 :"><p>知乎恢复草稿不可进入 target</p></div>';
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

async function navigateFixture(client, url) {
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
    `Marine target tracker did not become ready: ${url}`,
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
  let chromeBinary;
  for (const candidate of chromeCandidates) {
    try {
      await fs.access(candidate);
      chromeBinary = candidate;
      break;
    } catch {}
  }
  if (!chromeBinary)
    throw new Error(
      "Chrome for Testing, Google Chrome, or Microsoft Edge was not found",
    );

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
    client.on("Fetch.requestPaused", async (event) => {
      const url = event.request.url;
      const body = url.startsWith(zhihuHrefListUrl)
        ? zhihuHrefListFixtureHtml
        : url.startsWith(zhihuListUrl)
        ? zhihuListFixtureHtml
        : url.startsWith(zhihuArticleUrl)
        ? zhihuArticleFixtureHtml
        : url.startsWith(zhihuUrl)
          ? zhihuFixtureHtml
          : xhsFixtureHtml;
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
    await client.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "https://www.zhihu.com/question/1*",
          resourceType: "Document",
        },
        {
          urlPattern: "https://www.zhihu.com/search?q=hreffixture*",
          resourceType: "Document",
        },
        {
          urlPattern: "https://www.zhihu.com/search?q=fixture*",
          resourceType: "Document",
        },
        {
          urlPattern: "https://zhuanlan.zhihu.com/p/9001*",
          resourceType: "Document",
        },
        {
          urlPattern: `https://www.xiaohongshu.com/explore/${xhsNoteId}*`,
          resourceType: "Document",
        },
      ],
    });

    await navigateFixture(client, zhihuUrl);
    await delay(500);
    let checkpoint = apiCalls.length;
    await clickSelector(client, "#open-comments");
    const zhihuDirect = await waitFor(
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
    await clickSelector(client, "#zh-reply");
    const zhihuReply = await waitFor(
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
      "知乎 reused modal did not switch to the second answer scope",
    );
    assert.equal(
      zhihuSecondDirect.body.targetSummary,
      "直评回答 @知答乙 · Fixture 问题标题",
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

    // 专栏文章页：作用域来自 `.Post-content[data-zop]`（type=article）。
    // 这一段在修复前必然失败——文章页解析不出任何作用域，direct 目标发不出去。
    await navigateFixture(client, zhihuArticleUrl);
    await delay(500);
    checkpoint = apiCalls.length;
    await clickSelector(client, "#zh-article-editor");
    const zhihuArticleDirect = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "direct" &&
              call.body?.platform === "zhihu",
          ),
      "知乎专栏文章 direct target was not published",
    );
    assert.equal(zhihuArticleDirect.authOk, true);
    assert.equal(zhihuArticleDirect.body.actionId, "marine.generate-direct");
    assert.equal(zhihuArticleDirect.body.target, null);
    assert.equal(
      zhihuArticleDirect.body.targetSummary,
      "直评文章 @专栏作者 · 专栏文章标题",
    );
    assert.match(
      zhihuArticleDirect.body.payload.article.markdown,
      /专栏文章 9001 的正文/,
    );

    // 列表页：三张卡片 → uniqueZhihuScope 必然放弃（作用域不唯一），
    // 只能由编辑器所属的那张 `.ArticleItem[data-zop]` 解析出来。
    // 修复前这一段必然失败：列表里的文章卡匹配不上任何作用域选择器。
    await navigateFixture(client, zhihuListUrl);
    await delay(500);
    checkpoint = apiCalls.length;
    await clickSelector(client, "#zh-list-editor");
    const zhihuListDirect = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "direct" &&
              call.body?.platform === "zhihu",
          ),
      "知乎列表页文章卡 direct target was not published",
    );
    assert.equal(zhihuListDirect.authOk, true);
    assert.equal(zhihuListDirect.body.target, null);
    // 必须锁定编辑器所属的 5002，绝不能串到相邻的 5001 / 5003。
    assert.equal(
      zhihuListDirect.body.targetSummary,
      "直评文章 @列表文章作者 · 列表里的文章",
    );
    assert.match(
      zhihuListDirect.body.payload.article.markdown,
      /列表里的文章 5002 的正文/,
    );
    assert.doesNotMatch(
      zhihuListDirect.body.payload.article.markdown,
      /回答 5003/,
    );

    // 无 data-zop 的搜索列表页：作用域只能从卡片标题链接的 href 解析。
    await navigateFixture(client, zhihuHrefListUrl);
    await delay(500);
    checkpoint = apiCalls.length;
    await clickSelector(client, "#zh-href-editor");
    const zhihuHrefDirect = await waitFor(
      () =>
        apiCalls
          .slice(checkpoint)
          .find(
            (call) =>
              call.method === "PUT" &&
              call.body?.mode === "direct" &&
              call.body?.platform === "zhihu",
          ),
      "无 data-zop 的知乎搜索卡 direct target was not published",
    );
    assert.equal(zhihuHrefDirect.authOk, true);
    assert.equal(zhihuHrefDirect.body.target, null);
    // 卡片里没有可靠的作者元素，所以摘要不带 @作者，但必须锁定 7003 这篇文章。
    assert.equal(
      zhihuHrefDirect.body.targetSummary,
      "直评文章 · 列表里的文章标题",
    );
    assert.match(
      zhihuHrefDirect.body.payload.article.markdown,
      /文章卡 7003 的正文/,
    );
    assert.doesNotMatch(
      zhihuHrefDirect.body.payload.article.markdown,
      /回答卡 700[25]/,
    );

    await navigateFixture(client, xhsUrl);
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
