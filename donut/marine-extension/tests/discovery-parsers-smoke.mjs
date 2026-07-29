// discovery.js 回归测试 —— 发现侧解析器 + 健康断言。
//
// 用紧凑的合成 fixture，而不是把 1MB 的真实页面塞进仓库。每个 fixture 都按真
// 实页面的结构写，并且专门覆盖那些「实测踩到、看不出来会错」的形态：
//   · bilibili   广告卡没有 BV 链接（真实广告 href 指向 cm.bilibili.com）
//   · bilibili   指标是位置依赖的 —— 多一个 stat 必须大声失败而不是静默错位
//   · xiaohongshu 点赞数必须取自 like-wrapper 内部，不能是卡内第一个 .count
//   · zhihu      class 是无序 token 集合，换个书写顺序不能让解析归零
//   · canary     真实事故形态（HTML 变空、截断）必须被拦下
//
// 这些断言不是凭空写的，都是变异测试在真实产物上复现过的失败。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.resolve(here, "../src/platforms/discovery.js"), "utf8"),
  ctx,
);
const D = ctx.marineDiscovery;

// discovery.js 跑在 vm realm 里，它返回的数组用的是那个 realm 的 Array.prototype。
// assert.deepStrictEqual 会比对原型，于是两个内容完全相同的数组也会报
// "same structure but not reference-equal"。用扩展运算符搬回宿主 realm 再比。
const hostArray = (arr) => [...arr];

// ---------------------------------------------------------------- bilibili
function biliCard({ bv, title, play, danmaku, extraStat = false, ad = false }) {
  const href = ad
    ? "//cm.bilibili.com/cm/api/fees/pc/sync/v2?adtype=CPM"
    : `//www.bilibili.com/video/${bv}/`;
  const stat = (v) =>
    `<span class="bili-video-card__stats--item"><svg class="bili-video-card__stats--icon"></svg><span>${v}</span></span>`;
  // 真实结构：容器 .bili-video-card > 骨架屏(永远存在且带 hide) + .bili-video-card__wrap。
  // 解析器按容器切卡并用 (?![_]) 排除 BEM 子元素，所以 fixture 必须带容器，
  // 否则测的就不是真实代码路径。
  return `<div class="bili-video-card">
    <div class="bili-video-card__skeleton hide"><div class="bili-video-card__skeleton--cover"></div></div>
    <div class="bili-video-card__wrap">
    <a href="${href}" target="_blank"><div class="bili-video-card__image"></div></a>
    <div class="bili-video-card__stats"><div class="bili-video-card__stats--left">
      ${extraStat ? stat("999") : ""}${stat(play)}${stat(danmaku)}
    </div><span class="bili-video-card__stats__duration">05:19</span></div>
    <div class="bili-video-card__info--right">
      <a href="${href}"><h3 class="bili-video-card__info--tit" title="${title}">${title}</h3></a>
      <div class="bili-video-card__info--bottom">
        <a class="bili-video-card__info--owner" href="//space.bilibili.com/123">
          <span class="bili-video-card__info--author">UP</span>
          <span class="bili-video-card__info--date">· 2025-09-15</span></a>
      </div>
    </div></div></div>`;
}

{
  const html =
    biliCard({ bv: "BV1aaaaaaaaa", title: "真视频A", play: "6.6万", danmaku: "114" }) +
    biliCard({ bv: "BV1bbbbbbbbb", title: "真视频B", play: "3082", danmaku: "3" }) +
    biliCard({ bv: "", title: "广告", play: "1", danmaku: "1", ad: true });

  const items = D.bilibili.parse(html);
  assert.equal(items.length, 2, "带 CPM 广告链接的卡必须被剔除");
  assert.deepStrictEqual(hostArray(items).map((i) => i.id), ["BV1aaaaaaaaa", "BV1bbbbbbbbb"]);
  assert.equal(items[0].metrics.play, 66000, "6.6万 应解析为 66000");
  assert.equal(items[1].metrics.play, 3082, "纯数字播放量应原样解析");
  assert.equal(items[0].metrics.danmaku, 114);
  assert.ok(
    items.every((i) => /^https:\/\/www\.bilibili\.com\/video\/BV/.test(i.open_url)),
    "open_url 必须是可直接打开的永久链接",
  );
  assert.ok(items.every((i) => !i.open_url.includes("?")), "B 站候选不该带任何 query");
}

{
  // 位置依赖的护栏。B 站若在卡片上加一个 stat，按位取值会把新指标当成播放量，
  // 而候选数不变、零报错 —— 实测过的静默错值。必须抛。
  const html = biliCard({
    bv: "BV1ccccccccc", title: "多了一个指标", play: "6.6万", danmaku: "114", extraStat: true,
  });
  assert.throws(
    () => D.bilibili.parse(html),
    /stats--item/,
    "统计项数量变化时必须大声失败，不能静默错位",
  );
}

