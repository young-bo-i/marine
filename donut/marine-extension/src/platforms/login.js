// login.js — 平台登录态识别（运行在 ISOLATED world，经典脚本）
//
// 为什么必须在页内做：这些「我是谁」接口要请求签名（小红书 edith 的 x-s/x-t、
// 抖音的 a_bogus），只有页面自己的 JS 能算。实测同一个 profile、同一个接口：
//   浏览器内  -> {"success":true,"data":{"guest":false,"nickname":"这是我"}}
//   带 cookie 从 Rust 发 -> {"success":false}
// 而这个失败和「未登录」长得一模一样。所以从外部带 cookie 请求是不可信的。
//
// 两路信号，按可信度递减，任何一路能定论就返回：
//   1. api   同源 fetch 权威接口 —— 唯一能识破「cookie 还在但已失效」的
//   2. dom   页面上的头像/登录按钮 —— 接口改版时仍然可用
// 页内**不做** cookie 判据：document.cookie 看不到 HttpOnly，而会话 cookie 几乎
// 全是 HttpOnly。这条捷径会把已登录账号判死，见 SESSION_COOKIES 上方注释。
//
// 「未登录」和「判断不了」必须分开：前者是「去登录」，后者是「稍后重试」。
// 把网络抖动当成登出会平白废掉一个健康账号。

var marineLogin = marineLogin || {};

