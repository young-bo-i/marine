// login.js 回归测试 —— 平台登录态识别。
//
// 每个 fixture 都是真实抓包形状，不是照文档写的：
//   · bilibili    登出是 code:-101 + data.isLogin:false，HTTP 仍然 200
//   · xiaohongshu 登出是 success:true + data.guest:true（只看 success 会把游客判成已登录）
//   · zhihu       登出返回 { error: {...} }
//   · douyin      需要 status_code===0 且有 user 对象
//
// 另外锁住两条不许违反的规则：
//   1. 小红书只认 web_session —— a1/webId 登出也有，用它们判断会把 5 个 profile
//      全报成已登录（实测踩过）
//   2. 「判断不了」必须是 null，不能塌成 false —— 后者会平白废掉健康账号
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
// 浏览器里 setTimeout 一定存在；vm 默认没有，不补进去就测不到超时路径。
const ctx = { console, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.resolve(here, "../src/platforms/login.js"), "utf8"),
  ctx,
);
const L = ctx.marineLogin;

const fakeFetch = (body) => async () => ({ json: async () => body });
const failingFetch = () => async () => {
  throw new Error("network down");
};

// ---------------------------------------------------------------- 平台识别
assert.equal(L.detect("www.bilibili.com"), "bilibili");
assert.equal(L.detect("search.bilibili.com"), "bilibili");
assert.equal(L.detect("zhuanlan.zhihu.com"), "zhihu");
assert.equal(L.detect("www.xiaohongshu.com"), "xiaohongshu");
assert.equal(L.detect("www.douyin.com"), "douyin");
assert.equal(L.detect("weibo.com"), null, "未支持平台返回 null");

// ---------------------------------------------------------------- cookie 证否
{
  assert.deepStrictEqual(
    [...L.hasSessionCookie("xiaohongshu", "a1=x; webId=y; abRequestId=z")],
    [],
    "a1/webId 是匿名设备 cookie，登出也有，绝不能算登录信号",
  );
  assert.deepStrictEqual(
    [...L.hasSessionCookie("xiaohongshu", "a1=x; web_session=abc")],
    ["web_session"],
  );
  assert.deepStrictEqual(
    [...L.hasSessionCookie("bilibili", "buvid3=x; SESSDATA=s; DedeUserID=1")].sort(),
    ["DedeUserID", "SESSDATA"],
  );
}

// ------------------------------------------- 页内看不到 cookie 也必须照常查接口
{
  // 真实 profile 实测：同时登录了知乎/抖音/小红书的账号，页内 document.cookie
  // 里读到的会话 cookie 是 0 个（它们都是 HttpOnly）。早期版本据此直接返回
  // "no_session_cookie / loggedIn:false"，把健康账号确定性判死。
  const r = await L.status("bilibili", {
    cookieString: "buvid3=only",   // 一个会话 cookie 都看不见
    fetchImpl: fakeFetch({ code: 0, data: { isLogin: true, uname: "阿拉善的海", mid: 7 } }),
  });
  assert.equal(r.loggedIn, true, "页内 cookie 不可见不能推出未登录，必须以接口为准");
  assert.equal(r.evidence, "platform_confirmed");
  assert.deepStrictEqual([...r.cookiesFound], [], "cookie 列表只是诊断信息");
}

// ---------------------------------------------------------------- 权威接口
{
  // bilibili 登出：HTTP 200 但 code -101
  const out = await L.status("bilibili", {
    cookieString: "SESSDATA=dead",
    fetchImpl: fakeFetch({ code: -101, message: "账号未登录", data: { isLogin: false } }),
  });
  assert.equal(out.loggedIn, false);
  assert.equal(out.evidence, "platform_rejected", "cookie 还在但会话已死，必须识破");

  const inn = await L.status("bilibili", {
    cookieString: "SESSDATA=live",
    fetchImpl: fakeFetch({ code: 0, data: { isLogin: true, uname: "彭", mid: 18615149 } }),
  });
  assert.equal(inn.loggedIn, true);
  assert.equal(inn.accountName, "彭");
  assert.equal(inn.accountId, "18615149");
}

