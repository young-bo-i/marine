import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const commentsSource = await fs.readFile(
  path.resolve(here, "../src/comments.js"),
  "utf8",
);

let initialData = {};
const locationStub = {
  href: "https://www.zhihu.com/question/1/answer/101",
  hostname: "www.zhihu.com",
  pathname: "/question/1/answer/101",
};

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const documentStub = {
  title: "Fixture 页面",
  createElement() {
    let html = "";
    return {
      get innerHTML() {
        return html;
      },
      set innerHTML(value) {
        html = String(value || "");
        this.textContent = stripHtml(html);
      },
      textContent: "",
    };
  },
  getElementById(id) {
    if (id !== "js-initialData") return null;
    return { textContent: JSON.stringify(initialData) };
  },
};

const context = vm.createContext({
  console,
  document: documentStub,
  location: locationStub,
});
vm.runInContext(commentsSource, context, { filename: "comments.js" });

initialData = {
  initialState: {
    entities: {
      answers: {
        101: {
          id: 101,
          type: "answer",
          author: { id: "zh-user-a", name: "知乎甲" },
          question: { id: 1, title: "Fixture 问题" },
          content: "<p>回答 101 的<strong>正文</strong>。</p>",
          voteup_count: 8,
          comment_count: 2,
        },
        202: {
          id: 202,
          type: "answer",
          author: { id: "zh-user-b", name: "知乎乙" },
          question: { id: 1, title: "Fixture 问题" },
          content: "<p>回答 202 的目标正文，必须按 directScope 选择。</p>",
          voteup_count: 3,
          comment_count: 0,
        },
      },
      questions: {
        1: { id: 1, title: "Fixture 问题" },
      },
    },
  },
};

const zhihuCaptures = [
  {
    // Child pagination can arrive first and carries no answer id.
    url: "https://www.zhihu.com/api/v4/comment_v5/comment/zh-root-1001/child_comment?order=normal",
    body: JSON.stringify({
      data: [
        {
          id: "zh-child-1002",
          root_comment_id: "zh-root-1001",
          parent_comment_id: "zh-root-1001",
          author: { id: "zh-commenter-b", name: "评论乙" },
          content: "<p>楼中楼回复</p>",
          comment_tag: [{ type: "ip_info", text: "上海" }],
        },
      ],
    }),
  },
  {
    url: "https://www.zhihu.com/api/v4/comment_v5/answers/101/root_comment?order=normal",
    body: JSON.stringify({
      data: [
        {
          id: "zh-root-1001",
          author: { id: "zh-commenter-a", name: "评论甲" },
          content: "<p>根评论 <b>正文</b></p>",
          like_count: 7,
          child_comment_count: 1,
        },
      ],
    }),
  },
];

const zhihu = context.marineBuildComments("zhihu", zhihuCaptures);
assert.equal(zhihu.ok, true);
const answer101 = zhihu.comments.find((item) => item.id === "101");
assert.ok(answer101, "知乎回答应作为评论树的回答 scope 根节点");
assert.equal(answer101.kind, "answer");
assert.equal(answer101.author.name, "知乎甲");
assert.equal(answer101.children.length, 1);
const zhihuRoot = answer101.children[0];
assert.equal(zhihuRoot.id, "zh-root-1001");
assert.equal(zhihuRoot.parentId, null);
assert.equal(zhihuRoot.rootId, null);
assert.equal(zhihuRoot.author.name, "评论甲");
assert.equal(zhihuRoot.text, "根评论 正文");
assert.equal(zhihuRoot.children.length, 1);
const zhihuChild = zhihuRoot.children[0];
assert.equal(zhihuChild.id, "zh-child-1002");
assert.equal(zhihuChild.parentId, "zh-root-1001");
assert.equal(zhihuChild.rootId, "zh-root-1001");
assert.equal(zhihuChild.author.name, "评论乙");
assert.equal(zhihuChild.text, "楼中楼回复");
assert.equal(zhihuChild.ipLocation, "上海");
assert.deepEqual(JSON.parse(JSON.stringify(zhihu.stats)), {
  count: 4,
  roots: 2,
  subs: 2,
  maxDepth: 3,
});
assert.deepEqual(
  Array.from(
    context.marineFlattenComments(zhihu.comments),
    (item) => item.id,
  ).sort(),
  ["101", "202", "zh-child-1002", "zh-root-1001"].sort(),
);

