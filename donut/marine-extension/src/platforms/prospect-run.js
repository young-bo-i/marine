// prospect-run.js — 发现侧编排（ISOLATED world，经典脚本）
//
// 目标形态：启动 profile -> 自动打开搜索页 -> 后面全自动。
// 启动网址由 Donut 按该账号的筛选位下发（marine/search_slot.rs），所以这里
// 只需要「落到搜索页就开工」，不需要自己拼 URL、也不需要用户点任何按钮。
//
// 一次运行：
//   1. 登录检查 —— 未登录直接停。登出状态下搜也搜不出东西（小红书/抖音尤其），
//      硬跑只会白白制造一批风控足迹。
//   2. 解析候选（marineDiscovery）
//   3. canary 体检 —— 条数塌陷/关键字段缺失时中止，不把脏数据写进台账
//   4. ingest 进跨账号台账
//   5. claim 一条本账号没碰过、也没被别的账号占用的靶子
//   6. 导航过去 —— 到此为止
//
// **终止点是显式配置的**（`stopAfter`），不是硬编码：
//   'open' —— 打开靶子就停（最早的形态）
//   'fill' —— 生成话术并填进输入框，**停在点发送的前一步**（fill-only 工作流）
//   'send' —— 一路发出去
// 之所以做成配置而不是删掉判断：发送是整条链里唯一不可逆的动作，把它变成一个
// 一眼可见、可测试的开关，比散落在各处的 if 更难被误改。
//
// 终止点**按平台**决定，见 `SEND_ENABLED_PLATFORMS`：只有回执链路做好了的平台
// 才进入 'send'，其余仍停在 'fill'。
//
// 无论停在哪一步都要**留下记录**：成功填入记 `filled`，任何失败记 `failed`
// 且不重试（按运营决定，失败是数据不是重试信号）。
//
// 唯一的例外是**评论区对所有人关闭**（B 站「由于UP主隐私设置，你无法评论」）：
// 记 `blocked` 并**换一条靶子**。这不违反「失败不重试」—— 那条规矩针对的是我们
// 自己的失败，重试只会加重风控足迹；而关评论是内容的定论，同一条再试多少次也没
// 有输入框。`blocked` 会把该条从**所有**账号的候选池里摘掉，否则另外几个号会各
// 花一条腿来重新发现同一件事。换靶子有次数上限（MAX_TARGET_HOPS）。
//
// 幂等：同一个搜索页只跑一次（**文档内**的标记，绝不能用 sessionStorage —— 它会
// 被持久化用于会话恢复，导致同一个 URL 一辈子只跑一次），否则 SPA 的每次
// history 变更都会重跑一遍，把同一批候选反复灌进台账。

var marineProspectRun = marineProspectRun || {};

