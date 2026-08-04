// sw.js — 侧边栏与 Marine 本地 API 桥接
importScripts('scholay-skill.js');
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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
let marineSuspendedRetainedTabId = null;
let marineFocusEpoch = 0;
const marineTabContexts = new Map();
const marineTabEpochs = new Map();
const marineLatestRevisions = new Map();
const marineTabSources = new Map();
const marineRetiredSources = new Map();
const marineDeferredPuts = new Map();
// 每 tab 近期「页内生成并填入」的草稿文本（来自 content-iso 的 __marineGenFill）。
// 稍后若该草稿被发布，发帖回执按文本匹配把账本 generation_source 标为 'extension'。
const marineGenFills = new Map(); // tabId -> { text, at }
const marineGenFillTtlMs = 10 * 60 * 1000;
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
let marineLastOutboxRunAt = 0;
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
    if (Number.isInteger(state.suspendedRetainedTabId)) {
      marineSuspendedRetainedTabId = state.suspendedRetainedTabId;
      // A persisted activeTabKnown=null + suspended tab is the fail-closed
      // WINDOW_ID_NONE state. Restore it explicitly so a restarted MV3 worker
      // can renew only that exact retained lease while Chrome stays unfocused.
      if (marineActiveTabId === null) marineFocusedWindowId = null;
    }
    for (const [rawTabId, item] of Object.entries(state.tabs)) {
      const tabId = Number(rawTabId);
      if (!Number.isInteger(tabId) || !item) continue;
      if (item.contextId) marineTabContexts.set(tabId, {
        contextId: String(item.contextId),
        revision: Number(item.revision) || 0,
        sourceId: String(item.sourceId || ''),
        retainWhenUnfocused: item.retainWhenUnfocused === true,
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
        retainWhenUnfocused: tracked.retainWhenUnfocused === true,
      };
    }
    void session.set({
      [marineSessionStateKey]: {
        activeTabKnown: marineActiveTabId !== undefined,
        activeTabId: Number.isInteger(marineActiveTabId) ? marineActiveTabId : null,
        suspendedRetainedTabId: Number.isInteger(marineSuspendedRetainedTabId)
          ? marineSuspendedRetainedTabId
          : null,
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
    // 只有调试脚手架会往 runtime-config 里写这个。app 打包的正式 profile 没有
    // 它，所以正式路径上恒为 undefined —— Rust 侧照常走 resolve_running_profile。
    debugCdpPort: Number(runtime.debugCdpPort) || undefined,
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

/**
 * 平台评论 id。
 *
 * B 站/知乎是正整数（`rpid` / `id`），**小红书是 24 位十六进制字符串**
 * （实测 `note_id: "6a5b0f18000000001c00fb2c"`）。只认正整数会把小红书的回执
 * 一路判空 —— 而且是在最后一步静默丢掉，外部看到的仍是「没收到回执」。
 *
 * 两种都接受，但都要求**非空且形态确定**：id 是「这条评论真的上线了」的唯一
 * 凭据，含糊的值不能放行。
 */
function marinePublishedPositiveId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (/^[1-9]\d*$/.test(normalized)) return normalized;
  if (/^[0-9a-f]{16,32}$/i.test(normalized)) return normalized;
  return '';
}

function marinePublishedString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value : '';
}

/**
 * 允许上报发布回执的站点。
 *
 * 从「只认 B 站」扩成一张表：每加一个平台，必须先有它的回执构造器
 * （publish-receipt.js），否则收上来的东西没有「真的上线了」的凭据。
 * 这里放宽 = 允许该站点的页面往发布历史里写记录，所以只列已实现的。
 */
function marineIsPublishCapableUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return /(^|\.)bilibili\.com$/i.test(parsed.hostname) ||
      /(^|\.)zhihu\.com$/i.test(parsed.hostname) ||
      /(^|\.)xiaohongshu\.com$/i.test(parsed.hostname) ||
      /(^|\.)douyin\.com$/i.test(parsed.hostname);
  } catch (e) { return false; }
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
    marineIsPublishCapableUrl(sender.url || sender.tab.url);
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
      // 和 manifest 里回执桥的注入范围保持一致 —— 每加一个平台两处都要动，
      // 只改一处的后果是「评论发出去了但回执永远收不到」（实测踩过）。
      url: [
        'http://*.bilibili.com/*', 'https://*.bilibili.com/*',
        'http://*.zhihu.com/*', 'https://*.zhihu.com/*',
        'http://*.xiaohongshu.com/*', 'https://*.xiaohongshu.com/*',
        'http://*.douyin.com/*', 'https://*.douyin.com/*',
      ],
    });
  } catch (e) {
    return { reason, scanned: 0, injected: 0 };
  }
  let injected = 0;
  for (const tab of tabs || []) {
    if (!tab || !Number.isInteger(tab.id) || !marineIsPublishCapableUrl(tab.url)) continue;
    if (await marineEnsurePublishedCapture(tab.id)) injected += 1;
  }
  return { reason, scanned: (tabs || []).length, injected };
}

// ---- 生成来源标注（页内生成 → 账本 generation_source='extension'）----
function marineNormalizeCommentText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function marineGenerationSourceValue(value) {
  const v = String(value || '').trim();
  return v === 'extension' || v === 'rime' || v === 'manual' ? v : null;
}

// content-iso 页内生成并填入时上报文本，按 tab 记下（用于稍后发帖回执的来源判定）。
function marineRecordGenFill(tabId, text) {
  if (tabId == null) return;
  const normalized = marineNormalizeCommentText(text);
  if (normalized.length < 4) return;
  marineGenFills.set(tabId, { text: normalized, at: Date.now() });
}

// 一条发帖回执是否来自本 tab 近期的页内生成：归一后完全相等，或较长一方包含较短一方
// （容忍用户发布前的小改动 / 平台加尾巴）。仅在可靠匹配时才认定为 'extension'。
function marineGenFillMatchesPost(tabId, postedText) {
  if (tabId == null) return false;
  const fill = marineGenFills.get(tabId);
  if (!fill) return false;
  if (Date.now() - fill.at >= marineGenFillTtlMs) { marineGenFills.delete(tabId); return false; }
  const posted = marineNormalizeCommentText(postedText);
  if (!posted) return false;
  if (posted === fill.text) return true;
  const long = posted.length >= fill.text.length ? posted : fill.text;
  const short = posted.length >= fill.text.length ? fill.text : posted;
  return short.length >= 8 && long.indexOf(short) !== -1;
}