{
  // 小红书：游客态 success 仍然是 true
  const guest = await L.status("xiaohongshu", {
    cookieString: "web_session=x",
    fetchImpl: fakeFetch({ success: true, code: 0, data: { guest: true } }),
  });
  assert.equal(guest.loggedIn, false, "guest:true 不能算登录");

  // 真实抓包形状
  const real = await L.status("xiaohongshu", {
    cookieString: "web_session=x",
    fetchImpl: fakeFetch({
      success: true, code: 0, msg: "成功",
      data: { guest: false, user_id: "69c0fa620000000033037ae5", nickname: "这是我" },
    }),
  });
  assert.equal(real.loggedIn, true);
  assert.equal(real.accountName, "这是我");
}

{
  const out = await L.status("zhihu", {
    cookieString: "z_c0=x",
    fetchImpl: fakeFetch({ error: { message: "需要验证身份", code: 401 } }),
  });
  assert.equal(out.loggedIn, false);

  const inn = await L.status("zhihu", {
    cookieString: "z_c0=x",
    fetchImpl: fakeFetch({ id: "84f04517", name: "young" }),
  });
  assert.equal(inn.loggedIn, true);
  assert.equal(inn.accountName, "young");
}

{
  const partial = await L.status("douyin", {
    cookieString: "sessionid=x",
    fetchImpl: fakeFetch({ status_code: 0 }),
  });
  assert.equal(partial.loggedIn, false, "只有 status_code 没有 user 不能算登录");
}

// ---------------------------------------------------------------- DOM 兜底
{
  // 接口挂掉时，页面标记仍能给出方向
  const el = (visible) => ({
    offsetWidth: visible ? 10 : 0,
    offsetHeight: visible ? 10 : 0,
    getClientRects: () => (visible ? [{}] : []),
  });
  const doc = (signedIn) => ({
    querySelector: (sel) => {
      const cfg = L.PLATFORMS.bilibili;
      if (sel === cfg.domIn) return signedIn ? el(true) : null;
      if (sel === cfg.domOut) return signedIn ? null : el(true);
      return null;
    },
  });

  const viaDom = await L.status("bilibili", {
    cookieString: "SESSDATA=x",
    fetchImpl: failingFetch(),
    document: doc(true),
  });
  assert.equal(viaDom.loggedIn, true);
  assert.equal(viaDom.evidence, "dom_marker", "接口不可用时应退到 DOM 标记");

  const viaDomOut = await L.status("bilibili", {
    cookieString: "SESSDATA=x",
    fetchImpl: failingFetch(),
    document: doc(false),
  });
  assert.equal(viaDomOut.loggedIn, false);
}

// ---------------------------------------------------------------- 未知 ≠ 登出
{
  // 有 cookie、接口挂了、DOM 也说不清 —— 必须是 null
  const unknown = await L.status("bilibili", {
    cookieString: "SESSDATA=x",
    fetchImpl: failingFetch(),
    document: { querySelector: () => null },
  });
  assert.equal(
    unknown.loggedIn, null,
    "判断不了必须是 null；塌成 false 会把一个健康账号误判为需要重新登录",
  );
  assert.equal(unknown.evidence, "verify_failed");
}

// 两个标记同时命中也算说不清，不许硬猜
{
  const both = { offsetWidth: 5, offsetHeight: 5, getClientRects: () => [{}] };
  assert.equal(
    L.readDom("bilibili", { querySelector: () => both }), null,
    "登录标记与登出标记同时可见时应放弃判断",
  );
}

