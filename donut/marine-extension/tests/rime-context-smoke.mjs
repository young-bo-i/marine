import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = { TextEncoder };
vm.createContext(sandbox);
const source = fs.readFileSync(new URL("../src/rime-context.js", import.meta.url), "utf8");
vm.runInContext(source, sandbox, { filename: "marine-extension/src/rime-context.js" });

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
  const context = {
    contextId: "ctx",
    mode: "reply",
    actionId: "marine.generate-reply",
    payload: subtitlePayload,
  };
  const surrogate = marineRimeTruncateUtf8("😀😀😀", 5);
  return {
    articleBytes: marineRimeUtf8Bytes(articlePayload.article.markdown),
    commentBytes: marineRimeUtf8Bytes(commentsPayload.comments.agentMd),
    subtitleBytes: marineRimeUtf8Bytes(subtitlePayload.subtitle.text),
    contextBytes: marineRimeContextWireBytes(context),
    maxContextBytes: MARINE_RIME_CONTEXT_MAX_BYTES,
    surrogate,
    surrogateBytes: marineRimeUtf8Bytes(surrogate),
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

console.log("Marine extension Rime payload smoke: OK");