const scopedAnswer = context.marineExtractNoteText("zhihu", zhihuCaptures, {
  directScope: {
    id: "202",
    kind: "answer",
    title: "Fixture 问题",
    authorName: "知乎乙",
  },
});
assert.match(scopedAnswer, /^# Fixture 问题/m);
assert.match(scopedAnswer, /> 回答者：知乎乙/);
assert.match(scopedAnswer, /回答 202 的目标正文/);
assert.doesNotMatch(scopedAnswer, /回答 101 的正文/);

const xhsNoteId = "abcdef1234567890abcdef12";
locationStub.href = `https://www.xiaohongshu.com/explore/${xhsNoteId}`;
locationStub.hostname = "www.xiaohongshu.com";
locationStub.pathname = `/explore/${xhsNoteId}`;

const xhsFeedCapture = {
  url: "https://edith.xiaohongshu.com/api/sns/web/v1/feed",
  body: JSON.stringify({
    data: {
      items: [
        {
          id: "fedcba0987654321fedcba09",
          note_card: {
            note_id: "fedcba0987654321fedcba09",
            title: "错误笔记",
            desc: "不能因为排在第一项就被选择。",
            user: { nickname: "错误作者" },
          },
        },
        {
          id: xhsNoteId,
          note_card: {
            note_id: xhsNoteId,
            title: "目标笔记",
            desc: "必须根据当前 URL 的 note id 选择这条正文。",
            user: { nickname: "小红薯甲" },
            ip_location: "浙江",
          },
        },
      ],
    },
  }),
};

const selectedNote = context.marineExtractNoteText(
  "xiaohongshu",
  [xhsFeedCapture],
  {},
);
assert.match(selectedNote, /^# 目标笔记/m);
assert.match(selectedNote, /> 作者：小红薯甲（浙江）/);
assert.match(selectedNote, /当前 URL 的 note id/);
assert.doesNotMatch(selectedNote, /错误笔记|错误作者/);

const xhsRootId = "aabbccddeeff0011";
const xhsSubId = "1122334455667788";
const xhsParentId = "2233445566778899";
const xhsCaptures = [
  {
    url: `https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=${xhsNoteId}`,
    body: JSON.stringify({
      data: {
        comments: [
          {
            id: xhsRootId,
            content: "小红书根评论",
            user_info: { user_id: "xhs-user-a", nickname: "薯友甲" },
            like_count: "12",
            sub_comment_count: "1",
          },
        ],
      },
    }),
  },
  {
    url: `https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?root_comment_id=${xhsRootId}`,
    body: JSON.stringify({
      data: {
        comments: [
          {
            id: xhsSubId,
            root_comment_id: xhsRootId,
            parent_comment_id: xhsParentId,
            content: "小红书楼中楼",
            user_info: { user_id: "xhs-user-b", nickname: "薯友乙" },
          },
        ],
      },
    }),
  },
];

const xhs = context.marineBuildComments("xiaohongshu", xhsCaptures);
assert.equal(xhs.ok, true);
assert.equal(xhs.comments.length, 1);
assert.equal(xhs.comments[0].id, xhsRootId);
assert.equal(xhs.comments[0].parentId, null);
assert.equal(xhs.comments[0].rootId, null);
assert.equal(xhs.comments[0].children.length, 1);
assert.equal(xhs.comments[0].children[0].id, xhsSubId);
assert.equal(xhs.comments[0].children[0].parentId, xhsParentId);
assert.equal(xhs.comments[0].children[0].rootId, xhsRootId);
assert.equal(xhs.comments[0].children[0].author.name, "薯友乙");

const malformed = context.marineBuildComments("xiaohongshu", [
  {
    url: `https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=${xhsNoteId}`,
    body: '{"data":',
  },
]);
assert.equal(malformed.ok, false);
assert.equal(malformed.stats.count, 0);
assert.equal(Array.isArray(malformed.comments), true);
assert.equal(
  context.marineExtractNoteText(
    "xiaohongshu",
    [
      {
        url: "https://edith.xiaohongshu.com/api/sns/web/v1/feed",
        body: "not-json",
      },
    ],
    {},
  ),
  "",
);

console.log("Marine multi-platform comments smoke: OK");
