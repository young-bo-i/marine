// sw.js — 侧边栏与 Marine 本地 API 桥接
importScripts('scholay-skill.js');
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  marineEnsurePublishedReceiptAlarm();
  void marineRetryPublishedOutbox('installed');
  void marineEnsurePublishedCaptureForExistingTabs('installed');
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let marineConfigCache = null;
let marineSkillCache = null;
let marineOperationQueue = Promise.resolve();
// `undefined` means the MV3 worker has not observed Chrome focus yet. `null`
// means Chrome explicitly reported WINDOW_ID_NONE. Only the former may be
// initialized from the first active-tab content message.
let marineActiveTabId;
let marineFocusedWindowId;
let marineFocusEpoch = 0;
const marineTabContexts = new Map();
const marineTabEpochs = new Map();
const marineLatestRevisions = new Map();
const marineTabSources = new Map();
const marineRetiredSources = new Map();
const marineDeferredPuts = new Map();
const marineSessionStateKey = 'marineRimeLeaseStateV1';
const marineRimeMaxRequestBytes = 1_850_000;
const marineRimeMaxSkillBytes = 200_000;
const marineDeferredPutTtlMs = 5000;
const marineDeferredPutLimit = 8;
const marinePublishedReceiptTtlMs = 10 * 60 * 1000;
const marinePublishedOutboxTtlMs = 30 * 24 * 60 * 60 * 1000;
const marinePublishedOutboxMaxItems = 200;
const marinePublishedOutboxMaxBytes = 4_000_000;
const marinePublishedRetryBatch = 10;
const marinePublishedOutboxStorageKey = 'marinePublishedReceiptOutboxV1';
const marinePublishedRetryAlarm = 'marinePublishedReceiptRetryV1';
const marinePublishedReceiptRecent = new Map();
let marinePublishedOutboxQueue = Promise.resolve();
const marinePublishedBootstrapInFlight = new Map();
const marinePublishedMainInjectionQueues = new Map();
let marinePersistTimer = null;
const marineStateReady = marineRestoreState();

async function marineRestoreState() {
  const session = chrome.storage && chrome.storage.session;
  if (!session) return;
  try {
    const stored = await session.get(marineSessionStateKey);
    const state = stored && stored[marineSessionStateKey];
    if (!state || !state.tabs) return;
    if (state.activeTabKnown === true) {
      marineActiveTabId = Number.isInteger(state.activeTabId) ? state.activeTabId : null;
    } else if (Number.isInteger(state.activeTabId)) {
      // Backward compatibility with lease state written before activeTabKnown.
      marineActiveTabId = state.activeTabId;
    }
    for (const [rawTabId, item] of Object.entries(state.tabs)) {
      const tabId = Number(rawTabId);
      if (!Number.isInteger(tabId) || !item) continue;
      if (item.contextId) marineTabContexts.set(tabId, {
        contextId: String(item.contextId),
        revision: Number(item.revision) || 0,
        sourceId: String(item.sourceId || ''),
      });
      if (item.sourceId) marineTabSources.set(tabId, String(item.sourceId));
      if (Number(item.revision) > 0) marineLatestRevisions.set(tabId, Number(item.revision));
    }
  } catch (e) {}
}

function marinePersistState() {
  const session = chrome.storage && chrome.storage.session;
  if (!session) return;
  if (marinePersistTimer) clearTimeout(marinePersistTimer);
  marinePersistTimer = setTimeout(() => {
    marinePersistTimer = null;
    const tabs = {};
    const tabIds = new Set([...marineTabContexts.keys(), ...marineTabSources.keys()]);
    for (const tabId of tabIds) {
      const tracked = marineTabContexts.get(tabId) || {};
      tabs[String(tabId)] = {
        contextId: tracked.contextId || '',
        revision: marineLatestRevisions.get(tabId) || tracked.revision || 0,
        sourceId: marineTabSources.get(tabId) || tracked.sourceId || '',
      };
    }
    void session.set({
      [marineSessionStateKey]: {
        activeTabKnown: marineActiveTabId !== undefined,
        activeTabId: Number.isInteger(marineActiveTabId) ? marineActiveTabId : null,
        tabs,
      },
    }).catch(() => {});
  }, 20);
}

function marineTabEpoch(tabId) {
  return marineTabEpochs.get(tabId) || 0;
}

