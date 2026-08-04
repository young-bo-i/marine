// 编排接线回归测试。
//
// prospect-run.js 的决策路径由 prospect-run-smoke 覆盖；这里管的是**接线**：
// content-iso 有没有把真实依赖接对、SW 的代发有没有守住路由白名单。
// 这两处出错时语法检查一律通过，但线上表现是「编排静默不跑」或者
// 「页面能通过编排调到任意本地 API」。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(here, p), "utf8");

const iso = read("../src/content-iso.js");
const sw = read("../src/sw.js");
const manifest = JSON.parse(read("../manifest.json"));

// ------------------------------------------------- content-iso 的依赖必须接全
{
  // 少接一个依赖，run() 里就会在调用 undefined 时抛错，而 catch 会把它变成
  // 一条日志 —— 表现为「编排静默不跑」，最难查的那种。
  for (const dep of ["profileId", "login:", "pageHtml:", "parse:", "canary:", "api:", "navigate:"]) {
    assert.ok(iso.includes(dep), `content-iso 必须给编排接上 ${dep}`);
  }
  assert.ok(
    iso.includes("marineLogin.status"),
    "登录检查要走 login.js，不能在 content-iso 里另写一份",
  );
  assert.ok(
    iso.includes("marineDiscovery.parseFor") && iso.includes("marineDiscovery.canary.check"),
    "解析与体检都要走 discovery.js",
  );
  assert.ok(
    iso.includes("document.documentElement.outerHTML"),
    "B站/小红书是 SSR，必须取渲染后的整页 HTML",
  );
  assert.ok(
    iso.includes("typeof marineProspectRun !== 'undefined'"),
    "跨脚本依赖必须用 typeof 做安全探测，晚到时进入有界重试而不是抛错",
  );
  const boot = iso.slice(
    iso.indexOf("const MARINE_PROSPECT_BOOT_DELAYS_MS"),
    iso.indexOf("    // SW 代发：apiBase/token"),
  );
  assert.ok(
    /MARINE_PROSPECT_BOOT_DELAYS_MS\s*=\s*\[[^\]]+\]/.test(boot) &&
      boot.includes("marineProspectScheduleBoot(marineStartProspectRun"),
    "Phase A 依赖晚到时要做有界退避，不能一次 typeof 失败就永久退出",
  );
  assert.ok(
    /next >= MARINE_PROSPECT_BOOT_DELAYS_MS\.length/.test(boot) &&
      /setTimeout\(\(\) => start\(next\), MARINE_PROSPECT_BOOT_DELAYS_MS\[next\]\)/.test(boot),
    "依赖重试必须有硬上限，且每一轮推进 attempt，不能形成零延迟死循环",
  );
  assert.ok(
    boot.includes("marineLogin.status") &&
      boot.includes("marineDiscovery.parseFor") &&
      boot.includes("marineDiscovery.canary.check"),
    "ready 判据要覆盖 Phase A 真正会调用的全部跨脚本依赖",
  );
}

// ------------------------------------------------- 编排 ready 必须证明 SW + 配置 + Bearer API 都可用
{
  const readyBlock = iso.slice(
    iso.indexOf("async function marineProspectEnsureBridgeReady"),
    iso.indexOf("function marineProspectNavigateWithWatchdog"),
  );
  assert.ok(readyBlock.includes("__marineProspectReady"), "content 必须走独立 ready 握手");
  assert.ok(
    readyBlock.indexOf("reply.ok !== true") <
      readyBlock.indexOf("setAttribute('data-marine-prospect-ready', '1')"),
    "ready marker 只能在 SW 握手成功且 profileId 有效后 stamp",
  );
  assert.ok(
    iso.includes("data-marine-prospect-failed") &&
      iso.includes("prospect_bootstrap_failed") &&
      iso.includes("target_bootstrap_failed"),
    "Phase A/B 依赖或认证耗尽必须给 Rust 可见的结构化失败",
  );
  assert.ok(
    /MARINE_PROSPECT_READY_TIMEOUT_MS\s*=\s*7000/.test(iso) &&
      /setTimeout\(\(\) => controller\.abort\(\), 5000\)/.test(sw),
    "content ready 超时必须长于 SW 内部 GET abort，避免边界抢跑",
  );
  const phaseA = iso.slice(iso.indexOf("async function marineStartProspectRun"),
    iso.indexOf("// ---- Phase B"));
  const phaseB = iso.slice(iso.indexOf("async function marineStartProspectTargetPhase"));
  assert.ok(
    phaseA.indexOf("platformOfSearchPage(location.href)") <
      phaseA.indexOf("marineProspectEnsureBridgeReady()") &&
      phaseB.indexOf("platformOfSearchPage(location.href)") <
      phaseB.indexOf("marineProspectEnsureBridgeReady()"),
    "search 只让 Phase A 握手，target 只让 Phase B 握手",
  );
  assert.ok(
    phaseB.indexOf("marineProspectWarmupPage(location.href)") <
      phaseB.indexOf("marineProspectPhaseAReady()") &&
      phaseB.indexOf("marineProspectWarmupPage(location.href)") <
      phaseB.indexOf("runOnTargetSingleFlight"),
    "XHS 首页 warmup 必须在 ready/handoff read 前退出，不能消费或重定向旧任务",
  );
  {
    const warmupMatch = /function marineProspectWarmupPage\(href\) \{[\s\S]*?\n  \}/.exec(iso);
    assert.ok(warmupMatch, "warmup 判据必须可独立验证");
    const warmupCtx = { URL };
    vm.createContext(warmupCtx);
    vm.runInContext(
      warmupMatch[0] + "\nglobalThis.isWarmup = marineProspectWarmupPage;",
      warmupCtx,
    );
    assert.equal(warmupCtx.isWarmup("https://www.xiaohongshu.com/"), true);
    assert.equal(warmupCtx.isWarmup("https://www.xiaohongshu.com/?source=scheduler"), true);
    assert.equal(
      warmupCtx.isWarmup("https://www.xiaohongshu.com/search_result?keyword=test"),
      false,
    );
    assert.equal(
      warmupCtx.isWarmup("https://www.xiaohongshu.com/explore/abc"),
      false,
    );
  }
  assert.ok(
    sw.includes("if (msg && msg.__marineProspectReady)") &&
      sw.includes("MARINE_PROSPECT_READY_ROUTE = 'prospects/ready'") &&
      sw.includes("response.status !== 204"),
    "SW 必须用写死的 GET /prospects/ready 处理握手，不得伪造成普通 marker",
  );
}

// ------------------------------------------------- 真实导航必须等旧 document 卸载
{
  const helperStart = iso.indexOf("function marineProspectNavigateWithWatchdog");
  const helperEnd = iso.indexOf("\n\n  /**\n   * 交接单存在 SW 侧", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "必须有可测的导航 watchdog helper");
  const helperSource = iso.slice(helperStart, helperEnd);
  const buildHelper = new Function(
    "MARINE_PROSPECT_NAVIGATION_WATCHDOG_MS",
    `${helperSource}\nreturn marineProspectNavigateWithWatchdog;`,
  );
  assert.match(
    iso,
    /MARINE_PROSPECT_NAVIGATION_WATCHDOG_MS\s*=\s*12000/,
    "正式导航每个 watchdog 窗口至少 12s，不能误杀 6–10s 的正常 TTFB",
  );
  const navigateWithWatchdog = buildHelper(12000);

  function harness() {
    let nextTimer = 1;
    const timers = new Map();
    const listeners = new Map([
      ["pagehide", new Set()],
      ["unload", new Set()],
    ]);
    const host = {
      addEventListener: (type, fn) => listeners.get(type)?.add(fn),
      removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    };
    const document = { documentElement: {}, defaultView: host };
    const location = {
      href: "https://search.bilibili.com/all?keyword=test",
      assigned: [],
      assign(url) {
        this.assigned.push(url);
        // Chromium 可能在 pagehide 前就更新 href；故意模拟这个陷阱。
        this.href = url;
      },
    };
    const runtime = {
      window: host,
      document,
      location,
      delayMs: 5000,
      setTimeout(fn, ms) {
        const id = nextTimer++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    };
    const fire = (type) => {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type });
    };
    const runNextTimer = () => {
      const entry = timers.entries().next().value;
      assert.ok(entry, "watchdog 应该还有一个有界 timer");
      const [id, task] = entry;
      timers.delete(id);
      assert.equal(task.ms, 5000, "导航 watchdog 窗口应约为 5s");
      task.fn();
    };
    return { runtime, location, timers, listeners, fire, runNextTimer };
  }

  // 正常 pagehide 立即取消 watchdog：不重提交，也不产生 stalled 日志状态。
  {
    const h = harness();
    const pending = navigateWithWatchdog(
      "https://www.bilibili.com/video/BV_PAGEHIDE/",
      { key: "bilibili:BV_PAGEHIDE" },
      h.runtime,
    );
    assert.equal(h.location.assigned.length, 1);
    assert.equal(h.timers.size, 1);
    h.fire("pagehide");
    const result = await pending;
    assert.equal(result.status, "target_navigation_committed");
    assert.equal(h.timers.size, 0, "pagehide 必须清掉待执行 watchdog");
    assert.equal(h.location.assigned.length, 1, "正常卸载不能再 assign");
  }

  // href 即使已经是目标，只要旧 document 仍活着就必须精确重试一次；
  // 第二个窗口后只产生一个结构化 terminal，不能形成无限 timer。
  {
    const h = harness();
    let terminalReports = 0;
    const expected = "https://www.bilibili.com/video/BV_STALLED/";
    const pending = navigateWithWatchdog(
      expected,
      { key: "bilibili:BV_STALLED" },
      h.runtime,
    ).then((result) => {
      if (result.status === "target_navigation_stalled") terminalReports += 1;
      return result;
    });
    assert.equal(h.location.href, expected, "首次 assign 后 href 可能已提前变更");
    h.runNextTimer();
    assert.deepStrictEqual(h.location.assigned, [expected, expected], "旧 document 存活时只精确重试一次");
    assert.equal(h.timers.size, 1);
    h.runNextTimer();
    const result = await pending;
    assert.equal(result.status, "target_navigation_stalled");
    assert.equal(result.expected, expected);
    assert.equal(result.got, expected, "href 相等也不能掩盖旧 document 仍存活");
    assert.equal(result.key, "bilibili:BV_STALLED");
    assert.equal(result.attempts, 2);
    assert.equal(h.timers.size, 0, "第二个窗后不能继续建 timer");
    h.fire("pagehide");
    h.fire("unload");
    await Promise.resolve();
    assert.equal(terminalReports, 1, "后续生命周期事件不能重复上报 terminal");
  }

  assert.equal(
    [...iso.matchAll(/=> marineProspectNavigateWithWatchdog\(url, meta\)/g)].length,
    2,
    "Phase A claim 和 Phase B mismatch/hop 必须共用同一个真实导航 helper",
  );
  const runSource = read("../src/platforms/prospect-run.js");
  assert.equal(
    [...runSource.matchAll(/await deps\.navigate\(/g)].length,
    4,
    "claim、plain handoff resume、mismatch repair 和 blocked hop 都必须等导航 watchdog 结果",
  );
  assert.ok(
    runSource.includes("'target_navigation_stalled'") &&
      iso.includes("result.status === 'target_navigation_committed'") &&
      iso.includes("r.status !== 'target_navigation_committed'"),
    "stalled 要落结构化终局，正常 pagehide 不应刷日志",
  );
  assert.ok(
    iso.includes("const searchHref = location.href") &&
      iso.includes("marineProspectRun.markDone(searchHref, result.status)"),
    "href 可能在卸载前提前变更，Phase A 幂等标记必须绑定启动时搜索 URL",
  );
}