/** 已实现回执构造器的平台。加平台时要和 publish-receipt.js / publish-bridge.js 一起改。 */
const MARINE_RECEIPT_PLATFORMS = new Set(['bilibili', 'zhihu', 'xiaohongshu', 'douyin']);

function marineSanitizePublishedReceipt(value) {
  // 这个早退曾经写死 'bilibili'，和下面的 event_id 判据是**两处独立的闸**。
  // 只改一处的后果极其隐蔽：回执在 bridge 侧已经构造成功、页内全局也挂上了、
  // 台账都记了 posted，唯独发布历史里没有 —— 而外部完全看不出是哪一跳丢的。
  if (!value || value.schema_version !== 1 || !MARINE_RECEIPT_PLATFORMS.has(value.platform)) {
    return null;
  }
  const platformCommentId = marinePublishedPositiveId(value.platform_comment_id);
  const rootId = marinePublishedPositiveId(value.root_id);
  const parentId = marinePublishedPositiveId(value.parent_id);
  const targetCommentId = parentId || rootId;
  const text = marinePublishedString(value.text_snapshot, 20_000);
  const targetUrl = marinePublishedString(value.target_url, 4096);
  const postedAt = Number(value.posted_at);
  // event_id 必须是 `<platform>:<平台评论ID>`，且 platform 要和它自己声明的一致。
  // 写死 'bilibili:' 会让知乎的回执在这里被静默丢掉 —— 表现是「评论确实发出去了、
  // 台账却记 failed」，查起来很费劲（实测踩过）。
  const platform = marinePublishedString(value.platform, 32);
  if (!platformCommentId || !platform || value.event_id !== platform + ':' + platformCommentId ||
      !text.trim() || !targetUrl || !marineIsPublishCapableUrl(targetUrl) ||
      !Number.isSafeInteger(postedAt) || postedAt <= 0) return null;

  return {
    schema_version: 1,
    event_id: value.event_id,
    // 按声明的平台原样带出去 —— 强行改回 bilibili 会让知乎的记录在 Rust 侧
    // 被当成 B 站的，event_id 前缀和 platform 字段自相矛盾。
    platform: platform,
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
    generation_source: marineGenerationSourceValue(value.generation_source),
  };
}