function marineInvalidateTab(tabId) {
  const next = marineTabEpoch(tabId) + 1;
  marineTabEpochs.set(tabId, next);
  return next;
}

function marineDropDeferredPut(tabId) {
  const deferred = marineDeferredPuts.get(tabId);
  if (!deferred) return null;
  clearTimeout(deferred.timeout);
  marineDeferredPuts.delete(tabId);
  return deferred;
}

function marineDeferPut(msg, sender, expectedEpoch, expectedSource) {
  const tab = sender.tab;
  const tabId = tab && tab.id;
  if (tabId == null || tab.active !== true || !Number.isInteger(tab.windowId)) return false;

  marineDropDeferredPut(tabId);
  while (marineDeferredPuts.size >= marineDeferredPutLimit) {
    marineDropDeferredPut(marineDeferredPuts.keys().next().value);
  }
  const deferred = {
    msg,
    sender,
    expectedEpoch,
    expectedSource,
    expiresAt: Date.now() + marineDeferredPutTtlMs,
    timeout: null,
  };
  deferred.timeout = setTimeout(() => {
    if (marineDeferredPuts.get(tabId) === deferred) marineDeferredPuts.delete(tabId);
  }, marineDeferredPutTtlMs);
  marineDeferredPuts.set(tabId, deferred);
  return true;
}

function marineReplayDeferredPut(tabId) {
  const deferred = marineDropDeferredPut(tabId);
  if (!deferred || deferred.expiresAt < Date.now()) return;
  void marineQueueOperation(() => marineApplyContextMessage(
    deferred.msg,
    deferred.sender,
    deferred.expectedEpoch,
    deferred.expectedSource,
    { allowDefer: false },
  )).catch(() => {});
}

function marineSourceId(msg, sender, tabId) {
  return String(msg.sourceId || sender.documentId || ('legacy-tab-' + tabId));
}

function marinePrepareSource(tabId, sourceId) {
  const retired = marineRetiredSources.get(tabId) || new Set();
  if (retired.has(sourceId)) return { accepted: false, oldContext: null };
  const current = marineTabSources.get(tabId);
  if (current === sourceId) return { accepted: true, oldContext: null };
  if (current) {
    retired.add(current);
    while (retired.size > 16) retired.delete(retired.values().next().value);
    marineRetiredSources.set(tabId, retired);
  }
  marineDropDeferredPut(tabId);
  const oldContext = marineTabContexts.get(tabId) || null;
  marineTabContexts.delete(tabId);
  marineTabSources.set(tabId, sourceId);
  marineLatestRevisions.delete(tabId);
  marineInvalidateTab(tabId);
  marinePersistState();
  return { accepted: true, oldContext };
}

async function marineReadJson(rel) {
  try {
    const response = await fetch(chrome.runtime.getURL(rel), { cache: 'no-store' });
    return response.ok ? await response.json() : {};
  } catch (e) { return {}; }
}

async function marineResolveConfig() {
  if (marineConfigCache && Date.now() - marineConfigCache.at < 3000) return marineConfigCache.value;
  const runtime = await marineReadJson('marine-runtime-config.json');
  let manual = {};
  try {
    const stored = await chrome.storage.local.get('marineManualConfig');
    manual = stored.marineManualConfig || {};
  } catch (e) {}
  const nonEmpty = value => value != null && String(value).trim() !== '';
  const pick = key => nonEmpty(runtime[key]) ? String(runtime[key]).trim() : String(manual[key] || '').trim();
  const value = {
    apiBase: pick('apiBase').replace(/\/+$/, ''),
    token: pick('token'),
    profileId: pick('profileId'),
  };
  marineConfigCache = { at: Date.now(), value };
  return value;
}

async function marineFetchText(rel) {
  try {
    const response = await fetch(chrome.runtime.getURL(rel));
    return response.ok ? await response.text() : '';
  } catch (e) { return ''; }
}

