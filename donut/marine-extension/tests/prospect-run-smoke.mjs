// prospect-run.js 回归测试 —— 发现侧编排的决策路径。
//
// 编排本身没有难算法，风险全在「什么时候该停」。这些用例钉住的正是那些
// 停不住就会出事的分支：
//   · 未登录还继续搜 —— 搜不出东西，只留下风控足迹
//   · 「判断不了」被当成「未登录」—— 会把健康账号废掉
//   · 解析塌陷了还往台账灌 —— 脏数据一旦入库就分不清了
//   · SPA 每次路由变化都重跑 —— 同一批候选反复入账
//   · 自动发布 —— 产品红线，编排必须停在「打开靶子」
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
// vm 沙箱默认没有 URL/URLSearchParams（浏览器里是有的），不补进去
// platformOfSearchPage 会因为 new URL 抛错而一律返回 null。
const ctx = { console, URL, URLSearchParams };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.resolve(here, "../src/platforms/prospect-run.js"), "utf8"),
  ctx,
);
const R = ctx.marineProspectRun;

const SEARCH = {
  bilibili: "https://search.bilibili.com/all?keyword=%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7&order=click",
  zhihu: "https://www.zhihu.com/search?type=content&q=%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7",
  douyin: "https://www.douyin.com/search/%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7",
  xiaohongshu: "https://www.xiaohongshu.com/search_result?keyword=%E7%A7%91%E7%A0%94%E5%B7%A5%E5%85%B7",
};

// ---------------------------------------------------------------- 页面识别
for (const [plat, url] of Object.entries(SEARCH)) {
  assert.equal(R.platformOfSearchPage(url), plat, `${plat} 搜索页应被识别`);
  assert.equal(R.keywordOf(url), "科研工具", `${plat} 关键词应能取出`);
}
// 详情页/首页不该触发编排
for (const url of [
  "https://www.bilibili.com/video/BV1aaaaaaaaa/",
  "https://www.bilibili.com/",
  "https://www.zhihu.com/question/123/answer/456",
  "https://www.xiaohongshu.com/explore/68b6891b000000001c0306b8",
  "https://www.douyin.com/video/7550160854285684020",
]) {
  assert.equal(R.platformOfSearchPage(url), null, `${url} 不该被当成搜索页`);
}
assert.equal(R.platformOfSearchPage("not a url"), null, "坏 URL 不该抛");

// ---------------------------------------------------------------- 幂等
//
// 标记的落点是这次修复的核心。早期版本在 shouldRun 里就落标记，等于把「这次
// 没跑成」也算成「跑过了」—— 知乎实测：document_idle 时 SPA 还没渲染出结果，
// canary 判 unhealthy 直接停，而标记已落，渲染完也永远不再跑（零 API 调用）。
{
  const mk = () => {
    const store = new Map();
    return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  };

  {
    const storage = mk();
    assert.equal(R.shouldRun(SEARCH.bilibili, storage), true, "首次应当跑");
    assert.equal(R.shouldRun(SEARCH.bilibili, storage), true,
      "shouldRun 只做检查、不落标记 —— 落标记是 markDone 的事");
    assert.equal(R.shouldRun("https://www.bilibili.com/", storage), false, "非搜索页永远不跑");
  }

  {
    // 终局：落标记，不再重跑
    const storage = mk();
    for (const terminal of ["claimed", "nothing_to_claim", "not_logged_in"]) {
      const s2 = mk();
      assert.equal(R.isTerminal(terminal), true, `${terminal} 应当是终局`);
      assert.equal(R.markDone(SEARCH.zhihu, terminal, s2), true);
      assert.equal(R.shouldRun(SEARCH.zhihu, s2), false, `${terminal} 之后不该重跑`);
    }
    void storage;
  }

  {
    // 非终局：不落标记，保持可重试。这正是知乎那个 bug 的修复点。
    const storage = mk();
    for (const pending of ["unhealthy", "login_unknown", "error", "no_profile_id"]) {
      assert.equal(R.isTerminal(pending), false, `${pending} 不该算终局`);
      assert.equal(R.markDone(SEARCH.zhihu, pending, storage), false);
      assert.equal(R.shouldRun(SEARCH.zhihu, storage), true,
        `${pending} 之后必须还能重试 —— SPA 渲染完才够解析`);
    }
  }

  {
    // 换了搜索页要重新开始
    const storage = mk();
    R.markDone(SEARCH.bilibili, "claimed", storage);
    assert.equal(R.shouldRun(SEARCH.zhihu, storage), true, "换了搜索页应当再跑");
  }

  {
    // 标记的生存期只能是「一个 document」。
    //
    // 实测踩过：原来存在 sessionStorage，而 Chromium 会把它**持久化**用于会话
    // 恢复，app 又带 --restore-last-session 启动 —— 标记跨浏览器重启存活，同一个
    // profile 的同一个搜索 URL 一辈子只跑一次。第一轮正常，之后每一轮零日志、
    // 零 API 调用、浏览器停在搜索页。profile 的 Default/Session Storage 里能直接
    // grep 出这个键。
    const src = fs.readFileSync(path.resolve(here, "../src/platforms/prospect-run.js"), "utf8");
    const code = src.split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    assert.ok(
      !code.includes("sessionStorage"),
      "幂等标记不能碰 sessionStorage —— 它会被持久化用于会话恢复，导致同一 URL 永不重跑",
    );
    assert.ok(
      !code.includes("localStorage"),
      "更不能用 localStorage —— 那连浏览器重装都活得下来",
    );

    // 不传 storage 时也要正常工作，而且两次独立的判断互不串味（同一个模块内
    // 的默认存放处是共享的，所以只验「记了就挡、没记就放」）。
    const fresh = "https://search.bilibili.com/all?keyword=" + encodeURIComponent("默认存放处");
    assert.equal(R.shouldRun(fresh), true, "没记过就该跑");
    R.markDone(fresh, "claimed");
    assert.equal(R.shouldRun(fresh), false, "记过了就该挡住");
  }
}

