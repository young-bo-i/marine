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
//   'fill' —— 生成话术并填进输入框，**停在点发送的前一步**（当前调试阶段）
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
    deps.navigate(claimed.open_url);
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
  const TERMINAL = ['claimed', 'nothing_to_claim', 'not_logged_in'];

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
  // 终止点由交接单里的 stopAfter 决定，当前是 'fill' —— 敲完就停，不点发送。

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
   * 三个平台都实现了回执检测（劫持页面 fetch，判据各不相同）：
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

  function stopAfterFor(platform) {
    return SEND_ENABLED_PLATFORMS.indexOf(platform) >= 0 ? 'send' : 'fill';
  }

  /** Phase A 在导航前写下交接单：这条靶子是谁领的、要做到哪一步。 */
  async function writeHandoff(deps, claim, profileId, stopAfter, hops) {
    const store = storeOf(deps);
    if (!store) return false;
    // 必须把 write 的结果传回去。忽略它等于「SW 没存下也照样导航」，那正是
    // 这次要修的失败形态：页面过去了，却没人接手。
    try {
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

  async function clearHandoff(deps) {
    const store = storeOf(deps);
    if (!store) return;
    try { await store.clear(); } catch (e) { /* 清不掉不改变本轮结论 */ }
  }

  /**
   * 在靶子页跑第二阶段。
   *
   * 无论成功失败都会 settle 并清掉交接单 —— 失败按运营决定只记录不重试，
   * 留着交接单只会让下次进这个页面又试一遍。
   */
  async function runOnTarget(deps) {
    deps = deps || {};
    const handoff = deps.handoff !== undefined ? deps.handoff : await readHandoff(deps);
    if (!handoff) return { status: 'no_handoff' };

    // 交接单是给某一个 URL 的。SPA 里用户/脚本可能已经点去别处了。
    const href = deps.href || (typeof location !== 'undefined' ? location.href : '');
    if (handoff.open_url && href && !sameTarget(handoff.open_url, href)) {
      return { status: 'handoff_url_mismatch', expected: handoff.open_url, got: href };
    }

    if (handoff.stopAfter === 'open') {
      await clearHandoff(deps);
      await settle(deps, handoff, 'skipped');
      return { status: 'stopped_at_open', key: handoff.key };
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
      await settle(deps, handoff, 'blocked');
      await clearHandoff(deps);
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
      await clearHandoff(deps);
      return { status: 'aborted_no_context', key: handoff.key, error: outcome.error };
    }

    if (!outcome || !outcome.ok) {
      await settle(deps, handoff, 'failed');
      await clearHandoff(deps);
      return { status: 'fill_failed', key: handoff.key, error: outcome && outcome.error };
    }

    // stopAfter === 'send' 时才会走到发送；当前配置是 'fill'，到此为止。
    if (handoff.stopAfter === 'send') {
      let sent;
      // 把生成出来的文本一并传下去：发送实现要拿它跟输入框里的实际内容核对，
      // 挡住「只敲了一半就点发布」（实测在知乎发出过一条两个字的评论）。
      // 把 key 一并传下去：发送实现据此保证「同一条只点一次」——
      // 小红书发完不清空草稿，重试会把同一条再发一遍。
      try { sent = await deps.send(handoff.platform, outcome.text, handoff.key); }
      catch (e) { sent = { ok: false, error: String((e && e.message) || e) }; }
      if (!sent || !sent.ok) {
        await settle(deps, handoff, 'failed');
        await clearHandoff(deps);
        return { status: 'send_failed', key: handoff.key, error: sent && sent.error };
      }
      await settle(deps, handoff, 'posted');
      await clearHandoff(deps);
      return { status: 'posted', key: handoff.key, text: outcome.text };
    }

    await settle(deps, handoff, 'filled');
    await clearHandoff(deps);
    return { status: 'filled', key: handoff.key, text: outcome.text };
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
    deps.navigate(claimed.open_url);
    return {
      status: 'blocked_hopped',
      from: handoff.key,
      key: claimed.key,
      title: claimed.title,
      open_url: claimed.open_url,
      hops,
    };
  }

  /** 记录结果。settle 本身失败不改变结论 —— 已经填进去的事实不会因此撤销。 */
  async function settle(deps, handoff, state) {
    try {
      await deps.api('prospects/settle', {
        key: handoff.key, profile_id: handoff.profileId, state,
      });
    } catch (e) { /* 记录失败只影响台账，不影响本轮判定 */ }
  }

  /** 忽略 query/hash 比较是不是同一个目标 —— 平台会往 URL 上追加追踪参数。 */
  function sameTarget(a, b) {
    const strip = (u) => {
      try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); }
      catch (e) { return String(u); }
    };
    return strip(a) === strip(b);
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
  marineProspectRun.clearHandoff = clearHandoff;
  marineProspectRun.sameTarget = sameTarget;
  marineProspectRun.commentsClosed = commentsClosed;
  marineProspectRun.stopAfterFor = stopAfterFor;
  marineProspectRun.RUN_FLAG = RUN_FLAG;
  marineProspectRun.MAX_TARGET_HOPS = MAX_TARGET_HOPS;
})();