// ------------------------------------------------- SW 路由白名单是安全边界
{
  assert.ok(sw.includes("MARINE_PROSPECT_ROUTES"), "SW 必须有编排路由白名单");
  const block = sw.slice(sw.indexOf("MARINE_PROSPECT_ROUTES"), sw.indexOf("async function marineProspectApi"));
  for (const allowed of [
    "prospects/ingest",
    "prospects/claim",
    "prospects/prepare-send",
    "prospects/settle",
  ]) {
    assert.ok(block.includes(allowed), `白名单应包含 ${allowed}`);
  }
  // 编排跑在页面上下文（不可信）。放开成任意路径 = 把整个本地 API 交给页面，
  // 而本地 API 里有会产生外部动作的端点。
  for (const forbidden of ["generate-stream", "history/published", "rime/invoke"]) {
    assert.ok(!block.includes(forbidden), `白名单绝不能包含 ${forbidden}`);
  }
  assert.ok(
    sw.includes("不允许的编排路由"),
    "白名单未命中时要显式拒绝，不能默默放行",
  );
}

// ------------------------------------------------- 交接单绝不能用 sessionStorage
{
  // 这是实测踩过的坑，而且症状极具迷惑性：sessionStorage 按 **origin** 分区，
  // 而搜索页和靶子页经常不同源 —— B 站永远是（search.bilibili.com ->
  // www.bilibili.com），知乎专栏文章也是（-> zhuanlan.zhihu.com）。后果是
  // Phase A 全绿（入账、claim、导航都成功），Phase B 读不到交接单静默退出，
  // 台账里只留下一条永远停在 claimed、零 touch 的记录。
  const run = read("../src/platforms/prospect-run.js");
  const phaseBSrc = run.slice(run.indexOf("function storeOf"));
  assert.ok(
    !/sessionStorage/.test(phaseBSrc),
    "交接单不能碰 sessionStorage —— 它按 origin 分区，跨子域必丢",
  );
  assert.ok(
    run.includes("handoffStore"),
    "交接单要走可注入的 handoffStore，由 SW 按 tab 持有",
  );
  // Phase A 必须先落定交接单再导航，而且写失败就不许导航。
  assert.ok(
    run.includes("const handed = await writeHandoff(") && run.includes("handoff_write_failed"),
    "交接单要 await 写完再导航，写不成就不能导航",
  );
  // SW 侧：按 sender 的 tab 认身份，不能让调用方自己声明。
  assert.ok(sw.includes("__marineProspectHandoff"), "SW 要处理交接单读写");
  assert.ok(
    sw.includes("sender && sender.tab && sender.tab.id"),
    "tab 身份只认 sender —— 让页面自报 tabId 等于允许它读写别的标签页的交接单",
  );
  assert.ok(
    sw.includes("chrome.tabs.onRemoved"),
    "标签页关掉要清掉交接单，否则 session 存储会一直攒",
  );
  assert.ok(
    sw.includes("let marineHandoffQueue") &&
      sw.includes("conflictingOutbox") &&
      sw.includes("existing.sendStarted || existing.pendingSettlement"),
    "SW 必须跨 tab 串行 handoff/outbox CAS，并拒绝不同 key 覆盖不可逆凭据",
  );
  assert.ok(
    sw.includes("MARINE_HANDOFF_OUTBOX_PREFIX") &&
      sw.includes("chrome.storage.local.set({ [outboxKey]: storedValue })") &&
      sw.includes("marineHandoffRuntimeProfileId()"),
    "sendStarted/pendingSettlement 必须按 runtime profile 镜像到不依赖 tabId 的 local outbox",
  );
  // 顺序陷阱：在 onMessage 注册之前抛异常 = 监听器永远挂不上，SW 变成
  // 「活着但不回消息」（content script 看到 Receiving end does not exist），
  // 而 chrome://extensions 一条错误都不显示。实测踩过。
  {
    const msgIdx = sw.indexOf("chrome.runtime.onMessage.addListener");
    const before = sw.slice(0, msgIdx);
    const tabsIdx = before.lastIndexOf("chrome.tabs.onRemoved");
    if (tabsIdx >= 0) {
      const guarded = before.slice(Math.max(0, tabsIdx - 300), tabsIdx);
      assert.ok(
        guarded.includes("try {"),
        "onMessage 注册之前的顶层 chrome.* 调用必须包在 try 里，否则一抛就丢掉整个消息通道",
      );
    }
  }
}