// ---------------------------------------------------------------- 依赖桩
function deps(over) {
  const calls = { api: [], navigated: [] };
  const base = {
    href: SEARCH.bilibili,
    profileId: "p1",
    login: async () => ({ loggedIn: true, evidence: "platform_confirmed" }),
    pageHtml: () => "<html/>",
    parse: () => [
      { id: "BV1aaaaaaaaa", title: "A", open_url: "https://www.bilibili.com/video/BV1aaaaaaaaa/" },
      { id: "BV1bbbbbbbbb", title: "B", open_url: "https://www.bilibili.com/video/BV1bbbbbbbbb/" },
    ],
    canary: () => ({ ok: true, failures: [] }),
    api: async (route, body) => {
      calls.api.push({ route, body });
      if (route === "prospects/ingest") return { inserted: 2, refreshed: 0, already_known: 0 };
      if (route === "prospects/claim") {
        return { key: "bilibili:BV1aaaaaaaaa", title: "A",
                 open_url: "https://www.bilibili.com/video/BV1aaaaaaaaa/" };
      }
      return null;
    },
    navigate: (u) => calls.navigated.push(u),
    // 交接单在 SW 侧（按 tab），不是 sessionStorage —— B 站搜索页和靶子页不同源。
    handoffStore: (() => {
      let cell = null;
      return {
        read: async () => cell,
        write: async (v) => { cell = v; calls.handoff = v; return true; },
        clear: async () => { cell = null; },
      };
    })(),
  };
  return [Object.assign(base, over || {}), calls];
}

// ---------------------------------------------------------------- 正常路径
{
  const [d, calls] = deps();
  const r = await R.run(d);
  assert.equal(r.status, "claimed");
  assert.equal(r.count, 2);
  assert.deepStrictEqual([...calls.api].map((c) => c.route),
    ["prospects/ingest", "prospects/claim"], "必须先入账再领取");
  assert.equal(calls.api[0].body.candidates.length, 2);
  assert.equal(calls.api[0].body.candidates[0].keyword, "科研工具", "关键词应随候选入账");
  assert.deepStrictEqual([...calls.navigated],
    ["https://www.bilibili.com/video/BV1aaaaaaaaa/"], "应当导航到领到的靶子");
}

// ------------------------------------------- 交接单写不下就绝不能导航
{
  // 导航了但交接单没写成 = 打开一个没人接手的页面，还把这条靶子卡在 claimed
  // 直到 6 小时 TTL 过期。宁可不走这一步。
  const [d, calls] = deps({
    handoffStore: { read: async () => null, write: async () => false, clear: async () => {} },
  });
  const r = await R.run(d);
  assert.equal(r.status, "handoff_write_failed");
  assert.deepStrictEqual([...calls.navigated], [], "交接单没写成就不该导航");
}

