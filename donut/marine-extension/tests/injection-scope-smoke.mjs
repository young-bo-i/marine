// injection-scope-smoke.mjs — 钉住 manifest 的注入范围与代码里的平台判定一致。
//
// 平台适配器不再随主包注入全网，而是由 manifest 的 host 匹配单独投递。于是出现了
// 一个新的失配风险：有人往 detectPlatform() 里加一个平台却忘了改 manifest，站点上
// 就会静默地拿不到适配器（不报错，只是评论目标永远定位不到）。
//
// 这里把 detectPlatform() 逐字从源码里取出来执行，再对一张 host 表做**相等**断言：
// 少匹配会失败，多匹配同样会失败。
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));
const contentIsoSource = fs.readFileSync(new URL("src/content-iso.js", root), "utf8");

// ---- 从源码里原样取出 detectPlatform，避免测试自己抄一份定义 ----
const detectMatch = contentIsoSource.match(
  /function detectPlatform\(\) \{[\s\S]*?\n {2}\}/,
);
assert.ok(detectMatch, "detectPlatform() must be extractable from content-iso.js");
const detectPlatform = new Function(
  "location",
  `${detectMatch[0]}\nreturn detectPlatform();`,
);

// 有 src/platforms/ 文件、因此必须被 manifest 投递到的平台。
// netflix 只走通用 textTrack 抽取，没有平台文件，所以不在此列。
const PLATFORMS_WITH_FILES = new Set([
  "youtube",
  "bilibili",
  "zhihu",
  "xiaohongshu",
  "douyin",
]);

const adapterEntry = manifest.content_scripts.find((entry) =>
  entry.js.some((file) => file.startsWith("src/platforms/")),
);
assert.ok(adapterEntry, "platform scripts must live in their own content_scripts entry");
assert.deepEqual(
  adapterEntry.js,
  [
    "src/platforms/youtube.js",
    "src/platforms/bilibili.js",
    // 发现侧解析器（搜索结果 -> 候选）。放在 comment-targets 之前只是为了让
    // 「发现 -> 投放」的阅读顺序和数据流一致，两者之间没有加载依赖。
    "src/platforms/discovery.js",
    // 登录态识别：权威接口必须在页内调用（签名由页面 JS 计算）。
    "src/platforms/login.js",
    // 发现侧编排：落到搜索页就自动跑（启动网址由 Donut 下发）。
    "src/platforms/prospect-run.js",
    "src/platforms/comment-targets.js",
  ],
  "every src/platforms/* file must be in the host-scoped entry",
);
assert.equal(adapterEntry.all_frames, false);
assert.equal(adapterEntry.run_at, "document_idle");

// 每个 src/platforms/ 文件都必须出现在这条条目里，不能有落单的。
const platformFiles = fs
  .readdirSync(new URL("src/platforms/", root))
  .filter((f) => f.endsWith(".js"))
  .map((f) => `src/platforms/${f}`)
  .sort();
assert.deepEqual(
  [...adapterEntry.js].sort(),
  platformFiles,
  "a new src/platforms/ file must be added to the host-scoped manifest entry",
);

// ---- Chrome match pattern -> 匹配函数（只支持 manifest 里实际用到的形态）----
function matchPatternToRegExp(pattern) {
  if (pattern === "<all_urls>") return () => true;
  const m = pattern.match(/^(\*|https?|ftp|file):\/\/([^/]*)(\/.*)$/);
  assert.ok(m, `unsupported match pattern in manifest: ${pattern}`);
  const [, scheme, host, path] = m;
  const schemeRe = scheme === "*" ? "https?" : scheme;
  // `*://*.foo.com/*` 在 Chrome 里既匹配 foo.com 也匹配它的子域。
  const hostRe = host.startsWith("*.")
    ? `(?:[^/]+\\.)?${host.slice(2).replace(/\./g, "\\.")}`
    : host === "*"
      ? "[^/]+"
      : host.replace(/\./g, "\\.");
  const pathRe = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return (url) => new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`).test(url);
}

const adapterMatchers = adapterEntry.matches.map(matchPatternToRegExp);
const manifestMatches = (url) => adapterMatchers.some((fn) => fn(url));

// ---- host 表：正例、子域、以及后缀混淆负例 ----
const HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.bilibili.com",
  "bilibili.com",
  "m.bilibili.com",
  "player.bilibili.com",
  "space.bilibili.com",
  "www.zhihu.com",
  "zhihu.com",
  "zhuanlan.zhihu.com",
  "www.xiaohongshu.com",
  "xiaohongshu.com",
  "xhslink.com",
  "www.douyin.com",
  "douyin.com",
  "live.douyin.com",
  // netflix 被 detectPlatform 识别但没有平台文件 —— 必须 NOT 匹配
  "www.netflix.com",
  "netflix.com",
  // 完全无关
  "github.com",
  "mail.google.com",
  "example.com",
  // 后缀混淆负例：既不能被 detectPlatform 认成平台，也不能被 manifest 匹配
  "bilibili.com.evil.test",
  "notbilibili.com",
  "zhihu.com.attacker.test",
];

for (const host of HOSTS) {
  const url = `https://${host}/some/path`;
  const platform = detectPlatform({ hostname: host });
  const needsPlatformFiles = PLATFORMS_WITH_FILES.has(platform);
  assert.equal(
    manifestMatches(url),
    needsPlatformFiles,
    `manifest injection scope disagrees with detectPlatform() for ${host} ` +
      `(detected "${platform}", manifest ${manifestMatches(url) ? "matches" : "does not match"})`,
  );
}

// ---- 载入顺序护栏：适配器必须先于读取它们注册表的 content-iso.js ----
const isoIndex = manifest.content_scripts.findIndex((e) =>
  e.js.includes("src/content-iso.js"),
);
const adapterIndex = manifest.content_scripts.indexOf(adapterEntry);
assert.ok(adapterIndex < isoIndex, "platform adapters must be injected before content-iso.js");

// 顺序只是「预期」，不是契约：content-iso.js 还必须有那个延迟兜底，否则跨条目顺序
// 一旦变化，评论目标会在 4 个平台上静默失效。
assert.match(contentIsoSource, /ADAPTER_PLATFORMS/);
assert.match(
  contentIsoSource,
  /setTimeout\(marineRimeStartTargetTracking, 0\)/,
  "content-iso.js must defer startup when the adapter registry has not landed yet",
);

// ADAPTER_PLATFORMS 必须正好等于 comment-targets.js 的 adapters.get 认识的那些平台。
const commentTargetsSource = fs.readFileSync(
  new URL("src/platforms/comment-targets.js", root),
  "utf8",
);
const declared = [
  ...contentIsoSource.matchAll(/const ADAPTER_PLATFORMS = \{([^}]*)\}/g),
]
  .flatMap(([, body]) => [...body.matchAll(/(\w+):\s*1/g)].map((m) => m[1]))
  .sort();
const registered = [...commentTargetsSource.matchAll(/if \(key === '(\w+)'\) return \w+;/g)]
  .map((m) => m[1])
  .sort();
assert.deepEqual(
  declared,
  registered,
  "ADAPTER_PLATFORMS must list exactly the platforms comment-targets.js registers",
);

console.log("Marine extension injection scope smoke: OK");
