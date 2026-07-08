#!/usr/bin/env node
// CI: on a v* tag build, force the app version in tauri.conf.json, package.json,
// and Cargo.toml to match the tag — so the artifact name, the in-app "About"
// version, and the auto-updater's self-version can never drift apart. Reads the
// tag from GITHUB_REF_NAME (no shell-arg quoting → identical on bash + pwsh).
// No-op on non-tag builds (workflow_dispatch on a branch), leaving committed
// versions untouched.
import { readFileSync, writeFileSync } from "node:fs";

const ref = process.env.GITHUB_REF_NAME ?? "";
const m = ref.match(/^v(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)$/);
if (!m) {
  console.log(`ci-set-version: GITHUB_REF_NAME='${ref}' is not a v* tag — leaving versions as-is.`);
  process.exit(0);
}
const version = m[1];

// tauri.conf.json  (drives the bundle/artifact filename + CFBundleShortVersionString)
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

// package.json
const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// Cargo.toml — only the [package] version (first top-of-line `version = "..."`).
const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const versionLine = /^version = "[^"]*"$/m;
// Guard on whether the pattern MATCHES (not on whether text changed) — otherwise
// the common case where the committed version already equals the tag looks like a
// failure and would break the release build.
if (!versionLine.test(cargo)) {
  console.error("ci-set-version: FAILED to find [package] version in Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, cargo.replace(versionLine, `version = "${version}"`));

console.log(`ci-set-version: set version to ${version} (from tag ${ref})`);