function marineTrustedPublishedSender(sender) {
  if (!sender || !sender.tab || sender.tab.id == null || (sender.frameId != null && sender.frameId !== 0)) return false;
  return marineIsPublishCapableUrl(sender.url || sender.tab.url);
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

// 持久化是唯一的落地口，因此也是重试 alarm 生命周期的唯一真相来源：
// 队列非空才需要每分钟唤醒，空了必须撤掉。
async function marineSavePublishedOutbox(state) {
  if (!state.items.length) {
    await chrome.storage.local.remove(marinePublishedOutboxStorageKey);
    marineClearPublishedReceiptAlarm();
    return;
  }
  const bytes = marineUtf8Bytes(JSON.stringify(state));
  if (bytes > marinePublishedOutboxMaxBytes) throw new Error('Marine 发布待同步队列超过本地存储上限');
  await chrome.storage.local.set({ [marinePublishedOutboxStorageKey]: state });
  marineEnsurePublishedReceiptAlarm();
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
  // 生成来源：若本 tab 近期有一次页内生成填入、且文本与这条发帖匹配，标为 'extension'
  // （在持久化前设好，随 outbox 一起落地并 POST 到 /history/published）。
  if (!sanitized.generation_source &&
      marineGenFillMatchesPost(sender && sender.tab && sender.tab.id, sanitized.text_snapshot)) {
    sanitized.generation_source = 'extension';
  }
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
    // (Saving a non-empty queue also arms the retry alarm.)
    await marineSavePublishedOutbox(state);

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

// 这个 alarm 此前从不撤销：即使待同步队列早已清空，它仍每分钟把 sw 冷启一次，
// 顶层随之重跑一遍重试和全量注入清扫——一整天上千次唤醒，全程无事可做。
function marineClearPublishedReceiptAlarm() {
  const alarms = chrome.alarms;
  if (!alarms || typeof alarms.clear !== 'function') return;
  try {
    const result = alarms.clear(marinePublishedRetryAlarm);
    if (result && result.catch) void result.catch(() => {});
  } catch (e) {}
}

function marineRetryPublishedOutbox(reason) {
  // 同步打点（而不是在任务体里）：alarm 冷启 sw 时，顶层的 worker-start 重试
  // 会先入队，随后 onAlarm 才触发；没有这个时间戳，同一次唤醒会重试两遍。
  marineLastOutboxRunAt = Date.now();
  return marineQueuePublishedOutbox(async () => {
    marinePrunePublishedRecent(Date.now());
    const loaded = await marineLoadPublishedOutbox();
    const state = loaded.state;
    if (!state.items.length) {
      if (loaded.dirty) await marineSavePublishedOutbox(state);
      else marineClearPublishedReceiptAlarm();
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
    else if (state.items.length) marineEnsurePublishedReceiptAlarm();
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

function marineSuspendedRetainedContext(tabId) {
  if (marineFocusedWindowId !== null || marineActiveTabId !== null ||
      marineSuspendedRetainedTabId !== tabId) return null;
  const tracked = marineTabContexts.get(tabId);
  return tracked && tracked.retainWhenUnfocused === true ? tracked : null;
}

function marineExactSuspendedRetainedRenewal(msg, sender, expectedSource) {
  const tabId = sender.tab && sender.tab.id;
  const revision = Number(msg.revision) || 0;
  const tracked = marineSuspendedRetainedContext(tabId);
  return !!tracked && sender.tab.active === true && msg.op === 'put' &&
    msg.leaseRenewal === true && msg.retainWhenUnfocused === true &&
    !!msg.context && msg.context.contextId === msg.contextId &&
    tracked.contextId === msg.contextId && tracked.sourceId === expectedSource &&
    tracked.revision > 0 && revision === tracked.revision &&
    marineTabSources.get(tabId) === expectedSource &&
    marineLatestRevisions.get(tabId) === revision;
}

function marineExactSuspendedRetainedDelete(msg, sender, expectedSource) {
  const tabId = sender.tab && sender.tab.id;
  const revision = Number(msg.revision) || 0;
  const tracked = marineSuspendedRetainedContext(tabId);
  return !!tracked && msg.op === 'delete' && tracked.contextId === msg.contextId &&
    tracked.sourceId === expectedSource && marineTabSources.get(tabId) === expectedSource &&
    tracked.revision > 0 && revision >= tracked.revision;
}

async function marineApplyContextMessage(msg, sender, expectedEpoch, expectedSource, options = {}) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) throw new Error('缺少来源标签页');
  const revision = Number(msg.revision) || 0;

  if (msg.op === 'put') {
    if (!msg.context || !msg.contextId || msg.context.contextId !== msg.contextId) throw new Error('无效的 Marine context');
    if (revision && revision !== marineLatestRevisions.get(tabId)) return { ok: true, skipped: true, reason: 'revision' };
    if (expectedEpoch !== marineTabEpoch(tabId)) return { ok: true, skipped: true, reason: 'epoch' };
    if (marineTabSources.get(tabId) !== expectedSource) return { ok: true, skipped: true, reason: 'source' };
    let suspendedRenewalConfirmed = options.allowSuspendedRetainedRenewal === true &&
      marineExactSuspendedRetainedRenewal(msg, sender, expectedSource);
    let senderFocusConfirmed = true;
    if (!suspendedRenewalConfirmed &&
        (marineActiveTabId === undefined || marineFocusedWindowId === undefined)) {
      senderFocusConfirmed = await marineConfirmSenderFocus(sender);
    }
    suspendedRenewalConfirmed = options.allowSuspendedRetainedRenewal === true &&
      marineExactSuspendedRetainedRenewal(msg, sender, expectedSource);
    // 编排在驱动时跳过焦点闸。
    //
    // 焦点闸的存在理由是「全局只有一个 Rime 上下文槽位，只有用户正在看的那个
    // tab 能占用」—— 那是给人用侧边栏定的规则。编排独占浏览器、只有一个标签页
    // 在干活，而运行期间人必须能用鼠标干别的；照旧套用的话，鼠标一移开就
    // `window-blur` + PUT 被推迟 → 生成超时 → 台账记 failed → 靶子按「失败不
    // 重试」永久作废（实测）。
    //
    // 这个标记只能由本扩展的 content script 发出（isolated world），页面 JS
    // 够不着；和交接单、聚焦入口同一条信任边界。
    const orchestrated = msg && msg.orchestrated === true;
    if (!orchestrated &&
        (!senderFocusConfirmed || marineActiveTabId !== tabId) && !suspendedRenewalConfirmed) {
      const deferred = options.allowDefer !== false
        && marineDeferPut(msg, sender, expectedEpoch, expectedSource);
      return { ok: true, skipped: true, deferred, reason: 'focus-gate' };
    }
    // 编排同样要跳过**写闸**，不只是上面那道推迟闸。
    //
    // 这两道闸是分开的，只放行推迟闸等于没放行：人一切到别的程序，
    // `onFocusChanged(WINDOW_ID_NONE)` 会把 `marineActiveTabId` 直接置成 null，
    // 于是 `marineActiveTabId === tabId` 对**任何** tab 都不成立 →
    // `marineContextFetch` 的 `shouldProceed()` 返回 false → 连 fetch 都不发 →
    // 上面那句 `if (!wrote)` 回一个 `{ok:true, skipped:true}`。**报成功，实际没写**，
    // 而且因为跳过了推迟闸，连 `deferred` 标志都没有，content 侧一条日志都不打。
    // 12 秒后以「目标准备超时」收场，台账记 failed，靶子按「失败不重试」作废。
    //
    // 这个闭包同时被写前谓词和写后复核（那句 `!authorityIsCurrent()` 会补一个
    // DELETE 把刚写的撤掉）用，所以放行放在这里，两处一起覆盖。
    const authorityIsCurrent = () => (
      orchestrated ||
      marineActiveTabId === tabId ||
      (options.allowSuspendedRetainedRenewal === true &&
        marineExactSuspendedRetainedRenewal(msg, sender, expectedSource))
    );
    const wrote = await marineContextFetch('PUT', msg.contextId, msg.context, () => (
      expectedEpoch === marineTabEpoch(tabId)
        && marineTabSources.get(tabId) === expectedSource
        && authorityIsCurrent()
        && (!revision || revision === marineLatestRevisions.get(tabId))
    ));
    if (!wrote) return { ok: true, skipped: true, reason: 'authority' };
    // A tab switch/navigation/delete may happen while the localhost PUT is in
    // flight. Conditionally remove that just-written context instead of
    // letting an obsolete target come back after its clearing event.
    if (expectedEpoch !== marineTabEpoch(tabId)
        || marineTabSources.get(tabId) !== expectedSource
        || !authorityIsCurrent()
        || (revision && revision !== marineLatestRevisions.get(tabId))) {
      try { await marineContextFetch('DELETE', msg.contextId, null); } catch (e) {}
      return { ok: true, skipped: true, reason: 'authority-recheck' };
    }
    marineTabContexts.set(tabId, {
      contextId: msg.contextId,
      revision,
      sourceId: expectedSource,
      retainWhenUnfocused: msg.retainWhenUnfocused === true,
      // 记下这条上下文是编排建立的：失焦时 `marineSetActiveTab` 会清掉「上一个活动
      // 标签页」的上下文，而清理会发 DELETE（见 marineClearTrackedTab）。对编排来说
      // 那是致命的 —— 被 DELETE 的 contextId 会进后端的 revoked 名单，同一个 id
      // 再也 PUT 不进去，生成阶段直接报「目标已失效」。
      orchestrated,
    });
    marinePersistState();
    return { ok: true };
  }
  if (msg.op === 'delete') {
    marineDropDeferredPut(tabId);
    const contextId = msg.contextId || (marineTabContexts.get(tabId) || {}).contextId;
    if (!contextId) return { ok: true, skipped: true };
    await marineContextFetch('DELETE', contextId, null);
    const current = marineTabContexts.get(tabId);
    if (!current || current.contextId === contextId) {
      marineTabContexts.delete(tabId);
      if (marineSuspendedRetainedTabId === tabId) marineSuspendedRetainedTabId = null;
    }
    marinePersistState();
    return { ok: true };
  }
  throw new Error('未知的 Marine context 操作');
}

/**
 * 这个标签页的上下文是编排建立的吗？
 *
 * 用来把编排的上下文从「失焦即清理」里摘出来。清理不是标记一下而已 —— 它会对
 * 那个 contextId 发 DELETE，后端会把它记进 revoked，之后同一个 id 永远 PUT 不进去。
 * 不摘的话，人一切走浏览器，正在跑的那条腿就被判了死刑。
 */
function marineTabIsOrchestrated(tabId) {
  const tracked = Number.isInteger(tabId) ? marineTabContexts.get(tabId) : null;
  return !!tracked && tracked.orchestrated === true;
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
  if (marineSuspendedRetainedTabId === tabId) marineSuspendedRetainedTabId = null;
  if (options.removed) marineRetiredSources.delete(tabId);
  marinePersistState();
  if (!tracked) return;
  void marineQueueOperation(async () => {
    try { await marineContextFetch('DELETE', tracked.contextId, null); } catch (e) {}
  });
}

// ---- sw 保活（仅在有长任务在跑时）----
// MV3 的 service worker 约 30 秒无事件就被回收。流式生成期间，本机智能体可能几十秒
// 才吐出第一帧，中间没有任何事件——此前是那个每分钟的重试 alarm 意外充当了保活，
// 所以撤掉 alarm 必须同时补上显式保活，否则会把隐性问题变成显性的「生成中断」。
// 调用任意扩展 API 都会重置空闲计时器，这里用最廉价的一个。
let marineKeepaliveHolders = 0;
let marineKeepaliveTimer = null;

function marineAcquireKeepalive() {
  marineKeepaliveHolders += 1;
  if (marineKeepaliveTimer) return;
  marineKeepaliveTimer = setInterval(() => {
    try {
      const result = chrome.runtime.getPlatformInfo();
      if (result && result.catch) void result.catch(() => {});
    } catch (e) {}
  }, 20000);
}

function marineReleaseKeepalive() {
  marineKeepaliveHolders = Math.max(0, marineKeepaliveHolders - 1);
  if (marineKeepaliveHolders > 0 || !marineKeepaliveTimer) return;
  clearInterval(marineKeepaliveTimer);
  marineKeepaliveTimer = null;
}

// ---- 页面内「生成」按钮：本地智能体流式生成 ----
// content-iso 建立一条长连接端口 'marine-generate'，sw 调本地 Marine API 的
// /generate-stream（本机 codex/claude 智能体）拉 NDJSON 帧并原样转发回页面。
// 上下文（评论目标 + 话术）此前已由聚焦流程 PUT 到本地 API，这里只按 contextId 触发
// 生成，绝不发布/提交——结果只作草稿预览，由用户确认后填入。
async function marineRunGenerateStream(req, post, setController) {
  const config = await marineResolveConfig();
  if (!config.apiBase || !config.token) {
    post({ type: 'error', code: 'MARINE_NOT_CONFIGURED' });
    return;
  }
  const contextId = String((req && req.contextId) || '').trim();
  const actionId = String((req && req.actionId) || '').trim();
  const requestId = String((req && req.requestId) || ('gen-' + Date.now())).trim();
  if (!contextId || !actionId) {
    post({ type: 'error', code: 'MARINE_RIME_CONTEXT_INVALID' });
    return;
  }
  const controller = new AbortController();
  setController(controller);
  const timeout = setTimeout(() => controller.abort(), 245000);
  marineAcquireKeepalive();
  try {
    const response = await fetch(config.apiBase + '/generate-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ requestId, actionId, contextId }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      let code = 'MARINE_GENERATE_FAILED';
      try { const parsed = JSON.parse(await response.text()); if (parsed && parsed.code) code = parsed.code; }
      catch (e) {}
      post({ type: 'error', code, status: response.status });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame; try { frame = JSON.parse(line); } catch (e) { continue; }
        post(frame);
      }
    }
    const tail = buffer.trim();
    if (tail) { try { post(JSON.parse(tail)); } catch (e) {} }
  } finally {
    clearTimeout(timeout);
    marineReleaseKeepalive();
  }
}

if (chrome.runtime.onConnect && chrome.runtime.onConnect.addListener) {
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'marine-generate') return;
  let controller = null;
  let closed = false;
  const post = (frame) => {
    if (closed) return;
    try { port.postMessage(frame); } catch (e) {}
  };
  port.onDisconnect.addListener(() => {
    closed = true;
    if (controller) { try { controller.abort(); } catch (e) {} }
  });
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'start') return;
    // 若端口在 marineRunGenerateStream 里 await（如解析配置）期间就断开，此时才拿到
    // controller，必须立刻 abort——否则 fetch 会照常发出，本机智能体生成成孤儿、取消失效。
    marineRunGenerateStream(msg, post, (c) => { controller = c; if (closed) { try { c.abort(); } catch (e) {} } })
      .catch(error => post({ type: 'error', code: 'MARINE_GENERATE_FAILED', message: String(error && error.message || error) }))
      .finally(() => { if (!closed) { try { port.disconnect(); } catch (e) {} } });
  });
});
}