async function marineLoadSkill(context) {
  if (!marineSkillCache) {
    const base = 'skills/scholay/';
    const [brand, execution, style, mother, index] = await Promise.all([
      marineFetchText(base + '品牌.md'),
      marineFetchText(base + '执行口径.md'),
      marineFetchText(base + '风格参数.json'),
      marineFetchText(base + '母稿.md'),
      marineFetchText(base + '母稿索引.json'),
    ]);
    marineSkillCache = { brand, execution, style, mother, index, customSample: '' };
    try {
      const stored = await chrome.storage.local.get(['marineCustomSampleMd', 'marineCustomSampleName']);
      if (stored.marineCustomSampleMd && stored.marineCustomSampleMd.trim()) {
        marineSkillCache.customSample = [
          '## ' + (stored.marineCustomSampleName || 'custom.md'),
          '',
          stored.marineCustomSampleMd.trim(),
        ].join('\n');
      }
    } catch (e) {}
  }
  return marineScholayBuildSkill(marineSkillCache, context, marineSkillCache.customSample);
}

function marineUtf8Bytes(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

function marineTruncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (marineUtf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (marineUtf8Bytes(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

async function marineContextFetch(method, contextId, context, shouldProceed) {
  const config = await marineResolveConfig();
  if (!config.apiBase || !config.token) throw new Error('未配置 Marine 本地 API');
  const query = method === 'DELETE' && contextId ? '?contextId=' + encodeURIComponent(contextId) : '';
  const endpoint = config.apiBase + '/rime/context' + query;
  const options = {
    method,
    headers: { Authorization: 'Bearer ' + config.token },
  };
  if (method === 'PUT') {
    const skill = marineTruncateUtf8(await marineLoadSkill(context), marineRimeMaxSkillBytes);
    if (shouldProceed && !shouldProceed()) return false;
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(Object.assign({}, context, { skill }));
    if (marineUtf8Bytes(options.body) > marineRimeMaxRequestBytes) {
      throw new Error('Marine context 超过本地 API 安全传输上限');
    }
  }
  if (shouldProceed && !shouldProceed()) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  options.signal = controller.signal;
  try {
    const response = await fetch(endpoint, options);
    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch (e) {}
      throw new Error('HTTP ' + response.status + (detail ? ' · ' + detail.slice(0, 200) : ''));
    }
    return true;
  } finally { clearTimeout(timeout); }
}

function marinePublishedPositiveId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : '';
}

function marinePublishedString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value : '';
}

function marineIsBilibiliUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      /(^|\.)bilibili\.com$/i.test(parsed.hostname);
  }
  catch (e) { return false; }
}

function marineTrustedPublishedBridgeSender(sender) {
  return !!sender && !!sender.tab && Number.isInteger(sender.tab.id) &&
    (sender.frameId == null || Number.isInteger(sender.frameId)) &&
    marineIsBilibiliUrl(sender.url || sender.tab.url);
}

function marinePublishedHandshakeNonce(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : '';
}

function marinePublishedInjectionTarget(sender) {
  const target = { tabId: sender.tab.id };
  if (typeof sender.documentId === 'string' && sender.documentId) {
    target.documentIds = [sender.documentId];
  } else {
    target.frameIds = [Number.isInteger(sender.frameId) ? sender.frameId : 0];
  }
  return target;
}

async function marineInjectPublishedMain(sender, rawNonce) {
  if (!marineTrustedPublishedBridgeSender(sender)) throw new Error('无效的 Bilibili 发布桥来源');
  const nonce = marinePublishedHandshakeNonce(rawNonce);
  if (!nonce) throw new Error('无效的 Marine 发布桥握手');
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    throw new Error('当前 Chromium 不支持 Marine 发布桥注入');
  }
  const target = marinePublishedInjectionTarget(sender);
  await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    files: ['src/content-main.js'],
  });
  const results = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: function (handshakeNonce) {
      const state = window.__marinePublishedMainStateV1;
      return !!state && typeof state.ensurePort === 'function' && state.ensurePort(handshakeNonce) === true;
    },
    args: [nonce],
  });
  if (!results || !results.some(result => result && result.result === true)) {
    throw new Error('Marine MAIN 发布桥未就绪');
  }
}

function marinePublishedDocumentKey(sender) {
  if (typeof sender.documentId === 'string' && sender.documentId) {
    return sender.tab.id + '|document|' + sender.documentId;
  }
  return sender.tab.id + '|frame|' + (Number.isInteger(sender.frameId) ? sender.frameId : 0);
}