// ------------------------------------------- 交接单必须在导航之前写完
{
  // 顺序错了就会丢：导航一旦发生，这段脚本随页面卸载，没 await 完的写入不会完成。
  const order = [];
  const [d] = deps({
    handoffStore: {
      read: async () => null,
      write: async () => { order.push("write"); return true; },
      clear: async () => {},
    },
    navigate: () => order.push("navigate"),
  });
  await R.run(d);
  assert.deepStrictEqual(order, ["write", "navigate"],
    "交接单必须先落定再导航");
}

// ---------------------------------------------------------------- 未登录必须停
{
  const [d, calls] = deps({ login: async () => ({ loggedIn: false, evidence: "platform_rejected" }) });
  const r = await R.run(d);
  assert.equal(r.status, "not_logged_in");
  assert.deepStrictEqual([...calls.api], [], "未登录时不该产生任何台账写入");
  assert.deepStrictEqual([...calls.navigated], [], "也不该导航");
}

// ---------------------------------------------------------------- 未知 ≠ 未登录
{
  const [d] = deps({ login: async () => ({ loggedIn: null, evidence: "verify_failed" }) });
  const r = await R.run(d);
  assert.equal(r.status, "login_unknown",
    "判断不了要单独报告，好让上层选择稍后重试而不是去重新登录");
}

// ---------------------------------------------------------------- 体检不过不入账
{
  const [d, calls] = deps({
    parse: () => [],                                    // 解析塌陷：静默返回空
    canary: () => ({ ok: false, failures: ["条数 0 < 下界 15"] }),
  });
  const r = await R.run(d);
  assert.equal(r.status, "unhealthy");
  assert.deepStrictEqual([...calls.api], [],
    "体检不过时必须在写台账之前停住 —— 脏数据入库后就分不清了");
}

// ---------------------------------------------------------------- 没得领不是错误
{
  const [d, calls] = deps({
    api: async (route, body) => {
      if (route === "prospects/ingest") return { inserted: 0, already_known: 2, refreshed: 0 };
      return null;                                       // claim 返回 null
    },
  });
  const r = await R.run(d);
  assert.equal(r.status, "nothing_to_claim", "整批都被做过是正常结局");
  assert.deepStrictEqual([...calls.navigated], [], "没领到就不该导航");
}

// ------------------------------------------------- 终止点必须是显式且可测的
{
  const mkFlagStore = () => {
    let cell = null;
    return { read: async () => cell, write: async (v) => { cell = v; return true; }, clear: async () => { cell = null; } };
  };
  // 「绝不自动发布」这道硬编码闸已按运营决定移除，换成显式的 stopAfter 配置。
  // 但发送仍是整条链里唯一不可逆的动作，所以要钉住：当前阶段的默认终止点是
  // 'fill'（停在点发送的前一步），而不是悄悄变成 'send'。
  const src = fs.readFileSync(path.resolve(here, "../src/platforms/prospect-run.js"), "utf8");
  assert.ok(src.includes("stopAfter"), "终止点必须是显式配置，不能散落在各处 if 里");

  // 发送是**逐平台**放开的，不是一个全局开关。判据不是「点得到按钮」而是
  // 「能确认平台收下了」—— 只有做了回执检测的平台才允许进 send。
  assert.ok(src.includes("SEND_ENABLED_PLATFORMS"), "开哪些平台的发送必须是一个一眼可见的列表");
  assert.equal(R.stopAfterFor("bilibili"), "send", "B 站回执链路已就绪，允许发送");
  assert.equal(R.stopAfterFor("zhihu"), "send", "知乎回执链路已就绪（comment_v5 的正数 id），允许发送");
  assert.equal(R.stopAfterFor("xiaohongshu"), "send", "小红书回执链路已就绪");
  assert.equal(R.stopAfterFor("douyin"), "send", "抖音回执链路已就绪");
  // 未知平台一律保守
  assert.equal(R.stopAfterFor("weibo"), "fill", "没见过的平台必须停在 fill");

  // 交接单不传 stopAfter 时，按平台推导
  {
    const st = mkFlagStore();
    await R.writeHandoff({ handoffStore: st },
      { key: "bilibili:X", platform: "bilibili", open_url: "https://b/x" }, "p1");
    assert.equal((await st.read()).stopAfter, "send", "B 站默认进 send");
    const st2 = mkFlagStore();
    await R.writeHandoff({ handoffStore: st2 },
      { key: "weibo:Y", platform: "weibo", open_url: "https://w/y" }, "p1");
    assert.equal((await st2.read()).stopAfter, "fill", "没有回执检测的平台必须停在 fill");
  }

  // 掉登录才上报 —— 已登录不报（没信息量）。
  // 但「判断不了」必须**报**且和「确认登出」分开：把网络抖动当成登出，
  // 运营会去重新登录一个其实健康的账号。
  {
    const reported = [];
    const [d] = deps();
    d.reportLogin = (r) => { reported.push(r); };

    d.login = async () => ({ loggedIn: true, evidence: "platform_confirmed" });
    await R.run(d);
    assert.equal(reported.length, 0, "已登录不该上报");

    d.login = async () => ({ platform: "zhihu", loggedIn: false, evidence: "platform_rejected" });
    await R.run(d);
    assert.equal(reported.length, 1, "确认登出必须上报");
    assert.equal(reported[0].loggedIn, false);

    d.login = async () => ({ platform: "zhihu", loggedIn: null, evidence: "verify_failed" });
    await R.run(d);
    assert.equal(reported.length, 2, "判断不了也要上报 —— 它不是「正常」，只是还没定论");
    assert.equal(reported[1].loggedIn, null, "三态不能在上报时被压成两态");
  }

  // 编排自身仍然只碰台账端点：生成/发送走的是另一条既有链路。
  const [d, calls] = deps();
  await R.run(d);
  assert.ok(
    calls.api.every((c) => c.route.startsWith("prospects/")),
    "编排只允许调用台账相关端点",
  );
}

