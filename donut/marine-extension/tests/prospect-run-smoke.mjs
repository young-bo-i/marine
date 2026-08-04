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
const ctx = { console, URL, URLSearchParams, setTimeout, clearTimeout };
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
    for (const terminal of ["claimed", "nothing_to_claim", "not_logged_in", "target_navigation_stalled"]) {
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
    // Phase A 正常空读在单测里不需要真实等待；瞬时恢复由专门用例覆盖。
    handoffReadDelays: [0],
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

// ------------------------------------------- Phase A handoff 空读也要容忍 MV3 瞬时抖动
{
  let reads = 0;
  const [d, calls] = deps({
    handoffReadDelays: [0, 0],
    sleep: async () => {},
    handoffStore: {
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("worker waking");
        return null;
      },
      write: async () => true,
      clear: async () => {},
    },
  });
  const result = await R.run(d);
  assert.equal(result.status, "claimed",
    "首次 read 异常、随后成功确认为空时 Phase A 应继续，不能误报 handoff_read_failed");
  assert.equal(reads, 3,
    "恢复预检成功空读后仍要完成确认窗口，并把历史异常清掉");
  assert.equal(calls.api.filter(call => call.route === "prospects/claim").length, 1);
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

// ------------------------------------------------- 导航 watchdog 终局不能伪装成 claimed
{
  let navigationMeta = null;
  const [d] = deps({
    navigate: async (url, meta) => {
      navigationMeta = meta;
      return {
        status: "target_navigation_stalled",
        expected: url,
        // 刻意让 href 已是目标：字符串变了不代表旧 document 已卸载。
        got: url,
        key: meta.key,
        attempts: 2,
      };
    },
  });
  const r = await R.run(d);
  assert.equal(r.status, "target_navigation_stalled");
  assert.equal(r.expected, "https://www.bilibili.com/video/BV1aaaaaaaaa/");
  assert.equal(r.got, r.expected);
  assert.equal(r.key, "bilibili:BV1aaaaaaaaa");
  assert.equal(navigationMeta.key, "bilibili:BV1aaaaaaaaa");
  assert.equal(navigationMeta.platform, "bilibili");
  assert.equal(navigationMeta.reason, "claim");
  assert.equal(R.isTerminal(r.status), true, "导航停滞已 claim，Phase A 不能再领一条");
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
  assert.equal(calls.api.filter((call) => call.route === "prospects/claim").length, 1);
  assert.equal(R.isTerminal(r.status), true,
    "claim 已发生后写 handoff 失败必须终局，不能整轮重跑再 claim 一条");
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

// ------------------------------------------- Phase A 先恢复旧 settlement，再决定是否 login/claim
{
  const old = {
    key: "zhihu:OLD_POSTED",
    platform: "zhihu",
    open_url: "https://www.zhihu.com/question/1/answer/OLD_POSTED",
    profileId: "old-profile",
    stopAfter: "send",
    at: Date.now() - 60_000,
    sendStarted: true,
    pendingSettlement: "posted",
  };
  let cell = old;
  const order = [];
  const store = {
    read: async () => cell,
    write: async (value) => { cell = value; return true; },
    clear: async () => { cell = null; },
  };
  const [d] = deps({
    handoffStore: store,
    settlementRetryDelays: [0, 0, 0],
    settlementMaxAttempts: 3,
    settlementSleep: async () => {},
    login: async () => { order.push("login"); return { loggedIn: true }; },
    api: async (route, body) => {
      order.push(route);
      if (route === "prospects/settle") {
        assert.equal(cell.key, old.key, "API 成功前必须保留旧 pending handoff");
        assert.equal(cell.pendingSettlement, "posted");
        assert.equal(body.key, old.key);
        return {};
      }
      if (route === "prospects/ingest") return { inserted: 2 };
      if (route === "prospects/claim") {
        return {
          key: "bilibili:AFTER_RECOVERY",
          platform: "bilibili",
          open_url: "https://www.bilibili.com/video/AFTER_RECOVERY/",
        };
      }
      return null;
    },
  });
  const result = await R.run(d);
  assert.equal(result.status, "claimed", "跨平台补 settle 不会结束当前 leg，可继续搜索任务");
  assert.deepStrictEqual(order.slice(0, 2), ["prospects/settle", "login"],
    "旧 settlement 必须早于当前平台登录闸");
  assert.equal(cell.key, "bilibili:AFTER_RECOVERY", "恢复清理后才能写新 handoff");
}

// 同平台 terminal touch 会让 scheduler 立刻结束当前 leg；绝不能在它之后又 claim。
{
  const old = {
    key: "bilibili:SAME_PLATFORM_POSTED",
    platform: "bilibili",
    open_url: "https://www.bilibili.com/video/SAME_PLATFORM_POSTED/",
    profileId: "p1",
    stopAfter: "send",
    at: Date.now() - 60_000,
    sendStarted: true,
    pendingSettlement: "posted",
  };
  let cell = old;
  let loginCalls = 0;
  const apiRoutes = [];
  const [d] = deps({
    handoffStore: {
      read: async () => cell,
      write: async value => { cell = value; return true; },
      clear: async () => { cell = null; },
    },
    login: async () => { loginCalls += 1; return { loggedIn: true }; },
    api: async route => { apiRoutes.push(route); return {}; },
    settlementRetryDelays: [0],
    settlementMaxAttempts: 1,
  });
  const result = await R.run(d);
  assert.equal(result.status, "settled_before_claim");
  assert.equal(result.key, old.key);
  assert.equal(result.state, "posted");
  assert.deepStrictEqual(apiRoutes, ["prospects/settle"]);
  assert.equal(loginCalls, 0, "同平台恢复后不能再进入 login/ingest/claim");
  assert.equal(cell, null);
  const flags = new Map();
  const flagStore = {
    getItem: key => flags.get(key) ?? null,
    setItem: (key, value) => flags.set(key, value),
  };
  assert.equal(R.isTerminal(result.status), true);
  assert.equal(R.markDone(SEARCH.bilibili, result.status, flagStore), true,
    "settled_before_claim 必须立刻落 document terminal，不能在 scheduler poll 前重跑");
}

// blocked 不计 scheduler 的当前平台完成 touch，补记后仍应继续 claim 下一条。
{
  const old = {
    key: "bilibili:SAME_PLATFORM_BLOCKED",
    platform: "bilibili",
    open_url: "https://www.bilibili.com/video/SAME_PLATFORM_BLOCKED/",
    profileId: "p1",
    stopAfter: "send",
    at: Date.now() - 60_000,
    pendingSettlement: "blocked",
  };
  let cell = old;
  const [d] = deps({
    handoffStore: {
      read: async () => cell,
      write: async value => { cell = value; return true; },
      clear: async () => { cell = null; },
    },
    api: async (route) => {
      if (route === "prospects/settle") return {};
      if (route === "prospects/ingest") return { inserted: 1 };
      if (route === "prospects/claim") {
        return {
          key: "bilibili:AFTER_BLOCKED_RECOVERY",
          platform: "bilibili",
          open_url: "https://www.bilibili.com/video/AFTER_BLOCKED_RECOVERY/",
        };
      }
      return null;
    },
    settlementRetryDelays: [0],
    settlementMaxAttempts: 1,
  });
  const result = await R.run(d);
  assert.equal(result.status, "claimed");
  assert.equal(cell.key, "bilibili:AFTER_BLOCKED_RECOVERY");
}

// unconfirmed 与 posted 一样会结束 scheduler leg，恢复后也必须直接终局。
{
  const old = {
    key: "bilibili:SAME_PLATFORM_UNCONFIRMED",
    platform: "bilibili",
    open_url: "https://www.bilibili.com/video/SAME_PLATFORM_UNCONFIRMED/",
    profileId: "p1",
    stopAfter: "send",
    at: Date.now() - 60_000,
    sendStarted: true,
    pendingSettlement: "unconfirmed",
  };
  let cell = old;
  let loginCalls = 0;
  const [d] = deps({
    handoffStore: {
      read: async () => cell,
      write: async value => { cell = value; return true; },
      clear: async () => { cell = null; },
    },
    login: async () => { loginCalls += 1; return { loggedIn: true }; },
    api: async route => {
      assert.equal(route, "prospects/settle");
      return {};
    },
    settlementRetryDelays: [0],
    settlementMaxAttempts: 1,
  });
  const result = await R.run(d);
  assert.equal(result.status, "settled_before_claim");
  assert.equal(result.state, "unconfirmed");
  assert.equal(loginCalls, 0);
  assert.equal(R.isTerminal(result.status), true);
}

{
  const old = {
    key: "bilibili:OLD_FAILED_SETTLE",
    platform: "bilibili",
    open_url: "https://www.bilibili.com/video/OLD_FAILED_SETTLE/",
    profileId: "old-profile",
    stopAfter: "send",
    at: Date.now() - 60_000,
    sendStarted: true,
    pendingSettlement: "posted",
  };
  let cell = old;
  let loginCalls = 0;
  let claimCalls = 0;
  const [d] = deps({
    handoffStore: {
      read: async () => cell,
      write: async (value) => { cell = value; return true; },
      clear: async () => { cell = null; },
    },
    settlementRetryDelays: [0, 0, 0],
    settlementMaxAttempts: 3,
    settlementSleep: async () => {},
    login: async () => { loginCalls += 1; return { loggedIn: false }; },
    api: async (route) => {
      if (route === "prospects/claim") claimCalls += 1;
      throw new Error("settle API unavailable");
    },
  });
  const result = await R.run(d);
  assert.equal(result.status, "settle_failed");
  assert.equal(result.recoverable, true);
  assert.deepStrictEqual([loginCalls, claimCalls], [0, 0],
    "恢复失败时不能被当前平台掉登录截断，更不能 claim");
  assert.equal(cell.key, old.key);
  assert.equal(cell.pendingSettlement, "posted", "旧 pending 绝不能被新 handoff 覆盖");
}

// ---------------------------------------------------------------- 未登录必须停
{
  const [d, calls] = deps({ login: async () => ({ loggedIn: false, evidence: "platform_rejected" }) });
  const r = await R.run(d);
  assert.equal(r.status, "not_logged_in");
  assert.deepStrictEqual([...calls.api], [], "未登录时不该产生任何台账写入");
  assert.deepStrictEqual([...calls.navigated], [], "也不该导航");
}

// ------------------------------------------- 普通旧 handoff 要恢复导航，不能短路后续平台
{
  const old = {
    key: "bilibili:RESUME_OLD_HANDOFF",
    platform: "bilibili",
    open_url: "https://www.bilibili.com/video/RESUME_OLD_HANDOFF/",
    profileId: "p1",
    stopAfter: "send",
    at: Date.now(),
  };
  let loginCalls = 0;
  let apiCalls = 0;
  let navigationMeta = null;
  const [d] = deps({
    handoffReadDelays: [0],
    handoffStore: {
      read: async () => old,
      write: async () => true,
      clear: async () => { throw new Error("普通 handoff 不得清掉"); },
    },
    login: async () => { loginCalls += 1; return { loggedIn: true }; },
    api: async () => { apiCalls += 1; return null; },
    navigate: async (url, meta) => {
      assert.equal(url, old.open_url);
      navigationMeta = meta;
      return {
        status: "target_navigation_stalled",
        expected: url,
        got: url,
        key: old.key,
        attempts: 2,
      };
    },
  });
  const result = await R.run(d);
  assert.equal(result.status, "target_navigation_stalled");
  assert.equal(result.resumed, true);
  assert.equal(navigationMeta.reason, "handoff_resume");
  assert.deepStrictEqual([loginCalls, apiCalls], [0, 0],
    "恢复旧 handoff 时不能登录/ingest/claim 新任务");
}

// 已进入下一平台 search 时，旧平台 plain handoff 不得把当前 leg 劫回去。
{
  const old = {
    key: "bilibili:STALE_BEFORE_ZHIHU",
    platform: "bilibili",
    open_url: "https://www.bilibili.com/video/STALE_BEFORE_ZHIHU/",
    profileId: "p1",
    stopAfter: "send",
    at: Date.now() - 60_000,
  };
  let cell = old;
  const routes = [];
  const navigated = [];
  const target = {
    key: "zhihu:CURRENT_LEG_TARGET",
    platform: "zhihu",
    open_url: "https://www.zhihu.com/question/1/answer/CURRENT_LEG_TARGET",
  };
  const [d] = deps({
    href: SEARCH.zhihu,
    handoffReadDelays: [0],
    handoffStore: {
      read: async () => cell,
      write: async value => { cell = value; return true; },
      clear: async () => { cell = null; },
    },
    api: async (route, body) => {
      routes.push({ route, body });
      if (route === "prospects/settle") return {};
      if (route === "prospects/ingest") return { inserted: 1 };
      if (route === "prospects/claim") return target;
      return null;
    },
    navigate: async url => { navigated.push(url); },
    settlementRetryDelays: [0],
    settlementMaxAttempts: 1,
  });
  const result = await R.run(d);
  assert.equal(result.status, "claimed");
  assert.equal(routes[0].route, "prospects/settle");
  assert.equal(routes[0].body.key, old.key);
  assert.equal(routes[0].body.state, "failed");
  assert.deepStrictEqual(navigated, [target.open_url],
    "Bili plain handoff 应安全终结，Zhihu leg 只能导航自己的新目标");
  assert.equal(cell.key, target.key);
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
    const runLogin = async (login) => {
      const [d] = deps({
        login: async () => login,
        reportLogin: (r) => { reported.push(r); },
      });
      return await R.run(d);
    };

    await runLogin({ loggedIn: true, evidence: "platform_confirmed" });
    assert.equal(reported.length, 0, "已登录不该上报");

    await runLogin({ platform: "zhihu", loggedIn: false, evidence: "platform_rejected" });
    assert.equal(reported.length, 1, "确认登出必须上报");
    assert.equal(reported[0].loggedIn, false);

    await runLogin({ platform: "zhihu", loggedIn: null, evidence: "verify_failed" });
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
    profileId: "p1", stopAfter: stopAfter || "fill", at: Date.now(), hops: hops || 0,
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
      settlementRetryDelays: [0, 0, 0],
      settlementMaxAttempts: 3,
      settlementSleep: async () => {},
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

  // 还没进入发送阶段的旧/坏交接单必须在任何生成前清理。tab 恢复时
  // 把数小时前的详情页当成当前任务，比放弃这张未开始的交接单危险得多。
  {
    const invalidTimes = [
      ["超时", Date.now() - R.HANDOFF_TTL_MS - 1],
      ["缺失", undefined],
      ["非法", "not-a-timestamp"],
    ];
    for (const [label, at] of invalidTimes) {
      const handoff = { ...handoffFor("send"), key: `bilibili:expired-${label}`, at };
      const storage = mkStore(handoff);
      let generated = 0;
      let sent = 0;
      let settled = 0;
      const r = await R.runOnTarget({
        handoffStore: storage,
        href: handoff.open_url,
        generateAndFill: async () => { generated += 1; return { ok: true, text: "不该生成" }; },
        send: async () => { sent += 1; return { ok: true }; },
        api: async () => { settled += 1; return {}; },
      });
      assert.equal(r.status, "handoff_expired", `${label}的预发送交接单应过期`);
      assert.equal(await storage.read(), null, `${label}的交接单应被清理`);
      assert.deepStrictEqual([generated, sent, settled], [0, 0, 0],
        "过期交接单不能生成、发送或改写台账");
    }
  }

  // TTL 只能清预发送交接单。旧 pending settlement 是防重凭据，必须只补
  // settle；即使没有 sendStarted，pendingSettlement 本身也足以禁止过期清理。
  {
    const handoff = {
      ...handoffFor("send"),
      key: "bilibili:old-pending-settlement",
      at: Date.now() - R.HANDOFF_TTL_MS - 1,
      pendingSettlement: "posted",
    };
    const storage = mkStore(handoff);
    let generated = 0;
    let sent = 0;
    let settled = 0;
    const r = await R.runOnTarget({
      handoffStore: storage,
      href: handoff.open_url,
      generateAndFill: async () => { generated += 1; return { ok: true, text: "不应重生成" }; },
      send: async () => { sent += 1; return { ok: true }; },
      api: async (route, body) => {
        assert.equal(route, "prospects/settle");
        assert.equal(body.state, "posted");
        settled += 1;
        return {};
      },
    });
    assert.equal(r.status, "settled_after_retry");
    assert.deepStrictEqual([generated, sent, settled], [0, 0, 1],
      "旧 pending settlement 只能补记，不能重新生成或点击");
    assert.equal(await storage.read(), null, "补记成功后才清交接单");
  }

  // sendStarted 即使暂时没有 pending state 也不能被 TTL 清掉。
  {
    const handoff = {
      ...handoffFor("send"),
      key: "bilibili:old-send-started",
      at: Date.now() - R.HANDOFF_TTL_MS - 1,
      sendStarted: true,
    };
    const storage = mkStore(handoff);
    const r = await R.runOnTarget({ handoffStore: storage, href: handoff.open_url });
    assert.equal(r.status, "send_already_started");
    assert.ok(await storage.read(), "已开始发送的旧交接单必须保留");
  }

  // 新文档与 MV3 worker 启动有竞态：瞬时异常/空读都要在短窗口内恢复。
  {
    let reads = 0;
    let generated = 0;
    let began = 0;
    let ended = 0;
    const handoff = {
      ...handoffFor("fill"),
      key: "bilibili:single-flight",
      open_url: "https://www.bilibili.com/video/SINGLE_FLIGHT/",
    };
    const store = {
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("worker waking");
        if (reads === 2) return null;
        return handoff;
      },
      write: async () => true,
      // 模拟 clear 瞬时失败后交接单仍在；document 内的 started-key 仍要挡住重跑。
      clear: async () => { throw new Error("storage busy"); },
    };
    const d = {
      handoffStore: store,
      handoffReadDelays: [0, 0, 0],
      sleep: async () => {},
      href: handoff.open_url,
      settlementRetryDelays: [0, 0, 0],
      settlementMaxAttempts: 3,
      settlementSleep: async () => {},
      beginTarget: async () => { began += 1; },
      endTarget: async () => { ended += 1; },
      generateAndFill: async () => { generated += 1; return { ok: true, text: "只生成一次" }; },
      api: async () => ({}),
    };

    const [a, b] = await Promise.all([
      R.runOnTargetSingleFlight(d),
      R.runOnTargetSingleFlight(d),
    ]);
    assert.equal(a.status, "settle_failed");
    assert.equal(b.status, "settle_failed");
    assert.equal(a.stage, "clear", "API 成功但 handoff 未清理时不能误报 filled");
    assert.equal(reads, 3, "并发 bootstrap 必须共用同一条 handoff 重试链");
    assert.equal(generated, 1, "single-flight 只能驱动一次真实生成");
    assert.equal(began, 1);
    assert.equal(ended, 1, "成功或失败都必须成对退出编排模式");

    const duplicate = await R.runOnTargetSingleFlight(d);
    assert.equal(duplicate.status, "target_already_started",
      "交接单清理失败时，同一 document 也不能再次执行不可逆动作");
    assert.equal(generated, 1);
  }

  // 重试窗口耗尽后要给出可区分的 transport/storage 状态，且不能把 flight 永久锁死。
  {
    let value = null;
    let fail = true;
    const handoff = {
      ...handoffFor("fill"),
      key: "bilibili:retry-after-failure",
      open_url: "https://www.bilibili.com/video/RETRY_AFTER_FAILURE/",
    };
    const store = {
      read: async () => {
        if (fail) throw new Error("storage unavailable");
        return value;
      },
      write: async () => true,
      clear: async () => { value = null; },
    };
    const d = {
      handoffStore: store,
      handoffReadDelays: [0, 0],
      sleep: async () => {},
      href: handoff.open_url,
      generateAndFill: async () => ({ ok: true, text: "恢复后执行" }),
      api: async () => ({}),
    };
    const failed = await R.runOnTargetSingleFlight(d);
    assert.equal(failed.status, "handoff_read_failed");
    assert.equal(failed.attempts, 2);
    assert.match(failed.error, /storage unavailable/);

    fail = false;
    value = handoff;
    assert.equal((await R.runOnTargetSingleFlight(d)).status, "filled",
      "前一次读取耗尽不能永久锁住后续恢复");
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

  // settle 失败必须显式返回且保留 handoff；吞掉后清理会让调度器看不到终态。
  {
    const [d, , storage] = tdeps({ api: async () => { throw new Error("台账不可达"); } });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "settle_failed");
    assert.equal(r.state, "filled");
    assert.match(r.error, /台账不可达/);
    assert.equal((await storage.read()).pendingSettlement, "filled",
      "第一次 settle API 之前就必须持久化 terminal state");
  }

  // 短暂 settle 失败在同 document 只补记：不退回 runOnTarget 重生成。
  {
    let generated = 0;
    let settleCalls = 0;
    let cell = handoffFor("fill");
    const store = {
      read: async () => cell,
      write: async (value) => { cell = value; return true; },
      clear: async () => { cell = null; },
    };
    const result = await R.runOnTarget({
      handoffStore: store,
      href: CLAIM.open_url,
      generateAndFill: async () => { generated += 1; return { ok: true, text: "只生成一次" }; },
      settlementRetryDelays: [0, 0, 0],
      settlementMaxAttempts: 3,
      settlementSleep: async () => {},
      api: async (route, body) => {
        assert.equal(route, "prospects/settle");
        assert.equal(cell.pendingSettlement, "filled", "API 前必须看得见可恢复状态");
        assert.equal(body.state, "filled");
        settleCalls += 1;
        if (settleCalls < 3) throw new Error("transient settle failure");
        return {};
      },
    });
    assert.equal(result.status, "filled");
    assert.deepStrictEqual([generated, settleCalls], [1, 3],
      "同 document 恢复只重试 settle，不重复生成");
    assert.equal(cell, null, "API 成功后才清 handoff");
  }

  // 明确 4xx 不是传输抖动，持续 settlement-only 只会白等整条腿。
  {
    const [d, , storage] = tdeps({
      api: async () => { throw new Error("prospects/settle 返回 409"); },
    });
    const result = await R.runOnTarget(d);
    assert.equal(result.status, "settle_failed");
    assert.equal(result.recoverable, false);
    assert.equal(result.attempts, 1, "明确 409 应立即停，不进退避循环");
    assert.equal(await storage.read(), null,
      "nonrecoverable 必须移出 active outbox，否则会永久阻塞该 profile 的新 key");
  }

  // 4xx 已不可恢复，但 durable/local clear 若失败仍不能虚报 nonrecoverable 已清。
  {
    let cell = handoffFor("fill");
    const store = {
      read: async () => cell,
      write: async value => { cell = value; return true; },
      clear: async () => { throw new Error("local storage busy"); },
    };
    const result = await R.runOnTarget({
      handoffStore: store,
      href: CLAIM.open_url,
      generateAndFill: async () => ({ ok: true, text: "已填" }),
      api: async () => { throw new Error("prospects/settle 返回 404"); },
      settlementRetryDelays: [0],
      settlementMaxAttempts: 1,
    });
    assert.equal(result.status, "settle_failed");
    assert.equal(result.recoverable, true,
      "local-first 清理失败时必须保留恢复语义");
    assert.equal(result.stage, "dead_letter");
    assert.equal(cell.pendingSettlement, "filled");
  }

  // dead-letter mutation 自身也可能遇到 MV3/storage 瞬时抖动；正式 document 要留在
  // 同一 settlement-only 循环，只重试 move，不得静置，更不能重复 settle API。
  {
    let cell = handoffFor("fill");
    let apiCalls = 0;
    let deadLetterCalls = 0;
    let generated = 0;
    const store = {
      read: async () => cell,
      write: async value => { cell = value; return true; },
      clear: async () => { cell = null; },
      deadLetter: async () => {
        deadLetterCalls += 1;
        if (deadLetterCalls === 1) throw new Error("storage waking");
        cell = null;
      },
    };
    const result = await R.runOnTarget({
      handoffStore: store,
      href: CLAIM.open_url,
      generateAndFill: async () => { generated += 1; return { ok: true, text: "已填" }; },
      api: async () => {
        apiCalls += 1;
        throw new Error("prospects/settle 返回 409");
      },
      settlementRetryDelays: [0, 0],
      settlementMaxAttempts: 2,
      settlementSleep: async () => {},
    });
    assert.equal(result.status, "settle_failed");
    assert.equal(result.recoverable, false);
    assert.equal(result.deadLetterAttempts, 2);
    assert.deepStrictEqual([generated, apiCalls, deadLetterCalls], [1, 1, 2],
      "第一次 move 失败后只重试 dead-letter，不重复生成/settle API");
    assert.equal(cell, null);
  }

  // 页面已经不是那条靶子了：精确拉回一次，次数先持久化；再错就明确结束。
  {
    const navigated = [];
    const [d, calls, storage] = tdeps({
      href: "https://www.bilibili.com/video/BV_OTHER/",
      navigate: (url) => navigated.push(url),
    });
    const first = await R.runOnTarget(d);
    assert.equal(first.status, "handoff_redirected");
    assert.deepStrictEqual([...navigated], [CLAIM.open_url], "只能精确回到 claim 给出的 URL");
    assert.equal((await storage.read()).mismatchRedirects, 1,
      "必须在导航前持久化次数，否则新 document 会无限重定向");

    const second = await R.runOnTarget(d);
    assert.equal(second.status, "handoff_url_mismatch");
    assert.equal(second.redirects, 1);
    assert.deepStrictEqual([...navigated], [CLAIM.open_url], "同一交接单最多纠正一次");
    assert.deepStrictEqual([...calls], [], "认错页面时不该乱记");
    assert.equal(await storage.read(), null, "纠正一次仍错就是终局，不能把旧 handoff 留在 tab 上");
  }

  // 次数写不下时不能先导航，否则新页面看不到次数，会形成重定向死循环。
  {
    const navigated = [];
    const handoff = handoffFor("fill");
    const r = await R.runOnTarget({
      handoff,
      handoffStore: { read: async () => handoff, write: async () => false, clear: async () => {} },
      href: "https://www.bilibili.com/video/BV_OTHER/",
      navigate: (url) => navigated.push(url),
    });
    assert.equal(r.status, "handoff_redirect_persist_failed");
    assert.deepStrictEqual([...navigated], []);
  }

  // 平台会往 URL 追加追踪参数，不能因此判成换了页面
  {
    const [d] = tdeps({ href: CLAIM.open_url + "?spm_id_from=333.337.search-card.all.click" });
    assert.equal((await R.runOnTarget(d)).status, "filled", "query/hash 差异不算换页面");
    assert.equal(R.sameTarget("https://x.com/a/", "https://x.com/a?t=1"), true);
    assert.equal(R.sameTarget("https://x.com/a", "https://x.com/b"), false);
  }

  // 抖音同一内容会在详情页和精选抽屉之间改写 URL；只认内容 id，不认页面壳。
  {
    const id = "7667516480883379508";
    const modal = `https://www.douyin.com/jingxuan?modal_id=${id}`;
    assert.equal(R.sameTarget(`https://www.douyin.com/video/${id}`, modal), true);
    assert.equal(R.sameTarget(`https://www.douyin.com/note/${id}?from=search`, modal), true);
    assert.equal(
      R.sameTarget(`https://www.douyin.com/video/${id}`, "https://www.douyin.com/jingxuan?modal_id=7667548040672120064"),
      false,
      "精选页展示了另一条内容时仍必须判成真正错页",
    );
    assert.equal(R.sameTarget(modal, "https://www.douyin.com/jingxuan"), false,
      "精选抽屉关闭后没有 target id，不能靠忽略 query 误认成原内容");
    assert.equal(R.sameTarget(modal, "https://www.douyin.com/jingxuan?modal_id=bad"), false,
      "畸形 modal_id 不能被当成同靶子");
  }

  // stopAfter=send 时才走发送；当前四个自动化平台都依赖这条路径。
  {
    const [d, calls] = tdeps({ stopAfter: "send" });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "posted");
    assert.deepStrictEqual([...calls], [
      { route: "prospects/prepare-send", state: undefined },
      { route: "prospects/settle", state: "posted" },
    ]);
  }
  {
    // prepare-send 报错/响应丢失时不能猜成功后点击；guard 已 durable，随后只 settle。
    let cell = handoffFor("send");
    let sent = 0;
    const routes = [];
    const result = await R.runOnTarget({
      handoffStore: {
        read: async () => cell,
        write: async value => { cell = value; return true; },
        clear: async () => { cell = null; },
      },
      href: CLAIM.open_url,
      generateAndFill: async () => ({ ok: true, text: "不会被点击" }),
      send: async () => { sent += 1; return { ok: true }; },
      api: async (route, body) => {
        routes.push(route);
        if (route === "prospects/prepare-send") {
          assert.equal(cell.sendStarted, true, "prepare 前 durable send guard 必须已落定");
          assert.equal(cell.pendingSettlement, "failed");
          assert.equal(body.key, CLAIM.key);
          throw new Error("prepare response lost");
        }
        assert.equal(route, "prospects/settle");
        assert.equal(body.state, "failed");
        return {};
      },
      settlementRetryDelays: [0],
      settlementMaxAttempts: 1,
    });
    assert.equal(result.status, "prepare_send_failed");
    assert.equal(sent, 0, "prepare 失败绝不能调用 send/click");
    assert.deepStrictEqual(routes, ["prospects/prepare-send", "prospects/settle"]);
    assert.equal(cell, null, "failed settle 成功后才清 durable guard");
  }
  {
    // 发送实现必须拿到生成出来的文本 —— 它要用来核对输入框里的实际内容，
    // 挡住「只敲了一半就点发布」（实测在知乎发出过一条只有两个字的评论）。
    let gotArgs = null;
    const [d, , storage] = tdeps({
      stopAfter: "send",
      generateAndFill: async () => ({ ok: true, text: "完整的一条直评文案" }),
      send: async (platform, text, key, expectedTargetUrl, markAttempted) => {
        assert.equal(typeof markAttempted, "function");
        await markAttempted();
        assert.equal((await storage.read()).pendingSettlement, "unconfirmed",
          "真实 click 紧前必须先 durable unconfirmed");
        gotArgs = [platform, text, key, expectedTargetUrl];
        return { ok: true };
      },
    });
    await R.runOnTarget(d);
    assert.deepStrictEqual(gotArgs, [
      "bilibili",
      "完整的一条直评文案",
      "bilibili:BV1",
      CLAIM.open_url,
    ],
      "send 要收到平台、生成文本、交接单 key 和权威目标 URL：文本核对草稿，" +
      "key 用来保证同一条只点一次（小红书发完不清空草稿，重试会重复发送）");
  }

  // 生成期间 SPA 从 A 切到 B：在持久化 send guard/调用 send 前就终止。
  {
    let href = CLAIM.open_url;
    let generated = 0;
    let sent = 0;
    let cell = handoffFor("send");
    const result = await R.runOnTarget({
      handoffStore: {
        read: async () => cell,
        write: async (value) => { cell = value; return true; },
        clear: async () => { cell = null; },
      },
      href,
      currentHref: () => href,
      generateAndFill: async () => {
        generated += 1;
        href = "https://www.bilibili.com/video/BV_CHANGED_DURING_GENERATION/";
        return { ok: true, text: "A 的文案" };
      },
      send: async () => { sent += 1; return { ok: true }; },
      settlementRetryDelays: [0, 0, 0],
      settlementMaxAttempts: 3,
      settlementSleep: async () => {},
      api: async (route, body) => {
        assert.equal(route, "prospects/settle");
        assert.equal(body.state, "failed");
        assert.equal(cell.pendingSettlement, "failed");
        assert.equal(cell.sendStarted, undefined, "靶子已换时连 send guard 都不该进入");
        return {};
      },
    });
    assert.equal(result.status, "target_changed_before_send");
    assert.equal(result.expected, CLAIM.open_url);
    assert.equal(result.got, href);
    assert.deepStrictEqual([generated, sent], [1, 0], "A→B 后绝不能调用发送/点击链路");
    assert.equal(cell, null, "目标变更作为 failed 落账后才清交接单");
  }
  {
    const [d, calls] = tdeps({ stopAfter: "send", send: async () => ({ ok: false, error: "风控拦截" }) });
    const r = await R.runOnTarget(d);
    assert.equal(r.status, "send_failed");
    assert.deepStrictEqual([...calls], [
      { route: "prospects/prepare-send", state: undefined },
      { route: "prospects/settle", state: "failed" },
    ],
      "发送失败要记 failed，而不是 posted");
  }

  // click 已成功返回但回执超时：这是一次真实外部动作，必须记 unconfirmed；
  // 新 document 只补 settle，不能把它当 failed 后再点一次。
  {
    const handoff = { ...handoffFor("send"), key: "bilibili:receipt-timeout" };
    let cell = handoff;
    let generated = 0;
    let sent = 0;
    let settleCalls = 0;
    const d = {
      handoffStore: {
        read: async () => cell,
        write: async value => { cell = value; return true; },
        clear: async () => { cell = null; },
      },
      href: handoff.open_url,
      generateAndFill: async () => { generated += 1; return { ok: true, text: "已点击但回执未知" }; },
      send: async () => {
        sent += 1;
        return { ok: false, attempted: true, error: "已点发送但未收到平台回执" };
      },
      api: async route => {
        if (route === "prospects/prepare-send") return {};
        settleCalls += 1;
        if (settleCalls === 1) throw new Error("settle transport lost");
        return {};
      },
      settlementRetryDelays: [0],
      settlementMaxAttempts: 1,
    };
    const first = await R.runOnTarget(d);
    assert.equal(first.status, "settle_failed");
    assert.equal(first.state, "unconfirmed");
    assert.equal(cell.pendingSettlement, "unconfirmed");
    const recovered = await R.runOnTarget(d);
    assert.equal(recovered.status, "settled_after_retry");
    assert.equal(recovered.state, "unconfirmed");
    assert.deepStrictEqual([generated, sent], [1, 1],
      "receipt timeout 跨 document 只能补 settle，绝不能二次生成/点击");
    assert.equal(cell, null);
  }

  // send adapter reject 无法证明异常在 click 前还是后，同样必须保守 unconfirmed；
  // content wiring 另验证 btn.click catch 分支确实带 attempted:true。
  {
    const [d, calls] = tdeps({
      stopAfter: "send",
      send: async () => { throw new Error("adapter rejected after unknown click state"); },
    });
    const result = await R.runOnTarget(d);
    assert.equal(result.status, "send_unconfirmed");
    assert.deepStrictEqual([...calls], [
      { route: "prospects/prepare-send", state: undefined },
      { route: "prospects/settle", state: "unconfirmed" },
    ]);
  }

  // sendStarted/pendingSettlement 存在 SW store：跨 document 只能补记，不能再点。
  {
    const handoff = { ...handoffFor("send"), key: "bilibili:cross-document-send" };
    let cell = handoff;
    let generated = 0;
    let sent = 0;
    let settleAttempts = 0;
    let guardSeenBeforeSend = false;
    const store = {
      read: async () => cell,
      write: async (value) => { cell = value; return true; },
      clear: async () => { cell = null; },
    };
    const d = {
      handoffStore: store,
      href: handoff.open_url,
      generateAndFill: async () => { generated += 1; return { ok: true, text: "不可重复" }; },
      send: async () => {
        sent += 1;
        guardSeenBeforeSend = !!(cell && cell.sendStarted && cell.pendingSettlement === "failed");
        return { ok: true };
      },
      settlementRetryDelays: [0, 0, 0],
      settlementMaxAttempts: 3,
      settlementSleep: async () => {},
      api: async (route) => {
        if (route === "prospects/prepare-send") return {};
        settleAttempts += 1;
        if (settleAttempts <= 3) throw new Error("settle transport lost");
        return {};
      },
    };

    const first = await R.runOnTarget(d);
    assert.equal(first.status, "settle_failed");
    assert.equal(first.state, "posted");
    assert.equal(first.recoverable, true, "pending 仍可由当前/新 document 继续补记");
    assert.equal(first.attempts, 3);
    assert.equal(guardSeenBeforeSend, true, "必须先持久化不可逆动作闸再调用 send");
    assert.equal(cell.pendingSettlement, "posted", "回执成功后要留下可补记的 posted 状态");

    // 模拟页面重建后的新 document：直接读同一个 SW store，不共享任何内存 guard。
    const recovered = await R.runOnTarget(d);
    assert.equal(recovered.status, "settled_after_retry");
    assert.equal(recovered.state, "posted");
    assert.equal(sent, 1, "跨 document 恢复只允许补 settle，绝不能再次点击发送");
    assert.equal(generated, 1, "补记台账不应重新生成草稿");
    assert.equal(cell, null, "补记成功后才清 handoff");
  }

  // 不可逆动作闸写不下时宁可不发，也不能依赖当前 document 的内存标记。
  {
    const handoff = { ...handoffFor("send"), key: "bilibili:guard-write-failed" };
    let sent = 0;
    const r = await R.runOnTarget({
      handoff,
      handoffStore: { read: async () => handoff, write: async () => false, clear: async () => {} },
      href: handoff.open_url,
      generateAndFill: async () => ({ ok: true, text: "不能冒险发送" }),
      send: async () => { sent += 1; return { ok: true }; },
      api: async () => ({}),
    });
    assert.equal(r.status, "send_guard_persist_failed");
    assert.equal(sent, 0);
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
      profileId: "p1", stopAfter: "fill", at: Date.now(), hops: (over && over.hops) || 0,
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