function marineQueuePublishedMainInjection(sender, nonce) {
  const key = marinePublishedDocumentKey(sender);
  let state = marinePublishedMainInjectionQueues.get(key);
  if (!state) {
    state = { latestNonce: '', tail: Promise.resolve(), current: null };
    marinePublishedMainInjectionQueues.set(key, state);
  }
  state.latestNonce = nonce;
  const operation = state.tail.catch(() => {}).then(async () => {
    if (state.latestNonce !== nonce) return { ok: true, stale: true };
    await marineInjectPublishedMain(sender, nonce);
    return state.latestNonce === nonce
      ? { ok: true }
      : { ok: true, stale: true };
  });
  state.current = operation;
  state.tail = operation.catch(() => {});
  void operation.finally(() => {
    if (state.current === operation && state.latestNonce === nonce) {
      marinePublishedMainInjectionQueues.delete(key);
    }
  }).catch(() => {});
  return operation;
}

function marineEnsurePublishedCapture(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve(false);
  const current = marinePublishedBootstrapInFlight.get(tabId);
  if (current) return current;
  const operation = (async () => {
    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return false;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      files: ['src/publish-receipt.js', 'src/publish-bridge.js'],
    });
    return true;
  })().catch(() => false).finally(() => {
    if (marinePublishedBootstrapInFlight.get(tabId) === operation) {
      marinePublishedBootstrapInFlight.delete(tabId);
    }
  });
  marinePublishedBootstrapInFlight.set(tabId, operation);
  return operation;
}

async function marineEnsurePublishedCaptureForExistingTabs(reason) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({
      url: ['http://*.bilibili.com/*', 'https://*.bilibili.com/*'],
    });
  } catch (e) {
    return { reason, scanned: 0, injected: 0 };
  }
  let injected = 0;
  for (const tab of tabs || []) {
    if (!tab || !Number.isInteger(tab.id) || !marineIsBilibiliUrl(tab.url)) continue;
    if (await marineEnsurePublishedCapture(tab.id)) injected += 1;
  }
  return { reason, scanned: (tabs || []).length, injected };
}

function marineSanitizePublishedReceipt(value) {
  if (!value || value.schema_version !== 1 || value.platform !== 'bilibili') return null;
  const platformCommentId = marinePublishedPositiveId(value.platform_comment_id);
  const rootId = marinePublishedPositiveId(value.root_id);
  const parentId = marinePublishedPositiveId(value.parent_id);
  const targetCommentId = parentId || rootId;
  const text = marinePublishedString(value.text_snapshot, 20_000);
  const targetUrl = marinePublishedString(value.target_url, 4096);
  const postedAt = Number(value.posted_at);
  if (!platformCommentId || value.event_id !== 'bilibili:' + platformCommentId ||
      !text.trim() || !targetUrl || !marineIsBilibiliUrl(targetUrl) ||
      !Number.isSafeInteger(postedAt) || postedAt <= 0) return null;

  return {
    schema_version: 1,
    event_id: value.event_id,
    platform: 'bilibili',
    target_url: targetUrl,
    page_title: typeof value.page_title === 'string' ? value.page_title.slice(0, 512) : '',
    kind: targetCommentId ? 'reply' : 'direct',
    text_snapshot: text,
    posted_at: postedAt,
    site_account_id: marinePublishedPositiveId(value.site_account_id) || null,
    site_account_name: marinePublishedString(value.site_account_name, 256).trim() || null,
    platform_comment_id: platformCommentId,
    target_comment_id: targetCommentId || null,
    target_author: marinePublishedString(value.target_author, 256).trim() || null,
    parent_id: parentId || null,
    root_id: rootId || null,
    context_id: marinePublishedString(value.context_id, 128) || null,
  };
}

function marineTrustedPublishedSender(sender) {
  if (!sender || !sender.tab || sender.tab.id == null || (sender.frameId != null && sender.frameId !== 0)) return false;
  return marineIsBilibiliUrl(sender.url || sender.tab.url);
}

function marinePublishedOutboxKey(profileId, eventId) {
  return profileId + '|' + eventId;
}

function marineQueuePublishedOutbox(task) {
  const result = marinePublishedOutboxQueue.catch(() => {}).then(task);
  marinePublishedOutboxQueue = result.catch(() => {});
  return result;
}

function marinePrunePublishedRecent(now) {
  for (const [key, recordedAt] of marinePublishedReceiptRecent) {
    if (now - recordedAt >= marinePublishedReceiptTtlMs) marinePublishedReceiptRecent.delete(key);
  }
}