// 发现侧编排（prospect-run.js）要访问本地 API 的 /prospects/* 与 profileId，
// 但 content script 拿不到 runtime-config（apiBase/token 只有 SW 读得到），
// 所以由 SW 代发。
//
// 路由白名单不是洁癖：编排跑在页面上下文里，页面是不可信环境。放开成任意
// 路径就等于把整个本地 API 暴露给它，而本地 API 里有 /generate-stream 和
// /history/published 这类会产生外部动作的端点。
const MARINE_PROSPECT_ROUTES = new Set([
  'prospects/ingest',
  'prospects/claim',
  'prospects/prepare-send',
  'prospects/settle',
  // 键盘代打。**这条比上面三条危险**：它让调用方能操作浏览器本身，而不只是
  // 读写台账。放进来是因为抖音的编辑器对页内合成输入有反制（写一两个字就把整个
  // 评论组件拆掉，手动也一样），只有 CDP 的可信键盘事件能过。
  //
  // 危险被三层约束兜住，缺一不可：
  //   · Rust 侧只打字，不点击、不导航 —— 发送仍由扩展点站点自己的按钮
  //   · Rust 侧拒绝控制字符（否则一个回车就能绕过发送闸）和超长文本
  //   · 目标必须是**正在运行的** profile，由 resolve_running_profile 把关
  'type-text',
]);

const MARINE_PROSPECT_READY_ROUTE = 'prospects/ready';

/**
 * 只读认证握手。这条路由 SW 写死，不放进页面可指定的路由白名单；
 * 成功同时证明 runtime config、Bearer token 和本地 API bridge 都可用。
 */
async function marineProspectReady() {
  const config = await marineResolveConfig();
  if (!config.profileId || !config.apiBase || !config.token) {
    throw new Error('编排就绪探针缺少 profileId/apiBase/token');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(config.apiBase + '/' + MARINE_PROSPECT_READY_ROUTE, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + config.token },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status !== 204) {
      throw new Error(MARINE_PROSPECT_READY_ROUTE + ' 返回 ' + response.status);
    }
    return { profileId: config.profileId };
  } finally {
    clearTimeout(timeout);
  }
}

