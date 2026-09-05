// The Scholay generated assets must hash to exactly what manifest.json claims.
//
// sw.js (`marineLoadGeneratedSkillAssets`) SHA-256s each of these files at
// runtime and throws 「Scholay 生成资产 SHA-256 不匹配」 on any mismatch. That
// throw happens inside the PUT branch of `marineContextFetch`, *before* the
// fetch — so a mismatched build does not fail loudly: the rime-context PUT is
// simply never sent, the comment target never publishes, and the 「生成」 button
// sits at 「准备中…」 until it gives up with 「目标准备超时，请重新点选输入框」.
// DELETE skips that branch, so the local API still sees teardown traffic and
// everything looks half-alive.
//
// sw-rime-context-smoke.mjs already proves the gate REJECTS a tampered hash.
// This is the other half: that the assets we actually ship still PASS it. The
// failure this guards against is not a bad commit, it is a bad *checkout* —
// end-of-line translation on a Windows runner rewrites the bytes without
// touching the hex hashes in manifest.json, so the mismatch appears only in the
// shipped artifact. See .gitattributes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

const generated = new URL("../skills/scholay/generated/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, generated));
const manifest = JSON.parse(read("manifest.json").toString("utf8"));
const assetHashes = manifest.assetHashes ?? {};

const names = ["personas.json", "comment-exemplars.json", "generation-policy.json"];
assert.deepEqual(
  Object.keys(assetHashes).sort(),
  [...names].sort(),
  "manifest.assetHashes must cover exactly the assets sw.js loads",
);

for (const name of names) {
  const bytes = read(name);
  const expected = assetHashes[name];
  assert.match(expected, /^[a-f0-9]{64}$/, `${name}: manifest hash is not a SHA-256 digest`);

  // Named explicitly because it is the failure mode in practice: a CRLF
  // checkout. Reporting "hash mismatch" alone sends the reader hunting for a
  // stale asset when the bytes on disk are the wrong ones.
  assert.ok(
    !bytes.includes("\r\n"),
    `${name}: contains CRLF — the checkout translated line endings, so its ` +
      `SHA-256 can never match manifest.json (see .gitattributes)`,
  );

  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, expected, `${name}: SHA-256 does not match manifest.json`);
}

console.log(`Scholay asset integrity smoke: OK (${names.length} assets match manifest.json)`);