async function marineLoadPublishedOutbox() {
  const stored = await chrome.storage.local.get(marinePublishedOutboxStorageKey);
  const raw = stored && stored[marinePublishedOutboxStorageKey];
  const values = raw && Array.isArray(raw.items) ? raw.items : [];
  const now = Date.now();
  const byKey = new Map();
  let dirty = !!raw && (raw.version !== 1 || !Array.isArray(raw.items));
  for (const value of values) {
    const profileId = marinePublishedString(value && value.profile_id, 128).trim();
    const receipt = marineSanitizePublishedReceipt(value && value.receipt);
    const createdAt = Number(value && value.created_at);
    const expectedKey = receipt && profileId
      ? marinePublishedOutboxKey(profileId, receipt.event_id)
      : '';
    if (!expectedKey || value.key !== expectedKey || !Number.isSafeInteger(createdAt) ||
        createdAt <= 0 || now - createdAt >= marinePublishedOutboxTtlMs) {
      dirty = true;
      continue;
    }
    const normalized = {
      key: expectedKey,
      profile_id: profileId,
      receipt,
      created_at: createdAt,
      attempts: Math.max(0, Math.min(1_000_000, Number(value.attempts) || 0)),
    };
    if (byKey.has(expectedKey)) dirty = true;
    byKey.set(expectedKey, normalized);
  }
  const items = Array.from(byKey.values()).sort((a, b) => a.created_at - b.created_at);
  if (items.length > marinePublishedOutboxMaxItems) {
    items.length = marinePublishedOutboxMaxItems;
    dirty = true;
  }
  return { state: { version: 1, items }, dirty };
}

async function marineSavePublishedOutbox(state) {
  if (!state.items.length) {
    await chrome.storage.local.remove(marinePublishedOutboxStorageKey);
    return;
  }
  const bytes = marineUtf8Bytes(JSON.stringify(state));
  if (bytes > marinePublishedOutboxMaxBytes) throw new Error('Marine 发布待同步队列超过本地存储上限');
  await chrome.storage.local.set({ [marinePublishedOutboxStorageKey]: state });
}