async function marineProspectApi(route, body) {
  if (!MARINE_PROSPECT_ROUTES.has(route)) {
    throw new Error('不允许的编排路由：' + route);
  }
  const config = await marineResolveConfig();
  if (!config.apiBase || !config.token) throw new Error('未配置 Marine 本地 API');
  const controller = new AbortController();
  // 台账那几条是毫秒级的本地读写，15s 绰绰有余。但 `type-text` 是**同步等着
  // Rust 逐字敲完**才返回 —— 拟人节奏下 180 字要一分多钟，15s 必然掐断。
  // 实测症状是 `signal is aborted without reason`，而字其实正在被敲进去。
  const timeoutMs = route === 'type-text' ? 180000 : 15000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.apiBase + '/' + route, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(route + ' 返回 ' + response.status);
    const text = await response.text();
    // claim 没得领时返回 null；空体也按 null 处理，调用方分支是一样的。
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

// 扩展自己的日志落盘。
//
// 侧边栏的「调试」tab 是**活的**消费者：只在面板打开时、只对当前活动标签页、
// 只给人看。而发现调度器**每条腿结束都会关掉浏览器**——等去看的时候窗口连同
// 里面每一行日志都没了，只剩台账里的结果，没有原因。这条通道就是补这个。
//
// 刻意**不走** MARINE_PROSPECT_ROUTES 白名单：那份白名单管的是「页面上下文能
// 让 SW 代打哪些本地 API」，是安全边界。日志转发由 SW 自己发起，路径写死，
// 不接受调用方指定，所以不能、也不需要进那份名单。
/**
 * 掉登录的上报路由。
 *
 * 和日志同一类：**写死在 SW 里**，不进 `MARINE_PROSPECT_ROUTES` 那份白名单 ——
 * 那份名单是给不可信的页面上下文用的，页面能指定路由就等于能调任意本地 API。
 *
 * 只在**判定不是「已登录」**时才发。已登录不上报（没信息量），标记的清除由
 * 调度器在「那条腿真发出去了」时做 —— 发成功比任何探测都更能证明登录有效。
 */
const MARINE_LOGIN_ROUTE = 'login-status';

async function marineReportLogin(result) {
  if (!result || !result.platform) return;
  // 已登录不上报。三态里只有 false（确认登出）和 null（判断不了）值得记，
  // 而这两者在存储和界面上必须继续分开：把「判断不了」当成登出，
  // 运营会去重新登录一个其实健康的账号。
  if (result.loggedIn === true) return;

  let config;
  try { config = await marineResolveConfig(); } catch (e) { return; }
  if (!config.apiBase || !config.token || !config.profileId) return;

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, 8000);
  try {
    await fetch(config.apiBase + '/' + MARINE_LOGIN_ROUTE, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: config.profileId,
        platform: result.platform,
        page_result: {
          platform: result.platform,
          logged_in: result.loggedIn,
          evidence: result.evidence,
          account_name: result.accountName || null,
          account_id: result.accountId || null,
          cookies_found: result.cookiesFound || [],
        },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    // 上报失败不该影响编排：它的正事是决定要不要往下跑，不是记账。
  } finally { clearTimeout(timer); }
}

const MARINE_LOG_ROUTE = 'debug/logs';
const MARINE_LOG_MAX_BATCH = 200;

async function marineForwardLogs(entries, sender) {
  if (!Array.isArray(entries) || !entries.length) return;
  let config;
  try { config = await marineResolveConfig(); } catch (e) { return; }
  if (!config.apiBase || !config.token) return;

  // 日志是突发的（一次抓取几十条，每个 iframe 各一份）。截断而不是拒绝：
  // 丢掉超出的部分好过让一次风暴打爆本地 API。
  const batch = entries.slice(0, MARINE_LOG_MAX_BATCH).map((e) => Object.assign({}, e, {
    profile_id: config.profileId || null,
    url: (sender && sender.tab && sender.tab.url) || (sender && sender.url) || null,
  }));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(config.apiBase + '/' + MARINE_LOG_ROUTE, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    // 记日志失败绝不能影响被记录的那件事，静默吞掉。
  }
}

// Phase A -> Phase B 的交接单，按 tab 存在 SW 侧。
//
// **不能用 sessionStorage**：它按 origin 分区，而搜索页和靶子页经常不同源 ——
// B 站永远是（search.bilibili.com -> www.bilibili.com），知乎的专栏文章也是
// （www.zhihu.com -> zhuanlan.zhihu.com）。用 sessionStorage 的后果是 Phase A
// 一切正常（入账、claim、导航都成功），Phase B 在新源上读不到交接单直接静默
// 退出，台账里留下一条永远停在 claimed、没有任何 touch 的记录 —— 实测就是这样。
//
// 按 tab 而不是全局：编排虽然是串行的，但一个被遗留的全局交接单会让下一个
// 无关页面误以为自己是靶子。
const MARINE_HANDOFF_PREFIX = 'marineProspectHandoff:';
// 普通 Phase A -> B 交接只需要活到当前 tab 的下一份 document，继续放 session。
// 但 sendStarted / pendingSettlement 已跨过不可逆边界：若浏览器退出或调度器在
// hard-timeout 后关 tab，session 会被清掉，6h claim TTL 后就可能再次发送。
// 这两种状态额外镜像到 local outbox；实际 storage key 同时包含 profile +
// prospect key，恢复不依赖已经消失的 tabId。
const MARINE_HANDOFF_OUTBOX_PREFIX = 'marineProspectSettlementOutbox:v1:';
// 明确 4xx 的 active outbox 不能永久锁住整个 profile，也不能直接删除后重新发送。
// dead-letter 只拦同一 profile+key；若该 key 以后重新 claim，会先恢复成
// settlement-only handoff，绝不再次点击。
const MARINE_HANDOFF_DEAD_LETTER_PREFIX = 'marineProspectSettlementDeadLetter:v1:';
let marineHandoffQueue = Promise.resolve();

function marineHandoffNeedsOutbox(value) {
  return !!(value && (value.sendStarted || value.pendingSettlement));
}

function marineHandoffOutboxKey(profileId, prospectKey) {
  const profile = String(profileId || '').trim();
  const key = String(prospectKey || '').trim();
  if (!profile || !key) throw new Error('持久交接单缺少 profileId/key');
  return MARINE_HANDOFF_OUTBOX_PREFIX + encodeURIComponent(profile) + ':' + encodeURIComponent(key);
}

function marineHandoffDeadLetterKey(profileId, prospectKey) {
  const profile = String(profileId || '').trim();
  const key = String(prospectKey || '').trim();
  if (!profile || !key) throw new Error('dead-letter 交接单缺少 profileId/key');
  return MARINE_HANDOFF_DEAD_LETTER_PREFIX +
    encodeURIComponent(profile) + ':' + encodeURIComponent(key);
}

async function marineHandoffOutboxes(profileId) {
  const profile = String(profileId || '').trim();
  if (!profile) return [];
  const got = await chrome.storage.local.get(null);
  const entries = [];
  for (const [storageKey, raw] of Object.entries(got || {})) {
    if (!storageKey.startsWith(MARINE_HANDOFF_OUTBOX_PREFIX)) continue;
    if (!marineHandoffNeedsOutbox(raw) || String(raw.profileId || '').trim() !== profile) continue;
    let expected;
    try { expected = marineHandoffOutboxKey(profile, raw.key); } catch (e) { continue; }
    // storage key 和 payload 必须互相证明；忽略手工残留/旧格式，不能误删别的任务。
    if (storageKey !== expected) continue;
    entries.push({ storageKey, value: raw });
  }
  entries.sort((a, b) => {
    const at = Number(a.value.outboxAt || a.value.pendingSettlementAt ||
      a.value.sendStartedAt || a.value.at || 0);
    const bt = Number(b.value.outboxAt || b.value.pendingSettlementAt ||
      b.value.sendStartedAt || b.value.at || 0);
    return at - bt || a.storageKey.localeCompare(b.storageKey);
  });
  return entries;
}

async function marineHandoffRuntimeProfileId() {
  const config = await marineResolveConfig();
  return String((config && config.profileId) || '').trim();
}

async function marineHandoffUnlocked(op, tabId, value, reason) {
  if (tabId === undefined || tabId === null) throw new Error('交接单需要 tab 身份');
  const key = MARINE_HANDOFF_PREFIX + tabId;
  if (op === 'write') {
    const got = await chrome.storage.session.get(key);
    const existing = (got && got[key]) || null;
    const existingKey = String((existing && existing.key) || '');
    const nextKey = String((value && value.key) || '');
    const nextProfileId = String((value && value.profileId) || '').trim();
    const runtimeProfileId = await marineHandoffRuntimeProfileId();
    if (!nextProfileId || nextProfileId !== runtimeProfileId) {
      throw new Error('交接单 profile 与当前 runtime profile 不一致');
    }
    if (!nextKey) throw new Error('交接单缺少 prospect key');
    let nextValue = value;
    let nextNeedsOutbox = marineHandoffNeedsOutbox(nextValue);
    const outboxKey = nextKey ? marineHandoffOutboxKey(nextProfileId, nextKey) : '';
    const outboxes = await marineHandoffOutboxes(nextProfileId);
    const sameOutbox = outboxes.find(entry => entry.storageKey === outboxKey) || null;
    const conflictingOutbox = outboxes.find(entry => entry.storageKey !== outboxKey) || null;
    const deadLetterKey = marineHandoffDeadLetterKey(nextProfileId, nextKey);
    const deadLetterGot = await chrome.storage.local.get(deadLetterKey);
    const sameDeadLetter = (deadLetterGot && deadLetterGot[deadLetterKey]) || null;
    if (conflictingOutbox) {
      throw new Error('拒绝覆盖待 settle 的持久交接单：' + conflictingOutbox.value.key);
    }
    if (sameDeadLetter && !sameOutbox) {
      if (nextNeedsOutbox) {
        // dead-letter 之后晚到的旧 document write 不能把它重新变成 active outbox。
        throw new Error('拒绝复活 dead-letter 的不可逆交接单：' + nextKey);
      }
      const claimAt = Number((nextValue && nextValue.at) || 0);
      const deadAt = Number(sameDeadLetter.deadLetterAt || 0);
      if (!claimAt || claimAt < deadAt) {
        throw new Error('拒绝 dead-letter 之前的陈旧交接写入：' + nextKey);
      }
      // 同 key 确实被后端重新 claim：把 tombstone 恢复为 settlement-only，
      // Phase B 会先走 pendingSettlement 分支，绝不会重新生成/点击。
      nextValue = Object.assign({}, nextValue, {
        sendStarted: sameDeadLetter.sendStarted === true,
        sendStartedAt: sameDeadLetter.sendStartedAt || deadAt || claimAt,
        pendingSettlement: sameDeadLetter.pendingSettlement || 'failed',
        pendingSettlementAt: sameDeadLetter.pendingSettlementAt || deadAt || claimAt,
        outboxAt: Date.now(),
        recoveredFromDeadLetter: true,
      });
      nextNeedsOutbox = true;
    }
    if (existing && existingKey !== nextKey &&
        (existing.sendStarted || existing.pendingSettlement)) {
      throw new Error('拒绝覆盖已开始发送/待 settle 的交接单：' + existingKey);
    }
    if (existing && existingKey === nextKey && marineHandoffNeedsOutbox(existing) &&
        !nextNeedsOutbox) {
      throw new Error('拒绝把不可逆交接单降级为普通交接单：' + existingKey);
    }
    if (sameOutbox && !nextNeedsOutbox) {
      throw new Error('拒绝覆盖待 settle 的持久交接单：' + sameOutbox.value.key);
    }
    if (sameOutbox && sameOutbox.value.pendingSettlement === 'posted' &&
        nextValue.pendingSettlement !== 'posted') {
      throw new Error('拒绝把 posted 持久交接单降级为 ' +
        String(nextValue.pendingSettlement || 'empty') + '：' + sameOutbox.value.key);
    }
    if (sameOutbox && sameOutbox.value.pendingSettlement === 'unconfirmed' &&
        nextValue.pendingSettlement !== 'unconfirmed' &&
        nextValue.pendingSettlement !== 'posted') {
      throw new Error('拒绝把 unconfirmed 持久交接单降级为 ' +
        String(nextValue.pendingSettlement || 'empty') + '：' + sameOutbox.value.key);
    }

    let storedValue = nextValue;
    if (nextNeedsOutbox) {
      storedValue = Object.assign({}, nextValue, {
        outboxAt: Number(nextValue.outboxAt ||
          (sameOutbox && sameOutbox.value.outboxAt) || Date.now()),
      });
      // durable 成功后才能回写 session/允许页面点击。若 session 写失败，保守留下
      // failed outbox，下一份 document 只 settle，宁可少发也绝不重复发。
      await chrome.storage.local.set({ [outboxKey]: storedValue });
      if (sameDeadLetter) await chrome.storage.local.remove(deadLetterKey);
    }
    await chrome.storage.session.set({ [key]: storedValue });
    return true;
  }
  if (op === 'deadLetter') {
    const got = await chrome.storage.session.get(key);
    const existing = (got && got[key]) || value || null;
    if (!marineHandoffNeedsOutbox(existing)) {
      throw new Error('只有不可逆交接单可以进入 dead-letter');
    }
    const outboxKey = marineHandoffOutboxKey(existing.profileId, existing.key);
    const deadLetterKey = marineHandoffDeadLetterKey(existing.profileId, existing.key);
    const tombstone = Object.assign({}, existing, {
      deadLetterAt: Date.now(),
      deadLetterReason: String(reason || '').slice(0, 500),
    });
    // tombstone 必须先 durable，再移除 active。任一步失败都保留至少一份证据；
    // 调用方会返回 recoverable，不能把 partial move 误报成已清。
    await chrome.storage.local.set({ [deadLetterKey]: tombstone });
    await chrome.storage.local.remove(outboxKey);
    await chrome.storage.session.remove(key);
    return true;
  }
  if (op === 'clear') {
    const got = await chrome.storage.session.get(key);
    const existing = (got && got[key]) || value || null;
    if (marineHandoffNeedsOutbox(existing)) {
      // 先删 durable，再删 session。local 删除失败时保留 session，让调用方重试；
      // 反过来会在一次瞬时 local 错误后失去唯一可定位的 outbox 凭据。
      await chrome.storage.local.remove([
        marineHandoffOutboxKey(existing.profileId, existing.key),
        marineHandoffDeadLetterKey(existing.profileId, existing.key),
      ]);
    }
    await chrome.storage.session.remove(key);
    return true;
  }
  if (op === 'read') {
    const got = await chrome.storage.session.get(key);
    const current = (got && got[key]) || null;
    if (current) {
      // local 是不可逆状态的提交点，必须比 session 权威。典型 partial write：
      // posted 已 local.set 成功，但 session.set/消息回执中断，session 仍是 failed。
      // 若直接返回 failed，后续写会被 posted->failed 单调闸拒绝并看起来“卡住”。
      if (marineHandoffNeedsOutbox(current) && current.profileId && current.key) {
        const active = await marineHandoffOutboxes(current.profileId);
        const expected = marineHandoffOutboxKey(current.profileId, current.key);
        const durable = active.find(entry => entry.storageKey === expected) || null;
        if (durable) {
          await chrome.storage.session.set({ [key]: durable.value });
          return durable.value;
        }
      }
      return current;
    }

    // tab/session 已被 scheduler 或浏览器关闭时，按**当前 runtime profile**找
    // 最旧的不可逆 outbox。先重新挂回本 tab 的 session，再交给 Phase A/B；
    // 后续 clear 因此能精确删除同一条 local 记录。
    const profileId = await marineHandoffRuntimeProfileId();
    const oldest = (await marineHandoffOutboxes(profileId))[0] || null;
    if (!oldest) return null;
    await chrome.storage.session.set({ [key]: oldest.value });
    return oldest.value;
  }
  throw new Error('未知的交接单操作：' + op);
}

// chrome.storage 没有 compare-and-set。这里必须跨 tab 全局排队：local outbox 是按
// profile 共享的，只做 per-tab 队列仍会让两个 tab 同时通过「没有旧 outbox」检查。
function marineHandoff(op, tabId, value, reason) {
  if (tabId === undefined || tabId === null) {
    return Promise.reject(new Error('交接单需要 tab 身份'));
  }
  const operation = marineHandoffQueue.catch(() => {})
    .then(() => marineHandoffUnlocked(op, tabId, value, reason));
  marineHandoffQueue = operation.catch(() => {});
  return operation;
}

// 标签页关掉只删普通 session 交接；sendStarted/pendingSettlement 的 local outbox
// 必须留下，下一条腿才能 settlement-only 恢复。否则 hard timeout 关 tab 后仍会丢。
// try/catch 不是洁癖：这一行在 `chrome.runtime.onMessage` 的注册**之前**。
// 它一抛异常，消息监听器就永远挂不上，整个 SW 表现为「存在但不回消息」——
// content script 侧看到的是 `Receiving end does not exist`，而 chrome://extensions
// 里**一条错误都不显示**。实测踩过，查了很久：SW 脚本本身没崩，崩的是注册顺序。
//
// 一般规则：MV3 worker 顶层、在监听器注册完成之前的任何代码都必须防抛。
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove(MARINE_HANDOFF_PREFIX + tabId);
  });
} catch (e) {
  // 清不掉遗留交接单只是慢慢攒一点 session 存储，比丢掉整个消息通道轻得多。
}