// ---------------------------------------------------------------- 缺 profileId
{
  const [d, calls] = deps({ profileId: null });
  assert.equal((await R.run(d)).status, "no_profile_id");
  assert.deepStrictEqual([...calls.api], [], "没有账号身份就不能写跨账号台账");
}


// ================= Phase B：靶子页生成 + 填入 + 记录 =================
//
// 这一段的重点全在「无论怎么结束都要留下记录」。运营决定是失败不重试，所以
// 一次没记上的失败就是永久丢失的信息。
{
  // 交接单现在存在 SW 侧（按 tab），不是 sessionStorage —— 后者按 origin 分区，
  // 而 B 站搜索页和靶子页永远不同源。这里用一个等价的异步假实现。
  const mkStore = (seed) => {
    let cell = seed === undefined ? null : seed;
    return {
      read: async () => cell,
      write: async (v) => { cell = v; return true; },
      clear: async () => { cell = null; },
    };
  };
  const CLAIM = { key: "bilibili:BV1", platform: "bilibili", open_url: "https://www.bilibili.com/video/BV1/" };
  const handoffFor = (stopAfter, hops) => ({
    key: CLAIM.key, platform: CLAIM.platform, open_url: CLAIM.open_url,
    profileId: "p1", stopAfter: stopAfter || "fill", at: 0, hops: hops || 0,
  });

  const tdeps = (over) => {
    const calls = [];
    const storage = mkStore(handoffFor((over && over.stopAfter) || "fill"));
    const handoffStore = storage;
    return [Object.assign({
      handoffStore,
      href: CLAIM.open_url,
      generateAndFill: async () => ({ ok: true, text: "一条直评" }),
      send: async () => ({ ok: true }),
      api: async (route, body) => { calls.push({ route, state: body && body.state }); return {}; },
    }, over || {}), calls, storage];
  };

  // 交接单：Phase A 写、Phase B 认领
  {
    const st = mkStore();
    assert.equal(await R.readHandoff({ handoffStore: st }), null, "没有交接单时应为 null");
    await R.writeHandoff({ handoffStore: st }, CLAIM, "p1", "fill");
    const h = await R.readHandoff({ handoffStore: st });
    assert.equal(h.key, "bilibili:BV1");
    assert.equal(h.stopAfter, "fill");
  }

  // 没有交接单 = 这个页面不是编排打开的，必须完全不动
  {
    const calls = [];
    const r = await R.runOnTarget({ handoffStore: mkStore(), api: async (route) => { calls.push(route); } });
    assert.equal(r.status, "no_handoff");
    assert.deepStrictEqual([...calls], [], "非编排页面不该产生任何记录");
  }

  // 正常路径：填入 -> settle(filled)
  {
    const [d, calls, storage] = tdeps();
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "filled");
    assert.equal(r.text, "一条直评");
    assert.deepStrictEqual([...calls], [{ route: "prospects/settle", state: "filled" }]);
    assert.equal(await R.readHandoff({ handoffStore: storage }), null, "跑完必须清掉交接单");
  }

  // 当前阶段绝不发送
  {
    let sendCalled = false;
    const [d] = tdeps({ send: async () => { sendCalled = true; return { ok: true }; } });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "filled");
    assert.equal(sendCalled, false, "stopAfter=fill 时绝不能调用 send");
  }

  // 生成失败 -> settle(failed)，且不重试（交接单被清掉）
  {
    const [d, calls, storage] = tdeps({ generateAndFill: async () => ({ ok: false, error: "定位不到输入框" }) });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "fill_failed");
    assert.deepStrictEqual([...calls], [{ route: "prospects/settle", state: "failed" }]);
    assert.equal(await R.readHandoff({ handoffStore: storage }), null,
      "失败也要清交接单 —— 留着会让下次进这个页面又试一遍，与「不重试」矛盾");
  }

  // generateAndFill 抛异常也要记，不能让异常吃掉记录
  {
    const [d, calls] = tdeps({ generateAndFill: async () => { throw new Error("boom"); } });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "fill_failed");
    assert.deepStrictEqual([...calls], [{ route: "prospects/settle", state: "failed" }]);
  }

  // settle 自身失败不该改变结论 —— 已经填进去的事实不会因此撤销
  {
    const [d] = tdeps({ api: async () => { throw new Error("台账不可达"); } });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "filled", "记录失败只影响台账，不改变本轮判定");
  }

  // 页面已经不是那条靶子了（用户/脚本点走了）
  {
    const [d, calls] = tdeps({ href: "https://www.bilibili.com/video/BV_OTHER/" });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "handoff_url_mismatch");
    assert.deepStrictEqual([...calls], [], "认错页面时不该乱记");
  }

  // 平台会往 URL 追加追踪参数，不能因此判成换了页面
  {
    const [d] = tdeps({ href: CLAIM.open_url + "?spm_id_from=333.337.search-card.all.click" });
    assert.equal((await R.runOnTarget(d)).status, "filled", "query/hash 差异不算换页面");
    assert.equal(R.sameTarget("https://x.com/a/", "https://x.com/a?t=1"), true);
    assert.equal(R.sameTarget("https://x.com/a", "https://x.com/b"), false);
  }

  // stopAfter=send 时才走发送（当前不启用，但路径要是对的）
  {
    const [d, calls] = tdeps({ stopAfter: "send" });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "posted");
    assert.deepStrictEqual([...calls], [{ route: "prospects/settle", state: "posted" }]);
  }
  {
    // 发送实现必须拿到生成出来的文本 —— 它要用来核对输入框里的实际内容，
    // 挡住「只敲了一半就点发布」（实测在知乎发出过一条只有两个字的评论）。
    let gotArgs = null;
    const [d] = tdeps({
      stopAfter: "send",
      generateAndFill: async () => ({ ok: true, text: "完整的一条直评文案" }),
      send: async (platform, text, key) => { gotArgs = [platform, text, key]; return { ok: true }; },
    });
    await R.runOnTarget(d);
    assert.deepStrictEqual(gotArgs, ["bilibili", "完整的一条直评文案", "bilibili:BV1"],
      "send 要收到平台、生成文本和交接单 key —— 文本用来核对草稿完整性，" +
      "key 用来保证同一条只点一次（小红书发完不清空草稿，重试会重复发送）");
  }
  {
    const [d, calls] = tdeps({ stopAfter: "send", send: async () => ({ ok: false, error: "风控拦截" }) });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "send_failed");
    assert.deepStrictEqual([...calls], [{ route: "prospects/settle", state: "failed" }],
      "发送失败要记 failed，而不是 posted");
  }
}