async function marineSyncPublishedEntry(entry, config) {
  if (!config.apiBase || !config.token) {
    const error = new Error('未配置 Marine 本地 API');
    error.pauseQueue = true;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(config.apiBase + '/history/published', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(Object.assign({}, entry.receipt, {
        profile_id: entry.profile_id,
        brand_id: 'scholay',
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch (e) {}
      const error = new Error('HTTP ' + response.status + (detail ? ' · ' + detail.slice(0, 200) : ''));
      error.pauseQueue = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
      throw error;
    }
  } catch (caught) {
    const error = caught && typeof caught === 'object' ? caught : new Error(String(caught));
    if (error.pauseQueue == null) error.pauseQueue = true;
    throw error;
  } finally { clearTimeout(timeout); }
}

async function marineAcceptPublishedReceipt(receipt, sender) {
  if (!marineTrustedPublishedSender(sender)) throw new Error('无效的 Bilibili 发布回执来源');
  const sanitized = marineSanitizePublishedReceipt(receipt);
  if (!sanitized) throw new Error('无效的 Bilibili 发布回执');
  const config = await marineResolveConfig();
  const profileId = marinePublishedString(config.profileId, 128).trim();
  if (!profileId) throw new Error('未选择 Marine 发布身份');

  return marineQueuePublishedOutbox(async () => {
    const now = Date.now();
    marinePrunePublishedRecent(now);
    const key = marinePublishedOutboxKey(profileId, sanitized.event_id);
    if (marinePublishedReceiptRecent.has(key)) return { ok: true, queued: false, synced: true };

    const loaded = await marineLoadPublishedOutbox();
    const state = loaded.state;
    let entry = state.items.find(item => item.key === key);
    if (!entry) {
      if (state.items.length >= marinePublishedOutboxMaxItems) {
        throw new Error('Marine 发布待同步队列已满');
      }
      entry = {
        key,
        profile_id: profileId,
        receipt: sanitized,
        created_at: now,
        attempts: 0,
      };
      state.items.push(entry);
    }
    // Persistence is the acknowledgement boundary: never contact Marine until
    // this exact profile+event receipt is durable in chrome.storage.local.
    await marineSavePublishedOutbox(state);
    marineEnsurePublishedReceiptAlarm();

    try {
      await marineSyncPublishedEntry(entry, config);
      state.items = state.items.filter(item => item.key !== key);
      await marineSavePublishedOutbox(state);
      marinePublishedReceiptRecent.set(key, Date.now());
      return { ok: true, queued: false, synced: true };
    } catch (error) {
      entry.attempts += 1;
      await marineSavePublishedOutbox(state);
      console.warn('[Marine] 发布记录已进入待同步队列：' + String(error && error.message || error));
      return { ok: true, queued: true, synced: false };
    }
  });
}

function marineEnsurePublishedReceiptAlarm() {
  const alarms = chrome.alarms;
  if (!alarms || typeof alarms.create !== 'function') return;
  try {
    const result = alarms.create(marinePublishedRetryAlarm, { periodInMinutes: 1 });
    if (result && result.catch) void result.catch(() => {});
  } catch (e) {}
}

function marineRetryPublishedOutbox(reason) {
  return marineQueuePublishedOutbox(async () => {
    marinePrunePublishedRecent(Date.now());
    const loaded = await marineLoadPublishedOutbox();
    const state = loaded.state;
    if (!state.items.length) {
      if (loaded.dirty) await marineSavePublishedOutbox(state);
      return { synced: 0, pending: 0 };
    }
    const config = await marineResolveConfig();
    let synced = 0;
    let attempted = 0;
    let changed = loaded.dirty;
    for (const entry of state.items.slice()) {
      if (attempted >= marinePublishedRetryBatch) break;
      attempted++;
      try {
        await marineSyncPublishedEntry(entry, config);
        state.items = state.items.filter(item => item.key !== entry.key);
        marinePublishedReceiptRecent.set(entry.key, Date.now());
        synced++;
        changed = true;
      } catch (error) {
        entry.attempts += 1;
        changed = true;
        if (error && error.pauseQueue) break;
      }
    }
    if (changed) await marineSavePublishedOutbox(state);
    if (synced) console.info('[Marine] 已从待同步队列补写 ' + synced + ' 条发布记录（' + reason + '）');
    return { synced, pending: state.items.length };
  });
}

function marineQueueOperation(task) {
  const result = marineOperationQueue.catch(() => {}).then(task);
  marineOperationQueue = result.catch(() => {});
  return result;
}

function marineNextFocusEpoch() {
  marineFocusEpoch += 1;
  return marineFocusEpoch;
}

function marineFocusEpochIsCurrent(epoch, windowId) {
  return epoch === marineFocusEpoch
    && marineFocusedWindowId !== null
    && (marineFocusedWindowId === undefined || marineFocusedWindowId === windowId);
}

async function marineConfirmSenderFocus(sender) {
  const tab = sender.tab;
  const tabId = tab && tab.id;
  const windowId = tab && tab.windowId;
  if (tabId == null || tab.active !== true || !Number.isInteger(windowId)) return false;
  if (marineFocusedWindowId === null) return false;
  if (Number.isInteger(marineFocusedWindowId) && marineFocusedWindowId !== windowId) return false;

  const epoch = marineNextFocusEpoch();
  if (marineFocusedWindowId === undefined) {
    let window;
    try {
      window = await chrome.windows.get(windowId);
    } catch (e) {
      return false;
    }
    if (!window || window.focused !== true || !marineFocusEpochIsCurrent(epoch, windowId)) return false;
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, windowId });
  } catch (e) {
    return false;
  }
  if (!marineFocusEpochIsCurrent(epoch, windowId)
      || !tabs || !tabs[0] || tabs[0].id !== tabId) return false;

  marineFocusedWindowId = windowId;
  return marineSetActiveTab(tabId, () => marineFocusEpochIsCurrent(epoch, windowId));
}

async function marineApplyContextMessage(msg, sender, expectedEpoch, expectedSource, options = {}) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) throw new Error('缺少来源标签页');
  const revision = Number(msg.revision) || 0;

  if (msg.op === 'put') {
    if (!msg.context || !msg.contextId || msg.context.contextId !== msg.contextId) throw new Error('无效的 Marine context');
    if (revision && revision !== marineLatestRevisions.get(tabId)) return { ok: true, skipped: true };
    if (expectedEpoch !== marineTabEpoch(tabId)) return { ok: true, skipped: true };
    if (marineTabSources.get(tabId) !== expectedSource) return { ok: true, skipped: true };
    let senderFocusConfirmed = true;
    if (marineActiveTabId === undefined || marineFocusedWindowId === undefined) {
      senderFocusConfirmed = await marineConfirmSenderFocus(sender);
    }
    if (!senderFocusConfirmed || marineActiveTabId !== tabId) {
      const deferred = options.allowDefer !== false
        && marineDeferPut(msg, sender, expectedEpoch, expectedSource);
      return { ok: true, skipped: true, deferred };
    }
    const wrote = await marineContextFetch('PUT', msg.contextId, msg.context, () => (
      expectedEpoch === marineTabEpoch(tabId)
        && marineTabSources.get(tabId) === expectedSource
        && marineActiveTabId === tabId
        && (!revision || revision === marineLatestRevisions.get(tabId))
    ));
    if (!wrote) return { ok: true, skipped: true };
    // A tab switch/navigation/delete may happen while the localhost PUT is in
    // flight. Conditionally remove that just-written context instead of
    // letting an obsolete target come back after its clearing event.
    if (expectedEpoch !== marineTabEpoch(tabId)
        || marineTabSources.get(tabId) !== expectedSource
        || marineActiveTabId !== tabId
        || (revision && revision !== marineLatestRevisions.get(tabId))) {
      try { await marineContextFetch('DELETE', msg.contextId, null); } catch (e) {}
      return { ok: true, skipped: true };
    }
    marineTabContexts.set(tabId, { contextId: msg.contextId, revision, sourceId: expectedSource });
    marinePersistState();
    return { ok: true };
  }
  if (msg.op === 'delete') {
    marineDropDeferredPut(tabId);
    const contextId = msg.contextId || (marineTabContexts.get(tabId) || {}).contextId;
    if (!contextId) return { ok: true, skipped: true };
    await marineContextFetch('DELETE', contextId, null);
    const current = marineTabContexts.get(tabId);
    if (!current || current.contextId === contextId) marineTabContexts.delete(tabId);
    marinePersistState();
    return { ok: true };
  }
  throw new Error('未知的 Marine context 操作');
}

