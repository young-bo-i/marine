import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const helper = fs.readFileSync(new URL("../src/scholay-skill.js", import.meta.url), "utf8");
const mother = fs.readFileSync(new URL("../skills/scholay/母稿.md", import.meta.url), "utf8");
const assets = {
  brand: fs.readFileSync(new URL("../skills/scholay/品牌.md", import.meta.url), "utf8"),
  execution: fs.readFileSync(new URL("../skills/scholay/执行口径.md", import.meta.url), "utf8"),
  style: fs.readFileSync(new URL("../skills/scholay/风格参数.json", import.meta.url), "utf8"),
  mother,
  index: fs.readFileSync(new URL("../skills/scholay/母稿索引.json", import.meta.url), "utf8"),
};

const sandbox = { assets };
vm.createContext(sandbox);
vm.runInContext(helper, sandbox, { filename: "marine-extension/src/scholay-skill.js" });

const digest = crypto.createHash("sha256").update(mother).digest("hex");
assert.equal(
  digest,
  "7707219d9f301ab1294c4decc92747795dbf65ff898562aac150d35753ac9913",
  "用户原版母稿必须逐字保持不变",
);

const result = vm.runInContext(`(() => {
  const paragraphs = marineScholayParseMotherDraft(assets.mother);
  const subtitleOnly = {
    context: {
      platform: "bilibili",
      title: "开题怎么找研究空白",
      mode: "direct",
      targetSummary: "当前作品直评",
      source: "subtitle",
    },
    subtitle: { text: "选题价值需要做文献矩阵和多维度分析" },
    comments: { agentMd: "期刊投稿被拒稿，审稿人要求返修" },
  };
  const review = {
    context: {
      title: "期刊投稿复盘",
      mode: "reply",
      targetSummary: "@Alice：返修意见看不懂",
      source: "comments",
    },
    comments: { agentMd: "审稿人拒稿后怎样逐条修改意见，最后录用" },
  };
  const empty = { context: { source: "none", title: "日常视频" } };
  const nestedRimeReview = {
    contextId: "ctx-review",
    mode: "reply",
    title: "投稿复盘",
    targetSummary: "@Alice：返修意见看不懂",
    target: {
      id: "42",
      authorName: "Alice",
      text: "审稿人拒稿后怎么逐条返修",
      parentId: "41",
      rootId: "40",
    },
    payload: {
      context: {
        platform: "bilibili",
        title: "投稿复盘",
        mode: "reply",
        targetSummary: "@Alice：返修意见看不懂",
        source: "comments",
      },
      comments: { agentMd: "  ", md: "期刊审稿意见和最终录用" },
    },
  };
  const subtitleSelection = marineScholaySelectRoutes(assets, subtitleOnly);
  const reviewSelection = marineScholaySelectRoutes(assets, review);
  const fallbackSelection = marineScholaySelectRoutes(assets, empty);
  const nestedSelection = marineScholaySelectRoutes(assets, nestedRimeReview);
  const nestedSkill = marineScholayBuildSkill(assets, nestedRimeReview, "");
  const skill = marineScholayBuildSkill(assets, subtitleOnly, "我的补充范文");
  let corruptError = "";
  try { marineScholayBuildSkill({ ...assets, mother: "只剩一段" }, empty, ""); }
  catch (error) { corruptError = error.message; }
  return {
    paragraphs,
    subtitleSource: subtitleSelection.source,
    subtitleIds: subtitleSelection.routes.map(route => route.id),
    reviewIds: reviewSelection.routes.map(route => route.id),
    fallbackIds: fallbackSelection.routes.map(route => route.id),
    nestedSource: nestedSelection.source,
    nestedIds: nestedSelection.routes.map(route => route.id),
    nestedSkill,
    skill,
    corruptError,
  };
})()`, sandbox);

assert.equal(result.paragraphs.length, 6);
assert.equal(result.subtitleSource, "subtitle");
assert.deepEqual(Array.from(result.subtitleIds), ["research-matrix"]);
assert.equal(result.reviewIds[0], "submission-review");
assert.deepEqual(Array.from(result.fallbackIds), ["submission-review", "research-matrix"]);
assert.equal(result.nestedSource, "comments");
assert.equal(result.nestedIds[0], "submission-review");
assert.match(result.nestedSkill, /期刊审稿是很不客气的/);
assert.match(result.skill, /页面内容来源：subtitle/);
assert.match(result.skill, /其实开题这个东西，中国的大学根本就没教好/);
assert.doesNotMatch(result.skill, /期刊审稿是很不客气的/);
assert.doesNotMatch(result.skill, /不得编造/);
assert.match(result.skill, /用户主动导入的补充范文（次级参照）/);
assert.match(result.corruptError, /必须保持为 6 段/);

const popupHtml = fs.readFileSync(new URL("../popup.html", import.meta.url), "utf8");
const popupSource = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../src/sw.js", import.meta.url), "utf8");
assert.match(popupHtml, /src\/rime-context\.js[\s\S]+src\/scholay-skill\.js[\s\S]+popup\.js/);
for (const source of [popupSource, workerSource]) {
  assert.doesNotMatch(source, /base \+ '评论口径\.md'/);
  assert.doesNotMatch(source, /base \+ '范文\.md'/);
}

console.log("scholay skill smoke passed");
