import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(here, '../dev/local-bridge.mjs');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'marine-dev-bridge-'));
const runtimePath = path.join(temporaryRoot, 'runtime.json');
const earlyRuntimePath = path.join(temporaryRoot, 'early-runtime.json');
const failedRuntimePath = path.join(temporaryRoot, 'failed-runtime.json');
const pluginRoot = path.join(temporaryRoot, 'plugins');
const manifestPath = path.join(pluginRoot, 'marine', 'manifest.json');
const child = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    MARINE_EXTENSION_DEV_PORT: '0',
    MARINE_DEV_RUNTIME_PATH: runtimePath,
    RIMEBUFFER_PLUGIN_ROOT: pluginRoot,
    MARINE_DEV_DRAFT: '固定测试草稿',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let errors = '';
let earlyChild = null;
let failedChild = null;
child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { errors += chunk.toString('utf8'); });

async function waitForReady() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const line = output.split(/\r?\n/).find(item => item.startsWith('MARINE_DEV_BRIDGE_READY '));
    if (line) return JSON.parse(line.slice('MARINE_DEV_BRIDGE_READY '.length));
    if (child.exitCode != null) throw new Error(`bridge exited early: ${errors || output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`bridge did not become ready: ${errors || output}`);
}

try {
  const ready = await waitForReady();
  const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(ready.manifestPath, manifestPath);
  assert.equal(manifest.id, 'marine');
  assert.equal(runtime.pluginId, 'marine');
  assert.equal(runtime.instanceId.length > 0, true);
  assert.equal(runtime.token, ready.token);
  assert.equal((await fs.stat(runtimePath)).mode & 0o777, 0o600);
  const headers = {
    Authorization: `Bearer ${ready.token}`,
    'Content-Type': 'application/json',
  };
  const unauthorized = await fetch(`${ready.apiBase}/rime/status`);
  assert.equal(unauthorized.status, 401);

  const baseNow = Date.now();
  const context = {
    contextId: 'ctx-dev-1',
    mode: 'reply',
    actionId: 'marine.generate-reply',
    label: '回复 @Alice',
    targetSummary: 'Alice：原评论',
    platform: 'bilibili',
    url: 'https://www.bilibili.com/video/BVDEV',
    title: 'fixture',
    target: { id: '42', authorName: 'Alice', text: '原评论' },
    payload: {},
    updatedAt: baseNow + 1,
  };
  const secondsContext = {
    ...context,
    contextId: 'ctx-dev-seconds',
    updatedAt: Math.floor(baseNow / 1000),
  };
  const secondsPut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(secondsContext),
  });
  assert.equal(secondsPut.status, 200);
  assert.equal((await secondsPut.json()).contextId, secondsContext.contextId);
  await fetch(`${ready.apiBase}/rime/context?contextId=${secondsContext.contextId}`, {
    method: 'DELETE', headers,
  });

  const put = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(context),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).contextId, context.contextId);

  const sameTimestampLateContext = {
    ...context,
    contextId: 'ctx-dev-delayed',
  };
  const delayedPut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(sameTimestampLateContext),
  });
  assert.equal(delayedPut.status, 200);
  assert.equal((await delayedPut.json()).contextId, context.contextId);
  const resurrectSameTimestampLease = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...sameTimestampLateContext,
      updatedAt: context.updatedAt + 10,
    }),
  });
  assert.equal(resurrectSameTimestampLease.status, 409);

  const olderLateContext = {
    ...context,
    contextId: 'ctx-dev-older-delayed',
    updatedAt: context.updatedAt - 1,
  };
  const olderDelayedPut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(olderLateContext),
  });
  assert.equal(olderDelayedPut.status, 200);
  assert.equal((await olderDelayedPut.json()).contextId, context.contextId);
  const resurrectOlderLease = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...olderLateContext,
      updatedAt: context.updatedAt + 20,
    }),
  });
  assert.equal(resurrectOlderLease.status, 409);

  const status = await fetch(`${ready.apiBase}/rime/status`, { headers });
  assert.equal((await status.json()).actionId, context.actionId);
  const wrongPlugin = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: 'other-plugin',
      runtimeInstanceId: runtime.instanceId,
      requestId: 'request-1',
      actionId: context.actionId,
      contextId: context.contextId,
    }),
  });
  assert.equal(wrongPlugin.status, 400);
  const wrongRuntime = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: runtime.pluginId,
      runtimeInstanceId: 'wrong-runtime-instance',
      requestId: 'request-wrong-runtime',
      actionId: context.actionId,
      contextId: context.contextId,
    }),
  });
  assert.equal(wrongRuntime.status, 400);
  const mismatchedTarget = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: runtime.pluginId,
      runtimeInstanceId: runtime.instanceId,
      requestId: 'request-mismatched-target',
      actionId: context.actionId,
      contextId: 'ctx-dev-not-active',
    }),
  });
  assert.equal(mismatchedTarget.status, 409);

  const prepare = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: runtime.pluginId,
      runtimeInstanceId: runtime.instanceId,
      requestId: 'request-1',
      actionId: context.actionId,
      contextId: context.contextId,
    }),
  });
  assert.equal(prepare.status, 200);
  const result = await prepare.json();
  assert.deepEqual({
    protocolVersion: result.protocolVersion,
    resultFormat: result.resultFormat,
    pluginId: result.pluginId,
    runtimeInstanceId: result.runtimeInstanceId,
    requestId: result.requestId,
    actionId: result.actionId,
    contextId: result.contextId,
  }, {
    protocolVersion: 1,
    resultFormat: 'blocks-v1',
    pluginId: runtime.pluginId,
    runtimeInstanceId: runtime.instanceId,
    requestId: 'request-1',
    actionId: context.actionId,
    contextId: context.contextId,
  });
  assert.match(result.prompt, /固定测试草稿/);
  assert.match(result.prompt, /"blocks"/);

  const legacyInvoke = await fetch(`${ready.apiBase}/rime/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId: 'legacy-request',
      actionId: context.actionId,
      contextId: context.contextId,
    }),
  });
  assert.equal(legacyInvoke.status, 410);

  const directContext = {
    ...context,
    contextId: 'ctx-dev-direct',
    mode: 'direct',
    actionId: 'marine.generate-direct',
    label: '生成直评',
    targetSummary: '当前作品',
    target: null,
    updatedAt: context.updatedAt + 1,
  };
  const directPut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(directContext),
  });
  assert.equal(directPut.status, 200);
  const directPrepare = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: runtime.pluginId,
      runtimeInstanceId: runtime.instanceId,
      requestId: 'request-direct',
      actionId: directContext.actionId,
      contextId: directContext.contextId,
    }),
  });
  assert.equal(directPrepare.status, 200);
  assert.equal((await directPrepare.json()).actionId, directContext.actionId);

  const largeContext = {
    ...directContext,
    contextId: 'ctx-dev-large',
    payload: { subtitle: { text: 'x'.repeat(300_000) } },
    updatedAt: context.updatedAt + 2,
  };
  const largePut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(largeContext),
  });
  assert.equal(largePut.status, 200);
  const largePrepare = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: runtime.pluginId,
      runtimeInstanceId: runtime.instanceId,
      requestId: 'request-large',
      actionId: largeContext.actionId,
      contextId: largeContext.contextId,
    }),
  });
  assert.equal(largePrepare.status, 200);
  const largeResult = await largePrepare.json();
  assert.equal(Buffer.byteLength(largeResult.prompt, 'utf8') <= 256 * 1024, true);
  assert.match(largeResult.prompt, /页面数据已按 Rime 256 KiB 提示词上限截断/);

  const newerContext = {
    ...context,
    contextId: 'ctx-dev-newer',
    updatedAt: context.updatedAt + 3,
  };
  const newerPut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(newerContext),
  });
  assert.equal(newerPut.status, 200);
  assert.equal((await newerPut.json()).contextId, newerContext.contextId);
  await fetch(`${ready.apiBase}/rime/context?contextId=${newerContext.contextId}`, {
    method: 'DELETE', headers,
  });
  const noFallback = await fetch(`${ready.apiBase}/rime/status`, { headers });
  assert.equal((await noFallback.json()).available, false);
  const prepareAfterDelete = await fetch(`${ready.apiBase}/rime/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pluginId: runtime.pluginId,
      runtimeInstanceId: runtime.instanceId,
      requestId: 'request-after-delete',
      actionId: newerContext.actionId,
      contextId: newerContext.contextId,
    }),
  });
  assert.equal(prepareAfterDelete.status, 404);

  await fetch(`${ready.apiBase}/rime/context?contextId=some-other-context`, {
    method: 'DELETE', headers,
  });
  const stillActive = await fetch(`${ready.apiBase}/rime/status`, { headers });
  assert.equal((await stillActive.json()).available, false);
  await fetch(`${ready.apiBase}/rime/context?contextId=${context.contextId}`, {
    method: 'DELETE', headers,
  });
  await fetch(`${ready.apiBase}/rime/context?contextId=${sameTimestampLateContext.contextId}`, {
    method: 'DELETE', headers,
  });
  const cleared = await fetch(`${ready.apiBase}/rime/status`, { headers });
  assert.equal((await cleared.json()).available, false);
  const revokedPut = await fetch(`${ready.apiBase}/rime/context`, {
    method: 'PUT', headers, body: JSON.stringify(context),
  });
  assert.equal(revokedPut.status, 409);
  const stillCleared = await fetch(`${ready.apiBase}/rime/status`, { headers });
  assert.equal((await stillCleared.json()).available, false);

  const replacement = { ...runtime, instanceId: 'newer-bridge', processId: 999_999 };
  await fs.writeFile(runtimePath, JSON.stringify(replacement), { mode: 0o600 });
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  assert.deepEqual(JSON.parse(await fs.readFile(runtimePath, 'utf8')), replacement);
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).id, 'marine');
  await fs.unlink(runtimePath);

  let earlyOutput = '';
  let earlyErrors = '';
  earlyChild = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      MARINE_EXTENSION_DEV_PORT: '0',
      MARINE_DEV_RUNTIME_PATH: earlyRuntimePath,
      RIMEBUFFER_PLUGIN_ROOT: pluginRoot,
      MARINE_DEV_TEST_RUNTIME_WRITE_DELAY_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  earlyChild.stdout.on('data', chunk => { earlyOutput += chunk.toString('utf8'); });
  earlyChild.stderr.on('data', chunk => { earlyErrors += chunk.toString('utf8'); });

  const temporaryPrefix = `${path.basename(earlyRuntimePath)}.`;
  const temporaryDeadline = Date.now() + 5000;
  while (true) {
    const entries = await fs.readdir(temporaryRoot);
    if (entries.some(entry => entry.startsWith(temporaryPrefix) && entry.endsWith('.tmp'))) break;
    if (earlyChild.exitCode != null) {
      throw new Error(`early bridge exited before runtime write: ${earlyErrors || earlyOutput}`);
    }
    if (Date.now() >= temporaryDeadline) {
      throw new Error(`early bridge did not begin runtime write: ${earlyErrors || earlyOutput}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  earlyChild.kill('SIGTERM');
  const [earlyExitCode, earlySignal] = await new Promise(resolve => {
    earlyChild.once('exit', (code, signal) => resolve([code, signal]));
  });
  assert.equal(earlyExitCode, 0);
  assert.equal(earlySignal, null);
  await assert.rejects(fs.access(earlyRuntimePath));
  const earlyArtifacts = (await fs.readdir(temporaryRoot))
    .filter(entry => entry.startsWith(path.basename(earlyRuntimePath)));
  assert.deepEqual(earlyArtifacts, []);
  assert.equal(earlyOutput.includes('MARINE_DEV_BRIDGE_READY '), false);

  let failedOutput = '';
  let failedErrors = '';
  failedChild = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      MARINE_EXTENSION_DEV_PORT: '0',
      MARINE_DEV_RUNTIME_PATH: failedRuntimePath,
      RIMEBUFFER_PLUGIN_ROOT: pluginRoot,
      MARINE_DEV_TEST_RUNTIME_WRITE_FAILURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  failedChild.stdout.on('data', chunk => { failedOutput += chunk.toString('utf8'); });
  failedChild.stderr.on('data', chunk => { failedErrors += chunk.toString('utf8'); });
  const failedExitCode = await new Promise(resolve => failedChild.once('exit', resolve));
  assert.equal(failedExitCode, 1, failedErrors || failedOutput);
  await assert.rejects(fs.access(failedRuntimePath));
  const failedArtifacts = (await fs.readdir(temporaryRoot))
    .filter(entry => entry.startsWith(path.basename(failedRuntimePath)));
  assert.deepEqual(failedArtifacts, []);
  assert.equal(failedOutput.includes('MARINE_DEV_BRIDGE_READY '), false);
  console.log('Marine extension local bridge smoke: OK');
} finally {
  if (failedChild && failedChild.exitCode == null) {
    failedChild.kill('SIGTERM');
    await new Promise(resolve => failedChild.once('exit', resolve));
  }
  if (earlyChild && earlyChild.exitCode == null) {
    earlyChild.kill('SIGTERM');
    await new Promise(resolve => earlyChild.once('exit', resolve));
  }
  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await assert.rejects(fs.access(runtimePath));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
