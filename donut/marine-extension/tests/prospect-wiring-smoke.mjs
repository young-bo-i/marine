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
    iso.includes("typeof marineProspectRun === 'undefined'"),
    "未注入该站点时要安静退出，不能抛错",
  );
  assert.ok(
    /setTimeout\(marineStartProspectRun, 0\)/.test(iso),
    "跨 content_scripts 条目的注入顺序不在文档契约里，必须推迟一个宏任务",
  );
}

// ------------------------------------------------- SW 路由白名单是安全边界
{
  assert.ok(sw.includes("MARINE_PROSPECT_ROUTES"), "SW 必须有编排路由白名单");
  const block = sw.slice(sw.indexOf("MARINE_PROSPECT_ROUTES"), sw.indexOf("async function marineProspectApi"));
  for (const allowed of ["prospects/ingest", "prospects/claim", "prospects/settle"]) {
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
  const entry = manifest.content_scripts.find((e) =>
    e.js.some((f) => f.startsWith("src/platforms/")),
  );
  const iIdx = manifest.content_scripts.findIndex((e) => e.js.includes("src/content-iso.js"));
  const pIdx = manifest.content_scripts.indexOf(entry);
  assert.ok(pIdx < iIdx, "平台脚本条目应排在 content-iso 之前");
  assert.ok(
    entry.js.includes("src/platforms/prospect-run.js") &&
      entry.js.includes("src/platforms/login.js") &&
      entry.js.includes("src/platforms/discovery.js"),
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
    marineResolveConfig: async () => ({ apiBase: "http://127.0.0.1:1/v1/marine", token: "t" }),
    fetch: async (url, init) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => (url.endsWith("claim") ? "" : '{"inserted":2}') };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\nglobalThis.__api = marineProspectApi;", ctx);

  const ingested = await ctx.__api("prospects/ingest", { candidates: [] });
  assert.deepStrictEqual({ ...ingested }, { inserted: 2 });
  assert.ok(calls[0].endsWith("/prospects/ingest"), "URL 应拼在 apiBase 之后");

  // claim 没得领时后端返回空体 —— 必须变成 null，而不是解析报错
  const claimed = await ctx.__api("prospects/claim", {});
  assert.equal(claimed, null, "空响应体应视为「没得领」");

  await assert.rejects(
    () => ctx.__api("generate-stream", {}),
    /不允许的编排路由/,
    "白名单外的路由必须被拒绝",
  );
}


// ------------------------------------------------- Phase B 接线
{
  // Phase B 必须驱动**既有**的页内生成链路，而不是另写一套写入逻辑 ——
  // 那套已经做了拟人节奏敲字、失焦保护、目标快照，重写一份必然退化。
  assert.ok(iso.includes("marineRimeGenStart()"), "Phase B 要复用页内生成入口");
  assert.ok(iso.includes("marineRimeGen.state") || iso.includes("g.state"),
    "生成是状态机不是 Promise，必须轮询它的 state 判完成");
  assert.ok(iso.includes("marineProspectRun.runOnTarget"), "靶子页要调 runOnTarget");
  assert.ok(iso.includes("marineProspectRun.readHandoff({ handoffStore: marineProspectHandoffStore })"),
    "没有交接单说明这页不是编排打开的，必须完全不动");
  // 两个阶段的入口都要挂上
  assert.ok(/setTimeout\(marineStartProspectRun, 0\)/.test(iso), "Phase A 入口");
  assert.ok(/setTimeout\(marineStartProspectTargetPhase, \d+\)/.test(iso), "Phase B 入口");
  // 发送已接上，但成功判据必须是**平台回执**，不是「点了按钮」
  const phaseB = iso.slice(iso.indexOf("marineStartProspectTargetPhase"));
  assert.ok(/send: \(platform, text, key\) => marineProspectSendComment\(platform, text, key\)/.test(phaseB),
    "send 要接到真实实现，平台由交接单的 stopAfter 决定");
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
    impl.includes("marineProspectReadEditorText"),
    "发送前要读输入框的实际内容核对，间接推断生成完成不够可靠",
  );
  assert.ok(
    /拒绝发送/.test(impl),
    "草稿没写完必须拒发 —— 没发出去还能重来，发出去的公开评论撤不回",
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
    const clickIdx = sendFn.indexOf("btn.click()");
    assert.ok(markIdx >= 0 && clickIdx > markIdx,
      "标记要在点击之前落 —— 点完再标记的话，点击抛异常或页面跳转就会漏标");
  }
  assert.ok(
    /send: \(platform, text, key\) => marineProspectSendComment\(platform, text, key\)/.test(iso),
    "key 要接上，否则防重发无从判断",
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
  // 退出必须放在 finally 里，失败路径也要退出
  assert.ok(
    /finally\(\(\) => \{[\s\S]{0,200}marineProspectSetOrchestrating\(false\)/.test(iso),
    "退出编排模式要在 finally 里 —— 失败路径也必须退出",
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
    /navigate: \(url\) =>/.test(iso.slice(iso.indexOf("marineStartProspectTargetPhase"))),
    "Phase B 必须接上 navigate，否则换靶子无从发生",
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

console.log("prospect-wiring-smoke: OK");