function marineClearTrackedTab(tabId, options = {}) {
  marineDropDeferredPut(tabId);
  marineInvalidateTab(tabId);
  marineLatestRevisions.delete(tabId);
  if (options.retireSource) {
    const source = marineTabSources.get(tabId);
    if (source) {
      const retired = marineRetiredSources.get(tabId) || new Set();
      retired.add(source);
      marineRetiredSources.set(tabId, retired);
    }
    marineTabSources.delete(tabId);
  }
  const tracked = marineTabContexts.get(tabId);
  marineTabContexts.delete(tabId);
  if (options.removed) marineRetiredSources.delete(tabId);
  marinePersistState();
  if (!tracked) return;
  void marineQueueOperation(async () => {
    try { await marineContextFetch('DELETE', tracked.contextId, null); } catch (e) {}
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.__marineGetTabId) {
    sendResponse({ tabId: sender.tab && sender.tab.id });
    return true;
  }
  if (msg && msg.__marinePublishedComment) {
    void marineAcceptPublishedReceipt(msg.receipt, sender)
      .then(sendResponse)
      .catch(error => {
        const detail = String(error && error.message || error);
        console.warn('[Marine] 发布成功回执记录失败：' + detail);
        sendResponse({ ok: false, error: detail });
      });
    return true;
  }
  if (msg && msg.__marinePublishedBridgeReady) {
    if (!marineTrustedPublishedBridgeSender(sender) || !marinePublishedHandshakeNonce(msg.nonce)) {
      sendResponse({ ok: false, error: '无效的 Bilibili 发布桥来源' });
      return true;
    }
    void marineQueuePublishedMainInjection(sender, msg.nonce)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  }
  if (msg && msg.__marineRimeContext) {
    void marineStateReady.then(() => {
      const tabId = sender.tab && sender.tab.id;
      const revision = Number(msg.revision) || 0;
      if (tabId == null) return { immediate: { ok: false, error: '缺少来源标签页' } };
      const sourceId = marineSourceId(msg, sender, tabId);
      const source = marinePrepareSource(tabId, sourceId);
      if (!source.accepted) return { immediate: { ok: true, skipped: true } };
      const latest = marineLatestRevisions.get(tabId) || 0;
      if (revision && revision < latest) return { immediate: { ok: true, skipped: true } };
      if (revision && revision > latest) {
        marineDropDeferredPut(tabId);
        marineLatestRevisions.set(tabId, revision);
        marineInvalidateTab(tabId);
        marinePersistState();
      }
      const expectedEpoch = marineTabEpoch(tabId);
      const operation = marineQueueOperation(async () => {
        if (source.oldContext) {
          try { await marineContextFetch('DELETE', source.oldContext.contextId, null); } catch (e) {}
        }
        return marineApplyContextMessage(msg, sender, expectedEpoch, sourceId);
      });
      return { operation };
    }).then(result => result.immediate || result.operation)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.marineManualConfig) {
    marineConfigCache = null;
    void marineRetryPublishedOutbox('config-change');
  }
  if (changes.marineCustomSampleMd || changes.marineCustomSampleName) marineSkillCache = null;
});

