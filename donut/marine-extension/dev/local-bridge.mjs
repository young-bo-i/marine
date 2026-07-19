import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const host = '127.0.0.1';
const requestedPort = Number(process.env.MARINE_EXTENSION_DEV_PORT || 47711);
const runtimePath = process.env.MARINE_DEV_RUNTIME_PATH
  || path.join(os.homedir(), 'Library/Application Support/MarineDev/etinput-runtime.json');
const token = crypto.randomBytes(32).toString('base64url');
const instanceId = crypto.randomUUID();
const contexts = new Map();
const revokedContexts = new Map();
let activeContextId = null;
let highWatermarkMillis = 0;
let shuttingDown = false;
let runtimeWritePromise = null;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function timestampMillis(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Number.NaN;
  return timestamp >= 100_000_000_000 ? timestamp : timestamp * 1000;
}

function isFresh(updatedAt) {
  const timestamp = timestampMillis(updatedAt);
  return Number.isFinite(timestamp)
    && timestamp <= Date.now() + 60_000
    && Date.now() - timestamp <= 5 * 60_000;
}

function pruneRevokedContexts() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [contextId, revokedAt] of revokedContexts) {
    if (revokedAt < cutoff) revokedContexts.delete(contextId);
  }
  while (revokedContexts.size > 4096) {
    const oldest = revokedContexts.keys().next().value;
    revokedContexts.delete(oldest);
  }
}

function activeContext() {
  pruneRevokedContexts();
  if (!activeContextId) return null;
  const item = contexts.get(activeContextId);
  if (!item || !isFresh(Number(item.updatedAt))) {
    contexts.delete(activeContextId);
    activeContextId = null;
    return null;
  }
  return item;
}

function statusFor(context = activeContext()) {
  if (!context) {
    return {
      available: false,
      actionId: '',
      updatedAt: Date.now(),
    };
  }
  return {
    available: true,
    contextId: context.contextId,
    mode: context.mode,
    actionId: context.actionId,
    label: context.label,
    targetSummary: context.targetSummary,
    updatedAt: context.updatedAt,
  };
}

function json(response, status, value) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 2_000_000) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validateContext(context) {
  if (!context || typeof context !== 'object') return 'context must be an object';
  if (!String(context.contextId || '').trim()) return 'contextId is required';
  if (!['direct', 'reply'].includes(context.mode)) return 'invalid mode';
  const expectedAction = context.mode === 'reply'
    ? 'marine.generate-reply'
    : 'marine.generate-direct';
  if (context.actionId !== expectedAction) return 'actionId does not match mode';
  if (context.mode === 'reply' && !String(context.target?.id || '').trim()) {
    return 'reply context must identify a comment';
  }
  if (!isFresh(Number(context.updatedAt))) return 'context is stale';
  return null;
}

function draftFor(context) {
  if (process.env.MARINE_DEV_DRAFT?.trim()) return process.env.MARINE_DEV_DRAFT.trim();
  if (context.mode === 'reply') {
    const author = String(context.target?.authorName || '').trim();
    return `Chrome 独立调试回复${author ? ` @${author}` : ''}：已收到当前评论上下文。`;
  }
  return 'Chrome 独立调试直评：已收到当前作品上下文。';
}

async function pauseRuntimeWriteForSmokeTest() {
  const delayMillis = Number(process.env.MARINE_DEV_TEST_RUNTIME_WRITE_DELAY_MS || 0);
  if (Number.isFinite(delayMillis) && delayMillis > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMillis));
  }
}