// ---------------------------------------------------------------- 不能吊死
{
  // 这条是**整条编排**的保命闸。没有超时的话，一个挂住的登录请求会让 run()
  // 永远不返回：日志行在 run() 之后所以永远不打，重试循环也在 await 它所以
  // 永远不进下一轮，调度器只能干等满一整条腿的超时再报「未落账」。
  // 实测踩过：Network 里能看到登录请求发出去了，之后零 ingest、零日志、零重试。
  const never = new Promise(() => {});          // 永不 settle
  const started = Date.now();
  const r = await L.status("bilibili", {
    fetchImpl: () => never,
    timeoutMs: 300,
    document: { querySelector: () => null },
    cookieString: "",
  });
  const took = Date.now() - started;
  assert.ok(took < 3000, `必须超时返回，实际耗时 ${took}ms`);
  assert.equal(r.loggedIn, null,
    "超时不能下结论 —— 判「未登录」会让编排把健康账号当登出直接停机（终局，不重试）");
  assert.equal(r.evidence, "verify_failed",
    "要报「判断不了」，这是非终局状态，会被重试");
}

// body 迟迟不来也要能脱身（响应头回来了但 res.json() 挂住）
{
  const r = await L.status("bilibili", {
    fetchImpl: async () => ({ json: () => new Promise(() => {}) }),
    timeoutMs: 300,
    document: { querySelector: () => null },
    cookieString: "",
  });
  assert.equal(r.loggedIn, null, "读 body 挂住同样要走「判断不了」");
}

// ------------------------------------------- 接口不可用 ≠ 未登录
{
  // 实测小红书：user/me 需要站点自己的签名头，我们直接 fetch 一律
  // HTTP 406 + {"code":-1,"success":false}。把这个当权威的「未登录」，会让一个
  // 登录良好的账号被判成登出 —— 编排随即「设计内停机」，白白废掉一个号。
  const un = await L.status("xiaohongshu", {
    fetchImpl: async () => ({ ok: false, status: 406, json: async () => ({ code: -1, success: false }) }),
    document: { querySelector: (sel) => (/avatar|user/i.test(sel) ? { offsetWidth: 20, offsetHeight: 20, getClientRects: () => [{}] } : null) },
    cookieString: "",
  });
  assert.notEqual(un.loggedIn, false,
    "接口不可用不能塌成「未登录」—— 必须落到 DOM 兜底或报「判断不了」");

  // 两路都说不清才是 null
  const blind = await L.status("xiaohongshu", {
    fetchImpl: async () => ({ ok: false, status: 406, json: async () => ({}) }),
    document: { querySelector: () => null },
    cookieString: "",
  });
  assert.equal(blind.loggedIn, null);
  assert.equal(blind.evidence, "verify_failed");

  // 2xx 且接口说 guest 才是真的未登录
  const guest = await L.status("xiaohongshu", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { guest: true } }) }),
    document: { querySelector: () => null },
    cookieString: "",
  });
  assert.equal(guest.loggedIn, false);
  assert.equal(guest.evidence, "platform_rejected");
}

// ------------------------------------------- 抖音判据要对着真实响应
{
  // 实测响应是扁平的、没有 `user` 对象：
  //   {id,create_time,last_time,user_uid,user_uid_type,...,status_code}
  // 旧判据要求 b.user 存在 —— 一个登录良好的账号被判成登出。
  const real = { id: "7667486792971486766", create_time: "1785225894",
    user_uid: "96343272785", user_uid_type: 0, status_code: 0 };
  const inRes = await L.status("douyin", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => real }),
    document: { querySelector: () => null },
    cookieString: "",
  });
  assert.equal(inRes.loggedIn, true, "真实响应必须判成已登录");
  assert.equal(inRes.evidence, "platform_confirmed");
  assert.equal(inRes.accountId, "96343272785");

  // 登出：user_uid 为空
  for (const uid of ["", "0", null]) {
    const out = await L.status("douyin", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status_code: 0, user_uid: uid }) }),
      document: { querySelector: () => null },
      cookieString: "",
    });
    assert.equal(out.loggedIn, false, `user_uid=${JSON.stringify(uid)} 应判未登录`);
  }

  // status_code 正常但没有 uid，不能只看 status_code 就放行
  const bare = await L.status("douyin", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status_code: 0 }) }),
    document: { querySelector: () => null },
    cookieString: "",
  });
  assert.equal(bare.loggedIn, false, "status_code===0 只说明调用成功，不代表登录");
}

console.log("login-status-smoke: OK");