async function marineSetActiveTab(tabId, shouldApply = () => true) {
  await marineStateReady;
  if (!shouldApply()) return false;
  const previous = marineActiveTabId;
  marineActiveTabId = tabId;
  marinePersistState();
  if (previous != null && previous !== tabId) marineClearTrackedTab(previous);
  if (tabId != null) marineReplayDeferredPut(tabId);
  return true;
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return;
  if (marineFocusedWindowId === null) return;
  if (Number.isInteger(marineFocusedWindowId)) {
    if (marineFocusedWindowId !== windowId) return;
    const epoch = marineNextFocusEpoch();
    void marineSetActiveTab(tabId, () => marineFocusEpochIsCurrent(epoch, windowId));
    return;
  }

  const epoch = marineNextFocusEpoch();
  void chrome.windows.get(windowId).then(window => {
    if (!window || window.focused !== true || !marineFocusEpochIsCurrent(epoch, windowId)) return;
    marineFocusedWindowId = windowId;
    void marineSetActiveTab(tabId, () => marineFocusEpochIsCurrent(epoch, windowId));
  }).catch(() => {});
});
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(windowId => {
    const epoch = marineNextFocusEpoch();
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      marineFocusedWindowId = null;
      void marineSetActiveTab(null, () => epoch === marineFocusEpoch && marineFocusedWindowId === null);
      return;
    }
    marineFocusedWindowId = windowId;
    const activeTabQuery = chrome.tabs.query({ active: true, windowId }).catch(() => null);
    void marineSetActiveTab(
      null,
      () => marineFocusEpochIsCurrent(epoch, windowId),
    ).then(async cleared => {
      const tabs = await activeTabQuery;
      if (!cleared || !marineFocusEpochIsCurrent(epoch, windowId)) return;
      if (tabs === null) {
        // Treat a transient query failure as startup uncertainty again. The
        // next active content sender must re-prove both focused-window and
        // active-tab ownership instead of remaining deferred until another
        // Chrome focus event happens.
        marineFocusedWindowId = undefined;
        marineActiveTabId = undefined;
        marinePersistState();
        return;
      }
      await marineSetActiveTab(
        tabs && tabs[0] ? tabs[0].id : null,
        () => marineFocusEpochIsCurrent(epoch, windowId),
      );
    }).catch(() => {});
  });
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    void marineStateReady.then(() => marineClearTrackedTab(tabId, { retireSource: true }));
  } else if (changeInfo.url) {
    // pushState/replaceState keeps the same content-script document/source.
    void marineStateReady.then(() => marineClearTrackedTab(tabId));
  }
  if (changeInfo.status === 'complete' && tab && marineIsBilibiliUrl(tab.url)) {
    void marineEnsurePublishedCapture(tabId);
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  void marineStateReady.then(() => marineClearTrackedTab(tabId, { retireSource: true, removed: true }));
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    marineEnsurePublishedReceiptAlarm();
    void marineRetryPublishedOutbox('browser-startup');
    void marineEnsurePublishedCaptureForExistingTabs('browser-startup');
  });
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm && alarm.name === marinePublishedRetryAlarm) {
      void marineRetryPublishedOutbox('alarm');
    }
  });
}
marineEnsurePublishedReceiptAlarm();
void marineRetryPublishedOutbox('worker-start');
void marineEnsurePublishedCaptureForExistingTabs('worker-start');