// ------------------------------------------------- tab 删除后仍从 durable outbox 只补 settle
{
  function storageArea(initial = {}) {
    let values = { ...initial };
    return {
      async get(query) {
        if (query === null || query === undefined) return { ...values };
        const keys = Array.isArray(query) ? query : [query];
        const out = {};
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(values, key)) out[key] = values[key];
        }
        return out;
      },
      async set(next) { values = { ...values, ...next }; },
      async remove(query) {
        const keys = Array.isArray(query) ? query : [query];
        for (const key of keys) delete values[key];
      },
      dump() { return { ...values }; },
    };
  }

  const session = storageArea();
  const local = storageArea();
  const handoffSource = sw.slice(
    sw.indexOf("const MARINE_HANDOFF_PREFIX"),
    sw.indexOf("// 标签页关掉只删普通 session 交接"),
  );
  const handoffCtx = {
    console,
    chrome: { storage: { session, local } },
    marineResolveConfig: async () => ({ profileId: "profile-durable" }),
    setTimeout,
    clearTimeout,
  };
  vm.createContext(handoffCtx);
  vm.runInContext(
    handoffSource + "\nglobalThis.__handoff = marineHandoff;" +
      " globalThis.__handoffPrefix = MARINE_HANDOFF_PREFIX;" +
      " globalThis.__outboxPrefix = MARINE_HANDOFF_OUTBOX_PREFIX;" +
      " globalThis.__deadLetterPrefix = MARINE_HANDOFF_DEAD_LETTER_PREFIX;",
    handoffCtx,
  );

  const base = {
    key: "bilibili:BV_DURABLE",
    platform: "bilibili",
    profileId: "profile-durable",
    open_url: "https://www.bilibili.com/video/BV_DURABLE",
    stopAfter: "send",
    at: 100,
  };
  await handoffCtx.__handoff("write", 11, base);
  assert.equal(
    Object.keys(local.dump()).filter(key => key.startsWith(handoffCtx.__outboxPrefix)).length,
    0,
    "普通 pre-send handoff 不能长期持久化",
  );

  const irreversible = {
    ...base,
    sendStarted: true,
    sendStartedAt: 200,
    pendingSettlement: "posted",
    pendingSettlementAt: 201,
  };
  await handoffCtx.__handoff("write", 11, irreversible);
  const durableKeys = Object.keys(local.dump())
    .filter(key => key.startsWith(handoffCtx.__outboxPrefix));
  assert.equal(durableKeys.length, 1, "不可逆 handoff 必须先落 local outbox");
  assert.ok(
    durableKeys[0].includes(encodeURIComponent("profile-durable")) &&
      durableKeys[0].includes(encodeURIComponent("bilibili:BV_DURABLE")),
    "durable storage key 必须包含 profileId + prospect key，不能依赖 tabId",
  );
  // local 是不可逆状态的权威提交点：模拟 local posted 成功、session 仍为旧 failed。
  await session.set({
    [handoffCtx.__handoffPrefix + 11]: {
      ...irreversible,
      pendingSettlement: "failed",
    },
  });
  const authoritative = await handoffCtx.__handoff("read", 11);
  assert.equal(authoritative.pendingSettlement, "posted",
    "session=failed/local=posted 时 read 必须取 durable posted，不能卡在防降级闸");
  assert.equal(
    session.dump()[handoffCtx.__handoffPrefix + 11].pendingSettlement,
    "posted",
    "权威 durable 状态要回挂 session",
  );
  await assert.rejects(
    () => handoffCtx.__handoff("write", 11, {
      ...irreversible,
      pendingSettlement: "failed",
    }),
    /posted.*降级/,
    "晚到的 failed write 不能把 posted 降级",
  );
  await assert.rejects(
    () => handoffCtx.__handoff("write", 12, {
      ...base,
      key: "bilibili:BV_OTHER",
      open_url: "https://www.bilibili.com/video/BV_OTHER",
    }),
    /持久交接单/,
    "另一个 tab 的新 claim 不能穿透 durable outbox CAS",
  );

  // 模拟 scheduler hard-timeout 关掉原 tab：session 消失，local 必须保留。
  await session.remove(handoffCtx.__handoffPrefix + 11);
  const recovered = await handoffCtx.__handoff("read", 22);
  assert.equal(recovered.key, irreversible.key);
  assert.equal(recovered.pendingSettlement, "posted");
  assert.ok(
    session.dump()[handoffCtx.__handoffPrefix + 22],
    "durable recovery 要先重新挂入当前 tab session，供精确 clear",
  );

  const runCtx = { console, URL, Date, setTimeout, clearTimeout };
  vm.createContext(runCtx);
  vm.runInContext(
    read("../src/platforms/prospect-run.js") + "\nglobalThis.__prospectRun = marineProspectRun;",
    runCtx,
  );
  let generated = 0;
  let sent = 0;
  const settles = [];
  const result = await runCtx.__prospectRun.runOnTarget({
    handoff: recovered,
    handoffStore: {
      read: () => handoffCtx.__handoff("read", 22),
      write: value => handoffCtx.__handoff("write", 22, value),
      clear: value => handoffCtx.__handoff("clear", 22, value),
    },
    api: async (route, body) => { settles.push({ route, body }); return {}; },
    generateAndFill: async () => { generated += 1; return { ok: true, text: "never" }; },
    send: async () => { sent += 1; return { ok: true }; },
    settlementRetryDelays: [0],
    settlementMaxAttempts: 1,
  });
  assert.equal(result.status, "settled_after_retry");
  assert.equal(generated, 0, "durable 恢复 document 不得重新生成");
  assert.equal(sent, 0, "durable 恢复 document 不得重新点击发送");
  assert.equal(settles.length, 1);
  assert.equal(settles[0].route, "prospects/settle");
  assert.equal(
    Object.keys(local.dump()).filter(key => key.startsWith(handoffCtx.__outboxPrefix)).length,
    0,
    "settle 成功并 clear 后必须删除 durable outbox",
  );

  // 明确 409/404 移入只阻同 key 的 tombstone：不同 key 可继续执行；同 key 若
  // 后端将来重新 claim，则恢复成 settlement-only，仍然零生成/零发送。
  for (const [index, status] of [409, 404].entries()) {
    const oldTab = 30 + index * 10;
    const oldKey = `bilibili:DEAD_${status}`;
    const old = {
      ...base,
      key: oldKey,
      open_url: `https://www.bilibili.com/video/DEAD_${status}`,
      sendStarted: true,
      sendStartedAt: Date.now(),
      pendingSettlement: "posted",
      pendingSettlementAt: Date.now(),
    };
    await handoffCtx.__handoff("write", oldTab, old);
    let oldGenerated = 0;
    let oldSent = 0;
    const oldResult = await runCtx.__prospectRun.runOnTarget({
      handoff: old,
      handoffStore: {
        read: () => handoffCtx.__handoff("read", oldTab),
        write: value => handoffCtx.__handoff("write", oldTab, value),
        clear: value => handoffCtx.__handoff("clear", oldTab, value),
        deadLetter: (value, reason) =>
          handoffCtx.__handoff("deadLetter", oldTab, value, reason),
      },
      api: async () => { throw new Error(`prospects/settle 返回 ${status}`); },
      generateAndFill: async () => { oldGenerated += 1; return { ok: true }; },
      send: async () => { oldSent += 1; return { ok: true }; },
      settlementRetryDelays: [0],
      settlementMaxAttempts: 1,
    });
    assert.equal(oldResult.status, "settle_failed");
    assert.equal(oldResult.recoverable, false);
    assert.deepStrictEqual([oldGenerated, oldSent], [0, 0]);
    assert.equal(
      Object.keys(local.dump()).filter(key => key.startsWith(handoffCtx.__outboxPrefix)).length,
      0,
      `${status} 后不能留下阻塞整个 profile 的 active outbox`,
    );
    assert.equal(
      Object.keys(local.dump()).filter(key => key.startsWith(handoffCtx.__deadLetterPrefix)).length,
      1,
      `${status} 后必须保留只约束同 key 的防重 tombstone`,
    );

    const freshTab = oldTab + 1;
    const fresh = {
      ...base,
      key: `bilibili:FRESH_AFTER_${status}`,
      open_url: `https://www.bilibili.com/video/FRESH_AFTER_${status}`,
      stopAfter: "fill",
      at: Date.now(),
    };
    await handoffCtx.__handoff("write", freshTab, fresh);
    let freshGenerated = 0;
    const freshResult = await runCtx.__prospectRun.runOnTarget({
      handoff: fresh,
      handoffStore: {
        read: () => handoffCtx.__handoff("read", freshTab),
        write: value => handoffCtx.__handoff("write", freshTab, value),
        clear: value => handoffCtx.__handoff("clear", freshTab, value),
        deadLetter: (value, reason) =>
          handoffCtx.__handoff("deadLetter", freshTab, value, reason),
      },
      href: fresh.open_url,
      generateAndFill: async () => { freshGenerated += 1; return { ok: true, text: "fresh" }; },
      api: async () => ({}),
      settlementRetryDelays: [0],
      settlementMaxAttempts: 1,
    });
    assert.equal(freshResult.status, "filled");
    assert.equal(freshGenerated, 1,
      `${status} dead-letter 不能妨碍不同 key 正常执行`);

    const reclaimTab = oldTab + 2;
    await handoffCtx.__handoff("write", reclaimTab, {
      ...base,
      key: oldKey,
      open_url: old.open_url,
      stopAfter: "send",
      at: Date.now() + 1000,
    });
    const reclaimed = await handoffCtx.__handoff("read", reclaimTab);
    assert.equal(reclaimed.pendingSettlement, "posted");
    assert.equal(reclaimed.recoveredFromDeadLetter, true);
    let reclaimGenerated = 0;
    let reclaimSent = 0;
    const reclaimResult = await runCtx.__prospectRun.runOnTarget({
      handoff: reclaimed,
      handoffStore: {
        read: () => handoffCtx.__handoff("read", reclaimTab),
        write: value => handoffCtx.__handoff("write", reclaimTab, value),
        clear: value => handoffCtx.__handoff("clear", reclaimTab, value),
        deadLetter: (value, reason) =>
          handoffCtx.__handoff("deadLetter", reclaimTab, value, reason),
      },
      api: async () => ({}),
      generateAndFill: async () => { reclaimGenerated += 1; return { ok: true }; },
      send: async () => { reclaimSent += 1; return { ok: true }; },
      settlementRetryDelays: [0],
      settlementMaxAttempts: 1,
    });
    assert.equal(reclaimResult.status, "settled_after_retry");
    assert.deepStrictEqual([reclaimGenerated, reclaimSent], [0, 0],
      "同 key 重领只能补 settle，不能重新生成/发送");
    assert.equal(
      Object.keys(local.dump()).filter(key =>
        key.startsWith(handoffCtx.__outboxPrefix) ||
        key.startsWith(handoffCtx.__deadLetterPrefix)).length,
      0,
      "同 key 补 settle 成功后 active/tombstone 都应清除",
    );
  }
}

// ------------------------------------------------- 消息通道两端要对得上
{
  for (const msg of ["__marineProspectApi", "__marineProspectProfileId", "__marineProspectHandoff"]) {
    assert.ok(iso.includes(msg), `content-iso 要发送 ${msg}`);
    assert.ok(sw.includes(msg), `sw 要处理 ${msg}`);
  }
  // 异步 sendResponse 必须 return true，否则通道提前关闭、回调永远收不到。
  const apiHandler = sw.slice(sw.indexOf("if (msg && msg.__marineProspectApi)"));
  assert.ok(
    apiHandler.slice(0, 400).includes("return true"),
    "异步响应的 handler 必须 return true，否则消息通道会提前关闭",
  );
}

// ------------------------------------------------- 日志落盘不得绕过安全边界
{
  // 扩展日志现在会转发到本地 API，好让调度器关掉浏览器之后证据还在。
  assert.ok(sw.includes("marineForwardLogs"), "SW 要把日志批次转发到本地 API");
  assert.ok(
    sw.includes("Array.isArray(msg.__marineLogBatch)"),
    "要处理合批格式的日志消息",
  );
  // 侧边栏那条监听必须还能收到同一条消息 —— 抢答会把「调试」tab 弄哑。
  const handler = sw.slice(sw.indexOf("Array.isArray(msg.__marineLogBatch)"));
  assert.ok(
    !/^\s*return true;/m.test(handler.slice(0, 200)),
    "日志分支不能 return true / 提前应答，否则侧边栏收不到",
  );
  // 关键：日志路由是 SW 自己写死的，不能进「页面可指定」的白名单。
  const block = sw.slice(sw.indexOf("MARINE_PROSPECT_ROUTES"), sw.indexOf("async function marineProspectApi"));
  assert.ok(
    !block.includes("debug/logs"),
    "日志路由绝不能进编排白名单 —— 那份名单是给不可信页面上下文用的",
  );
  assert.ok(
    sw.includes("const MARINE_LOG_ROUTE = 'debug/logs'"),
    "日志路由要写死在 SW 里，不接受调用方指定",
  );
  assert.ok(
    sw.includes("MARINE_LOG_MAX_BATCH"),
    "日志是突发的，必须截断，否则一次抓取能打爆本地 API",
  );
}

