// 语料配额真的在驱动 brandMode —— 而且是确定性的。
//
// requiredRatio 长期只是 generation-policy.json 里的一个统计字段：品牌模式的唯一
// 出路是「页面自己已经提到 Scholay，并且命中某个能力点」，实际上接近于永不触发，
// 所以生成出来的评论几乎从不介绍 Scholay。现在运行时继承这个比例。
//
// 这里锁三件事，每一件都对应一种真实的翻车方式：
//   1. 比例真的生效（否则又退回「几乎从不」，而且没有任何报错提示）
//   2. 同一个目标每次都落在同一侧。质量校验失败会带着同一个目标重跑，brandMode
//      一旦中途翻面，上一轮按 required 写的稿子会被 evidence_only 的规则判死，
//      表现成随机的「候选文案未通过质量校验」
//   3. required 恰好绑定一个能力点。少了它 marineScholayBuildBundle 会抛，而那个抛
//      发生在 rime-context 的 PUT 之前 —— 整条链路一个字都不出，页面上只有超时
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, root), "utf8"));
const assets = {
  manifest: readJson("skills/scholay/generated/manifest.json"),
  personas: readJson("skills/scholay/generated/personas.json"),
  exemplars: readJson("skills/scholay/generated/comment-exemplars.json"),
  policy: readJson("skills/scholay/generated/generation-policy.json"),
};

const sandbox = { assets };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL("src/scholay-skill.js", root), "utf8"), sandbox, {
  filename: "marine-extension/src/scholay-skill.js",
});

// 一个普通的「科研工具」目标：页面既没提 Scholay，也没命中任何能力点。改动之前
// 这类目标 100% 走 evidence_only —— 而线上绝大多数目标都长这样。
const buildFor = (index) =>
  vm.runInContext(
    `(() => {
      const input = {
        contextId: "ctx-${index}",
        platform: "zhihu",
        mode: "direct",
        actionId: "marine.generate-direct",
        title: "科研工具推荐 ${index}",
        target: { id: "t${index}", authorName: "作者", text: "有没有好用的文献工具" },
        payload: { context: { source: "comments" }, comments: { agentMd: "问文献工具 ${index}" } },
      };
      const bundle = marineScholayBuildBundle(assets, input, "", { profileId: "p1" });
      return {
        brandMode: bundle.qualitySpec.brandMode,
        terms: bundle.qualitySpec.requiredCapabilityTerms,
      };
    })()`,
    sandbox,
  );

const SAMPLE = 600;
const ratio = assets.policy.brandPolicy.sourceDistribution.requiredRatio;
let required = 0;
for (let index = 0; index < SAMPLE; index++) {
  const { brandMode, terms } = buildFor(index);
  assert.ok(
    brandMode === "required" || brandMode === "evidence_only",
    `unexpected brandMode ${brandMode}`,
  );
  // 3. 自洽性，对每一条都查
  assert.equal(
    terms.length,
    brandMode === "required" ? 1 : 0,
    `${brandMode} bound ${terms.length} capability term(s)`,
  );
  if (brandMode === "required") required++;
}

// 1. 比例。容差给到 ±6 个百分点：600 个样本下二项分布的抖动远小于此，而真正要挡的
//    回归（配额没接上 → 0%，或者忘了判比例 → 100%）差着几十个百分点。
const observed = required / SAMPLE;
assert.ok(
  Math.abs(observed - ratio) < 0.06,
  `required ratio ${(observed * 100).toFixed(1)}% is not within 6pp of the configured ${ratio * 100}%`,
);

// 2. 确定性。同一个目标连算两次必须完全一致 —— 这是 Math.random 会破坏的那条。
const first = buildFor(42);
const second = buildFor(42);
assert.deepEqual(second, first, "the same target must always resolve to the same brand mode");

// 页面自带证据的路径不受配额影响：它必须始终 required，并且绑定页面上那个能力点。
const evidenceDriven = vm.runInContext(
  `(() => {
    const input = {
      contextId: "ctx-evidence",
      platform: "zhihu",
      mode: "direct",
      actionId: "marine.generate-direct",
      title: "Scholay 的文献矩阵分析好用吗",
      target: { id: "t-evidence", authorName: "作者", text: "Scholay 的文献矩阵分析能不能保留证据链" },
      payload: { context: { source: "comments" }, comments: { agentMd: "Scholay 文献矩阵分析" } },
    };
    const bundle = marineScholayBuildBundle(assets, input, "", { profileId: "p1" });
    return {
      brandMode: bundle.qualitySpec.brandMode,
      terms: bundle.qualitySpec.requiredCapabilityTerms,
    };
  })()`,
  sandbox,
);
assert.equal(evidenceDriven.brandMode, "required");
// Array.from：这个数组来自 vm 沙箱，原型不是宿主的 Array.prototype，
// deepStrictEqual 会因此判不等，尽管内容一模一样。
assert.deepEqual(Array.from(evidenceDriven.terms), ["文献矩阵分析"]);

console.log(
  `Scholay brand quota smoke: OK (${(observed * 100).toFixed(1)}% required over ${SAMPLE}, configured ${ratio * 100}%)`,
);