// ---------------------------------------------------------------- 评论区关闭
{
  // 判据本身：三态，只有 true 才会触发换靶子。
  assert.equal(R.commentsClosed("bilibili", "由于UP主隐私设置，你无法评论"), true);
  assert.equal(R.commentsClosed("bilibili", "评论区已关闭"), true);
  assert.equal(R.commentsClosed("bilibili", "UP主已关闭了评论"), true);
  assert.equal(R.commentsClosed("bilibili", "发一条友善的评论"), false,
    "正常的输入框占位符不能算关闭");

  // 还没渲染出来 ≠ 关闭。把空文本判成 true 会让每条靶子一进去就被作废。
  assert.equal(R.commentsClosed("bilibili", ""), null);
  assert.equal(R.commentsClosed("bilibili", null), null);

  // 没实测过的平台一律「判断不了」，绝不猜。猜错的代价是静默跳过本来能评的
  // 靶子，而且 blocked 是全局永久的，事后查不出来。
  for (const p of ["zhihu", "douyin", "xiaohongshu"]) {
    assert.equal(R.commentsClosed(p, "你无法评论"), null,
      `${p} 的关闭文案没实测过，必须返回 null 而不是 true`);
  }
}

// ---------------------------------------------------------------- 换一条靶子
{
  // 交接单现在存在 SW 侧（按 tab），不是 sessionStorage —— 后者按 origin 分区，
  // 而 B 站搜索页和靶子页永远不同源。这里用一个等价的异步假实现。
  const mkStore = (seed) => {
    let cell = seed === undefined ? null : seed;
    return {
      read: async () => cell,
      write: async (v) => { cell = v; return true; },
      clear: async () => { cell = null; },
    };
  };
  const CLAIM = { key: "bilibili:BV1", platform: "bilibili", open_url: "https://www.bilibili.com/video/BV1/" };
  const NEXT = { key: "bilibili:BV2", platform: "bilibili", open_url: "https://www.bilibili.com/video/BV2/", title: "下一条" };

  const closedDeps = (over) => {
    const calls = [];
    const navigated = [];
    const storage = mkStore({
      key: CLAIM.key, platform: CLAIM.platform, open_url: CLAIM.open_url,
      profileId: "p1", stopAfter: "fill", at: 0, hops: (over && over.hops) || 0,
    });
    const handoffStore = storage;
    return [Object.assign({
      handoffStore,
      href: CLAIM.open_url,
      generateAndFill: async () => ({ ok: false, reason: "comments_closed", error: "该内容已关闭评论" }),
      send: async () => ({ ok: true }),
      api: async (route, body) => {
        calls.push({ route, state: body && body.state });
        return route === "prospects/claim" ? NEXT : {};
      },
      navigate: (u) => navigated.push(u),
    }, over || {}), calls, navigated, storage];
  };

  // 关评论 -> 记 blocked（不是 failed）-> claim 下一条 -> 导航过去
  {
    const [d, calls, navigated, storage] = closedDeps();
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "blocked_hopped");
    assert.equal(r.from, "bilibili:BV1");
    assert.equal(r.key, "bilibili:BV2");
    assert.deepStrictEqual([...calls], [
      { route: "prospects/settle", state: "blocked" },
      { route: "prospects/claim", state: undefined },
    ], "必须记 blocked —— failed 只挡本账号，另外几个号还会各撞一次");
    assert.deepStrictEqual([...navigated], [NEXT.open_url]);
    const h = await R.readHandoff({ handoffStore: storage });
    assert.equal(h.key, "bilibili:BV2", "换靶子后要留下新交接单，否则新页面的 Phase B 认不了自己");
    assert.equal(h.hops, 1, "跳数要累加，否则封顶形同虚设");
  }

  // 跳够了就停 —— 一串关评论的视频不能把整批任务卡在一个 profile 上
  {
    const [d, calls, navigated] = closedDeps({ hops: R.MAX_TARGET_HOPS });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "blocked_hop_limit");
    assert.deepStrictEqual([...calls], [{ route: "prospects/settle", state: "blocked" }],
      "封顶了也要把这条记成 blocked");
    assert.deepStrictEqual([...navigated], [], "封顶后不该再导航");
  }

  // 台账里没别的可领了 —— 正常结局，不是错误
  {
    const [d, calls, navigated] = closedDeps({
      api: async (route, body) => { void body; return route === "prospects/claim" ? null : {}; },
    });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "blocked_nothing_left");
    assert.deepStrictEqual([...navigated], [], "没得领就不导航");
    void calls;
  }

  // claim 挂了不能吃掉 blocked 记录
  {
    let settled = null;
    const [d] = closedDeps({
      api: async (route, body) => {
        if (route === "prospects/settle") { settled = body.state; return {}; }
        throw new Error("台账不可达");
      },
    });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "blocked_hop_failed");
    assert.equal(settled, "blocked", "换靶子失败了，但「这条关了评论」这个事实必须已经落账");
  }

  // 换靶子绝不能顺手把发送打开
  {
    let sendCalled = false;
    const [d] = closedDeps({ send: async () => { sendCalled = true; return { ok: true }; } });
    await R.runOnTarget(d);
    assert.equal(sendCalled, false, "换靶子路径同样不许触碰发送");
  }
}

console.log("prospect-run-smoke: OK");