/**
 * 让编排把自己的窗口/标签页拉到前台。
 *
 * **为什么还要抢焦点** —— 理由已经变了，别再按旧理由推断：
 *
 * 旧理由（已失效）：上下文的三道归属闸只认「当前活动标签页」。那个问题已经修好
 * 了，`orchestrated` 的 PUT 现在在写闸、挂起租约闸、失焦清理三处都放行，
 * **上下文本身不再需要任何焦点**。
 *
 * 真正的理由（实测）：**B 站的发布按钮只在窗口拿到操作系统焦点时才渲染**。
 * 只改这一个变量，结果直接翻转：
 *   窗口聚焦 → `<button> 70×32 cls=active` → posted
 *   窗口失焦 → 只剩一个 768×50 的紧凑条外壳 → 找不到按钮
 * 试过但**无效**的替代：合成 window focus 事件、在 MAIN world 覆盖
 * `document.hasFocus()`、用 CDP 真实鼠标事件点那个紧凑条 —— 三种都没能让按钮
 * 出现。所以这不是能绕过去的东西。
 *
 * 代价是自动化每跑一条腿会打断用户一次，这是知情的取舍，不是疏忽。
 *
 * tab 身份只认 `sender`，和交接单同一条规矩：让调用方自报 tabId 等于允许一个
 * 页面把别的标签页抢到前台。
 */