(function () {
  'use strict';

  // 每个平台：权威接口 + 解析规则 + DOM 兜底选择器。
  // 接口形状全部来自真实抓包，不是文档。
  const PLATFORMS = {
    bilibili: {
      host: /(^|\.)bilibili\.com$/,
      api: 'https://api.bilibili.com/x/web-interface/nav',
      // 登出是 code:-101 + data.isLogin:false，HTTP 仍然 200 —— 不能靠状态码判断
      readApi: (b) => ({
        ok: !!(b && b.data && b.data.isLogin),
        name: b && b.data && b.data.uname,
        id: b && b.data && b.data.mid != null ? String(b.data.mid) : null,
      }),
      // 已登录：头像入口；未登录：登录按钮
      domIn: '.header-entry-mini, .bili-avatar, .header-avatar-wrap',
      domOut: '.header-login-entry',
    },
    zhihu: {
      host: /(^|\.)zhihu\.com$/,
      api: 'https://www.zhihu.com/api/v4/me',
      // 登出返回 { error: {...} }，登录直接返回用户对象
      readApi: (b) => ({
        ok: !!(b && !b.error && b.id),
        name: b && b.name,
        id: b && b.id ? String(b.id) : null,
      }),
      domIn: '.AppHeader-profileAvatar, .Avatar--large, [data-za-detail-view-element_name="Me"]',
      domOut: '.AppHeader-login, .SignFlow',
    },
    douyin: {
      host: /(^|\.)douyin\.com$/,
      api: 'https://www.douyin.com/aweme/v1/web/query/user/',
      // 实测响应是**扁平的**，没有 `user` 对象：
      //   {id, create_time, last_time, user_uid, user_uid_type,
      //    firebase_instance_id, user_agent, browser_name, status_code}
      // 旧判据要求 `b.user` 存在，于是一个登录良好的账号被判成登出 ——
      // 和小红书那次是同一类错误（判据照着想当然的结构写，没对过真实响应）。
      //
      // 登录凭据是 `user_uid` 非空且不是 "0"：登出态该字段为空串。
      // `status_code === 0` 只说明这次调用成功，单看它每个游客都算已登录。
      readApi: (b) => {
        const uid = b && b.user_uid != null ? String(b.user_uid).trim() : '';
        return {
          ok: !!(b && b.status_code === 0 && uid && uid !== '0'),
          name: (b && b.nickname) || null,
          id: uid && uid !== '0' ? uid : null,
        };
      },
      domIn: '[data-e2e="live-avatar"], .avatar-component, [class*="avatar" i][class*="user" i]',
      domOut: '#login-panel-new, [data-e2e="login-button"]',
    },
    xiaohongshu: {
      host: /(^|\.)xiaohongshu\.com$/,
      api: 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me',
      // guest:true 是登出形态，而且 success 仍然是 true —— 只看 success 会把
      // 每个游客都判成已登录。实测响应：{"success":true,"data":{"guest":false,…}}
      readApi: (b) => ({
        ok: !!(b && b.success && b.data && b.data.guest !== true && b.data.user_id),
        name: b && b.data && b.data.nickname,
        id: b && b.data && b.data.user_id ? String(b.data.user_id) : null,
      }),
      domIn: '.user .link-wrapper, .side-bar .user, [class*="avatar" i]',
      domOut: '.login-btn, .sign-in, [class*="login" i][class*="btn" i]',
    },
  };

  // ⚠️ 页内的 cookie 检查**只能当诊断信息，不能当判据**。
  //
  // document.cookie 看不到 HttpOnly cookie，而这四个平台的会话 cookie 几乎全是
  // HttpOnly（SESSDATA / z_c0 / sessionid / web_session）。真实 profile 实测：
  // 一个同时登录了知乎/抖音/小红书的账号，页内读到的会话 cookie 是 0 个 ——
  // 如果据此下「未登录」的结论，就会把健康账号确定性地判死。
  //
  // 「无 cookie ⇒ 必定登出」这个推理只在能看到 HttpOnly 的地方成立，也就是
  // Rust 侧的 CDP Network.getCookies（见 marine/login.rs::cookie_probe）。
  //
  // 名单本身仍然有用：小红书只认 web_session —— a1 / webId 是匿名设备 cookie，
  // 登出也有，拿它们判断会把 5 个 profile 全报成已登录（实测踩过）。
  const SESSION_COOKIES = {
    bilibili: ['SESSDATA', 'DedeUserID'],
    zhihu: ['z_c0'],
    douyin: ['sessionid', 'sessionid_ss'],
    xiaohongshu: ['web_session'],
  };

  function detect(hostname) {
    const h = hostname || (typeof location !== 'undefined' ? location.hostname : '');
    for (const key of Object.keys(PLATFORMS)) {
      if (PLATFORMS[key].host.test(h)) return key;
    }
    return null;
  }

  /** document.cookie 里能看到的会话 cookie 名。仅作诊断 —— 看不到 HttpOnly，
   *  所以返回空数组**不能**推出「未登录」。 */
  function hasSessionCookie(platform, cookieString) {
    const names = SESSION_COOKIES[platform] || [];
    const raw = cookieString != null
      ? cookieString
      : (typeof document !== 'undefined' ? document.cookie : '');
    const present = String(raw)
      .split(';')
      .map((s) => s.split('=')[0].trim())
      .filter(Boolean);
    return names.filter((n) => present.includes(n));
  }

  /** DOM 兜底：接口改版时仍然能给出方向性判断。 */
  function readDom(platform, doc) {
    const cfg = PLATFORMS[platform];
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!cfg || !d) return null;
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    let inEl = null;
    let outEl = null;
    try { inEl = d.querySelector(cfg.domIn); } catch (e) { /* 选择器无效不该拖垮判断 */ }
    try { outEl = d.querySelector(cfg.domOut); } catch (e) { /* 同上 */ }
    const signedIn = visible(inEl);
    const signedOut = visible(outEl);
    // 两个都命中或都没命中 ⇒ 说明不了问题，交给上层，别硬猜。
    if (signedIn === signedOut) return null;
    return signedIn;
  }

  /** 权威接口的等待上限。宁可判「不知道」并重试，也不能无限期挂住。 */
  const API_TIMEOUT_MS = 8000;

  /**
   * 给 promise 加上限。超时时 reject，让调用方走既有的兜底路径。
   *
   * 不用 AbortController 是因为要同时罩住 `res.json()` —— 响应头回来了但 body
   * 迟迟不来，同样会吊死。
   */
  function withTimeout(value, ms) {
    // Promise.resolve 包一层：桩实现（和某些平台的 res.json()）可能直接返回值
    // 而不是 promise，直接 .then 会抛。
    const p = Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /**
   * 解析登录态。
   * @returns {Promise<{platform,loggedIn:boolean|null,evidence,accountName,accountId,cookiesFound}>}
   *   loggedIn === null 表示「判断不了」，调用方必须和 false 区别对待。
   */
  async function status(platformOverride, opts) {
    opts = opts || {};
    const platform = platformOverride || detect();
    if (!platform || !PLATFORMS[platform]) {
      return { platform: platform || 'unknown', loggedIn: null, evidence: 'unsupported_platform',
               accountName: null, accountId: null, cookiesFound: [] };
    }
    const cfg = PLATFORMS[platform];
    // 仅作诊断随结果带出；不参与判定，理由见 SESSION_COOKIES 上方注释。
    // （opts.cookieString 存在是为了让单测能构造场景，生产路径读 document.cookie。）
    const cookiesFound = hasSessionCookie(platform, opts.cookieString);

    // 1) 权威接口。同源 + credentials:include，让页面自己的签名逻辑生效。
    //    注意：这里不做「没 cookie 就跳过」的短路 —— 页内看不到 HttpOnly，
    //    那个短路会在已登录账号上错误触发。
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (fetchImpl) {
      try {
        // 超时是**必须**的，不是保险。这个 await 没有上限的话，一个挂住的请求
        // 会让整条编排静默吊死：run() 永远不返回 → 日志行（在 run() 之后）永远
        // 不打 → 重试循环（也在 await 它）永远不进下一轮 → 调度器只能等满整条腿
        // 的超时，然后报「未落账」。实测形态就是这样：登录请求在 Network 里看得
        // 见，之后零 ingest、零日志、零重试。
        //
        // 超时后不下结论，落到 DOM 兜底、再落到「判断不了」—— 那是非终局状态，
        // 会被重试，这正是想要的。
        const res = await withTimeout(
          fetchImpl(cfg.api, { credentials: 'include' }),
          opts.timeoutMs || API_TIMEOUT_MS,
        );
        // 非 2xx **不是**「未登录」，是「这个接口对我们不可用」。
        //
        // 实测小红书：`edith.xiaohongshu.com/api/sns/web/v2/user/me` 需要站点
        // 自己的签名头（x-s/x-t），我们直接 fetch 一律 HTTP 406 +
        // `{"code":-1,"success":false}`。旧代码把这个当成权威的「未登录」直接
        // 下结论，于是一个登录良好的账号（web_session/id_token 都在且有效期到
        // 2027）被判成登出、编排设计内停机 —— 而 DOM 兜底明明能判对
        // （头像元素 68 个、登录按钮 0 个）。
        //
        // 抛出去落到 DOM 兜底，兜不住再报「判断不了」，这才符合三态约定。
        // 只在**明确失败**时抛：真实 Response 一定带 ok/status，缺这两个字段的
        // 只可能是测试桩，不该被误伤。
        const failed = res.ok === false ||
          (typeof res.status === 'number' && (res.status < 200 || res.status >= 300));
        if (failed) throw new Error('api_unusable_' + res.status);
        const body = await withTimeout(res.json(), opts.timeoutMs || API_TIMEOUT_MS);
        const v = cfg.readApi(body);
        return { platform, loggedIn: !!v.ok,
                 evidence: v.ok ? 'platform_confirmed' : 'platform_rejected',
                 accountName: v.name || null, accountId: v.id || null, cookiesFound };
      } catch (e) {
        // 落到 DOM 兜底，不要在这里就下结论
      }
    }

    // 2) DOM 兜底。
    const dom = readDom(platform, opts.document);
    if (dom !== null) {
      return { platform, loggedIn: dom, evidence: 'dom_marker',
               accountName: null, accountId: null, cookiesFound };
    }

    // 3) 两路都没说清 —— 未知，不是登出。
    return { platform, loggedIn: null, evidence: 'verify_failed',
             accountName: null, accountId: null, cookiesFound };
  }

  marineLogin.detect = detect;
  marineLogin.hasSessionCookie = hasSessionCookie;
  marineLogin.readDom = readDom;
  marineLogin.status = status;
  marineLogin.PLATFORMS = PLATFORMS;
  marineLogin.SESSION_COOKIES = SESSION_COOKIES;
})();
