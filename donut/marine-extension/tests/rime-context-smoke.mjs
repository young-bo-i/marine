import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = { TextEncoder };
vm.createContext(sandbox);
const source = fs.readFileSync(new URL("../src/rime-context.js", import.meta.url), "utf8");
vm.runInContext(source, sandbox, { filename: "marine-extension/src/rime-context.js" });
const contentIsoSource = fs.readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

const result = vm.runInContext(`(() => {
  const allSources = {
    platform: "bilibili",
    url: "https://www.bilibili.com/video/BV1",
    title: "作品标题",
    text: { md: "文".repeat(400_000) },
    comments: { agentMd: "评".repeat(1_000_000), md: "unused" },
    subtitle: { text: "幕".repeat(500_000) },
  };
  const envelope = {
    mode: "reply",
    targetSummary: "@Alice：「目标评论」",
  };
  const subtitlePayload = marineRimeBuildPayload(allSources, envelope);
  const commentsPayload = marineRimeBuildPayload({
    platform: allSources.platform,
    url: allSources.url,
    title: allSources.title,
    text: allSources.text,
    comments: allSources.comments,
    subtitle: { text: "  " },
  }, envelope);
  const articlePayload = marineRimeBuildPayload({
    platform: allSources.platform,
    url: allSources.url,
    title: allSources.title,
    text: allSources.text,
    comments: { agentMd: "\\n" },
    subtitle: { text: "" },
  }, envelope);
  const fallbackCommentPayload = marineRimeBuildPayload({
    platform: allSources.platform,
    url: allSources.url,
    title: allSources.title,
    text: { md: "ARTICLE-MUST-NOT-WIN" },
    comments: { agentMd: "  ", md: "备用评论内容" },
    subtitle: { text: "" },
  }, envelope);
  const emptyPayload = marineRimeBuildPayload({
    platform: allSources.platform,
    url: allSources.url,
    title: allSources.title,
  }, envelope);
  const zhihuPayload = marineRimeBuildPayload({
    platform: "zhihu",
    url: "https://www.zhihu.com/question/1/answer/2",
    title: "知乎回答",
    text: { md: "当前回答正文" },
    comments: { agentMd: "评论区不能盖掉回答正文" },
    subtitle: { text: "" },
  }, envelope);
  const xhsPayload = marineRimeBuildPayload({
    platform: "xiaohongshu",
    url: "https://www.xiaohongshu.com/explore/abcdef1234567890",
    title: "小红书笔记",
    text: { md: "当前笔记正文" },
    comments: { agentMd: "评论区不能盖掉笔记正文" },
    subtitle: { text: "" },
  }, envelope);
  const context = {
    contextId: "ctx",
    mode: "reply",
    actionId: "marine.generate-reply",
    payload: subtitlePayload,
  };
  const surrogate = marineRimeTruncateUtf8("😀😀😀", 5);
  const longSummary = marineRimeBuildContextEnvelope(allSources, {
    targetSummary: "界".repeat(1_000),
  }, "subtitle").targetSummary;
  return {
    articleBytes: marineRimeUtf8Bytes(articlePayload.article.markdown),
    commentBytes: marineRimeUtf8Bytes(commentsPayload.comments.agentMd),
    subtitleBytes: marineRimeUtf8Bytes(subtitlePayload.subtitle.text),
    contextBytes: marineRimeContextWireBytes(context),
    maxContextBytes: MARINE_RIME_CONTEXT_MAX_BYTES,
    surrogate,
    surrogateBytes: marineRimeUtf8Bytes(surrogate),
    longSummaryBytes: marineRimeUtf8Bytes(longSummary),
    maxTargetSummaryBytes: MARINE_RIME_TARGET_SUMMARY_MAX_BYTES,
    subtitleKeys: Object.keys(subtitlePayload),
    commentsKeys: Object.keys(commentsPayload),
    articleKeys: Object.keys(articlePayload),
    emptyKeys: Object.keys(emptyPayload),
    subtitleContext: subtitlePayload.context,
    commentsSource: commentsPayload.context.source,
    articleSource: articlePayload.context.source,
    fallbackCommentSource: fallbackCommentPayload.context.source,
    fallbackCommentText: fallbackCommentPayload.comments.agentMd,
    emptySource: emptyPayload.context.source,
    zhihuSource: zhihuPayload.context.source,
    zhihuText: zhihuPayload.article.markdown,
    xhsSource: xhsPayload.context.source,
    xhsText: xhsPayload.article.markdown,
    replyTarget: marineRimeBuildReplyTarget({
      id: " 42 ",
      authorName: " Alice ",
      text: " 目标评论 ",
      parentId: " 41 ",
      rootId: " 40 ",
      snippet: "must not cross the wire",
    }),
    exactTarget: marineRimeResolveExactCapturedTarget([
      { id: "42", authorName: " Alice ", text: "same\\ncomment" },
    ], { authorName: "Alice", text: "same comment" }, 1),
    duplicateCapture: marineRimeResolveExactCapturedTarget([
      { id: "42", authorName: "Alice", text: "same comment" },
      { id: "43", authorName: "Alice", text: "same comment" },
    ], { authorName: "Alice", text: "same comment" }, 1),
    duplicateRenderer: marineRimeResolveExactCapturedTarget([
      { id: "42", authorName: "Alice", text: "same comment" },
    ], { authorName: "Alice", text: "same comment" }, 2),
    substringOnly: marineRimeResolveExactCapturedTarget([
      { id: "42", authorName: "Alice", text: "same comment with suffix" },
    ], { authorName: "Alice", text: "same comment" }, 1),
    containedUnique: marineRimeResolveContainedCapturedTarget([
      { id: "52", authorName: "第一块钢化玻璃", text: "有没有帮忙想创新点的skill" },
      { id: "53", authorName: "其他人", text: "嵌套楼层内容" },
    ], {
      authorName: "第一块钢化玻璃",
      text: "",
      wholeText: "第一块钢化玻璃 有没有帮忙想创新点的skill 点赞 回复 其他人 嵌套楼层内容",
    }),
    containedAmbiguous: marineRimeResolveContainedCapturedTarget([
      { id: "52", authorName: "Alice", text: "first body" },
      { id: "54", authorName: "Alice", text: "nested body" },
    ], { authorName: "Alice", wholeText: "Alice first body reply Alice nested body" }),
    containedDuplicateSameId: marineRimeResolveContainedCapturedTarget([
      { id: "52", authorName: "Alice", text: "exact body" },
      { id: "52", authorName: "Alice", text: "exact body" },
    ], { authorName: "Alice", wholeText: "Alice exact body reply" }),
    containedAuthorMismatch: marineRimeResolveContainedCapturedTarget([
      { id: "52", authorName: "Bob", text: "exact body" },
    ], { authorName: "Alice", wholeText: "Alice exact body reply" }),
    stableDomId: marineRimeStableDomTargetId(
      "https://www.bilibili.com/video/BV1",
      { authorName: " Alice ", text: "same\\ncomment" },
      "bili-comment-renderer:2/bili-comments:0",
    ),
    stableDomIdAgain: marineRimeStableDomTargetId(
      "https://www.bilibili.com/video/BV1",
      { authorName: "Alice", text: "same comment" },
      "bili-comment-renderer:2/bili-comments:0",
    ),
    otherFloorDomId: marineRimeStableDomTargetId(
      "https://www.bilibili.com/video/BV1",
      { authorName: "Alice", text: "same comment" },
      "bili-comment-renderer:3/bili-comments:0",
    ),
    placeholderAuthor: marineRimeReplyPlaceholderAuthor("回复 @Alice :"),
    claimNewEditor: marineRimeCanClaimReplyLease({
      pageKey: "page", sourceId: "source", expiresAt: 5000, authorName: "Alice",
    }, {
      isReplyEditor: true, structurallyOwned: false, isNewEditor: true,
      becameReplyEditor: false, placeholderAuthor: "Alice",
    }, "page", "source", 4000),
    rejectExistingOtherEditor: marineRimeCanClaimReplyLease({
      pageKey: "page", sourceId: "source", expiresAt: 5000, authorName: "Alice",
    }, {
      isReplyEditor: true, structurallyOwned: false, isNewEditor: false,
      becameReplyEditor: false, placeholderAuthor: "Bob",
    }, "page", "source", 4000),
    rejectExpiredLease: marineRimeCanClaimReplyLease({
      pageKey: "page", sourceId: "source", expiresAt: 3000, authorName: "Alice",
    }, {
      isReplyEditor: true, structurallyOwned: true, isNewEditor: true,
      becameReplyEditor: false, placeholderAuthor: "Alice",
    }, "page", "source", 4000),
  };
})()`, sandbox);