// ------------------------------------------------- 回执范围三处必须一致
{
  // 「哪些平台能上报回执」在三个地方各写了一遍：manifest 的注入范围、SW 的信任
  // 判据、SW 的引导扫描 URL 过滤。只改其中一两处的后果是**评论确实发出去了、
  // 台账却记 failed** —— 实测踩过，而且极难查（页面上看得到评论，日志说没收到）。
  const manifestHosts = manifest.content_scripts
    .filter((e) => e.js.includes("src/publish-receipt.js"))
    .flatMap((e) => e.matches);
  for (const host of ["bilibili", "zhihu"]) {
    assert.ok(manifestHosts.some((m) => m.includes(host)), `manifest 回执桥要覆盖 ${host}`);
    assert.ok(
      new RegExp(`${host}\\\\.com\\$`).test(sw) || sw.includes(`${host}.com/*`),
      `SW 的引导扫描要覆盖 ${host}`,
    );
  }
  // 桥内部还有两处曾经写死 bilibili，而且必须成对改：只改握手会变成
  // 「握手通了但回执在最后一步被静默丢掉」，比原来更难查。
  const bridge = read("../src/publish-bridge.js");
  assert.ok(
    !/if \(!isBilibiliUrl\(window\.location/.test(bridge),
    "握手判据不能写死 bilibili —— 否则别的平台 readyAttempts 永远是 0，MessagePort 从不建立",
  );
  assert.ok(
    !/value\.platform !== 'bilibili'/.test(bridge),
    "回执消毒的平台白名单不能写死 bilibili",
  );
  assert.ok(
    bridge.includes("SUPPORTED_RECEIPT_PLATFORMS"),
    "平台白名单要集中成一处，和 receiptBuilderFor 一起改",
  );
  // id 形态是**第二个**跨层散落的判据：B站/知乎是正整数，小红书是 24 位十六进制。
  // 四处各判一次（bridge、sw、Rust、构造器的 xhsId），漏一处就静默丢回执。
  for (const [name, src] of [["bridge", bridge], ["sw", sw]]) {
    assert.ok(
      /\[0-9a-f\]\{16,32\}/i.test(src),
      `${name} 的 id 校验要接受十六进制平台 id（小红书）`,
    );
  }
  // sanitize 里曾经有**三处**写死 bilibili（event_id 前缀、URL 判据、输出的
  // platform 字段），只改其中一处等于没改：回执构造成功了却在这一步被静默丢掉，
  // 外部看到的和「压根没构造出来」完全一样。实测靠 diag 的 built 字段才分辨出来。
  const san = bridge.slice(bridge.indexOf("function sanitize"));
  const sanBody = san.slice(0, 1600);
  assert.ok(
    !sanBody.includes("'bilibili:' + platformCommentId"),
    "event_id 前缀要按声明的平台判",
  );
  assert.ok(
    !sanBody.includes("isBilibiliUrl(targetUrl)"),
    "URL 判据要按「已实现回执的平台」判",
  );
  assert.ok(
    !/platform: 'bilibili'/.test(sanBody),
    "输出的 platform 字段不能强行改回 bilibili",
  );
  assert.ok(
    sw.includes("function marineIsPublishCapableUrl"),
    "信任判据要按「已实现回执的平台」判，不能写死单个站点",
  );
  // event_id 前缀不能写死某个平台，否则别的平台的回执会被静默丢掉
  assert.ok(
    !sw.includes("value.event_id !== 'bilibili:'"),
    "回执消毒不能把 event_id 前缀写死成 bilibili",
  );
}

// ------------------------------------------------- SW 改了就必须换入口版本号
{
  // sw.js 是通过 importScripts('sw.js?v=X') 加载的，Chromium 会**按 URL 缓存**
  // 这个 worker。改了 sw.js 而不动版本号，已有 profile 会继续跑旧 worker——
  // 实测形态：content script 是新的、SW 是旧的，新加的消息类型无人应答，
  // Phase A 每次重试都白 claim 一条候选然后卡住不导航。
  const entry = manifest.background.service_worker;
  const version = /sw-entry-([\d.]+)\.js$/.exec(entry);
  assert.ok(version, `background.service_worker 应是带版本号的入口，实际是 ${entry}`);
  const entrySrc = read("../" + entry);
  assert.ok(
    entrySrc.includes(`sw.js?v=${version[1]}`),
    `入口文件里的 importScripts 版本号要和文件名一致（${entry}）`,
  );
}

// ------------------------------------------------- 注入顺序：依赖先于使用者
{
  const platformEntry = manifest.content_scripts.find((e) =>
    e.js.some((f) => f.startsWith("src/platforms/")),
  );
  const isoEntries = manifest.content_scripts.filter((e) => e.js.includes("src/content-iso.js"));
  const platformIsoEntry = isoEntries.find((e) => e.js.includes("src/platforms/prospect-run.js"));
  if (platformIsoEntry) {
    const consumer = platformIsoEntry.js.indexOf("src/content-iso.js");
    for (const dependency of [
      "src/platforms/discovery.js",
      "src/platforms/login.js",
      "src/platforms/prospect-run.js",
    ]) {
      const dependencyIndex = platformIsoEntry.js.indexOf(dependency);
      assert.ok(dependencyIndex >= 0 && dependencyIndex < consumer,
        `同一 content_scripts entry 内 ${dependency} 必须先于 content-iso`);
    }
  } else {
    const iIdx = manifest.content_scripts.findIndex((e) => e.js.includes("src/content-iso.js"));
    const pIdx = manifest.content_scripts.indexOf(platformEntry);
    assert.ok(pIdx < iIdx,
      "仍分 entry 时平台脚本应排在 content-iso 前，且 content-iso 的 ready 重试是确定性兜底");
  }
  assert.ok(
    platformEntry.js.includes("src/platforms/prospect-run.js") &&
      platformEntry.js.includes("src/platforms/login.js") &&
      platformEntry.js.includes("src/platforms/discovery.js"),
    "编排、登录、发现三个模块都要在平台脚本条目里",
  );
}

// ------------------------------------------------- 红线仍然成立
{
  // 接线不能绕过 prospect-run 的边界去直接发布。
  const wiring = iso.slice(iso.indexOf("marineStartProspectRun"));
  for (const forbidden of ["history/published", "generate-stream", "submit("]) {
    assert.ok(!wiring.includes(forbidden), `编排接线不得触碰 ${forbidden}`);
  }
}

// ------------------------------------------------- 代发行为（用桩跑一遍）
{
  // 把 marineProspectApi 从 sw.js 里抠出来单独跑，验证白名单与 null 处理。
  // 只抠代发那一段：后面的交接单处理会碰 chrome.*，在 vm 里跑不了。
  const src = sw.slice(sw.indexOf("const MARINE_PROSPECT_ROUTES"), sw.indexOf("// Phase A -> Phase B 的交接单"));
  const calls = [];
  const ctx = {
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    marineResolveConfig: async () => ({
      apiBase: "http://127.0.0.1:1/v1/marine",
      token: "t",
      profileId: "profile-ready",
    }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: url.endsWith("/prospects/ready") ? 204 : 200,
        text: async () => (url.endsWith("claim") ? "" : '{"inserted":2}'),
      };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    src + "\nglobalThis.__api = marineProspectApi; globalThis.__ready = marineProspectReady;",
    ctx,
  );

  const ingested = await ctx.__api("prospects/ingest", { candidates: [] });
  assert.deepStrictEqual({ ...ingested }, { inserted: 2 });
  assert.ok(calls[0].url.endsWith("/prospects/ingest"), "URL 应拼在 apiBase 之后");

  // claim 没得领时后端返回空体 —— 必须变成 null，而不是解析报错
  const claimed = await ctx.__api("prospects/claim", {});
  assert.equal(claimed, null, "空响应体应视为「没得领」");

  await assert.rejects(
    () => ctx.__api("generate-stream", {}),
    /不允许的编排路由/,
    "白名单外的路由必须被拒绝",
  );

  const ready = await ctx.__ready();
  assert.equal(ready.profileId, "profile-ready");
  const probe = calls.find((call) => call.url.endsWith("/prospects/ready"));
  assert.ok(probe, "SW ready 握手必须实际 GET 只读本地 API 探针");
  assert.equal(probe.init.method, "GET");
  assert.equal(probe.init.headers.Authorization, "Bearer t");
  assert.equal(probe.init.body, undefined, "ready 探针不得带任何变更状态的 body");
}


// ------------------------------------------------- settlement 必须可跨 document 恢复
{
  const run = read("../src/platforms/prospect-run.js");
  const states = run.slice(
    run.indexOf("const PENDING_SETTLEMENT_STATES"),
    run.indexOf("const SETTLEMENT_RETRY_DELAYS_MS"),
  );
  for (const state of ["posted", "unconfirmed", "failed", "blocked", "skipped", "filled"]) {
    assert.ok(states.includes(`${state}: 1`), `terminal ${state} 必须有 pendingSettlement 恢复态`);
  }
  const settleBlock = run.slice(
    run.indexOf("async function settleAndClear"),
    run.indexOf("async function settle(deps"),
  );
  assert.ok(
    settleBlock.indexOf("persistHandoff(deps, pending)") <
      settleBlock.indexOf("settle(deps, pending, state)"),
    "每次 settle API 前必须先持久化 pendingSettlement",
  );
  assert.ok(
    settleBlock.includes("Math.min(cycle, delays.length - 1)") &&
      settleBlock.includes("while (cycle < maxCycles)") &&
      /SETTLEMENT_RETRY_DELAYS_MS\s*=\s*\[0, 500, 1500, 4000, 8000\]/.test(run),
    "Phase B 必须用有上限间隔的 settlement-only 退避持续恢复",
  );
  assert.ok(
    settleBlock.includes("(?:400|404|409)") &&
      settleBlock.includes("if (deadLetterReason)") &&
      settleBlock.includes("deadLetterHandoff(deps, pending, deadLetterReason)"),
    "明确 400/404/409 必须停止 API 重试，并持续重试 dead-letter mutation",
  );
  const phaseARun = run.slice(run.indexOf("async function run(deps)"), run.indexOf("// ---- 1. 登录"));
  assert.ok(
    phaseARun.includes("recoverSettlementBeforeClaim(deps, platform)"),
    "Phase A 必须在当前平台 login 之前恢复旧 pending，否则掉登录会吞掉上一腿",
  );
  assert.ok(
    run.includes("'handoff_write_failed'") && run.includes("const TERMINAL"),
    "claim 后 handoff 写失败必须终局，不能整轮再 claim",
  );
  const sendPathStart = run.indexOf("let guarded = Object.assign({}, handoff");
  const sendPath = run.slice(sendPathStart, run.indexOf("const state =", sendPathStart) + 300);
  assert.ok(
    sendPath.indexOf("persistHandoff(deps, guarded)") <
      sendPath.indexOf("'prospects/prepare-send'") &&
      sendPath.indexOf("'prospects/prepare-send'") < sendPath.indexOf("deps.send("),
    "发送顺序必须是 durable guard → prepare-send → 真实 click",
  );
}

// ------------------------------------------------- Phase B 接线
{
  // Phase B 必须驱动**既有**的页内生成链路，而不是另写一套写入逻辑 ——
  // 那套已经做了拟人节奏敲字、失焦保护、目标快照，重写一份必然退化。
  assert.ok(iso.includes("marineRimeGenStart()"), "Phase B 要复用页内生成入口");
  assert.ok(iso.includes("marineRimeGen.state") || iso.includes("g.state"),
    "生成是状态机不是 Promise，必须轮询它的 state 判完成");
  assert.ok(iso.includes("marineProspectRun.runOnTargetSingleFlight"),
    "交接单读取和真实执行必须共用 single-flight，不能预读后再读一次");
  assert.ok(!iso.includes("marineProspectRun.readHandoff({ handoffStore: marineProspectHandoffStore })"),
    "Phase B 不能先预读再让 runOnTarget 二次读取 —— 第二次瞬时失败会丢任务");
  const handoffAdapter = iso.slice(
    iso.indexOf("const marineProspectHandoffStore"),
    iso.indexOf("function marineStartProspectRun"),
  );
  assert.ok(
    /MARINE_PROSPECT_HANDOFF_READ_TIMEOUT_MS\s*=\s*3000/.test(iso) &&
      /MARINE_PROSPECT_HANDOFF_MUTATION_TIMEOUT_MS\s*=\s*5000/.test(iso) &&
      handoffAdapter.includes("MARINE_PROSPECT_HANDOFF_MUTATION_TIMEOUT_MS") &&
      /if \(!r \|\| !r\.ok\) throw/.test(handoffAdapter),
    "handoff read 要可重试，write/clear 要容纳 MV3 cold wake，不能 1s 误判 durable mutation",
  );
  // 两个阶段的入口都要挂上；可以直接启动或定时启动，可靠性由有界 ready 重试
  // 保证，不能再把某个固定的 0ms 延迟当成唯一屏障。
  const startup = iso.slice(iso.indexOf("if (typeof window !== 'undefined') window.marineInternals"));
  assert.ok(startup.includes("marineStartProspectRun"), "Phase A 入口");
  assert.ok(startup.includes("marineStartProspectTargetPhase"), "Phase B 入口");
  // 发送已接上，但成功判据必须是**平台回执**，不是「点了按钮」
  const phaseB = iso.slice(iso.indexOf("marineStartProspectTargetPhase"));
  assert.ok(
    /send: \(platform, text, key, expectedTargetUrl, markAttempted\) =>[\s\S]{0,100}marineProspectSendComment\(platform, text, key, expectedTargetUrl, markAttempted\)/
      .test(phaseB),
    "send 要接到真实实现，并把权威目标 URL 传到 btn.click 前的最后一道闸",
  );
}

// ------------------------------------------------- 发送：必须点站点自己的按钮
{
  assert.ok(
    iso.includes("marineProspectFindSendButton"),
    "必须定位站点自己的发送控件",
  );
  // 这是整块最关键的一条：回执检测是在 MAIN world 劫持页面 fetch/XHR，
  // 扩展自己发的请求根本不经过它 —— 那样永远拿不到「真的上线了」的证据。
  const sendBlock = iso.slice(iso.indexOf("function marineProspectSendComment"));
  const impl = sendBlock.slice(0, sendBlock.indexOf("function marineStartProspectTargetPhase"));
  assert.ok(impl.includes(".click()"), "只能点网站自己的按钮");
  assert.ok(
    !/fetch\(|XMLHttpRequest/.test(impl),
    "绝不能由扩展自己发评论请求 —— 那会绕过 MAIN world 的回执劫持，永远无法确认是否真的发出去",
  );
  // 发送前必须核对输入框实际内容 —— 唯一能挡住「发出半截评论」的闸
  assert.ok(
    impl.includes("marineProspectEditorTexts") &&
      impl.includes("marineProspectResolveEditor"),
    "发送前要读输入框的实际内容核对，间接推断生成完成不够可靠",
  );
  // 两种读法必须都比一遍：只用 textContent 会让多行草稿永远对不上（B站/知乎/抖音
  // 全部拒发），只用 innerText 会在知乎弹层不可见时读不到内容（实测把知乎从
  // 「能发」变成「内容不一致」）。
  assert.ok(
    /candidates\.some\(/.test(impl),
    "两种读法任一匹配即可放行，锁死其中一种都会造成整平台拒发",
  );
  assert.ok(
    /拒绝发送/.test(impl),
    "草稿没写完必须拒发 —— 没发出去还能重来，发出去的公开评论撤不回",
  );
  const targetCheck = impl.indexOf("marineProspectRun.sameTarget(expectedTargetUrl, gotTargetUrl)");
  const attemptGuard = impl.indexOf("await markAttempted()");
  const finalTargetCheck = impl.indexOf(
    "marineProspectRun.sameTarget(expectedTargetUrl, finalTargetUrl)",
  );
  const click = impl.indexOf("        btn.click();");
  assert.ok(
    targetCheck >= 0 && attemptGuard > targetCheck &&
      finalTargetCheck > attemptGuard && click > finalTargetCheck &&
      impl.slice(targetCheck, click).includes("target_changed_before_send"),
    "btn.click 前必须 target→durable unconfirmed→再验 target，SPA A→B/崩溃都不能重发",
  );
  assert.ok(
    /attempted:\s*true[\s\S]{0,160}已点发送但未收到平台回执/.test(impl),
    "click 成功返回后回执超时必须标 attempted，供台账 settle unconfirmed",
  );
  assert.ok(
    /btn\.click\(\);[\s\S]{0,240}catch \(e\)[\s\S]{0,180}attempted:\s*true/.test(impl),
    "btn.click 调用抛错也已跨不可逆边界，必须 settle unconfirmed",
  );
  const navigationHandler = iso.slice(
    iso.indexOf("function marineRimeHandleNavigation"),
    iso.indexOf("function marineRimeStartTargetTracking"),
  );
  assert.ok(
    navigationHandler.includes("marineRimeGenAbort('navigation')"),
    "真实 URL navigation 必须中止在途生成；不能和同内容 DOM 重挂载混为一谈",
  );
  const normalizeDraft = iso.slice(
    iso.indexOf("function marineProspectNormalizeDraft"),
    iso.indexOf("function marineProspectTypeViaCdp"),
  );
  assert.ok(
    normalizeDraft.includes("\\u200B-\\u200D\\u2060\\uFEFF") &&
      normalizeDraft.includes(".replace(/\\s+/g, ' ')") &&
      // 归一化后必须**全文相等**（任一读法），不能退化成比长度。
      /marineProspectNormalizeDraft\(t\) === expected/.test(impl),
    "发送前要去零宽字符、折叠空白后全文相等；只比较长度会放过同长度错稿",
  );
  {
    const match = /function marineProspectNormalizeDraft\(value\) \{[\s\S]*?\n  \}/.exec(iso);
    assert.ok(match, "草稿归一化函数必须可独立验证");
    const normalizeCtx = {};
    vm.createContext(normalizeCtx);
    vm.runInContext(match[0] + "\nglobalThis.normalizeDraft = marineProspectNormalizeDraft;", normalizeCtx);
    assert.equal(normalizeCtx.normalizeDraft("甲\u200B  \n 乙\uFEFF"), "甲 乙");
    assert.notEqual(normalizeCtx.normalizeDraft("同长甲"), normalizeCtx.normalizeDraft("同长乙"),
      "同长度错稿不能归一化成同一个值");
  }
  assert.ok(
    !/actual\.replace\([^\n]+\.length\s*</.test(impl),
    "不能退回长度比较",
  );
  assert.ok(
    iso.includes("已写入并核对生成草稿，准备自动提交") &&
      !iso.includes("请人工确认后手动发送"),
    "生成完成日志要反映真实的自动提交模式，不能误导排障",
  );
  // 生成完成必须以 marineRimeGenFinish 的 reason 为准
  const gen = iso.slice(iso.indexOf("function begin()"));
  const genBlock = gen.slice(0, 1800);
  assert.ok(
    genBlock.includes("finishSeq") && genBlock.includes("lastFinish"),
    "完成判据必须是 marineRimeGenFinish 的 reason —— 用 state/文本长度推断会把中止当成完成",
  );
  assert.ok(
    genBlock.includes("g.lastFinish !== 'done'"),
    "只有 reason==='done' 算敲完；中止必须报失败，否则会发出半截评论（实测发生过两次）",
  );
  const seqAt = genBlock.indexOf("const seqBefore = g.finishSeq || 0");
  const startAt = genBlock.indexOf("marineRimeGenStart()");
  assert.ok(
    seqAt >= 0 && startAt > seqAt,
    "finishSeq 基线必须在 start 前捕获 —— 同步失败会在 start 内推进序号，后取会白等 120s",
  );
  assert.ok(
    genBlock.indexOf("marineRimeGenBusy()") >= 0 &&
      genBlock.indexOf("marineRimeGenBusy()") < startAt &&
      genBlock.indexOf("reason: 'target_lost'") < startAt,
    "生成器 busy 或目标瞬失要在 start 前立即结束，不能串用别人的 finishSeq 或白等 120s",
  );
  assert.ok(
    !genBlock.includes("STABLE_ROUNDS"),
    "别再用「文本不再增长」推断 —— 中止时文本同样不再增长",
  );
  // 状态机要真的暴露这个信号
  assert.ok(
    iso.includes("marineRimeGen.lastFinish = reason"),
    "marineRimeGenFinish 要把结束原因暴露出来",
  );
  // 失败路径也必须推进 finishSeq，否则编排既收不到完成也收不到中止，
  // 只能等满 120s —— **所有失败都伪装成「生成超时」**，排查会被带偏。
  const fail = iso.slice(iso.indexOf("function marineRimeGenFail"));
  assert.ok(
    fail.slice(0, 900).includes("finishSeq"),
    "marineRimeGenFail 也要推进 finishSeq，否则失败原因永远传不出去",
  );
  // Draft.js（知乎）在接收输入时会重建 DOM 节点，打字开始时拿到的引用当场失效。
  // 实测：敲到第 3 个字 isConnected 变 false，整轮以「目标输入框已失效」告终。
  // 手动没事是因为人会先点输入框、等它挂载稳定再点生成。
  assert.ok(
    iso.includes("function marineProspectRecoverEditor"),
    "节点被重建时要按选择器重新解析，而不是判死刑",
  );
  {
    const rec = iso.slice(iso.indexOf("function marineProspectRecoverEditor"));
    // 不限编排：节点重建是 Draft.js 自己的行为，手动点生成一样会碰到
    // （实测：手动也只写进第一个输出块）。安全性来自「原节点已从文档消失」
    // 和「新节点必须被认成评论输入框」两条，不是来自谁触发的。
    assert.ok(
      !rec.slice(0, 900).includes("if (!marineProspectOrchestrating) return null"),
      "节点恢复不能限定在编排模式 —— 手动路径面对同一个 Draft.js",
    );
    assert.ok(
      rec.slice(0, 1400).includes("fresh.isConnected") && rec.slice(0, 1400).includes("fresh === stale"),
      "只在原节点已消失时才换，且不能换成同一个",
    );
    // 抖音重建时整条输入条会消失（实测那一刻 [contenteditable] 是 0 个），
    // 重新查询查无可查 —— 必须允许再走一遍「打开评论区」。
    assert.ok(
      rec.slice(0, 1400).includes("marineProspectOpenCommentPanel"),
      "查不到候选时要允许重开评论区 —— 抖音会把整条输入条收起来",
    );
    assert.ok(
      iso.includes("g.recoverTries"),
      "重挂载要给几轮时间，立刻判死会把正常的重建当成失败",
    );
  }
  assert.ok(
    /const fresh = marineProspectRecoverEditor\(editor\);/.test(iso),
    "打字泵和起始处都要走恢复路径",
  );

  // 打字泵逐字检查焦点，一次失焦就 abort('focus-lost')。知乎的评论弹层敲字中
  // 会短暂夺焦，不容忍的话敲两个字就中止 —— 实测发出过两字评论。
  // 夺焦是 Draft.js 重绘的副作用，手动点生成一样会碰到 —— 所以这层保护也不能
  // 限定在编排模式。
  const pump = iso.slice(iso.indexOf("insertText 落在"));
  assert.ok(
    pump.slice(0, 1200).includes("editor.focus()") && pump.slice(0, 1200).includes("recovered"),
    "失焦要先尝试抢回；抢不回来才停手",
  );
  assert.ok(
    !/if \(marineProspectOrchestrating && editor && editor\.isConnected\)/.test(pump.slice(0, 1200)),
    "失焦恢复不能限定在编排模式",
  );

  // 防重发：小红书发完**不清空草稿**（B站/知乎会清），配上「没收到回执记
  // failed」，任何重试都会把同一条再发一遍。发送是唯一不可逆的动作。
  assert.ok(
    iso.includes("marineProspectSentKeys"),
    "同一条交接单只允许点一次发送",
  );
  {
    // 锚在发送函数上：常量和它之间会插别的独立函数（抖音的 CDP 打字就在那）。
    const guard = iso.slice(iso.indexOf("function marineProspectSendComment"));
    const g = guard.slice(0, 2400);
    assert.ok(
      /拒绝重复发送/.test(g),
      "重复调用要显式拒绝，不能默默再点一次",
    );
    // 标记必须在点击之前落下
    // 锚在发送函数本身上：`const marineProspectSentKeys` 和它之间可能插着别的
    // 独立函数（抖音的 CDP 打字就在那），从常量起切会把无关代码算进来。
    const sendFn = iso.slice(iso.indexOf("function marineProspectSendComment"));
    const markIdx = sendFn.indexOf("marineProspectSentKeys[key] = true");
    const clickIdx = sendFn.indexOf("        btn.click();");
    assert.ok(markIdx >= 0 && clickIdx > markIdx,
      "标记要在点击之前落 —— 点完再标记的话，点击抛异常或页面跳转就会漏标");
  }
  assert.ok(
    /send: \(platform, text, key, expectedTargetUrl, markAttempted\) =>\s*marineProspectSendComment\(platform, text, key, expectedTargetUrl, markAttempted\)/.test(iso),
    "key 和目标 URL 都要接上，否则防重发与点击前目标校验无从判断",
  );

  // 成功判据 = 回执
  assert.ok(
    impl.includes("marineLastPublishedReceipt"),
    "成功与否要等平台回执，不能点完就算成功",
  );
  assert.ok(
    /未收到平台回执/.test(impl),
    "等不到回执必须报失败 —— 把没发出去的记成 posted 会污染 cap 和报表",
  );
  // B 站的发送控件不是 <button>，按 tagName 找必然选错
  const finder = iso.slice(iso.indexOf("function marineProspectFindSendButton"));
  // 命中的是同一个按钮的多层包装（外壳 898x120 → 工具栏 898x32 → 外框 70x32
  // → BUTTON）。取文档序第一个 = 取到最外层外壳，点下去毫无反应，实测踩过。
  assert.ok(
    finder.slice(0, 2200).includes("getBoundingClientRect") &&
      finder.slice(0, 2200).includes("'button'"),
    "要取最内层控件：优先 <button>，否则取面积最小的那个",
  );
  assert.ok(
    finder.slice(0, 900).includes("!== '发布'"),
    "要用 textContent 严格相等匹配 —— includes 会把正文里出现「发布」的评论卡片匹配进来",
  );
  assert.ok(
    finder.slice(0, 900).includes("platform !== 'bilibili'"),
    "没实测过的平台一律不返回控件，猜一个选择器的代价是往真实账号发错东西",
  );
  // 小红书：控件必须限定在 .engage-bar-container 内 —— 页面右上角还有「发布
  // 笔记」的入口，全局找必然选错。
  const xhsFinder = iso.slice(iso.indexOf("function marineProspectFindXhsSendButton"));
  assert.ok(
    xhsFinder.slice(0, 900).includes("engage-bar-container"),
    "小红书的发送控件要锚在评论条容器内，不能全局搜",
  );
  // 抖音：三个 36×36 的图标控件（@ / 表情 / 发送）都没有文字，类名是混淆的
  // （实测 wchsYBpK jfGCpJo0，改版必变）。唯一稳定的区分是**位置最右**。
  const dyFinder = iso.slice(iso.indexOf("function marineProspectFindDouyinSendButton"));
  assert.ok(
    dyFinder.slice(0, 1400).includes("bestLeft") &&
      dyFinder.slice(0, 1400).includes("r.left > bestLeft"),
    "抖音只能按位置取最右那个 —— 类名是混淆的，钉类名下次改版就选错",
  );
  assert.ok(
    dyFinder.slice(0, 1400).includes("contenteditable") &&
      dyFinder.slice(0, 1400).includes("parentElement"),
    "要锚在输入框的祖先容器内搜 —— 播放器那条弹幕栏也有发送控件，全局搜会选错",
  );
}

// ------------------------------------------------- 自动打开评论区 / 选中输入框
{
  // 抖音有**三种**页面形态，评论区入口各不相同，而且判据不能是「有没有图标」：
  //   · 视频页 /video/…          feed-comment-icon 点了就出评论区
  //   · 图文笔记页 /note/…       没有图标，右栏「相关推荐 | 评论(N)」要点 tab
  //   · 精选页 /jingxuan?modal_id=…  **图标存在**，但点它只开合右侧抽屉；
  //     必须再点抽屉里的「评论」tab，而且那一页**没有 comment-list**
  // 老代码用「没有图标」来决定要不要找 tab，于是精选页永远走不到 tab 分支：
  // 一轮轮点图标直到 240 秒超时（实测卡满一整条腿）。
  const dy = iso.slice(iso.indexOf("function marineProspectOpenDouyinComments"));
  const body = dy.slice(0, 3000);
  assert.ok(
    body.includes("marineProspectDouyinIconClicked"),
    "评论图标每个文档只能点一次 —— 精选页点它是开合抽屉，反复点会把刚开的关上",
  );
  assert.ok(
    /jingxuan/.test(body),
    "精选页这个形态要在注释里留痕 —— 它和视频页的区别是「有图标但点了没用」，" +
      "不写下来下次还会照着「没有图标才找 tab」写",
  );
  assert.ok(
    !/el\.offsetParent !== null/.test(body),
    "可见性判据不能用 offsetParent —— 它在 position:fixed 的子树里恒为 null，" +
      "而抖音的右侧抽屉正是 fixed，会把真实存在的输入框判成不可见",
  );
  assert.ok(
    body.includes("|| document.body"),
    "找输入条要能在没有 comment-list 时退回全文档 —— 精选页一个带 comment 的 data-e2e 都没有",
  );
}

{
  // 这四条都是实测踩出来的，每一条都曾让链路停在「未能定位到直评输入框」。
  assert.ok(
    iso.includes("marineProspectOpenCommentsAndFocus"),
    "自动化打开的页面没人滚也没人点，必须自己滚到评论区并激活目标",
  );
  // 后台标签页的上下文 PUT 会被 SW 推迟并在 5 秒后丢弃 —— 结果不是「慢一点」
  // 而是烧靶子：生成超时 → 记 failed → 按「失败不重试」那条候选永久作废。
  assert.ok(
    iso.includes("__marineProspectFocusTab"),
    "Phase B 必须先把自己的窗口拉到前台",
  );
  assert.ok(sw.includes("marineFocusSenderTab"), "SW 要提供聚焦入口");

  // 编排模式：人必须能在跑的时候用鼠标干别的。
  // 实测：鼠标一移开就 `已清理投放目标：window-blur` + `put 失败：deferred`
  // → 生成超时 → 台账记 failed → 靶子按「失败不重试」永久作废。
  assert.ok(iso.includes("marineProspectSetOrchestrating(true)"), "Phase B 要进入编排模式");
  assert.ok(iso.includes("marineProspectSetOrchestrating(false)"), "跑完必须退出，否则人工操作会一直绕过焦点保护");
  // 失焦有三条独立路径（window-blur / editor-blur / 打字泵的逐字检查）。
  // 只豁免其中一条的话，换个平台就复发 —— 小红书走的是 editor-blur。
  const retain = iso.slice(iso.indexOf("function marineRimeRetainOrClear"));
  assert.ok(
    /marineProspectOrchestrating && marineRimeGenBusy\(\)/.test(retain.slice(0, 900)),
    "编排生成期间任何失焦都不得清目标，不能只挡 window-blur 一条",
  );
  assert.ok(
    !/reason === 'window-blur'/.test(retain.slice(0, 900)),
    "别按 reason 逐条豁免 —— 那是在追症状，新平台会带来新的 reason",
  );
  assert.ok(iso.includes("orchestrated: marineProspectOrchestrating === true"), "上下文 PUT 要带编排标记");
  // marineRimeDeliver 是逐字段重建消息的 —— 漏掉这个字段等于特性从未存在，
  // 而且没有任何报错。实测踩过：SW 侧豁免正确、content 侧也设了标记，就是到不了。
  const deliver = iso.slice(iso.indexOf("function marineRimeDeliver"));
  assert.ok(
    deliver.slice(0, 900).includes("orchestrated: operation.orchestrated === true"),
    "投递时必须把编排标记带上 —— 这个函数逐字段重建消息，漏字段会静默丢特性",
  );
  // 光认这个标记不够 —— 它必须在**三道闸**上都放行。只放行一道等于没放行，
  // 而且症状完全一样（PUT 静默不写 → 12 秒超时 → 记 failed → 靶子作废）。
  // 这正是这个 bug 活下来的原因：老测试只 grep 了标记本身，半截接线照样通过。
  assert.ok(
    sw.includes("msg.orchestrated === true"),
    "SW 要认这个编排标记",
  );
  {
    const authority = sw.slice(sw.indexOf("const authorityIsCurrent = () => ("));
    assert.ok(
      authority.slice(0, 200).includes("orchestrated ||"),
      "写闸要对编排放行 —— 只放行推迟闸的话，人一切走 marineActiveTabId 就是 null，" +
        "PUT 连 fetch 都不发，却回一个 ok:true",
    );
  }
  assert.ok(
    /hasSuspendedRetainedLease && msg\.op === 'put' && !orchestrated/.test(sw),
    "挂起租约闸也要放行 —— 它在 marineApplyContextMessage 之前就返回，" +
      "里面的豁免够不着；且只在小红书/抖音可达，B站知乎跑通不代表它不存在",
  );
  assert.ok(
    sw.includes("marineTabIsOrchestrated"),
    "失焦清理要跳过编排的上下文 —— 清理会 DELETE 掉 contextId，" +
      "后端记进 revoked 之后同一个 id 再也 PUT 不进去",
  );
  // single-flight 的生命周期钩子必须成对接上，失败路径也会走 endTarget。
  assert.ok(
    /beginTarget:\s*async \(\) => \{[\s\S]{0,200}marineProspectSetOrchestrating\(true\)/.test(iso) &&
      /endTarget:\s*\(\) => \{[\s\S]{0,200}marineProspectSetOrchestrating\(false\)/.test(iso),
    "进入/退出编排模式要交给 single-flight 的 finally 生命周期，且只有读到交接单才进入",
  );
  // 必须抢窗口焦点 —— 但**理由和以前不是同一个**，别照旧注释推断。
  //
  // 旧理由（已失效）：上下文的归属闸只认活动标签页。那个已经修好了，
  // orchestrated 的 PUT 在三道闸上都放行，上下文本身不再需要任何焦点。
  //
  // 现在的理由（实测，只改这一个变量就翻转）：**B 站的发布按钮只在窗口拿到
  // 操作系统焦点时才渲染**。失焦时整个评论框停在一个 768×50 的紧凑条上，
  // 内层 BUTTON 根本不在 DOM 里。三种绕法都试过且都无效：合成 window focus
  // 事件、在 MAIN world 覆盖 document.hasFocus()、用 CDP 真实鼠标点那个条。
  assert.ok(
    sw.includes("chrome.windows.update") && sw.includes("focused: true"),
    "必须聚焦窗口 —— B 站的发布按钮只在窗口有操作系统焦点时才渲染（实测）",
  );
  assert.ok(
    sw.includes("chrome.tabs.update(tabId, { active: true })"),
    "还要把自己变成窗口内的活动标签页 —— 否则 document.hidden 为真，打字泵会被浏览器 clamp",
  );
  const focusFn = sw.slice(sw.indexOf("async function marineFocusSenderTab"));
  assert.ok(
    focusFn.slice(0, 700).includes("sender && sender.tab"),
    "tab 身份只认 sender —— 让页面自报 tabId 等于允许它把别的标签页抢到前台",
  );
  assert.ok(
    iso.includes("marineProspectScanForEditor(document)"),
    "评论根找不到时要退回全文档 —— marineCommentSearchRoot 的逗号选择器在 B 站会先命中一个普通 DIV，" +
      "而输入框在 <bili-comments> 的 shadow root 里",
  );
  // 激活有三个来源（显式调用 + click/focus 各自的 focusin），每次都换新
  // contextId，而 marineRimeGenSync 看到 contextId 变了就 abort('target-switched')。
  // 实测：连着三条「已锁定」后生成被自己人打断。
  // 生成进行中，人工点击不得改写目标 —— 编排独占标签页，而人要用鼠标干别的。
  // 实测：随手点一下页面别处就 abort('target-switched')，一整轮生成白费。
  assert.ok(
    /if \(marineProspectOrchestrating && marineRimeGenBusy\(\)\) return;/.test(iso),
    "编排生成期间要冻结人工事件驱动的目标切换",
  );
  assert.ok(
    /active\.contextId !== marineRimeGen\.contextId && !marineProspectOrchestrating/.test(iso),
    "编排期间也不因目标切换中止在途生成（双保险）",
  );
  assert.ok(
    /already && already\.editor === editor/.test(iso),
    "已经锁在同一个输入框上就不能重复激活",
  );
  assert.ok(
    iso.includes("marineRimeActivate(editor)"),
    "必须显式激活：合成 click 的 isTrusted 是 false，focus 在已聚焦时不产生事件，" +
      "导航后的重新武装闸因此永不放行",
  );
  // 等待条件：必须等目标激活，不能等 marineRimeGen.editor
  const wait = iso.slice(iso.indexOf("function marineProspectGenerateAndFill"));
  const waitBlock = wait.slice(0, wait.indexOf("function begin"));
  assert.ok(
    waitBlock.includes("marineRimeTarget") && waitBlock.includes("active"),
    "要等 marineRimeTarget.active",
  );
  assert.ok(
    !/if \(g\.editor && g\.editor\.isConnected\) return begin\(\)/.test(waitBlock),
    "不能等 marineRimeGen.editor —— 它只在 marineRimeGenStart() 之后才被赋值，等它是死锁；" +
      "而且症状会伪装成「定位不到输入框」",
  );
}

// ------------------------------------------------- 抖音走 CDP 键盘代打
{
  // 抖音的编辑器对页内合成输入有反制：execCommand 写一两个字就把整个评论组件
  // 拆掉（实测 comment-list 消失且点图标 6 次都恢复不了），**手动点生成也一样**。
  // CDP Input.dispatchKeyEvent 是浏览器层面的可信事件，实测连打 8 个字无损。
  assert.ok(
    iso.includes("marineProspectTypeViaCdp"),
    "抖音的写入要委托给 Rust 侧的 CDP 键盘事件",
  );
  assert.ok(
    /detectPlatform\(\) === 'douyin' && !g\.douyinDelegated/.test(iso),
    "只对抖音走这条路，且只委托一次",
  );
  // 另外三个平台的页内写入是真实验证过的，不能被这条改动波及
  const wu = iso.slice(iso.indexOf("function marineRimeGenWriteUnit"));
  assert.ok(
    !/douyin/i.test(wu.slice(0, 900)),
    "写入函数本身不该出现平台分支 —— 三平台的路径保持原样",
  );

  // 这条路由比 prospects/* 危险，约束必须都在
  assert.ok(sw.includes("'type-text'"), "SW 白名单要放行 type-text");
  // type-text 是同步等 Rust 逐字敲完才返回，拟人节奏下 180 字要一分多钟；
  // 沿用台账那套 15s 超时必然掐断（实测报 `signal is aborted without reason`，
  // 而字其实正在被敲进去）。
  assert.ok(
    /route === 'type-text' \? \d{5,}/.test(sw),
    "type-text 要单独放宽超时 —— 它不是毫秒级的本地读写",
  );
  const rs = read("../../src-tauri/src/api_server.rs");
  assert.ok(
    rs.includes("MARINE_TYPE_MAX_CHARS"),
    "Rust 侧要限制单次代打的字数",
  );
  assert.ok(
    /c\.is_control\(\)/.test(rs),
    "必须拒绝控制字符 —— 否则一个回车就能绕过「发送必须点站点按钮」这道闸",
  );
  assert.ok(
    rs.includes("resolve_running_profile"),
    "目标必须是正在运行的 profile，不能由调用方随意指定",
  );
  // 只打字，不能顺手把点击/导航也开出去
  const typeFn = rs.slice(rs.indexOf("async fn marine_type_text"));
  assert.ok(
    !/dispatchMouseEvent|Page::navigate|Page\.navigate/.test(typeFn.slice(0, 2000)),
    "这条路由只许打字 —— 点击和导航会让页面上下文获得远超必要的能力",
  );
}

// ------------------------------------------------- 抖音的评论区要两步打开
{
  const dy = iso.slice(iso.indexOf("function marineProspectOpenDouyinComments"));
  const body = dy.slice(0, 4000);
  assert.ok(
    body.includes("feed-comment-icon") && body.includes("comment-list"),
    "抖音要先点评论图标展开面板，再点输入条",
  );
  // 抖音有两种页面形态，入口完全不同：视频页 /video/ 有评论图标，
  // 图文笔记页 /note/ 右栏是「相关推荐 | 评论(N)」tab，默认不在评论上。
  // 只处理视频页的话，笔记页永远找不到输入框。
  assert.ok(
    /\^评论/.test(body),
    "笔记页要能点「评论(N)」这个 tab —— 那种页面没有 feed-comment-icon",
  );
  assert.ok(
    body.includes("previousElementSibling"),
    "输入条要靠「comment-list 的前一个兄弟」定位 —— 抖音类名是混淆的且每个视频页都不同",
  );
  assert.ok(
    !/\.comment-input/.test(body),
    "不能依赖 .comment-input 类名：实测同一份代码在两个视频上类名完全不同",
  );
  // 抖音评论区要两步打开且渲染慢（实测十几秒）。窗口太短会表现成「定位不到
  // 输入框」，而手动同样的步骤是通的 —— 症状会误导人去查选择器。
  assert.ok(
    /marineProspectOpenCommentsAndFocus\(30000\)/.test(iso),
    "打开评论区的窗口要够抖音用（两步 + 慢渲染）",
  );
  assert.ok(
    body.includes("spots[spots.length - 1]"),
    "取最内层元素 —— 外层容器同样命中占位文案，点外层不一定触发挂载",
  );
}

// ------------------------------------------------- 关评论 -> 换靶子的接线
{
  // 判据必须走 prospect-run 的三态函数，不能在 content-iso 里另写一份字符串
  // 匹配 —— 那份没有测试覆盖，而误判的代价是全局永久作废一条靶子。
  assert.ok(
    iso.includes("marineProspectRun.commentsClosed("),
    "关闭判据要复用 prospect-run.commentsClosed，不能在 iso 里另写",
  );
  assert.ok(
    iso.includes("reason: 'comments_closed'"),
    "等不到输入框且判定关闭时，要给出可区分的 reason，否则 runOnTarget 只能当普通失败处理",
  );
  // 换靶子要能导航；缺了它 runOnTarget 只会走 blocked_no_hop。
  assert.ok(
    /navigate: \(url, meta\) => marineProspectNavigateWithWatchdog\(url, meta\)/
      .test(iso.slice(iso.indexOf("marineStartProspectTargetPhase"))),
    "Phase B 必须接上共用导航 watchdog，否则换靶子仍可能卡在旧 document",
  );
  // 关闭判据必须在「没等到输入框」之后才问，两道独立的闸。
  const gaf = iso.slice(iso.indexOf("function marineProspectGenerateAndFill"));
  const giveUpAt = gaf.indexOf("function giveUp");
  const closedAt = gaf.indexOf("marineProspectRun.commentsClosed(");
  assert.ok(giveUpAt >= 0 && closedAt > giveUpAt,
    "只有等不到输入框才去问是不是关了评论 —— 有输入框还判关闭必是噪声");
  // 扫描必须避开评论正文，否则有人评论里写「无法评论」就会误判。
  assert.ok(
    iso.includes("marineInsideCommentItem"),
    "扫描关闭文案时必须排除评论正文",
  );
  assert.ok(
    iso.includes("if (el.childElementCount) continue;"),
    "只取叶子节点，否则父节点会把整块文本重复一遍",
  );
}

// ------------------------------------------------- blocked 是全局状态
{
  const run = read("../src/platforms/prospect-run.js");
  assert.ok(
    run.includes("'blocked'"),
    "关评论要记 blocked，不能记 failed —— failed 只挡本账号",
  );
  assert.ok(
    run.includes("MAX_TARGET_HOPS"),
    "换靶子必须封顶，否则一串关评论的视频会把整批任务卡在一个 profile 上",
  );
  // 换靶子只能靠台账重新 claim，不能自己挑 —— 自己挑等于把去重逻辑复制一份。
  const hop = run.slice(run.indexOf("async function hopToNextTarget"));
  assert.ok(
    hop.includes("prospects/claim"),
    "换靶子要走台账的 claim，不能在扩展里自己挑下一条",
  );
}

// ------------------------------------------------- 发送前的草稿核对（行为级）
//
// 这道闸是唯一能挡住「发出半截评论」的东西，可它本身也能把**正确的**草稿判成
// 不一致 —— 那样整个平台永远发不出去，而且看起来像是选择器失效。两种读法各有
// 一次实测翻车：
//   · 只读 textContent → contenteditable 没有块级分隔符，多行草稿全部拒发
//   · 只读 innerText   → 知乎弹层在发送前那一刻不可见，读不出内容，同样拒发
// 所以这里真跑一遍比对逻辑，不做字符串断言。
{
  const sliceFn = (name) => {
    const from = iso.indexOf("function " + name + "(");
    assert.ok(from >= 0, name + " 必须存在");
    let depth = 0;
    for (let i = iso.indexOf("{", from); i < iso.length; i += 1) {
      if (iso[i] === "{") depth += 1;
      else if (iso[i] === "}") {
        depth -= 1;
        if (depth === 0) return iso.slice(from, i + 1);
      }
    }
    throw new Error(name + " 没配平");
  };

  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    [sliceFn("marineProspectEditorTexts"), sliceFn("marineProspectNormalizeDraft")].join("\n") +
      "\nglobalThis.__texts = marineProspectEditorTexts;" +
      "globalThis.__norm = marineProspectNormalizeDraft;",
    sandbox,
    { filename: "marine-extension/src/content-iso.js#draft-verify" },
  );

  // 发送处的判据：两种读法任一对得上就放行。
  const accepts = (el, generated) => {
    const cands = sandbox.__texts(el);
    assert.notEqual(cands, null, "应当读得到输入框内容");
    const want = sandbox.__norm(generated);
    return cands.some((t) => sandbox.__norm(t) === want);
  };

  const editable = ({ text, innerText, connected = true }) => ({
    tagName: "DIV", isConnected: connected, textContent: text, innerText,
  });
  const textarea = (value) => ({ tagName: "TEXTAREA", isConnected: true, value });

  const generated = "第一行\n第二行";

  // contenteditable 的块级结构在 textContent 里没有分隔符，靠 innerText 兜。
  assert.ok(
    accepts(editable({ text: "第一行第二行", innerText: "第一行\n第二行" }), generated),
    "多行草稿必须通过 —— 否则 B站/知乎/抖音 100% 拒发，只有小红书能发出去",
  );

  // 知乎实测：弹层不可见时 innerText 给不出内容，此时要能退回 textContent。
  assert.ok(
    accepts(editable({ text: "第一行 第二行", innerText: "" }), generated),
    "innerText 读不到时必须退回 textContent —— 否则知乎从「能发」变成「内容不一致」",
  );

  // 小红书那条路没变：textarea 读 value。
  assert.ok(accepts(textarea("第一行\n第二行"), generated), "textarea 仍然读 value");

  // 闸门本身还得管用：两种读法都对不上才拒发。
  assert.ok(
    !accepts(editable({ text: "第一行", innerText: "第一行" }), generated),
    "只填进去半截必须拒发",
  );
  assert.ok(
    !accepts(editable({ text: "第一行别的第二行", innerText: "第一行\n别的\n第二行" }), generated),
    "被插入了额外内容必须拒发",
  );

  // 零宽字符与空白差异属于表现差异，不该拦。
  assert.ok(
    accepts(editable({ text: "", innerText: "第一行\u200b\n\n  第二行  " }), generated),
    "零宽字符和多余空白不该被当成改写",
  );

  // 输入框脱离文档时要报「读不到」，而不是读成空串然后判不一致。
  assert.equal(
    sandbox.__texts(editable({ text: "x", innerText: "x", connected: false })),
    null,
    "脱离文档的输入框应当读不到",
  );
  assert.equal(sandbox.__texts(null), null, "没有输入框时应当读不到");
}

console.log("prospect-wiring-smoke: OK");