// ---------------------------------------------------------------- xiaohongshu
function xhsCard({ id, token, liked, withCommentCount = false }) {
  const commentFirst = withCommentCount
    ? `<span class="comment-wrapper"><span class="count">7</span></span>`
    : "";
  return `<section class="note-item" data-note-id="${id}">
    <a class="cover" href="/search_result/${id}?xsec_token=${token}&amp;xsec_source=pc_search"></a>
    <div class="footer">
      <a class="title"><span>笔记 ${id.slice(0, 4)}</span></a>
      <div class="author-wrapper">
        <a class="author" href="/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=T"><span class="name">作者</span></a>
        ${commentFirst}
        <span class="like-wrapper like-active"><span class="count">${liked}</span></span>
      </div>
      <div class="time">07-15</div>
    </div></section>`;
}

{
  const html = xhsCard({ id: "68b6891b000000001c0306b8", token: "ABtok1", liked: "8319" });
  const items = D.xiaohongshu.parse(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "68b6891b000000001c0306b8");
  assert.equal(items[0].metrics.liked_count, 8319);
  assert.ok(items[0].open_url.includes("xsec_token=ABtok1"), "open_url 必须带 token，否则笔记打不开");
  assert.equal(items[0].xsec_token, "ABtok1");
}

{
  // 点赞数作用域。小红书 CSS 里已经存在 comment-wrapper，只差一个开关；一旦它
  // 排在点赞前面，"卡内第一个 .count" 会静默把评论数当成点赞数。
  const html = xhsCard({
    id: "68b6891b000000001c0306b9", token: "ABtok2", liked: "8319", withCommentCount: true,
  });
  const items = D.xiaohongshu.parse(html);
  assert.equal(items.length, 1);
  assert.equal(
    items[0].metrics.liked_count, 8319,
    "点赞数必须取自 like-wrapper 内部，不能被前面的评论数顶掉",
  );
}

// ---------------------------------------------------------------- zhihu
function zhihuCard({ kind, id, qid, voteup, comment, classOrder = "normal" }) {
  const cardCls = classOrder === "swapped" ? "SearchResult-Card Card" : "Card SearchResult-Card";
  const itemCls =
    classOrder === "swapped"
      ? `${kind === "answer" ? "AnswerItem" : "ArticleItem"} ContentItem`
      : `ContentItem ${kind === "answer" ? "AnswerItem" : "ArticleItem"}`;
  const link =
    kind === "answer"
      ? `<a href="/question/${qid}/answer/${id}">标题</a>`
      : `<a href="//zhuanlan.zhihu.com/p/${id}">标题</a>`;
  return `<div class="${cardCls}"><div class="${itemCls}" name="${id}">
    <h2 class="ContentItem-title"><span class="Highlight">知乎标题 ${id}</span>${link}</h2>
    <button>赞同 ${voteup}</button><button>${comment} 条评论</button>
  </div></div>`;
}

{
  const normal =
    zhihuCard({ kind: "answer", id: "2058589191940871354", qid: "2058544568744907558", voteup: 3, comment: 0 }) +
    zhihuCard({ kind: "article", id: "2029618678237262953", voteup: 22, comment: 7 });
  const base = D.zhihu.parseSearchHtml(normal);
  assert.equal(base.length, 2, "回答卡与文章卡都应被识别");

  // class 是无序 token 集合。仅调换书写顺序曾让解析从 17 条变 0 条。
  const swapped =
    zhihuCard({ kind: "answer", id: "2058589191940871354", qid: "2058544568744907558", voteup: 3, comment: 0, classOrder: "swapped" }) +
    zhihuCard({ kind: "article", id: "2029618678237262953", voteup: 22, comment: 7, classOrder: "swapped" });
  assert.equal(
    D.zhihu.parseSearchHtml(swapped).length, 2,
    "class 书写顺序变化不能让解析归零",
  );
}

// ---------------------------------------------------------------- canary
{
  const { check } = D.canary;

  // 事故 1：CDP getOuterHTML 超时 → HTML 变 0 字节 → 解析出 0 条。
  for (const p of ["bilibili", "zhihu", "douyin", "xiaohongshu"]) {
    const r = check(p, []);
    assert.equal(r.ok, false, `${p}: 空结果必须被拦下，而不是当成"今天没候选"`);
    assert.match(r.failures.join(""), /条数/);
  }

  // 事故 2：小红书 token 缺失 —— 没有 token 的候选是打不开的死候选。
  const half = Array.from({ length: 20 }, (_, i) => ({
    open_url: "u", xsec_token: i < 10 ? "t" : null,
  }));
  const r = check("xiaohongshu", half);
  assert.equal(r.ok, false);
  assert.match(r.failures.join(""), /xsec_token/);

  // 正常批次必须放行，否则断言会变成噪音而被忽略。
  const healthy = Array.from({ length: 30 }, (_, i) => ({
    title: `t${i}`, open_url: "u", xsec_token: "t",
  }));
  assert.equal(check("xiaohongshu", healthy).ok, true, "健康批次不能误报");
}

// ---------------------------------------------------------------- 入口
{
  assert.equal(D.parseFor("weibo", "<html></html>"), null, "未知平台返回 null，不抛");
  assert.ok(Array.isArray(D.parseFor("bilibili", "")), "已知平台走对应解析器");
}

console.log("discovery-parsers-smoke: OK");