function failRuntimeWriteForSmokeTest() {
  if (process.env.MARINE_DEV_TEST_RUNTIME_WRITE_FAILURE === '1') {
    throw new Error('injected runtime write failure');
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    });
    response.end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(request.url || '/', `http://${host}`);
  try {
    if (request.method === 'GET' && url.pathname === '/v1/marine/rime/status') {
      json(response, 200, statusFor());
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/v1/marine/rime/context') {
      const context = await readJson(request);
      const error = validateContext(context);
      if (error) {
        json(response, 400, { error });
        return;
      }
      pruneRevokedContexts();
      if (revokedContexts.has(context.contextId)) {
        json(response, 409, { error: 'browser target was already revoked' });
        return;
      }
      const updatedAtMillis = timestampMillis(context.updatedAt);
      const current = activeContext();
      if (activeContextId === context.contextId) {
        if (!current || updatedAtMillis > timestampMillis(current.updatedAt)) {
          contexts.set(context.contextId, context);
          highWatermarkMillis = Math.max(highWatermarkMillis, updatedAtMillis);
        }
      } else if (updatedAtMillis > highWatermarkMillis) {
        if (activeContextId) revokedContexts.set(activeContextId, Date.now());
        contexts.clear();
        contexts.set(context.contextId, context);
        activeContextId = context.contextId;
        highWatermarkMillis = updatedAtMillis;
      } else {
        contexts.delete(context.contextId);
        revokedContexts.set(context.contextId, Date.now());
        pruneRevokedContexts();
      }
      json(response, 200, statusFor());
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/v1/marine/rime/context') {
      const contextId = url.searchParams.get('contextId');
      if (contextId) {
        contexts.delete(contextId);
        revokedContexts.set(contextId, Date.now());
        if (activeContextId === contextId) activeContextId = null;
      } else {
        for (const existingId of contexts.keys()) revokedContexts.set(existingId, Date.now());
        contexts.clear();
        activeContextId = null;
      }
      pruneRevokedContexts();
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/marine/rime/invoke') {
      const payload = await readJson(request);
      const context = activeContext();
      if (!context) {
        json(response, 404, { error: 'no active browser target' });
        return;
      }
      if (payload.contextId !== context.contextId || payload.actionId !== context.actionId) {
        json(response, 409, { error: 'browser target changed' });
        return;
      }
      json(response, 200, {
        requestId: payload.requestId,
        actionId: payload.actionId,
        contextId: payload.contextId,
        blocks: [{ text: draftFor(context), title: context.targetSummary || context.label }],
        targetSummary: context.targetSummary,
      });
      return;
    }
    json(response, 404, { error: 'not found' });
  } catch (error) {
    json(response, String(error?.message).includes('large') ? 413 : 400, {
      error: String(error?.message || error),
    });
  }
});

async function writeRuntime(port) {
  const value = {
    apiBase: `http://${host}:${port}/v1/marine`,
    token,
    updatedAt: nowSeconds(),
    instanceId,
    processId: process.pid,
  };
  const temporary = `${runtimePath}.${instanceId}.tmp`;
  try {
    await fs.mkdir(path.dirname(runtimePath), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await pauseRuntimeWriteForSmokeTest();
    failRuntimeWriteForSmokeTest();
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, runtimePath);
    await fs.chmod(runtimePath, 0o600);
    return value;
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        console.error(`Marine dev bridge temporary cleanup: ${cleanupError.message}`);
      }
    }
    throw error;
  }
}

async function removeOwnedRuntime() {
  const claimedPath = `${runtimePath}.cleanup-${process.pid}-${instanceId}`;
  try {
    await fs.rename(runtimePath, claimedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`Marine dev bridge cleanup claim: ${error.message}`);
    return;
  }

  let owned = false;
  try {
    const current = JSON.parse(await fs.readFile(claimedPath, 'utf8'));
    owned = current.instanceId === instanceId && current.processId === process.pid;
  } catch (error) {
    console.error(`Marine dev bridge cleanup inspect: ${error.message}`);
  }

  if (!owned) {
    try {
      await fs.link(claimedPath, runtimePath);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        console.error(`Marine dev bridge cleanup restore: ${error.message}`);
        return;
      }
    }
  }
  try {
    await fs.unlink(claimedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`Marine dev bridge cleanup remove: ${error.message}`);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try {
    await runtimeWritePromise;
  } catch {
    // Startup reports write failures; cleanup still needs to run.
  }
  await removeOwnedRuntime();
  if (signal) process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

server.listen(requestedPort, host, async () => {
  if (shuttingDown) return;
  const address = server.address();
  runtimeWritePromise = writeRuntime(address.port);
  try {
    const runtime = await runtimeWritePromise;
    if (shuttingDown) return;
    const extensionConfig = {
      apiBase: runtime.apiBase,
      token,
    };
    console.log(`MARINE_DEV_BRIDGE_READY ${JSON.stringify({ ...extensionConfig, runtimePath })}`);
    console.log('把上面的 apiBase/token 填入 Marine 扩展侧栏的手动配置，然后重载扩展页面。');
    console.log('这是本地固定草稿桥，不会输入或发布；Ctrl-C 会删除本次 Rime runtime 文件。');
  } catch (error) {
    if (!shuttingDown) {
      console.error(`Marine dev bridge runtime write failed: ${error.message}`);
      server.close();
      await removeOwnedRuntime();
      process.exitCode = 1;
    }
  }
});

server.on('error', async (error) => {
  console.error(`Marine dev bridge failed: ${error.message}`);
  await removeOwnedRuntime();
  process.exitCode = 1;
});