assert.ok(result.articleBytes <= 180_000);
assert.ok(result.commentBytes <= 700_000);
assert.ok(result.subtitleBytes <= 300_000);
assert.ok(result.contextBytes <= result.maxContextBytes);
assert.equal(result.surrogate, "😀");
assert.equal(result.surrogateBytes, 4);
assert.equal(result.longSummaryBytes, result.maxTargetSummaryBytes - 1);
assert.deepEqual(Array.from(result.subtitleKeys), ["context", "subtitle"]);
assert.deepEqual(Array.from(result.commentsKeys), ["context", "comments"]);
assert.deepEqual(Array.from(result.articleKeys), ["context", "article"]);
assert.deepEqual(Array.from(result.emptyKeys), ["context"]);
assert.equal(result.subtitleContext.platform, "bilibili");
assert.equal(result.subtitleContext.url, "https://www.bilibili.com/video/BV1");
assert.equal(result.subtitleContext.title, "作品标题");
assert.equal(result.subtitleContext.mode, "reply");
assert.equal(result.subtitleContext.targetSummary, "@Alice：「目标评论」");
assert.equal(result.subtitleContext.source, "subtitle");
assert.equal(result.commentsSource, "comments");
assert.equal(result.articleSource, "article");
assert.equal(result.fallbackCommentSource, "comments");
assert.equal(result.fallbackCommentText, "备用评论内容");
assert.equal(result.emptySource, "none");
assert.equal(result.zhihuSource, "article");
assert.equal(result.zhihuText, "当前回答正文");
assert.equal(result.xhsSource, "article");
assert.equal(result.xhsText, "当前笔记正文");
assert.deepEqual(JSON.parse(JSON.stringify(result.replyTarget)), {
  id: "42",
  authorName: "Alice",
  text: "目标评论",
  parentId: "41",
  rootId: "40",
});
assert.equal(result.exactTarget.id, "42");
assert.equal(result.duplicateCapture, null);
assert.equal(result.duplicateRenderer, null);
assert.equal(result.substringOnly, null);
assert.equal(result.containedUnique.target.id, "52");
assert.equal(result.containedUnique.target.text, "有没有帮忙想创新点的skill");
assert.equal(result.containedUnique.containedMatchCount, 1);
assert.equal(result.containedAmbiguous.target, null);
assert.equal(result.containedAmbiguous.containedMatchCount, 2);
assert.equal(result.containedDuplicateSameId.target.id, "52");
assert.equal(result.containedDuplicateSameId.containedMatchCount, 1);
assert.equal(result.containedAuthorMismatch.target, null);
assert.equal(result.containedAuthorMismatch.sameAuthorCount, 0);
assert.match(result.stableDomId, /^dom-[a-z0-9]+-[a-z0-9]+$/);
assert.equal(result.stableDomId, result.stableDomIdAgain);
assert.notEqual(result.stableDomId, result.otherFloorDomId);
assert.equal(result.placeholderAuthor, "Alice");
assert.equal(result.claimNewEditor, true);
assert.equal(result.rejectExistingOtherEditor, false);
assert.equal(result.rejectExpiredLease, false);

