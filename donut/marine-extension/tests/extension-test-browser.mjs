import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const executableNames = new Set([
  "Chromium",
  "Google Chrome for Testing",
  "chrome",
  "chrome.exe",
]);

async function findCachedBrowsers(root, maxDepth = 8) {
  const matches = [];

  async function visit(directory, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (entry.isFile() && executableNames.has(entry.name)) {
        matches.push(candidate);
      }
    }));
  }

  await visit(root, 0);
  return matches.sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }));
}

async function browserVersion(binary) {
  try {
    const result = await execFileAsync(binary, ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return `${result.stdout || ""}${result.stderr || ""}`.trim();
  } catch {
    return "";
  }
}

function blockedBrandedChrome(version, binary) {
  const isChromeForTesting =
    /Chrome for Testing/i.test(version) ||
    binary.includes("Google Chrome for Testing.app");
  const hasBrandedBundle =
    /\/Google Chrome(?: Beta| Canary)?\.app\/Contents\/MacOS\//.test(binary);
  if (
    isChromeForTesting ||
    (!hasBrandedBundle && !/^Google Chrome(?:\s|$)/i.test(version))
  ) {
    return false;
  }
  const major = Number(version.match(/\b(\d+)\./)?.[1] || 0);
  return major === 0 || major >= 137;
}

async function resolveExecutable(candidate) {
  await fs.access(candidate, constants.X_OK);
  return fs.realpath(candidate);
}

function brandedChromeError(version, binary) {
  return `${version || "Google Chrome 137+"} (${binary}) does not support command-line unpacked extensions: branded Google Chrome 137+ ignores --load-extension and --disable-extensions-except. The Marine E2E was NOT run. Use Chrome for Testing/Chromium or Microsoft Edge.`;
}

export async function findExtensionTestBrowser({ edgeEnvironment = false } = {}) {
  const home = os.homedir();
  const explicit = [
    process.env.MARINE_CHROME_BINARY,
    edgeEnvironment ? process.env.MARINE_EDGE_BINARY : null,
  ].filter(Boolean);
  if (explicit.length > 0) {
    let binary;
    try {
      binary = await resolveExecutable(explicit[0]);
    } catch {
      throw new Error(
        `The configured Marine E2E browser is not executable: ${explicit[0]}. The test was NOT run.`,
      );
    }
    const version = await browserVersion(binary);
    if (blockedBrandedChrome(version, binary)) {
      throw new Error(brandedChromeError(version, binary));
    }
    return { binary, version: version || path.basename(binary) };
  }
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, "Library/Caches/ms-playwright"),
    path.join(home, ".cache/ms-playwright"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "ms-playwright")
      : null,
    process.env.PUPPETEER_CACHE_DIR,
    path.join(home, ".cache/puppeteer"),
    path.resolve("node_modules/.cache/ms-playwright"),
    path.resolve("node_modules/.cache/puppeteer"),
    path.resolve("node_modules/playwright/.local-browsers"),
    path.resolve("node_modules/playwright-core/.local-browsers"),
  ].filter(Boolean);
  const cached = (await Promise.all(
    cacheRoots.map((root) => findCachedBrowsers(root)),
  )).flat();
  const installed = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    path.join(home, "Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    path.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const brandedChrome = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  const seen = new Set();
  const blocked = [];

  for (const candidate of [...cached, ...installed, ...brandedChrome]) {
    let binary;
    try {
      binary = await resolveExecutable(candidate);
    } catch {
      continue;
    }
    if (seen.has(binary)) continue;
    seen.add(binary);

    const version = await browserVersion(binary);
    if (blockedBrandedChrome(version, binary)) {
      blocked.push(`${version || "Google Chrome 137+"} (${binary})`);
      continue;
    }
    return { binary, version: version || path.basename(binary) };
  }

  const brandedExplanation = blocked.length > 0
    ? ` Found only unsupported branded Chrome: ${blocked.join(", ")}. Google Chrome 137+ ignores --load-extension and --disable-extensions-except, so the Marine E2E was NOT run.`
    : "";
  throw new Error(
    `No extension-capable test browser was found.${brandedExplanation} Set MARINE_CHROME_BINARY to Chrome for Testing/Chromium, or install/use Microsoft Edge.`,
  );
}

export async function extensionIdFromManifest(extensionDirectory) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionDirectory, "manifest.json"), "utf8"),
  );
  if (typeof manifest.key !== "string" || manifest.key.length === 0) {
    throw new Error("Marine test extension manifest.key is missing");
  }
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest()
    .subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}
