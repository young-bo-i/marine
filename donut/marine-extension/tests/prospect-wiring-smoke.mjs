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

// 两个发送/输入定位器都是 DOM 邻接关系算法。用一个很小的 DOM fixture 跑真实
// 函数体，避免只靠字符串断言漏掉「选择器写了，但仍会越界点到页面别处」这类问题。
class ProspectDomFixture {
  constructor(tagName = "div", options = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.className = options.className || "";
    this.textContent = options.textContent || "";
    this.attrs = { ...(options.attrs || {}) };
    this.visible = options.visible !== false;
    this.disabled = options.disabled === true;
    this.kind = options.kind || "";
    this.width = options.width ?? 80;
    this.height = options.height ?? 30;
    this.left = options.left ?? 0;
    this.top = options.top ?? 0;
    this.children = [];
    this.parentElement = null;
    this.clicked = 0;
    this.isConnected = true;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  getAttribute(name) {
    if (name === "class") return this.className;
    return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null;
  }

  matches(selector) {
    return String(selector).split(",").some((raw) => {
      const part = raw.trim();
      if (part === "*") return true;
      if (/^[a-z][a-z0-9-]*$/i.test(part)) return this.tagName === part.toUpperCase();
      const exactAttr = part.match(/^\[([\w-]+)="([^"]+)"\]$/);
      if (exactAttr) return this.getAttribute(exactAttr[1]) === exactAttr[2];
      const presentAttr = part.match(/^\[([\w-]+)\]$/);
      if (presentAttr) return this.getAttribute(presentAttr[1]) !== null;
      if (part === 'textarea[placeholder]') {
        return this.tagName === "TEXTAREA" && this.getAttribute("placeholder") !== null;
      }
      if (part === 'input[placeholder]') {
        return this.tagName === "INPUT" && this.getAttribute("placeholder") !== null;
      }
      const classContains = part.match(/^\[class\*="([^"]+)" i\]$/);
      if (classContains) {
        return this.className.toLowerCase().includes(classContains[1].toLowerCase());
      }
      const attrContains = part.match(/^\[([\w-]+)\*="([^"]+)" i\]$/);
      if (attrContains) {
        return String(this.getAttribute(attrContains[1]) || "").toLowerCase()
          .includes(attrContains[2].toLowerCase());
      }
      if (part === '.public-DraftEditor-content[role="textbox"]') {
        return this.className.split(/\s+/).includes("public-DraftEditor-content") &&
          this.getAttribute("role") === "textbox";
      }
      if (part.startsWith(".")) {
        return this.className.split(/\s+/).includes(part.slice(1));
      }
      return false;
    });
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  contains(other) {
    for (let node = other; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  getBoundingClientRect() {
    return {
      width: this.width,
      height: this.height,
      left: this.left,
      top: this.top,
      right: this.left + this.width,
      bottom: this.top + this.height,
    };
  }

  scrollIntoView() {}
  click() { this.clicked += 1; }
}

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
  // 距离放宽到 600：超时分支现在会先抓一份 diag() 落进 marine-debug.jsonl，再按
  // lastPost.built 决定说「判据未通过」还是「可能被风控拦截」。断言的意图没变 ——
  // 超时必须标 attempted 供台账 settle unconfirmed —— 只是中间多了那段取证。
  assert.ok(
    /attempted:\s*true[\s\S]{0,600}未收到平台回执/.test(impl),
    "click 成功返回后回执超时必须标 attempted，供台账 settle unconfirmed",
  );
  // 捕获回读：断链兜底。这三条钉的是**为什么它不可能造成重复评论** —— 全程只读。
  // 从整份 iso 里取：这个 helper 定义在 marineProspectSendComment 之上，不在 impl 切片内。
  const readback = iso.slice(
    iso.indexOf('function marineTryReceiptReadback'),
    iso.indexOf('function marineProspectSendComment'),
  );
  assert.ok(readback.length > 200, '找不到 marineTryReceiptReadback，回读兜底不见了');
  assert.ok(
    !/\.click\(|\.focus\(|dispatchEvent|scrollIntoView|fetch\(|XMLHttpRequest/.test(readback),
    '捕获回读必须全程只读：任何点击/聚焦/网络请求都可能变成第二次发送',
  );
  // 判据不能在这里复制一份 —— 必须转交桥里那个实测过的构造器，否则两处会各自漂移。
  assert.ok(
    /state\.buildFromCapture\(/.test(readback) && !/comment_v5|JSON\.parse/.test(readback),
    '回读必须把判据交给桥的 buildFromCapture，不能自己解析响应体',
  );
  // beforeId 守卫：否则会把上一条评论的回执当成这次的。
  assert.ok(
    /built\.eventId\s*!==\s*beforeId/.test(readback),
    '回读必须排除发送前就已存在的那条回执',
  );
  // 捕获必须留住 method/status/ok，否则回读根本无从判断「这是一次成功的 POST」。
  assert.ok(
    /commentCaptures\.push\(\{[\s\S]{0,300}method:[\s\S]{0,120}status:[\s\S]{0,120}ok:/.test(iso),
    'marineIngestComment 必须保留 method/status/ok',
  );

  // 取证本身也钉住：没有它，下一次「发出去了却没回执」又会只剩一句猜测。
  assert.ok(
    /__marinePublishedBridgeStateV1[\s\S]{0,400}marineLog\(\s*'error',\s*'publish-receipt'/.test(impl),
    "回执超时必须把桥的 diag() 落进持久日志，否则收尾一停页面证据就没了",
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
  // 知乎：新弹层可能把动作做成非 button 的 [role=button]，文字也可能是「发布
  // 评论」。必须从当前 editor 的祖先向上绑定；页面创作入口的「发布」是诱饵。
  {
    const start = iso.indexOf("function marineProspectFindZhihuSendButton");
    const end = iso.indexOf("\n\n  /**\n   * 当前直评输入框", start);
    assert.ok(start >= 0 && end > start, "知乎发送定位器必须可独立验证");
    const source = iso.slice(start, end);
    const compile = new Function(
      "marineProspectResolveEditor",
      "marineRimeIsCommentEditor",
      "marineVisible",
      `${source}\nreturn marineProspectFindZhihuSendButton;`,
    );
    const finderFor = (editor) => compile(
      () => editor,
      (candidate) => candidate?.kind === "comment-editor",
      (candidate) => candidate?.visible === true,
    );

    const page = new ProspectDomFixture("main");
    const decoy = new ProspectDomFixture("button", { textContent: "发布" });
    const modal = new ProspectDomFixture("section", { className: "Modal-content" });
    const owner = new ProspectDomFixture("div", { className: "CommentEditorV2" });
    const editor = new ProspectDomFixture("div", {
      className: "public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const publish = new ProspectDomFixture("div", {
      attrs: { role: "button", "aria-label": "发布评论" },
    });
    page.append(decoy, modal);
    modal.append(owner);
    owner.append(editor, publish);
    assert.equal(finderFor(editor)(), publish,
      "要支持当前评论 editor 内的非 button [role=button]/发布评论控件");
    assert.notEqual(finderFor(editor)(), decoy, "不能选页面级「发布」诱饵");

    // 新 DOM 也可能让动作行与 editor 壳成为兄弟：共同弹层只有一个 editor 时
    // 归属仍唯一，可以选；一旦出现第二个 editor 就必须 fail closed。
    const siblingModal = new ProspectDomFixture("section", { className: "Modal-content" });
    const siblingOwner = new ProspectDomFixture("div", { className: "CommentEditorV2" });
    const siblingEditor = new ProspectDomFixture("div", {
      className: "public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const siblingActions = new ProspectDomFixture("div");
    const siblingPublish = new ProspectDomFixture("button", { textContent: "发布" });
    siblingOwner.append(siblingEditor);
    siblingActions.append(siblingPublish);
    siblingModal.append(siblingOwner, siblingActions);
    assert.equal(finderFor(siblingEditor)(), siblingPublish,
      "唯一 editor 时可绑定同一弹层里的 sibling 动作行");

    const ambiguousModal = new ProspectDomFixture("section", { className: "Modal-content" });
    const firstOwner = new ProspectDomFixture("div", { className: "CommentEditorV2" });
    const firstEditor = new ProspectDomFixture("div", {
      className: "public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const secondOwner = new ProspectDomFixture("div", { className: "CommentBox" });
    const secondEditor = new ProspectDomFixture("div", {
      className: "public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const sharedActions = new ProspectDomFixture("div");
    const sharedPublish = new ProspectDomFixture("button", { textContent: "发布" });
    firstOwner.append(firstEditor);
    secondOwner.append(secondEditor);
    sharedActions.append(sharedPublish);
    ambiguousModal.append(firstOwner, secondOwner, sharedActions);
    assert.equal(finderFor(firstEditor)(), null,
      "共同容器有多个 editor 时不能猜共享发布按钮归属");

    // 改版若去掉 CommentEditorV2/CommentBox，localOwner 会是 null；这时更不能
    // 跳过唯一性检查，否则一个 modal 里的直评框和回复框会共用到同一发布按钮。
    const ownerlessModal = new ProspectDomFixture("section", { className: "Modal-content" });
    const ownerlessCurrentWrap = new ProspectDomFixture("div");
    const ownerlessCurrent = new ProspectDomFixture("div", {
      className: "public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const ownerlessReplyWrap = new ProspectDomFixture("div");
    const ownerlessReply = new ProspectDomFixture("div", {
      className: "public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const ownerlessPublish = new ProspectDomFixture("button", { textContent: "发布" });
    ownerlessCurrentWrap.append(ownerlessCurrent);
    ownerlessReplyWrap.append(ownerlessReply);
    ownerlessModal.append(ownerlessCurrentWrap, ownerlessReplyWrap, ownerlessPublish);
    assert.equal(finderFor(ownerlessCurrent)(), null,
      "owner 缺失且 modal 有多个 editor 时必须 fail closed");

    const selfBoundaryPage = new ProspectDomFixture("main");
    const selfBoundaryEditor = new ProspectDomFixture("div", {
      className: "CommentBox public-DraftEditor-content",
      attrs: { role: "textbox" },
      kind: "comment-editor",
    });
    const selfBoundaryDecoy = new ProspectDomFixture("button", { textContent: "发布" });
    selfBoundaryPage.append(selfBoundaryEditor, selfBoundaryDecoy);
    assert.equal(finderFor(selfBoundaryEditor)(), null,
      "boundary 就是 editor 时不能错过停止点后爬到页面级发布诱饵");
  }
  // 小红书：控件必须限定在 .engage-bar-container 内 —— 页面右上角还有「发布
  // 笔记」的入口，全局找必然选错。
  const xhsFinder = iso.slice(iso.indexOf("function marineProspectFindXhsSendButton"));
  assert.ok(
    xhsFinder.slice(0, 1800).includes("marineProspectResolveEditor") &&
      xhsFinder.slice(0, 1800).includes("engage-bar-container") &&
      !xhsFinder.slice(0, 1800).includes("bar || document"),
    "小红书必须锚在已验证的当前 editor/bar，缺失时不能全局兜底",
  );
  {
    const start = iso.indexOf("function marineProspectFindXhsSendButton");
    const end = iso.indexOf("\n\n  /**\n   * 抖音的发送控件", start);
    assert.ok(start >= 0 && end > start, "小红书发送定位器必须可独立验证");
    const compile = new Function(
      "marineProspectResolveEditor",
      "marineRimeIsCommentEditor",
      "marineVisible",
      `${iso.slice(start, end)}\nreturn marineProspectFindXhsSendButton;`,
    );
    const finderFor = (editor) => compile(
      () => editor,
      (candidate) => candidate?.kind === "xhs-comment-editor",
      (candidate) => candidate?.visible === true,
    );

    const page = new ProspectDomFixture("main");
    const pagePublishDecoy = new ProspectDomFixture("button", { textContent: "发布" });
    const bar = new ProspectDomFixture("div", { className: "engage-bar-container" });
    const editor = new ProspectDomFixture("div", {
      attrs: { id: "content-textarea" },
      kind: "xhs-comment-editor",
    });
    const localSend = new ProspectDomFixture("button", { textContent: "发送" });
    page.append(pagePublishDecoy, bar);
    bar.append(editor, localSend);
    assert.equal(finderFor(editor)(), localSend, "只选当前 engage bar 内的发送控件");
    assert.notEqual(finderFor(editor)(), pagePublishDecoy, "不能选页面级发布诱饵");
    assert.equal(finderFor(null)(), null, "没有当前 editor 时必须 fail closed");

    const orphanEditor = new ProspectDomFixture("div", {
      attrs: { id: "content-textarea" },
      kind: "xhs-comment-editor",
    });
    page.append(orphanEditor);
    assert.equal(finderFor(orphanEditor)(), null,
      "editor 不在 engage-bar-container 时不能退回 document");

    const ambiguousBar = new ProspectDomFixture("div", { className: "engage-bar-container" });
    const ambiguousEditor = new ProspectDomFixture("div", {
      attrs: { id: "content-textarea" },
      kind: "xhs-comment-editor",
    });
    ambiguousBar.append(
      ambiguousEditor,
      new ProspectDomFixture("button", { textContent: "发送" }),
      new ProspectDomFixture("div", { className: "btn submit", textContent: "发布" }),
    );
    assert.equal(finderFor(ambiguousEditor)(), null,
      "同一 bar 有两个独立可见发送控件时必须 fail closed");
  }
  // 抖音：三个 36×36 的图标控件（@ / 表情 / 发送）都没有文字，类名是混淆的
  // （实测 wchsYBpK jfGCpJo0，改版必变）。唯一稳定的区分是**位置最右**。
  const dyFinder = iso.slice(iso.indexOf("function marineProspectFindDouyinSendButton"));
  assert.ok(
    dyFinder.slice(0, 5200).includes("marineProspectResolveEditor") &&
      dyFinder.slice(0, 5200).includes("marineRimeIsCommentEditor"),
    "抖音发送必须从当前已验证的评论 editor 锚定",
  );
  assert.ok(
    dyFinder.slice(0, 5200).includes("proven.length !== 1") &&
      dyFinder.slice(0, 5200).includes("row[row.length - 1].el") &&
      !dyFinder.slice(0, 5200).includes("document.querySelector('[contenteditable"),
    "只在最小语义祖先内证明唯一工具栏行，再取该行最右控件",
  );
  {
    const start = iso.indexOf("function marineProspectFindDouyinSendButton");
    const end = iso.indexOf("\n\n  /**\n   * 点发送", start);
    assert.ok(start >= 0 && end > start, "抖音发送定位器必须可独立验证");
    const compile = new Function(
      "marineProspectResolveEditor",
      "marineRimeIsCommentEditor",
      "marineVisible",
      `${iso.slice(start, end)}\nreturn marineProspectFindDouyinSendButton;`,
    );
    const finderFor = (editor) => compile(
      () => editor,
      (candidate) => candidate?.kind === "douyin-comment-editor",
      (candidate) => candidate?.visible === true,
    );
    const icon = (left, top) => new ProspectDomFixture("span", {
      width: 36,
      height: 36,
      left,
      top,
    });
    const attachToolbar = (owner, top, left) => {
      const toolbar = new ProspectDomFixture("div");
      const icons = [icon(left, top), icon(left + 36, top), icon(left + 72, top)];
      toolbar.append(...icons);
      owner.append(toolbar);
      return icons;
    };

    const page = new ProspectDomFixture("main");
    const danmakuOwner = new ProspectDomFixture("div", { className: "comment-input-container" });
    const danmakuEditor = new ProspectDomFixture("div", { kind: "danmaku-editor" });
    danmakuOwner.append(danmakuEditor);
    const danmakuIcons = attachToolbar(danmakuOwner, 420, 80);

    const commentOwner = new ProspectDomFixture("div", { className: "comment-input-container" });
    const editorWrap = new ProspectDomFixture("div");
    const commentEditor = new ProspectDomFixture("div", {
      kind: "douyin-comment-editor",
      left: 600,
      top: 100,
      width: 380,
      height: 80,
    });
    editorWrap.append(commentEditor);
    commentOwner.append(editorWrap);
    const commentIcons = attachToolbar(commentOwner, 130, 860);
    page.append(danmakuOwner, commentOwner);
    assert.equal(finderFor(commentEditor)(), commentIcons[2],
      "DOM 更靠前的弹幕 editor/36×36 行不能劫持当前评论的发送定位");
    assert.notEqual(finderFor(commentEditor)(), danmakuIcons[2]);
    assert.equal(finderFor(null)(), null, "没有当前评论 editor 时必须 fail closed");
    assert.equal(finderFor(danmakuEditor)(), null, "未通过评论适配器的 editor 必须拒绝");

    // 当前 comment-input 壳没有工具栏时，不能越过语义壳爬到页面级诱饵。
    const emptyOwner = new ProspectDomFixture("div", { className: "comment-input-container" });
    const emptyEditor = new ProspectDomFixture("div", {
      kind: "douyin-comment-editor",
      left: 600,
      top: 100,
      width: 380,
      height: 80,
    });
    emptyOwner.append(emptyEditor);
    page.append(emptyOwner);
    assert.equal(finderFor(emptyEditor)(), null,
      "局部工具栏缺失时不能在更高页面容器中选别人的最右图标");

    // 极端改版：comment-input 语义直接落在 editor 自身。limit===editor 时循环必须
    // 当场停住，不能因为从 parent 起步错过 sentinel 后继续爬到外层诱饵。
    const selfAnchorOuter = new ProspectDomFixture("div");
    const selfAnchoredEditor = new ProspectDomFixture("div", {
      className: "comment-input-container",
      kind: "douyin-comment-editor",
      left: 600,
      top: 100,
      width: 380,
      height: 80,
    });
    selfAnchorOuter.append(selfAnchoredEditor);
    attachToolbar(selfAnchorOuter, 130, 860);
    page.append(selfAnchorOuter);
    assert.equal(finderFor(selfAnchoredEditor)(), null,
      "limit 就是 editor 时不能越过自身命中外层工具栏诱饵");

    const ambiguousOwner = new ProspectDomFixture("div", { className: "comment-input-container" });
    const ambiguousEditor = new ProspectDomFixture("div", {
      kind: "douyin-comment-editor",
      left: 600,
      top: 100,
      width: 380,
      height: 160,
    });
    ambiguousOwner.append(ambiguousEditor);
    attachToolbar(ambiguousOwner, 120, 850);
    attachToolbar(ambiguousOwner, 190, 850);
    assert.equal(finderFor(ambiguousEditor)(), null,
      "同一局部容器出现两行候选工具栏时必须 fail closed");
  }
}

// ------------------------------------------------- 自动打开评论区 / 选中输入框
{
  // 知乎问题页同时有多条回答。入口必须由 URL answer id 与卡片 data-zop.itemId
  // 唯一对应，不能继续点击 DOM 第一条「添加评论」。
  const zhihuStart = iso.indexOf("function marineProspectZhihuRouteTarget");
  const zhihuEnd = iso.indexOf("\n\n  /**\n   * 抖音：点开评论面板", zhihuStart);
  assert.ok(zhihuStart >= 0 && zhihuEnd > zhihuStart, "知乎 opener 必须可独立验证");
  const zhihuSource = iso.slice(zhihuStart, zhihuEnd);
  assert.ok(
    zhihuSource.includes("document.querySelectorAll('[data-zop]')") &&
      zhihuSource.includes("meta.itemId") && zhihuSource.includes("scopes.length === 1") &&
      zhihuSource.includes("marker.matches('.Post-content')"),
    "知乎入口必须由 URL id/type 唯一绑定 answer 卡或专栏 Post-content",
  );
  assert.ok(
    !zhihuSource.includes("document.querySelectorAll('button')"),
    "知乎入口不能再全文档找第一个评论按钮",
  );

  const compileZhihuOpen = (document, pathname) => new Function(
    "document",
    "location",
    "marineVisible",
    `${zhihuSource}\nreturn marineProspectOpenCommentPanel;`,
  )(document, { pathname }, (candidate) => candidate?.visible === true);
  const zhihuCard = (itemId, label = "添加评论") => {
    const card = new ProspectDomFixture("article", {
      className: "ContentItem AnswerItem",
      attrs: { "data-zop": JSON.stringify({ itemId, type: "answer" }) },
    });
    const actions = new ProspectDomFixture("div", { className: "ContentItem-actions" });
    const button = new ProspectDomFixture("button", { textContent: label });
    actions.append(button);
    card.append(actions);
    return { card, button };
  };

  const zhihuPage = new ProspectDomFixture("body");
  const firstAnswer = zhihuCard("111", "12 条评论");
  const targetAnswer = zhihuCard("222", "\u200b添加评论");
  zhihuPage.append(firstAnswer.card, targetAnswer.card);
  assert.equal(
    compileZhihuOpen(zhihuPage, "/question/9/answer/222")("zhihu"),
    true,
    "目标回答不是 DOM 第一条时仍应打开 URL 指定回答的评论区",
  );
  assert.equal(firstAnswer.button.clicked, 0, "不能点击 DOM 第一条其他回答的评论入口");
  assert.equal(targetAnswer.button.clicked, 1, "应只点击 itemId 与 URL 相等的回答入口");

  const ambiguousZhihuPage = new ProspectDomFixture("body");
  const duplicateA = zhihuCard("333");
  const duplicateB = zhihuCard("333");
  ambiguousZhihuPage.append(duplicateA.card, duplicateB.card);
  assert.equal(
    compileZhihuOpen(ambiguousZhihuPage, "/question/9/answer/333")("zhihu"),
    false,
    "同一 answer id 对应多个独立卡片时必须 fail closed",
  );
  assert.equal(duplicateA.button.clicked + duplicateB.button.clicked, 0,
    "卡片歧义时不能点击任一评论入口");

  const missingZhihuPage = new ProspectDomFixture("body");
  const unrelatedAnswer = zhihuCard("444");
  missingZhihuPage.append(unrelatedAnswer.card);
  assert.equal(
    compileZhihuOpen(missingZhihuPage, "/question/9/answer/555")("zhihu"),
    false,
    "URL 指定回答缺少 data-zop 卡片证据时必须 fail closed",
  );
  assert.equal(unrelatedAnswer.button.clicked, 0, "缺失目标卡片时不能退回其他回答");

  const articlePage = new ProspectDomFixture("body");
  const articleContent = new ProspectDomFixture("div", {
    className: "Post-content",
    attrs: {
      "data-zop": JSON.stringify({ itemId: "9001", type: "article" }),
    },
  });
  const articleActions = new ProspectDomFixture("div", { className: "ContentItem-actions" });
  const articleCommentButton = new ProspectDomFixture("button", { textContent: "8 条评论" });
  articleActions.append(articleCommentButton);
  articleContent.append(articleActions);
  const articleDecoy = zhihuCard("9001");
  articlePage.append(articleDecoy.card, articleContent);
  assert.equal(
    compileZhihuOpen(articlePage, "/p/9001")("zhihu"),
    true,
    "专栏 /p/:id 应由 type=article 的唯一 Post-content 打开自己的评论入口",
  );
  assert.equal(articleCommentButton.clicked, 1, "专栏应点击 Post-content 内的评论入口");
  assert.equal(articleDecoy.button.clicked, 0,
    "同 id 的 answer 卡类型不符，不能劫持专栏入口");

  const ambiguousArticlePage = new ProspectDomFixture("body");
  const articleCopyA = new ProspectDomFixture("div", {
    className: "Post-content",
    attrs: { "data-zop": JSON.stringify({ itemId: "9002", type: "article" }) },
  });
  const articleCopyB = new ProspectDomFixture("div", {
    className: "Post-content",
    attrs: { "data-zop": JSON.stringify({ itemId: "9002", type: "article" }) },
  });
  const articleCopyActionsA = new ProspectDomFixture("div", { className: "ContentItem-actions" });
  const articleCopyActionsB = new ProspectDomFixture("div", { className: "ContentItem-actions" });
  const articleCopyButtonA = new ProspectDomFixture("button", { textContent: "添加评论" });
  const articleCopyButtonB = new ProspectDomFixture("button", { textContent: "添加评论" });
  articleCopyActionsA.append(articleCopyButtonA);
  articleCopyActionsB.append(articleCopyButtonB);
  articleCopyA.append(articleCopyActionsA);
  articleCopyB.append(articleCopyActionsB);
  ambiguousArticlePage.append(articleCopyA, articleCopyB);
  assert.equal(
    compileZhihuOpen(ambiguousArticlePage, "/p/9002")("zhihu"),
    false,
    "专栏出现两个匹配 Post-content 时必须 fail closed",
  );
  assert.equal(articleCopyButtonA.clicked + articleCopyButtonB.clicked, 0,
    "专栏 scope 歧义时不能点任一入口");

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
    body.includes("marineProspectFindCommentEditor(marineCommentSearchRoot())") &&
      !body.includes("document.querySelector('[contenteditable=\"true\"], textarea')"),
    "已有输入框时也必须经平台适配器确认，不能把搜索框/弹幕框当成评论 editor",
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

// ------------------------------------------------- 三个平台走 CDP 代打
{
  // 页内 `execCommand` 写入在这三个平台上各自坏在不同地方，实测（新开页面、
  // 评论框已聚焦、中文）：
  //
  //   抖音：写一两个字就把整个评论组件拆掉（comment-list 消失且点图标 6 次都
  //         恢复不了），**手动点生成也一样**。
  //   知乎：Draft.js 不拦 execCommand，浏览器原生插入和 Draft.js 的重渲染各写
  //         一遍，DOM 里是 `<span>正文<span data-text="true">正文</span></span>`，
  //         两种读法都是双份 —— 发送前的草稿核对必然不一致，条条卡在拒绝发送。
  //   B 站：字写得进去但工具栏不展开，内层 `<button>发布</button>` 不挂载，
  //         只剩 597×50 的壳，被面积兜底挡掉，报「未找到发送按钮」。
  assert.ok(
    iso.includes("marineProspectTypeViaCdp"),
    "写入要委托给 Rust 侧的 CDP 可信输入",
  );
  assert.ok(
    /CDP_TYPING_MODES\s*=\s*\{[^}]*douyin:\s*'keys'/.test(iso),
    "抖音必须留在 keys —— 那是它唯一验证过的路径，不该为统一而改",
  );
  for (const platform of ["zhihu", "bilibili"]) {
    assert.ok(
      new RegExp(`CDP_TYPING_MODES\\s*=\\s*\\{[^}]*${platform}:\\s*'insert'`).test(iso),
      `${platform} 必须用 insert —— 三种按键拼法实测中文一个字都写不进知乎的 Draft.js`,
    );
  }
  assert.ok(
    /if \(cdpMode && !g\.cdpDelegated\)/.test(iso),
    "只委托一次",
  );
  assert.ok(
    /marineProspectTypeViaCdp\(g\.wanted, cdpMode\)/.test(iso),
    "写入模式要按平台传下去，不能让 Rust 侧猜",
  );
  // 小红书的页内写入是真实验证过的，不该被这条改动波及
  assert.ok(
    !/CDP_TYPING_MODES\s*=\s*\{[^}]*xiaohongshu/.test(iso),
    "小红书的页内写入已验证过，不要顺手拉进来",
  );
  const wu = iso.slice(iso.indexOf("function marineRimeGenWriteUnit"));
  assert.ok(
    !/douyin|zhihu|bilibili/i.test(wu.slice(0, 900)),
    "写入函数本身不该出现平台分支 —— 分支只在委托那一处",
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
  const body = dy.slice(0, 5200);
  const helperStart = iso.indexOf("const MARINE_PROSPECT_DOUYIN_INPUT_HINT_RE");
  const helperEnd = iso.indexOf("\n\n  function marineProspectOpenDouyinComments", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "抖音输入邻域定位器必须可独立验证");
  const helper = iso.slice(helperStart, helperEnd);
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
    helper.includes("previousElementSibling") && helper.includes("nextElementSibling") &&
      /depth < 3/.test(helper),
    "输入条要在 comment-list 的有限 sibling 邻域找，不能继续只认前一个兄弟",
  );
  assert.ok(
    helper.includes('[class*="comment-input" i]') &&
      helper.includes("裸 role=textbox / textarea 不是评论信号"),
    "要认 comment-input 语义壳和新旧提示，但裸 textbox 不能成为评论信号",
  );
  // 抖音评论区要两步打开且渲染慢（实测十几秒）。窗口太短会表现成「定位不到
  // 输入框」，而手动同样的步骤是通的 —— 症状会误导人去查选择器。
  assert.ok(
    /marineProspectOpenCommentsAndFocus\(30000\)/.test(iso),
    "打开评论区的窗口要够抖音用（两步 + 慢渲染）",
  );
  assert.ok(
    helper.includes("candidate.el.contains(other.el)") && helper.includes("leaves.length === 1"),
    "同一文案的多层包装要取唯一最内层；出现两个独立入口则 fail closed",
  );

  const compile = new Function(
    "marineVisible",
    `${helper}\nreturn {` +
      "findInput: marineProspectFindDouyinInputEntry," +
      "findNoListInput: marineProspectFindDouyinNoListInputEntry };",
  );
  const helpers = compile((candidate) => candidate?.visible === true);
  const findInput = helpers.findInput;
  const findNoListInput = helpers.findNoListInput;

  // /note/ 新形态：list 的前兄弟只是「全部评论」头，真正输入条在包裹 list 的
  // comment pane 旁边。页面级另放一个 textbox 诱饵，局部算法绝不能看见它。
  const bodyRoot = new ProspectDomFixture("body");
  const rightRail = new ProspectDomFixture("aside");
  const commentPane = new ProspectDomFixture("section");
  const header = new ProspectDomFixture("div", { textContent: "全部评论" });
  const list = new ProspectDomFixture("div", { attrs: { "data-e2e": "comment-list" } });
  const inputEntry = new ProspectDomFixture("div", { className: "comment-input-container" });
  const sameRailDecoy = new ProspectDomFixture("div", { attrs: { role: "textbox" } });
  const outsideDecoy = new ProspectDomFixture("div", { attrs: { role: "textbox" } });
  commentPane.append(header, list);
  rightRail.append(sameRailDecoy, commentPane, inputEntry);
  bodyRoot.append(rightRail, outsideDecoy);
  assert.notEqual(list.previousElementSibling, inputEntry, "fixture 要复现输入条不在前兄弟的 DOM");
  assert.equal(findInput(list), inputEntry, "要从 list 包装层附近找到新输入条");
  assert.notEqual(findInput(list), sameRailDecoy, "同一右栏的裸 textbox 也不是评论信号");
  assert.notEqual(findInput(list), outsideDecoy, "不能越过右栏边界选页面级 textbox");

  // 若局部根本没有入口，body 下的 textbox 诱饵也不能被当作兜底。
  const closedRail = new ProspectDomFixture("aside");
  const closedPane = new ProspectDomFixture("section");
  const closedHeader = new ProspectDomFixture("div", { textContent: "全部评论" });
  const closedList = new ProspectDomFixture("div", { attrs: { "data-e2e": "comment-list" } });
  const closedBody = new ProspectDomFixture("body");
  closedPane.append(closedHeader, closedList);
  closedRail.append(closedPane);
  closedBody.append(closedRail,
    new ProspectDomFixture("div", { className: "comment-input-container" }));
  assert.equal(findInput(closedList), null,
    "有界邻域无入口时应失败，连页面级 comment-input 诱饵也不能选");

  // 旧形态仍保留：占位文案的外壳和叶子都会命中，要点最内层叶子。
  const legacyPane = new ProspectDomFixture("section");
  const legacyShell = new ProspectDomFixture("div", { textContent: "留下你的精彩评论吧" });
  const legacyLeaf = new ProspectDomFixture("span", { textContent: "留下你的精彩评论吧" });
  const legacyList = new ProspectDomFixture("div", { attrs: { "data-e2e": "comment-list" } });
  legacyShell.append(legacyLeaf);
  legacyPane.append(legacyShell, legacyList);
  assert.equal(findInput(legacyList), legacyLeaf, "旧占位条仍要取唯一最内层点击目标");

  // 精选页没有 comment-list：只能借「评论」tab 所属 dialog/drawer 证明范围。
  const noListDrawer = new ProspectDomFixture("aside", { attrs: { role: "dialog" } });
  const noListTabs = new ProspectDomFixture("div", { attrs: { role: "tablist" } });
  const noListCommentTab = new ProspectDomFixture("div", {
    textContent: "评论",
    attrs: { role: "tab" },
  });
  const noListPanel = new ProspectDomFixture("section", { attrs: { role: "tabpanel" } });
  const noListInput = new ProspectDomFixture("div", { textContent: "写下你的评论" });
  const noListOutsideDecoy = new ProspectDomFixture("div", {
    className: "comment-input-container",
  });
  noListTabs.append(noListCommentTab);
  noListPanel.append(noListInput);
  noListDrawer.append(noListTabs, noListPanel);
  const noListBody = new ProspectDomFixture("body");
  noListBody.append(noListDrawer, noListOutsideDecoy);
  assert.equal(findNoListInput(noListCommentTab), noListInput,
    "无 list 时要能在评论 tab 的 dialog 内找到输入入口");
  assert.notEqual(findNoListInput(noListCommentTab), noListOutsideDecoy,
    "无 list fallback 不能越过评论 dialog 选页面级诱饵");

  // /note/ 与部分精选 DOM 没有 ARIA role：同组的「相关推荐」tab 是边界证据，
  // 仍只允许向上三层、且不能上升到 body。
  const plainBody = new ProspectDomFixture("body");
  const plainDrawer = new ProspectDomFixture("aside");
  const plainTabs = new ProspectDomFixture("div");
  const plainRelatedTab = new ProspectDomFixture("div", { textContent: "相关推荐" });
  const plainCommentTab = new ProspectDomFixture("div", { textContent: "评论(12)" });
  const plainPanel = new ProspectDomFixture("section");
  const plainInput = new ProspectDomFixture("div", { className: "comment-input-inner-container" });
  plainTabs.append(plainRelatedTab, plainCommentTab);
  plainPanel.append(plainInput);
  plainDrawer.append(plainTabs, plainPanel);
  plainBody.append(plainDrawer,
    new ProspectDomFixture("div", { className: "comment-input-container" }));
  assert.equal(findNoListInput(plainCommentTab), plainInput,
    "无 role 时可由同组稳定 tab 证明局部 drawer，但仍不能全局搜索");

  // 不只测 helper：连续两轮跑真实 opener，第一轮点 tab，第二轮必须能到达并点击
  // no-list fallback。这样才能锁住本次「每轮都在 tab.click 后 return」的回归。
  const openStart = iso.indexOf("let marineProspectDouyinIconClicked");
  const openEnd = iso.indexOf("\n\n  function marineProspectOpenCommentsAndFocus", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "抖音 opener 必须可独立验证");
  const openSource = iso.slice(openStart, openEnd);
  const compileOpen = new Function(
    "document",
    "marineProspectFindCommentEditor",
    "marineCommentSearchRoot",
    "marineVisible",
    "marineLog",
    `${openSource}\nreturn marineProspectOpenDouyinComments;`,
  );
  const openDouyin = compileOpen(
    noListBody,
    () => null,
    () => noListBody,
    (candidate) => candidate?.visible === true,
    () => {},
  );
  assert.equal(openDouyin(), false, "无 list 第一轮只切到评论 tab，等待 panel 挂载");
  assert.equal(noListCommentTab.clicked, 1, "评论 tab 只点一次，不能轮询时反复开合");
  assert.equal(openDouyin(), true, "无 list 第二轮必须进入局部 fallback 并点输入条");
  assert.equal(noListInput.clicked, 1, "应点击 dialog 内的输入入口");
  assert.equal(noListOutsideDecoy.clicked, 0, "页面级诱饵绝不能被点击");

  // 两套可见抽屉同时残留时不能用 DOM 顺序（旧实现 `.pop()`）任选最后一个。
  // 即使页面还有 feed icon，也不能用它绕过歧义再开合另一套面板。
  const ambiguousDouyinBody = new ProspectDomFixture("body");
  const ambiguousIcon = new ProspectDomFixture("button", {
    attrs: { "data-e2e": "feed-comment-icon" },
  });
  const douyinTabIn = (label) => {
    const dialog = new ProspectDomFixture("aside", { attrs: { role: "dialog" } });
    const tablist = new ProspectDomFixture("div", { attrs: { role: "tablist" } });
    const tab = new ProspectDomFixture("div", { textContent: label, attrs: { role: "tab" } });
    tablist.append(tab);
    dialog.append(tablist);
    return { dialog, tab };
  };
  const ambiguousTabA = douyinTabIn("评论");
  const ambiguousTabB = douyinTabIn("评论(8)");
  ambiguousDouyinBody.append(ambiguousIcon, ambiguousTabA.dialog, ambiguousTabB.dialog);
  const ambiguousOpenDouyin = compileOpen(
    ambiguousDouyinBody,
    () => null,
    () => ambiguousDouyinBody,
    (candidate) => candidate?.visible === true,
    () => {},
  );
  assert.equal(ambiguousOpenDouyin(), false,
    "多个有边界证据的评论 tab 必须 fail closed");
  assert.equal(ambiguousTabA.tab.clicked + ambiguousTabB.tab.clicked, 0,
    "评论 tab 歧义时不能任选其一");
  assert.equal(ambiguousIcon.clicked, 0,
    "评论 tab 歧义时也不能转而点击 feed icon 绕过保护");
  assert.ok(
    openSource.includes("tabCandidates.length > 1") &&
      !/\.filter\([\s\S]{0,500}\)\s*\.pop\(\)/.test(openSource),
    "评论 tab 必须显式拒绝多个候选，不能再按 DOM 顺序取最后一个",
  );

  // feed icon 也不能 querySelector 任取：隐藏的旧节点应忽略；只剩一个可见节点
  // 才能点击。没有可见节点或同时两个可见节点都必须 fail closed。
  const iconPage = new ProspectDomFixture("body");
  const hiddenIcon = new ProspectDomFixture("button", {
    visible: false,
    attrs: { "data-e2e": "feed-comment-icon" },
  });
  const visibleIcon = new ProspectDomFixture("button", {
    attrs: { "data-e2e": "feed-comment-icon" },
  });
  iconPage.append(hiddenIcon, visibleIcon);
  const openWithHiddenIcon = compileOpen(
    iconPage,
    () => null,
    () => iconPage,
    (candidate) => candidate?.visible === true,
    () => {},
  );
  assert.equal(openWithHiddenIcon(), false, "唯一可见 feed icon 点击后等待面板挂载");
  assert.equal(hiddenIcon.clicked, 0, "隐藏的旧 feed icon 不能被 querySelector 抢先选中");
  assert.equal(visibleIcon.clicked, 1, "混有隐藏节点时仍应点击唯一可见 feed icon");

  const hiddenOnlyPage = new ProspectDomFixture("body");
  const hiddenOnlyIcon = new ProspectDomFixture("button", {
    visible: false,
    attrs: { "data-e2e": "feed-comment-icon" },
  });
  hiddenOnlyPage.append(hiddenOnlyIcon);
  const openWithNoVisibleIcon = compileOpen(
    hiddenOnlyPage,
    () => null,
    () => hiddenOnlyPage,
    (candidate) => candidate?.visible === true,
    () => {},
  );
  assert.equal(openWithNoVisibleIcon(), false, "没有可见 feed icon 时必须 fail closed");
  assert.equal(hiddenOnlyIcon.clicked, 0, "隐藏 feed icon 绝不能被点击");

  const multipleIconPage = new ProspectDomFixture("body");
  const visibleIconA = new ProspectDomFixture("button", {
    attrs: { "data-e2e": "feed-comment-icon" },
  });
  const visibleIconB = new ProspectDomFixture("button", {
    attrs: { "data-e2e": "feed-comment-icon" },
  });
  multipleIconPage.append(visibleIconA, visibleIconB);
  const openWithMultipleIcons = compileOpen(
    multipleIconPage,
    () => null,
    () => multipleIconPage,
    (candidate) => candidate?.visible === true,
    () => {},
  );
  assert.equal(openWithMultipleIcons(), false, "多个可见 feed icon 时必须 fail closed");
  assert.equal(visibleIconA.clicked + visibleIconB.clicked, 0,
    "多个可见 feed icon 时不能任取其一");
  assert.ok(
    openSource.includes("iconCandidates.length !== 1") &&
      openSource.includes(".filter(function (candidate) { return marineVisible(candidate); })") &&
      !openSource.includes("document.querySelector('[data-e2e=\"feed-comment-icon\"]')"),
    "feed icon 必须由唯一可见候选证明，不能 querySelector 任取",
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