const transportStartMarker = "// BEGIN marine-rime-reliable-transport";
const transportEndMarker = "// END marine-rime-reliable-transport";
const transportStart = contentIsoSource.indexOf(transportStartMarker);
const transportEnd = contentIsoSource.indexOf(transportEndMarker);
assert.ok(transportStart >= 0 && transportEnd > transportStart);
const transportSource = contentIsoSource.slice(
  transportStart + transportStartMarker.length,
  transportEnd,
);

const transportCalls = [];
const transportLogs = [];
let transportOutcomes = [];
const transportSandbox = {
  chrome: {
    runtime: {
      async sendMessage(message) {
        transportCalls.push(structuredClone(message));
        const outcome = transportOutcomes.shift();
        if (typeof outcome === "function") return outcome(message);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  },
  clearTimeout,
  marineLog(level, area, message) {
    transportLogs.push({ level, area, message });
  },
  marineRimeTarget: {
    active: null,
    revision: 0,
    sourceId: "source-a",
  },
  Promise,
  setTimeout,
  structuredClone,
};
vm.createContext(transportSandbox);
vm.runInContext(`${transportSource}\n` +
  "globalThis.__marineDeliver = marineRimeDeliver;", transportSandbox, {
  filename: "marine-extension/src/content-iso.js#reliable-transport",
});

async function deliver(operation, outcomes) {
  transportCalls.length = 0;
  transportLogs.length = 0;
  transportOutcomes = [...outcomes];
  return transportSandbox.__marineDeliver(operation);
}

transportSandbox.marineRimeTarget.active = { contextId: "ctx-current" };
transportSandbox.marineRimeTarget.revision = 1;
transportSandbox.marineRimeTarget.sourceId = "source-a";
let delivery = await deliver({
  op: "put",
  contextId: "ctx-current",
  context: { contextId: "ctx-current" },
  revision: 1,
  sourceId: "source-a",
}, [
  new Error("The message port closed before a response was received."),
  { ok: true },
]);
assert.equal(delivery.applied, true);
assert.equal(transportCalls.length, 2, "a closed cold-start port must retry and require an ACK");

transportSandbox.marineRimeTarget.active = {
  contextId: "ctx-retained-renewal",
  publishedRevision: 1,
};
// Unsuccessful content refreshes may advance the local generation, but a pure
// lease renewal must stay bound to the last worker-acknowledged revision.
transportSandbox.marineRimeTarget.revision = 9;
delivery = await deliver({
  op: "put",
  contextId: "ctx-retained-renewal",
  context: { contextId: "ctx-retained-renewal", updatedAt: 1234 },
  revision: 1,
  sourceId: "source-a",
  retainWhenUnfocused: true,
  leaseRenewal: true,
}, [{ ok: true }]);
assert.equal(delivery.applied, true);
assert.equal(transportCalls.length, 1);
assert.equal(transportCalls[0].leaseRenewal, true);
assert.equal(transportCalls[0].revision, 1);

transportSandbox.marineRimeTarget.active = { contextId: "ctx-stale" };
transportSandbox.marineRimeTarget.revision = 2;
delivery = await deliver({
  op: "put",
  contextId: "ctx-stale",
  context: { contextId: "ctx-stale" },
  revision: 2,
  sourceId: "source-a",
}, [
  () => {
    transportSandbox.marineRimeTarget.revision = 3;
    throw new Error("The message port closed before a response was received.");
  },
  { ok: true },
]);
assert.equal(delivery.stale, true);
assert.equal(transportCalls.length, 1, "an obsolete PUT must not be revived by its retry");

transportSandbox.marineRimeTarget.active = { contextId: "ctx-deferred" };
transportSandbox.marineRimeTarget.revision = 4;
delivery = await deliver({
  op: "put",
  contextId: "ctx-deferred",
  context: { contextId: "ctx-deferred" },
  revision: 4,
  sourceId: "source-a",
}, [
  { ok: true, skipped: true, deferred: true },
  { ok: true },
]);
assert.equal(delivery.applied, true);
assert.equal(transportCalls.length, 2, "a worker-deferred PUT must make one bounded follow-up attempt");

transportSandbox.marineRimeTarget.active = { contextId: "ctx-skipped" };
transportSandbox.marineRimeTarget.revision = 5;
delivery = await deliver({
  op: "put",
  contextId: "ctx-skipped",
  context: { contextId: "ctx-skipped" },
  revision: 5,
  sourceId: "source-a",
}, [{ ok: true, skipped: true }]);
assert.equal(delivery.applied, false);
assert.equal(transportCalls.length, 1, "a definitively skipped PUT must not loop");

transportSandbox.marineRimeTarget.active = { contextId: "ctx-new" };
transportSandbox.marineRimeTarget.revision = 7;
transportSandbox.marineRimeTarget.sourceId = "source-b";
delivery = await deliver({
  op: "delete",
  contextId: "ctx-old",
  context: null,
  revision: 6,
  sourceId: "source-a",
}, [new Error("The message port closed before a response was received."), { ok: true }]);
assert.equal(delivery.applied, true);
assert.equal(transportCalls.length, 2);
assert.ok(transportCalls.every((call) => call.contextId === "ctx-old"));
assert.ok(transportCalls.every((call) => call.sourceId === "source-a"));

delivery = await deliver({
  op: "delete",
  contextId: "ctx-new",
  context: null,
  revision: 7,
  sourceId: "source-b",
}, [{ ok: true }]);
assert.equal(delivery.stale, true);
assert.equal(transportCalls.length, 0, "an old DELETE may never remove the current target");

const publishStart = contentIsoSource.indexOf("async function marineRimePublish");
const publishEnd = contentIsoSource.indexOf("function marineRimeContextDataChanged", publishStart);
const publishSource = contentIsoSource.slice(publishStart, publishEnd);
assert.ok(publishSource.indexOf("await marineRimeSend('put'") <
  publishSource.indexOf("published.publishedContext = context"));
assert.ok(publishSource.indexOf("await marineRimeSend('put'") <
  publishSource.indexOf("published.publishedAt = Date.now()"));
assert.ok(publishSource.indexOf("published.publishedRevision = revision") <
  publishSource.indexOf("published.publishedAt = Date.now()"));
const renewStart = contentIsoSource.indexOf("async function marineRimeRenew");
const renewEnd = contentIsoSource.indexOf("function marineRimeClear", renewStart);
const renewSource = contentIsoSource.slice(renewStart, renewEnd);
assert.match(renewSource, /Number\(active\.publishedRevision\)/);
assert.match(renewSource, /\{ leaseRenewal: true \}/);
assert.doesNotMatch(renewSource, /\+\+marineRimeTarget\.revision/);
assert.doesNotMatch(transportSource, /sendMessage\([^)]*,\s*function/);

console.log("Marine extension Rime payload smoke: OK");