(function () {
  'use strict';

  const RUN_FLAG = '__marineProspectRunV1';

  /**
   * 幂等标记的存放处 —— **必须只活在本文档里**。
   *
   * 原来用的是 `sessionStorage`，而 Chromium 会把它**持久化**用于会话恢复，app
   * 又带着 `--restore-last-session` 启动。于是标记跨浏览器重启存活，同一个
   * profile 的同一个搜索 URL **一辈子只跑一次**：第一轮正常，之后每一轮零日志、
   * 零 API 调用、浏览器停在搜索页。实测抓到 —— profile 的
   * `Default/Session Storage` LevelDB 里能直接 grep 出这个键。
   *
   * 模块级变量的生存期恰好是「一个 document」，正是这里要的语义：SPA 的 history
   * 变更不会重新注入 content script（标记还在，重跑被挡住），而真正的导航会换
   * 文档（标记归零，该跑就跑）。
   */
  const documentFlags = Object.create(null);
  const defaultFlagStore = {
    getItem: (k) => (k in documentFlags ? documentFlags[k] : null),
    setItem: (k, v) => { documentFlags[k] = String(v); },
  };

  // 各平台「这是不是搜索结果页」。只认结果页 —— 详情页/首页不该触发编排。
  const SEARCH_PAGE = {
    bilibili: (u) => /(^|\.)search\.bilibili\.com$/.test(u.hostname),
    zhihu: (u) => /(^|\.)zhihu\.com$/.test(u.hostname) && u.pathname.startsWith('/search'),
    douyin: (u) => /(^|\.)douyin\.com$/.test(u.hostname) && u.pathname.startsWith('/search'),
    xiaohongshu: (u) =>
      /(^|\.)xiaohongshu\.com$/.test(u.hostname) && u.pathname.startsWith('/search_result'),
  };

  function platformOfSearchPage(href) {
    let u;
    try { u = new URL(href); } catch (e) { return null; }
    for (const key of Object.keys(SEARCH_PAGE)) {
      if (SEARCH_PAGE[key](u)) return key;
    }
    return null;
  }

  function keywordOf(href) {
    let u;
    try { u = new URL(href); } catch (e) { return null; }
    return (
      u.searchParams.get('keyword') ||
      u.searchParams.get('q') ||
      // 抖音把关键词放在路径里：/search/科研工具
      (u.pathname.startsWith('/search/') ? decodeURIComponent(u.pathname.slice(8)) : null)
    );
  }

  /**
   * 跑一次编排。
   *
   * 依赖全部可注入，方便在没有浏览器的情况下测完整决策路径。
   * @returns {Promise<{status:string, ...}>} status 取值见下方各 return。
   */
  async function run(deps) {
    deps = deps || {};
    const href = deps.href || (typeof location !== 'undefined' ? location.href : '');
    const platform = platformOfSearchPage(href);
    if (!platform) return { status: 'not_a_search_page' };

    const profileId = deps.profileId;
    if (!profileId) return { status: 'no_profile_id' };

    // 搜索页可能是旧 document/session 恢复出来的，SW 里仍保留着上一条的
    // pending settlement。必须在当前平台的登录检查之前补记：上一条的
    // settle 不应被下一平台掉登录阻断。失败时本轮零写入、零 claim。
    const prior = await recoverSettlementBeforeClaim(deps, platform);
    if (!prior.ok) {
      return Object.assign({ platform }, prior.result || { status: 'handoff_read_failed' });
    }
    // 同一 scheduler leg 的旧 terminal touch 会让 Rust 下一次 poll 立刻结束并
    // park about:blank。此时继续 claim/导航新 key，刚写下的新 handoff 会被截断。
    // blocked 不计该 leg 的完成 touch；跨平台 touch 也不结束当前平台，所以这两类
    // 仍可继续。其余同平台恢复必须直接终局，等下一轮再 claim。
    if (prior.recovered && prior.platform === platform &&
        ['posted', 'unconfirmed', 'skipped', 'filled', 'failed'].indexOf(prior.state) >= 0) {
      return {
        status: 'settled_before_claim',
        platform,
        key: prior.key,
        state: prior.state,
      };
    }

    // ---- 1. 登录 ----------------------------------------------------------
    const login = await deps.login(platform);
    // 只在**不是「已登录」**时上报，让 profile 列表能标出哪个账号在哪个平台掉了。
    // 已登录不报（没信息量）；标记的清除由调度器在「这条腿真发出去了」时做。
    if (login.loggedIn !== true && deps.reportLogin) {
      try { deps.reportLogin(login); } catch (e) {}
    }
    if (login.loggedIn !== true) {
      // 未登录和判断不了都停，但要分开报告：前者要去登录，后者稍后重试。
      return {
        status: login.loggedIn === false ? 'not_logged_in' : 'login_unknown',
        platform,
        evidence: login.evidence,
      };
    }

    // ---- 2. 解析 ----------------------------------------------------------
    const raw = deps.pageHtml();
    const items = deps.parse(platform, raw) || [];

    // ---- 3. 体检 ----------------------------------------------------------
    // 解析器失败时是静默返回短列表，不是抛错。没有这道闸，一次页面改版或抓取
    // 残缺会表现为「今天候选少」，而脏数据已经进了台账。
    const health = deps.canary(platform, items);
    if (!health.ok) {
      return { status: 'unhealthy', platform, count: items.length, failures: health.failures };
    }

    // ---- 4. 入账 ----------------------------------------------------------
    const keyword = keywordOf(href);
    const candidates = items.map((i) => ({
      platform,
      item_id: String(i.id),
      title: i.title || '',
      open_url: i.open_url,
      keyword,
      // 知乎解析器本来就解出了 question_id，只是以前没往上传。
      // 台账靠它把同一问题下的多个回答归成一组；不传的话就只能从 open_url 里
      // 抠，而搜索结果拿不到 questionId 时给的是裸 /answer/<id>，
      // 分组当场退化成按回答算 —— 同一个账号立刻能领走同问题下的另一个回答。
      thread_hint: i.question_id ? String(i.question_id) : null,
    }));
    const ingested = await deps.api('prospects/ingest', { candidates });

    // ---- 5. 领取 ----------------------------------------------------------
    const claimed = await deps.api('prospects/claim', {
      profile_id: profileId,
      platform,
    });
    if (!claimed) {
      // 正常结局，不是错误：这一批全被本账号做过、或被别的账号占了。
      return { status: 'nothing_to_claim', platform, ingested, count: items.length };
    }

    // ---- 6. 打开靶子 ------------------------------------------------------
    // 先写交接单再导航，而且要 await 完 —— 导航一旦发生这段脚本就随页面卸载，
    // 没写完的交接单等于 Phase B 永远认不了自己。
    const handed = await writeHandoff(deps, claimed, profileId, deps.stopAfter);
    if (!handed) {
      // 写不下交接单就别导航：过去了也只是打开一个没人接手的页面，还把这条靶子
      // 卡在 claimed 上直到 TTL 过期。
      return { status: 'handoff_write_failed', platform, key: claimed.key };
    }
    const navigation = await deps.navigate(claimed.open_url, {
      key: claimed.key,
      platform,
      reason: 'claim',
    });
    // 真实导航适配层会等 pagehide/unload，而不是看 location.href
    // 是否提前变了。旧 document 若两个窗口后仍活着，要把它的结构化
    // 终局传回去，不能误报 claimed 并落幂等标记。
    if (navigation && (navigation.status === 'target_navigation_stalled' ||
        navigation.status === 'target_navigation_committed')) {
      return Object.assign({
        platform,
        ingested,
        count: items.length,
        title: claimed.title,
        open_url: claimed.open_url,
      }, navigation, { key: navigation.key || claimed.key });
    }
    return {
      status: 'claimed',
      platform,
      ingested,
      count: items.length,
      key: claimed.key,
      title: claimed.title,
      open_url: claimed.open_url,
    };
  }

  // 已经有定论、不必再跑的终局状态。
  //
  // `unhealthy` 刻意不在此列：它多半意味着「现在还太早」而不是「这页不行」。
  // 知乎/抖音/小红书是 SPA，document_idle 触发时结果卡片可能还没渲染，解析
  // 到的条数不够，canary 就会判 unhealthy —— 这时候把页面标记成跑过，等渲染
  // 完了也永远不会再跑。（实测：知乎自动跑零 API 调用，手动清掉标记重跑一次
  // 立刻 claimed 15 条。B 站是 SSR 所以没暴露这个问题。）
  const TERMINAL = [
    'claimed',
    'nothing_to_claim',
    'not_logged_in',
    'target_navigation_stalled',
    // claim 已经发生；重跑整轮只会再 claim 一条，不会修好这一条。
    'handoff_write_failed',
    // 已有交接单时必须先消费/恢复它，Phase A 不能用新 claim 覆盖。
    'handoff_in_progress',
    'send_already_started',
    // 同平台旧 pending 已补记；必须等 scheduler 收到这次 touch 后再开下一条。
    'settled_before_claim',
  ];

  function isTerminal(status) {
    return TERMINAL.indexOf(status) >= 0;
  }

  /**
   * 幂等守卫：同一个搜索页只**成功**跑一次。
   *
   * 只做检查，不落标记 —— 落标记的时机由 `markDone` 在拿到终局状态后决定。
   * 早期版本在这里就落标记，等于把「这次没跑成」也算成「跑过了」。
   */
  function shouldRun(href, storage) {
    const s = storage || defaultFlagStore;
    if (!platformOfSearchPage(href)) return false;
    return s.getItem(RUN_FLAG) !== href;
  }

  /** 拿到终局状态后落标记；非终局（如 unhealthy）保持可重试。 */
  function markDone(href, status, storage) {
    if (!isTerminal(status)) return false;
    const s = storage || defaultFlagStore;
    s.setItem(RUN_FLAG, href);
    return true;
  }


  // ==================== Phase B：在靶子页生成并填入 ====================
  //
  // Phase A 导航走之后，页面变成了内容页，`run()` 会返回 not_a_search_page。
  // 所以第二阶段是独立入口：靠 Phase A 留下的交接单认领自己，再驱动既有的
  // 页内生成链路（marineRimeGenStart 那套：流式产出 + 拟人节奏敲进输入框）。
  //
  // 终止点由交接单里的 stopAfter 决定；具备平台回执的站点会继续到 send。

  /**
   * 一条腿里最多换几次靶子。
   *
   * 只有「评论区对所有人关闭」才换 —— 那是**内容**的定论，换一条是唯一出路，
   * 跟「发送失败不重试」的运营决定不冲突（那说的是我们自己的失败）。
   * 但仍要封顶：碰上一串关评论的视频时，不封顶就会在一条腿里无限跳，把整批
   * 任务卡死在一个 profile 上。
   */
  const MAX_TARGET_HOPS = 3;

  /**
   * 「这页根本不让评论」的判据。
   *
   * 返回 `true` / `false` / `null`，`null` 表示**判断不了**——照 login 那套
   * 三态约定。只有 `true` 会触发换靶子；判断不了时走原有路径（等输入框、超时
   * 记 failed），因为把「没看出来」当成「关了」会平白丢掉能评的视频。
   *
   * 只有 B 站有实测过的文案。其余三个平台一律返回 `null`：猜一个选择器进来，
   * 就和 search_slot 里「没有稳定 URL 排序参数就不要编一个」是同一种错误——
   * 猜错的代价是静默跳过本来能用的靶子，而且查不出来。
   *
   * @param {string} platform
   * @param {string} areaText 评论区范围内的可见文本（含 shadow DOM）
   * @returns {boolean|null}
   */
  function commentsClosed(platform, areaText) {
    if (platform !== 'bilibili') return null;
    const text = String(areaText || '');
    if (!text) return null;                       // 还没渲染 ≠ 关闭
    // 实测文案（截图）+ 同族变体。刻意匹配短语而不是整句：B 站这几种提示的
    // 措辞随版本变过，但「无法评论」「关闭评论」这两个短语一直在。
    const CLOSED = [
      '你无法评论',
      '无法评论',
      '评论区已关闭',
      '已关闭评论',
      '关闭了评论',
      '评论已关闭',
    ];
    for (let i = 0; i < CLOSED.length; i++) {
      if (text.indexOf(CLOSED[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 交接单的存放处。
   *
   * **不是 sessionStorage** —— 它按 origin 分区，而搜索页和靶子页经常不同源：
   * B 站永远是（search.bilibili.com -> www.bilibili.com），知乎的专栏文章也是
   * （www.zhihu.com -> zhuanlan.zhihu.com）。用 sessionStorage 的表现极具迷惑
   * 性：Phase A 全程正常（入账、claim、导航都成功），Phase B 在新源上读不到交
   * 接单就静默退出，台账里只留下一条永远停在 claimed、零 touch 的记录。实测踩
   * 过，两轮都是这个形态。
   *
   * 所以交接单存在 SW 侧（按 tab），由 `deps.handoffStore` 注入。三个方法都是
   * 异步的 —— 尤其 `write` 必须在导航**之前** await 完，导航一旦发生这段脚本
   * 就随页面卸载了。
   */
  function storeOf(deps) {
    return (deps && deps.handoffStore) || null;
  }

  /**
   * 哪些平台**真的会点发送**。
   *
   * 做成一个列表而不是一个全局开关：发送是整条链里唯一不可逆、且会在真实账号
   * 上留下公开痕迹的动作，逐平台放开才能保证每个平台都是「验证过才开」。
   *
   * 四个平台都实现了回执检测（劫持页面 fetch，判据各不相同）：
   *   B 站：  /x/v2/reply/add 的 `code===0` + 正数 `rpid`
   *   知乎：  /api/v4/comment_v5/{res}/{id}/comment 的 2xx + 正数 `id`
   *   小红书：/api/sns/web/v{n}/comment/{post|create|add} 的 2xx + 正数评论 id
   *   抖音：  /aweme/v{n}/web/comment/{publish|create|post} 的 status_code===0 + 正数 cid
   *
   * 抖音还额外要求写入走 Rust 侧的 CDP 键盘事件（见 content-iso 的委托）——
   * 它对页内合成输入有反制，`execCommand` 会把整个评论组件拆掉。
   *
   * 加平台的顺序必须是：先做该平台的回执检测 → 再加进这个列表。
   */
  const SEND_ENABLED_PLATFORMS = ['bilibili', 'zhihu', 'xiaohongshu', 'douyin'];

  // Phase A 写入后正常只需几秒就会被 Phase B 消费。超过这个窗口仍未开始
  // 发送的交接单大概率是 tab/导航遗留，继续执行反而可能评论到过期页面。
  // 发送已开始或存在待补 settle 时不适用 TTL：这两种状态是 at-most-once 的
  // 持久化凭据，清掉它们会导致重复发送或台账永久卡在 claimed。
  const HANDOFF_TTL_MS = 10 * 60 * 1000;
  const PENDING_SETTLEMENT_STATES = {
    posted: 1,
    unconfirmed: 1,
    failed: 1,
    blocked: 1,
    skipped: 1,
    filled: 1,
  };
  // 最多三次。每次 API 前都会先确认 pendingSettlement 已持久化，
  // 因此页面在任意退避窗口卸载，新 document 也只会补 settle。
  const SETTLEMENT_RETRY_DELAYS_MS = [0, 500, 1500, 4000, 8000];

  function stopAfterFor(platform) {
    return SEND_ENABLED_PLATFORMS.indexOf(platform) >= 0 ? 'send' : 'fill';
  }

  /** Phase A 在导航前写下交接单：这条靶子是谁领的、要做到哪一步。 */
  async function writeHandoff(deps, claim, profileId, stopAfter, hops) {
    const store = storeOf(deps);
    if (!store) return false;
    // 先读后写是最后一道防覆盖闸。Phase A 在 claim 之前会主动恢复
    // pending settlement，但从预检到这里仍可能有异步状态变化。存在
    // 任何旧 handoff 时都宁可拒绝，绝不覆盖 sendStarted/pendingSettlement。
    try {
      if (await store.read()) return false;
      return !!(await store.write({
        key: claim.key, platform: claim.platform, open_url: claim.open_url,
        profileId, stopAfter: stopAfter || stopAfterFor(claim.platform), at: Date.now(),
        hops: hops || 0,
      }));
    } catch (e) {
      return false;
    }
  }

  async function readHandoff(deps) {
    const store = storeOf(deps);
    if (!store) return null;
    try { return (await store.read()) || null; } catch (e) { return null; }
  }

  // 新文档起来时，MV3 worker 可能还在恢复，chrome.storage.session 也可能正好
  // 返回一次瞬时错误。一次 read 就把它压成「没有交接单」会让 Phase B 永久消失。
  // 退避本身不到 1 秒；消息侧另有 1 秒上限，整轮不会因 SW 不回包而无限挂住。
  const HANDOFF_READ_DELAYS_MS = [0, 100, 250, 500];

  async function readHandoffWithRetry(deps) {
    deps = deps || {};
    const store = storeOf(deps);
    if (!store) {
      return { status: 'handoff_read_failed', handoff: null, attempts: 0, error: 'handoff store unavailable' };
    }
    const delays = Array.isArray(deps.handoffReadDelays) && deps.handoffReadDelays.length
      ? deps.handoffReadDelays
      : HANDOFF_READ_DELAYS_MS;
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let lastError = null;
    let hadSuccessfulRead = false;

    for (let i = 0; i < delays.length; i += 1) {
      if (i > 0 && Number(delays[i]) > 0) await sleep(Number(delays[i]));
      try {
        const handoff = await store.read();
        hadSuccessfulRead = true;
        lastError = null;
        if (handoff) return { status: 'handoff_ready', handoff, attempts: i + 1 };
      } catch (e) {
        lastError = String((e && e.message) || e);
      }
    }

    return {
      status: hadSuccessfulRead ? 'no_handoff' : 'handoff_read_failed',
      handoff: null,
      attempts: delays.length,
      error: hadSuccessfulRead ? null : lastError,
    };
  }

  async function clearHandoff(deps, handoff) {
    const store = storeOf(deps);
    if (!store) return false;
    try { await store.clear(handoff); return true; } catch (e) { return false; }
  }

  async function deadLetterHandoff(deps, handoff, reason) {
    const store = storeOf(deps);
    if (!store) return false;
    try {
      // 浏览器真实 store 会把证据移入按 profile+key 隔离的 local tombstone；
      // 简单注入 store 没实现 deadLetter 时退回 clear，保持 API 可测试/兼容。
      if (typeof store.deadLetter === 'function') {
        await store.deadLetter(handoff, reason);
      } else {
        await store.clear(handoff);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function persistHandoff(deps, handoff) {
    const store = storeOf(deps);
    if (!store) return false;
    try { return !!(await store.write(handoff)); } catch (e) { return false; }
  }

  function isPendingSettlement(value) {
    return !!PENDING_SETTLEMENT_STATES[String(value || '')];
  }

  /**
   * Phase A 的新 claim 闸：恢复旧 pending settlement，或拒绝覆盖仍在执行的
   * handoff。恢复复用同一套有界 settle 退避；全部失败也会在
   * ingest/claim 之前返回，不会领第二条。
   */
  async function recoverSettlementBeforeClaim(deps, currentPlatform) {
    const store = storeOf(deps);
    if (!store || typeof store.read !== 'function') {
      return {
        ok: false,
        result: { status: 'handoff_read_failed', error: 'handoff store unavailable' },
      };
    }

    const read = await readHandoffWithRetry(deps);
    if (!read.handoff && read.status !== 'no_handoff') {
      return {
        ok: false,
        result: {
          status: 'handoff_read_failed',
          attempts: read.attempts,
          error: read.error,
        },
      };
    }
    const existing = read.handoff;
    if (!existing) return { ok: true, recovered: false };

    if (isPendingSettlement(existing.pendingSettlement)) {
      const state = existing.pendingSettlement;
      const recovered = await settleAndClear(
        deps,
        existing,
        state,
        { status: 'settled_before_claim', key: existing.key, state },
      );
      if (recovered.status === 'settle_failed') return { ok: false, result: recovered };
      return {
        ok: true,
        recovered: true,
        state,
        key: existing.key,
        platform: existing.platform,
      };
    }

    // sendStarted 没有 pending state 是一张不完整但仍然不可覆盖的防重凭据。
    // 没有权威结果时不猜 posted/failed。
    if (existing.sendStarted) {
      return {
        ok: false,
        result: { status: 'send_already_started', key: existing.key },
      };
    }

    // 跨平台搜索说明 scheduler 已经 park about:blank 并完成了当前 search commit，
    // 上一平台的旧导航不可能再“晚到”。此时若仍跳回旧平台，scheduler 只等当前
    // 平台 touch，会白等整腿。安全地把旧 claim 记 failed/clear，再继续当前平台。
    if (existing.platform && currentPlatform && existing.platform !== currentPlatform) {
      const abandoned = await settleAndClear(
        deps,
        existing,
        'failed',
        {
          status: 'cross_platform_handoff_settled',
          key: existing.key,
          platform: existing.platform,
        },
      );
      if (abandoned.status === 'settle_failed') return { ok: false, result: abandoned };
      return {
        ok: true,
        recovered: true,
        state: 'failed',
        key: existing.key,
        platform: existing.platform,
      };
    }

    // 同平台普通 pre-send handoff 说明上一条已 claim、但目标 document 没接上。不能 clear：
    // 第一次导航可能只是晚到，清掉后它一旦 commit 就失去归属；也不能只报
    // handoff_in_progress 后让后续平台逐条短路。安全恢复方式是保留同一交接单，
    // 精确重导航到它的 open_url，让 Phase B 在新 document 继续消费。
    if (existing.open_url && typeof deps.navigate === 'function') {
      try {
        const navigation = await deps.navigate(existing.open_url, {
          key: existing.key,
          platform: existing.platform,
          reason: 'handoff_resume',
        });
        if (navigation && (navigation.status === 'target_navigation_stalled' ||
            navigation.status === 'target_navigation_committed')) {
          return {
            ok: false,
            result: Object.assign({
              key: existing.key,
              open_url: existing.open_url,
              resumed: true,
            }, navigation, { key: navigation.key || existing.key }),
          };
        }
        return {
          ok: false,
          result: {
            status: 'handoff_in_progress',
            key: existing.key,
            open_url: existing.open_url,
            resumeSubmitted: true,
          },
        };
      } catch (e) {
        return {
          ok: false,
          result: {
            status: 'handoff_in_progress',
            key: existing.key,
            open_url: existing.open_url,
            error: String((e && e.message) || e),
          },
        };
      }
    }

    return {
      ok: false,
      result: { status: 'handoff_in_progress', key: existing.key, open_url: existing.open_url },
    };
  }

  /**
   * 在靶子页跑第二阶段。
   *
   * settle 成功后才清交接单；发送已经开始但落账失败时保留 pendingSettlement，
   * 让新 document 只补记台账、绝不再次点击。
   */
  async function runOnTarget(deps) {
    deps = deps || {};
    const handoff = deps.handoff !== undefined ? deps.handoff : await readHandoff(deps);
    if (!handoff) return { status: 'no_handoff' };

    // 发送已经发生（或至少已经开始）后，跨 document 只允许补记台账，绝不能再
    // 生成/点击一次。pendingSettlement 在点击前先保守写成 failed，确认回执后改成
    // posted；页面中途卸载也始终有一个可恢复且 at-most-once 的状态。
    if (isPendingSettlement(handoff.pendingSettlement)) {
      const state = handoff.pendingSettlement;
      return await settleAndClear(
        deps,
        handoff,
        state,
        { status: 'settled_after_retry', key: handoff.key, state },
      );
    }
    if (handoff.sendStarted) {
      return { status: 'send_already_started', key: handoff.key };
    }

    // 只淘汰尚未进入不可逆阶段的交接单。`at` 是 Phase A 写下的 epoch
    // milliseconds；缺失、非数值或非正数都不能证明它仍然属于本轮。
    // 未来时间不主动判死，给系统时钟回拨/修正留余地。
    if (!handoff.pendingSettlement) {
      const now = typeof deps.now === 'function' ? deps.now() : Date.now();
      const at = handoff.at;
      const expired = typeof at !== 'number' || !Number.isFinite(at) || at <= 0 ||
        typeof now !== 'number' || !Number.isFinite(now) || now - at > HANDOFF_TTL_MS;
      if (expired) {
        await clearHandoff(deps, handoff);
        return { status: 'handoff_expired', key: handoff.key, at: handoff.at };
      }
    }

    // 交接单是给某一个 URL 的。SPA 里用户/脚本可能已经点去别处了。
    const href = deps.href || (typeof location !== 'undefined' ? location.href : '');
    if (handoff.open_url && href && !sameTarget(handoff.open_url, href)) {
      const redirects = Number(handoff.mismatchRedirects) || 0;
      // 平台会自动跳到推荐内容，尤其抖音精选页和 B 站连播。第一次认错页时精确
      // 拉回 claim 给出的 URL；次数必须先写回 SW，否则新文档又从 0 开始会死循环。
      if (redirects < 1 && deps.navigate) {
        const repaired = Object.assign({}, handoff, { mismatchRedirects: redirects + 1 });
        if (!(await persistHandoff(deps, repaired))) {
          return {
            status: 'handoff_redirect_persist_failed',
            expected: handoff.open_url,
            got: href,
          };
        }
        try {
          const navigation = await deps.navigate(handoff.open_url, {
            key: handoff.key,
            platform: handoff.platform,
            reason: 'mismatch_repair',
          });
          if (navigation && (navigation.status === 'target_navigation_stalled' ||
              navigation.status === 'target_navigation_committed')) {
            return Object.assign({
              expected: handoff.open_url,
              got: href,
              redirects: redirects + 1,
            }, navigation, { key: navigation.key || handoff.key });
          }
          return {
            status: 'handoff_redirected',
            expected: handoff.open_url,
            got: href,
            redirects: redirects + 1,
          };
        } catch (e) {
          await clearHandoff(deps, handoff);
          return {
            status: 'handoff_url_mismatch',
            expected: handoff.open_url,
            got: href,
            redirects: redirects + 1,
            error: String((e && e.message) || e),
          };
        }
      }
      // 一次精确纠正仍不匹配就是终局。清掉交接单，避免它跨 document 留在 tab
      // 上，之后把用户打开的每一个普通详情页都再次当成自动任务。
      await clearHandoff(deps, handoff);
      return {
        status: 'handoff_url_mismatch',
        expected: handoff.open_url,
        got: href,
        redirects,
      };
    }

    if (handoff.stopAfter === 'open') {
      return await settleAndClear(
        deps,
        handoff,
        'skipped',
        { status: 'stopped_at_open', key: handoff.key },
      );
    }

    let outcome;
    try {
      // 既有链路：选中直评框 -> 触发生成 -> 流式敲进去。
      outcome = await deps.generateAndFill(handoff.platform);
    } catch (e) {
      outcome = { ok: false, error: String((e && e.message) || e) };
    }

    // 交接单**不能在这里就清**。
    //
    // 发送是唯一不可逆、也唯一会让页面跳转的动作：一旦发送途中页面变了或标签页
    // 没了，清掉交接单就意味着没人 settle，台账那条会卡在 `claimed` 直到 6 小时
    // TTL 过期。send 还是空操作时这个顺序无害，真的会点发送之后就是实打实的洞。
    // 所以改成「每条 return 之前各自清」，让「清交接单」和「落账」成对出现。

    // 评论区对所有人关闭 —— 这条靶子作废，换一条。
    //
    // 和「失败不重试」不冲突：那条规矩针对的是**我们**的失败（生成挂了、发送
    // 挂了），重试只会加重风控足迹。这里是**内容**的定论，同一条靶子再试一万
    // 次也没有输入框，唯一的出路就是换一条。
    if (outcome && outcome.reason === 'comments_closed') {
      // 记 blocked 而不是 failed：blocked 会把这条从**所有**账号的候选池里摘掉，
      // 否则另外 4 个号还会各花一条腿来重新发现同一件事。
      const blocked = await settleAndClear(
        deps,
        handoff,
        'blocked',
        { status: 'blocked_settled', key: handoff.key },
      );
      if (blocked.status === 'settle_failed') return blocked;
      return await hopToNextTarget(deps, handoff);
    }

    // 拿不到上下文槽位 —— **不落账**。
    //
    // 这是我们这边的系统性故障（SW 的归属闸把 PUT 挡了），不是这条靶子的属性。
    // 记 failed 的爆炸半径是「这个账号 × 这条靶子」永久作废（failed 进
    // settled_accounts，按「失败不重试」），所以一个半截接线的 bug 能沿着一条腿
    // 一条接一条地烧候选 —— 这正是当初焦点闸出问题时发生过的事。
    //
    // 代价说清楚：不落账 = 台账里这条停在 claimed，要等 claim TTL 过期才重新可领。
    // 用「一条 key 锁一段时间」换「不永久烧掉一整条腿」，这个交易是划算的。
    if (outcome && outcome.reason === 'context_unavailable') {
      await clearHandoff(deps, handoff);
      return { status: 'aborted_no_context', key: handoff.key, error: outcome.error };
    }

    if (!outcome || !outcome.ok) {
      return await settleAndClear(
        deps,
        handoff,
        'failed',
        { status: 'fill_failed', key: handoff.key, error: outcome && outcome.error },
      );
    }

    // 只有 stopAfter === 'send' 才会走到发送。
    if (handoff.stopAfter === 'send') {
      // 生成最长约 120s，这期间 SPA 可能已从靶子 A 切到 B。初始的 URL
      // 校验早已过期；必须在任何发送 guard/点击之前重新读当前 URL。
      const latestHref = typeof deps.currentHref === 'function'
        ? deps.currentHref()
        : (typeof location !== 'undefined' ? location.href : deps.href || '');
      if (handoff.open_url && latestHref && !sameTarget(handoff.open_url, latestHref)) {
        return await settleAndClear(
          deps,
          handoff,
          'failed',
          {
            status: 'target_changed_before_send',
            key: handoff.key,
            expected: handoff.open_url,
            got: latestHref,
          },
        );
      }

      // 跨 document 的不可逆动作闸。必须先持久化再调用 send；初始 pending state
      // 保守记 failed，若点击过程中页面消失，新文档只补记失败、绝不会再点一次。
      let guarded = Object.assign({}, handoff, {
        sendStarted: true,
        sendStartedAt: Date.now(),
        pendingSettlement: 'failed',
      });
      if (!(await persistHandoff(deps, guarded))) {
        return { status: 'send_guard_persist_failed', key: handoff.key };
      }

      // durable guard 落定后、真实点击前，再让后端把本次 claim 标成 send-started。
      // 这样即使生成/网络抖动超过普通 claim TTL，也不会被另一 profile 重领并让
      // 旧发送者 settle 409。prepare 的响应丢失也绝不能猜成功后继续点击；保守
      // settle failed，整个恢复路径仍只处理台账、不产生第二次外部动作。
      try {
        await deps.api('prospects/prepare-send', {
          key: handoff.key,
          profile_id: handoff.profileId,
        });
      } catch (e) {
        return await settleAndClear(
          deps,
          guarded,
          'failed',
          {
            status: 'prepare_send_failed',
            key: handoff.key,
            error: String((e && e.message) || e),
          },
        );
      }

      let sent;
      let attemptGuarded = false;
      const markAttempted = async () => {
        if (attemptGuarded) return true;
        const attemptedGuard = Object.assign({}, guarded, {
          pendingSettlement: 'unconfirmed',
          sendAttemptedAt: Date.now(),
        });
        if (!(await persistHandoff(deps, attemptedGuard))) {
          throw new Error('send attempt guard persist failed');
        }
        guarded = attemptedGuard;
        attemptGuarded = true;
        return true;
      };
      // 把生成出来的文本一并传下去：发送实现要拿它跟输入框里的实际内容核对，
      // 挡住「只敲了一半就点发布」（实测在知乎发出过一条两个字的评论）。
      // 把 key 一并传下去：发送实现据此保证「同一条只点一次」——
      // 小红书发完不清空草稿，重试会把同一条再发一遍。
      // 第五个回调由真实 send 在所有 draft/button/target 前置检查通过后、btn.click
      // 紧前 await。这样 click 导致同步导航/崩溃时，local 已是 unconfirmed；而按钮
      // 缺失/错页仍不会调用回调，最终可以准确 settle failed。
      try {
        sent = await deps.send(
          handoff.platform,
          outcome.text,
          handoff.key,
          handoff.open_url,
          markAttempted,
        );
      }
      catch (e) {
        // send adapter reject 无法证明异常发生在 click 前还是 click 后；所有明确的
        // draft/button/target 前置拒绝都应正常 resolve attempted:false。这里保守按
        // 已跨不可逆边界处理，避免未知异常把 public footprint 释放后再次发送。
        sent = { ok: false, attempted: true, error: String((e && e.message) || e) };
      }
      const state = sent && sent.ok ? 'posted' : sent && sent.attempted ? 'unconfirmed' : 'failed';
      if (state === 'posted' || state === 'unconfirmed') {
        guarded = Object.assign({}, guarded, { pendingSettlement: state });
        // 即使这次写失败也继续尝试 settle；sendStarted 仍在。unconfirmed 表示点击
        // 已返回但回执未知，必须计作外部动作，绝不能降成 failed 后被别号重领。
        await persistHandoff(deps, guarded);
      }

      return await settleAndClear(
        deps,
        guarded,
        state,
        sent && sent.reason === 'target_changed_before_send'
          ? {
              status: 'target_changed_before_send',
              key: handoff.key,
              expected: handoff.open_url,
              got: sent.got,
            }
          : state === 'posted'
          ? { status: 'posted', key: handoff.key, text: outcome.text }
          : state === 'unconfirmed'
          ? { status: 'send_unconfirmed', key: handoff.key, error: sent && sent.error }
          : { status: 'send_failed', key: handoff.key, error: sent && sent.error },
      );
    }

    return await settleAndClear(
      deps,
      handoff,
      'filled',
      { status: 'filled', key: handoff.key, text: outcome.text },
    );
  }

  /**
   * 换一条靶子：再 claim 一条，写新交接单，导航过去。
   *
   * 靠的还是台账的 claim —— 不在这里自己挑，也不缓存「上次那批候选」。原因是
   * 刚才那条已经 settle 成 blocked，台账已经把它从所有人的池子里摘掉了，所以
   * 一次普通的 claim 天然就会给出下一条。自己挑等于把去重逻辑复制一份出来。
   */
  async function hopToNextTarget(deps, handoff) {
    const hops = (handoff.hops || 0) + 1;
    if (hops > MAX_TARGET_HOPS) {
      return { status: 'blocked_hop_limit', key: handoff.key, hops: hops - 1 };
    }
    if (!deps.api || !deps.navigate) {
      // 换靶子需要 API 和导航两个能力；缺哪个都只能停在这里，但 blocked 已经
      // 记上了，这一跳的信息不会丢。
      return { status: 'blocked_no_hop', key: handoff.key };
    }

    let claimed;
    try {
      claimed = await deps.api('prospects/claim', {
        profile_id: handoff.profileId,
        platform: handoff.platform,
      });
    } catch (e) {
      return { status: 'blocked_hop_failed', key: handoff.key, error: String((e && e.message) || e) };
    }
    if (!claimed) {
      return { status: 'blocked_nothing_left', key: handoff.key, hops };
    }

    const handed = await writeHandoff(deps, claimed, handoff.profileId, handoff.stopAfter, hops);
    if (!handed) return { status: 'blocked_no_hop', key: handoff.key };
    const navigation = await deps.navigate(claimed.open_url, {
      key: claimed.key,
      platform: handoff.platform,
      reason: 'blocked_hop',
    });
    if (navigation && (navigation.status === 'target_navigation_stalled' ||
        navigation.status === 'target_navigation_committed')) {
      return Object.assign({
        from: handoff.key,
        title: claimed.title,
        open_url: claimed.open_url,
        hops,
      }, navigation, { key: navigation.key || claimed.key });
    }
    return {
      status: 'blocked_hopped',
      from: handoff.key,
      key: claimed.key,
      title: claimed.title,
      open_url: claimed.open_url,
      hops,
    };
  }

  function settleFailed(handoff, state, error, recoverable, details) {
    return {
      status: 'settle_failed',
      key: handoff.key,
      state,
      recoverable: recoverable === true,
      error,
      attempts: (details && details.attempts) || 0,
      persistAttempts: (details && details.persistAttempts) || 0,
      deadLetterAttempts: (details && details.deadLetterAttempts) || 0,
      stage: (details && details.stage) || 'api',
    };
  }

  /**
   * 终局落账的唯一入口。
   *
   * 顺序不能换：先把 pendingSettlement 写到 tab 级 store，再调 settle API，
   * API 成功后才清 handoff。退避期间如果 document 卸载，新 document 一眼就
   * 能看出只许补 settle，不会重新生成/点击。
   *
   * Phase B 前 5 次退避为 0/0.5/1.5/4/8s；仍失败后以 8s 为上限继续
   * settlement-only 唤起，直到成功或 document 卸载。这个循环绝不重进
   * runOnTarget 的生成/发送分支。因此 content 只会看到最终成功；不会把
   * 中间传输抖动日志化后让 scheduler 提前停车。
   */
  async function settleAndClear(deps, handoff, state, result, options) {
    options = options || {};
    const configured = Array.isArray(options.delays) && options.delays.length
      ? options.delays
      : (Array.isArray(deps.settlementRetryDelays) && deps.settlementRetryDelays.length
          ? deps.settlementRetryDelays
          : SETTLEMENT_RETRY_DELAYS_MS);
    const delays = configured.slice(0, SETTLEMENT_RETRY_DELAYS_MS.length);
    const sleep = deps.settlementSleep || deps.sleep ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const maxCycles = Number.isInteger(deps.settlementMaxAttempts) && deps.settlementMaxAttempts > 0
      ? deps.settlementMaxAttempts
      : Number.POSITIVE_INFINITY;
    const pending = Object.assign({}, handoff, {
      pendingSettlement: state,
      pendingSettlementAt: handoff.pendingSettlementAt || Date.now(),
    });
    let lastError = 'settlement retry exhausted';
    let lastStage = 'persist';
    let attempts = 0;
    let persistAttempts = 0;
    let deadLetterAttempts = 0;
    let deadLetterReason = null;

    let cycle = 0;
    while (cycle < maxCycles) {
      const delayIndex = Math.min(cycle, delays.length - 1);
      if (cycle > 0 && Number(delays[delayIndex]) > 0) {
        await sleep(Number(delays[delayIndex]));
      }
      if (typeof deps.settlementIsActive === 'function' && deps.settlementIsActive() !== true) {
        return settleFailed(handoff, state, lastError, true, {
          attempts,
          persistAttempts,
          deadLetterAttempts,
          stage: lastStage,
        });
      }
      cycle += 1;

      // API 已给出明确 nonrecoverable 4xx 后，后续循环只做 durable tombstone move。
      // 不能再次 persist active/API settle：dead-letter 可能已部分成功，重新写 active
      // 会与 tombstone 单调闸互锁。正式 document 按同一退避持续重试到成功/卸载。
      if (deadLetterReason) {
        deadLetterAttempts += 1;
        if (await deadLetterHandoff(deps, pending, deadLetterReason)) {
          return settleFailed(handoff, state, deadLetterReason, false, {
            attempts,
            persistAttempts,
            deadLetterAttempts,
            stage: 'dead_letter',
          });
        }
        lastError = deadLetterReason + '; nonrecoverable outbox dead-letter failed';
        lastStage = 'dead_letter';
        continue;
      }

      persistAttempts += 1;
      if (!(await persistHandoff(deps, pending))) {
        lastError = 'pending settlement persist failed';
        lastStage = 'persist';
        continue;
      }

      attempts += 1;
      const recorded = await settle(deps, pending, state);
      if (recorded.ok) {
        if (await clearHandoff(deps, pending)) return result;
        lastError = 'settlement recorded but handoff clear failed';
        lastStage = 'clear';
        continue;
      }
      lastError = recorded.error;
      lastStage = 'api';
      // 明确的客户端/状态错误不会因为等待而恢复。继续 8s 循环只会
      // 让 scheduler 白等整条腿。它也不能永久留在 active outbox：否则这个
      // profile 之后所有不同 key 都会被 CAS 拒绝，形成毒 outbox。也不能直接丢掉
      // “已经发送”的证据，否则 claim TTL 后同 key 可能二次公开发送。浏览器 store
      // 会把它移到只阻挡同 key 的 dead-letter；同 key 再被 claim 时自动恢复为
      // settlement-only。移动失败仍算 recoverable，绝不虚报已清理。
      if (/(?:返回|status)\s*(?:400|404|409)\b/i.test(String(recorded.error || ''))) {
        deadLetterReason = recorded.error;
        deadLetterAttempts += 1;
        if (!(await deadLetterHandoff(deps, pending, deadLetterReason))) {
          lastError = deadLetterReason + '; nonrecoverable outbox dead-letter failed';
          lastStage = 'dead_letter';
          continue;
        }
        return settleFailed(handoff, state, deadLetterReason, false, {
          attempts,
          persistAttempts,
          deadLetterAttempts,
          stage: 'dead_letter',
        });
      }
    }

    // 只有测试/显式调用方设了 maxAttempts 才会到这里；正式 document
    // 会持续 settlement-only 恢复。pending 仍保留，所以返回也必须是 recoverable。
    return settleFailed(handoff, state, lastError, true, {
      attempts,
      persistAttempts,
      deadLetterAttempts,
      stage: lastStage,
    });
  }

  /** 记录结果；失败必须显式返回，调用方不能清掉唯一的恢复凭据。 */
  async function settle(deps, handoff, state) {
    try {
      await deps.api('prospects/settle', {
        key: handoff.key, profile_id: handoff.profileId, state,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 同一个抖音内容会在详情页与精选抽屉之间改写 URL：
  //   /video/<id> 或 /note/<id>  <->  /jingxuan?modal_id=<id>
  // 路径不同但 id 相同，不能触发错页重定向。
  function douyinTargetIdentity(value) {
    try {
      const url = new URL(value);
      if (url.hostname !== 'douyin.com' && !url.hostname.endsWith('.douyin.com')) return null;
      const direct = /^\/(?:video|note)\/(\d+)(?:\/|$)/.exec(url.pathname);
      if (direct) return { id: direct[1] };
      if (/^\/(?:video|note)(?:\/|$)/.test(url.pathname)) return { id: null };
      if (/^\/jingxuan\/?$/.test(url.pathname)) {
        const modal = url.searchParams.get('modal_id');
        return { id: /^\d+$/.test(modal || '') ? modal : null };
      }
    } catch (e) {}
    return null;
  }

  /** 忽略 query/hash 比较是不是同一个目标 —— 平台会往 URL 上追加追踪参数。 */
  function sameTarget(a, b) {
    const douyinA = douyinTargetIdentity(a);
    const douyinB = douyinTargetIdentity(b);
    // 只要任一边是抖音详情壳，就必须两边都有明确且相同的内容 id。不能让
    // `/jingxuan?modal_id=123` 与裸 `/jingxuan` 回退到「忽略 query」后误判相同。
    if (douyinA || douyinB) {
      return !!(douyinA && douyinB && douyinA.id && douyinA.id === douyinB.id);
    }
    const strip = (u) => {
      try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); }
      catch (e) { return String(u); }
    };
    return strip(a) === strip(b);
  }

  // Phase B 的交接读取与执行必须是一个 single-flight。旧接线会先 read 一次确认，
  // runOnTarget 再 read 一次；第二次瞬时失败就把一张真实交接单变成 no_handoff。
  // started key 在本 document 内保留，防止重复 bootstrap 触发第二次真实发送。
  let targetPhaseFlight = null;
  const targetPhaseStartedKeys = Object.create(null);

  function runOnTargetSingleFlight(deps) {
    deps = deps || {};
    if (targetPhaseFlight) return targetPhaseFlight;

    const flight = (async () => {
      const read = deps.handoff !== undefined
        ? { status: 'handoff_ready', handoff: deps.handoff, attempts: 0 }
        : await readHandoffWithRetry(deps);
      if (!read.handoff) return read;

      const handoff = read.handoff;
      const key = String(handoff.key || handoff.open_url || '');
      if (key && targetPhaseStartedKeys[key]) {
        return { status: 'target_already_started', key };
      }
      if (key) targetPhaseStartedKeys[key] = true;

      let began = false;
      try {
        if (deps.beginTarget) {
          began = true;
          await deps.beginTarget(handoff);
        }
        return await runOnTarget(Object.assign({}, deps, { handoff }));
      } finally {
        if (began && deps.endTarget) await deps.endTarget(handoff);
      }
    })();

    targetPhaseFlight = flight;
    const clearFlight = () => {
      if (targetPhaseFlight === flight) targetPhaseFlight = null;
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  marineProspectRun.run = run;
  marineProspectRun.shouldRun = shouldRun;
  marineProspectRun.markDone = markDone;
  marineProspectRun.isTerminal = isTerminal;
  marineProspectRun.platformOfSearchPage = platformOfSearchPage;
  marineProspectRun.keywordOf = keywordOf;
  marineProspectRun.runOnTarget = runOnTarget;
  marineProspectRun.writeHandoff = writeHandoff;
  marineProspectRun.readHandoff = readHandoff;
  marineProspectRun.readHandoffWithRetry = readHandoffWithRetry;
  marineProspectRun.clearHandoff = clearHandoff;
  marineProspectRun.sameTarget = sameTarget;
  marineProspectRun.runOnTargetSingleFlight = runOnTargetSingleFlight;
  marineProspectRun.commentsClosed = commentsClosed;
  marineProspectRun.stopAfterFor = stopAfterFor;
  marineProspectRun.RUN_FLAG = RUN_FLAG;
  marineProspectRun.MAX_TARGET_HOPS = MAX_TARGET_HOPS;
  marineProspectRun.HANDOFF_TTL_MS = HANDOFF_TTL_MS;
})();