async function marineFocusSenderTab(sender) {
  const tab = sender && sender.tab;
  const tabId = tab && tab.id;
  if (!Number.isInteger(tabId)) throw new Error('聚焦需要 tab 身份');
  if (Number.isInteger(tab.windowId)) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  }
  try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
  return { tabId };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.__marineLoginReport) {
    void marineReportLogin(msg.result);
    return;   // 不回执：编排不等这个
  }
  if (msg && Array.isArray(msg.__marineLogBatch)) {
    // 不 return true：侧边栏那条监听也要收到同一条消息，而且日志不需要回执。
    void marineForwardLogs(msg.__marineLogBatch, sender);
  }
  if (msg && msg.__marineProspectFocusTab) {
    void marineFocusSenderTab(sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (msg && msg.__marineProspectHandoff) {
    // tab 身份只认 sender，不认消息内容 —— 让调用方自己声明 tabId 等于允许一个
    // 页面去读写别的标签页的交接单。
    void marineHandoff(msg.op, sender && sender.tab && sender.tab.id, msg.value, msg.reason)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  }
  if (msg && msg.__marineProspectReady) {
    void marineProspectReady()
      .then(data => sendResponse({ ok: true, profileId: data.profileId }))
      .catch(error => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  }
  if (msg && msg.__marineProspectApi) {
    void marineProspectApi(msg.route, msg.body)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  }
  if (msg && msg.__marineProspectProfileId) {
    void marineResolveConfig()
      .then(config => sendResponse({
        ok: true,
        profileId: config.profileId || null,
        // 调试脚手架会往 runtime-config 里写这个字段；app 打包的正式 profile
        // 永远没有，所以正式路径上它是 undefined。
        debugCdpPort: config.debugCdpPort || undefined,
      }))
      .catch(() => sendResponse({ ok: false, profileId: null }));
    return true;
  }

  if (msg && msg.__marineGenFill) {
    // content-iso 报告一次「页内生成并填入」的草稿文本，按 tab 记下供发帖回执来源判定。
    marineRecordGenFill(sender && sender.tab && sender.tab.id, msg.text);
    return; // 无需回应
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
      // 这道闸在 marineApplyContextMessage **之前**就返回，所以那里面的编排豁免
      // 够不着它 —— 必须在这里单独放行一次。触发前提是存在挂起的保留租约，而
      // 只有实现了 persistentTargetIsOpen 的平台（小红书 / 抖音）会走到，
      // 所以 B 站、知乎跑通不代表这条不存在：换平台必复发。
      const orchestrated = msg && msg.orchestrated === true;
      const hasSuspendedRetainedLease = marineFocusedWindowId === null &&
        marineActiveTabId === null && Number.isInteger(marineSuspendedRetainedTabId);
      if (hasSuspendedRetainedLease && msg.op === 'put' && !orchestrated &&
          !marineExactSuspendedRetainedRenewal(msg, sender, sourceId)) {
        // While Chrome is explicitly unfocused, never let another tab, a
        // retired document, or a newer/older revision mutate worker ownership
        // before it has re-proved foreground authority.
        return { immediate: { ok: true, skipped: true, reason: 'suspended-lease' } };
      }
      if (hasSuspendedRetainedLease && msg.op === 'delete' &&
          tabId === marineSuspendedRetainedTabId &&
          !marineExactSuspendedRetainedDelete(msg, sender, sourceId)) {
        return { immediate: { ok: true, skipped: true } };
      }
      const source = marinePrepareSource(tabId, sourceId);
      if (!source.accepted) return { immediate: { ok: true, skipped: true, reason: 'retired-source' } };
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
        return marineApplyContextMessage(msg, sender, expectedEpoch, sourceId, {
          allowDefer: !hasSuspendedRetainedLease,
          allowSuspendedRetainedRenewal: hasSuspendedRetainedLease &&
            msg.op === 'put' && msg.leaseRenewal === true,
        });
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

async function marineSetActiveTab(tabId, shouldApply = () => true, options = {}) {
  await marineStateReady;
  if (!shouldApply()) return false;
  const previous = marineActiveTabId;
  const previousContext = Number.isInteger(previous) ? marineTabContexts.get(previous) : null;
  if (tabId == null && options.preserveRetained === true) {
    if (previousContext && previousContext.retainWhenUnfocused === true) {
      marineSuspendedRetainedTabId = previous;
      marineActiveTabId = null;
      marinePersistState();
      return true;
    }
    // A focus-gain event first parks the current tab while Chrome resolves the
    // newly focused window's active tab. Keep an already suspended XHS reply
    // through that short query, but let ordinary (focus-bound) contexts fall
    // through to the original clear path.
    if (!Number.isInteger(previous) && Number.isInteger(marineSuspendedRetainedTabId)) {
      marineActiveTabId = null;
      marinePersistState();
      return true;
    }
  }
  const suspended = marineSuspendedRetainedTabId;
  if (Number.isInteger(suspended) && tabId != null) {
    marineSuspendedRetainedTabId = null;
    if (suspended !== tabId && !marineTabIsOrchestrated(suspended)) marineClearTrackedTab(suspended);
  } else if (tabId == null && options.preserveRetained !== true) {
    marineSuspendedRetainedTabId = null;
    if (Number.isInteger(suspended) && !marineTabIsOrchestrated(suspended)) {
      marineClearTrackedTab(suspended);
    }
  }
  marineActiveTabId = tabId;
  marinePersistState();
  // 编排的上下文不随焦点走。清理会 DELETE 掉 contextId（后端记进 revoked，同 id
  // 再也写不进去），而编排期间人本来就在用别的程序 —— 那等于每切一次窗口就废掉
  // 一条腿。真正该清的时机仍然照旧：导航（tabs.onUpdated）和关闭（tabs.onRemoved）。
  if (previous != null && previous !== tabId && !marineTabIsOrchestrated(previous)) {
    marineClearTrackedTab(previous);
  }
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
      void marineSetActiveTab(
        null,
        () => epoch === marineFocusEpoch && marineFocusedWindowId === null,
        { preserveRetained: true },
      );
      return;
    }
    marineFocusedWindowId = windowId;
    const activeTabQuery = chrome.tabs.query({ active: true, windowId }).catch(() => null);
    void marineSetActiveTab(
      null,
      () => marineFocusEpochIsCurrent(epoch, windowId),
      { preserveRetained: true },
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
  if (changeInfo.status === 'complete' && tab && marineIsPublishCapableUrl(tab.url)) {
    void marineEnsurePublishedCapture(tabId);
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  marineGenFills.delete(tabId);
  void marineStateReady.then(() => marineClearTrackedTab(tabId, { retireSource: true, removed: true }));
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void marineRetryPublishedOutbox('browser-startup');
    void marineEnsurePublishedCaptureForExistingTabs('browser-startup');
  });
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm || alarm.name !== marinePublishedRetryAlarm) return;
    // 若这次 alarm 正是把 sw 冷启起来的那次，顶层的 worker-start 重试已经入队，
    // 这里再来一遍只是重复 load + resolveConfig。
    if (Date.now() - marineLastOutboxRunAt < 5000) return;
    void marineRetryPublishedOutbox('alarm');
  });
}
// 不再无条件建 alarm：由 marineSavePublishedOutbox 按队列是否为空来建/撤，
// 而这次 worker-start 重试本身就会把空队列对应的残留 alarm 清掉。
void marineRetryPublishedOutbox('worker-start');
void marineEnsurePublishedCaptureForExistingTabs('worker-start');
