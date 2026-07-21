import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function eventSource() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
    first() {
      assert.equal(listeners.length, 1);
      return listeners[0];
    },
  };
}

const runtimeMessages = eventSource();
const installed = eventSource();
const storageChanged = eventSource();
const tabActivated = eventSource();
const tabUpdated = eventSource();
const tabRemoved = eventSource();
const windowFocusChanged = eventSource();
const apiCalls = [];
const putBodies = [];
const revokedContextIds = new Set();
const putGates = new Map();
const deleteGates = new Map();
const restoredContextId = "restored-before-storage-hang";
const restoredSourceId = "document-restored-before-storage-hang";
const restoredRevision = 7;
const sessionState = {
  marineRimeLeaseStateV1: {
    activeTabKnown: true,
    activeTabId: 1,
    suspendedRetainedTabId: null,
    tabs: {
      "1": {
        contextId: restoredContextId,
        revision: restoredRevision,
        sourceId: restoredSourceId,
        windowId: 10,
        retainWhenUnfocused: true,
        reservation: null,
      },
    },
  },
};
const activeTabByWindow = new Map();
const activeTabQueryGates = new Map();
const activeTabQueryFailures = new Set();
const activeTabQueryHangsOnce = new Set();
const windowGetHangsOnce = new Set();
let sessionGetHangsOnce = true;
let sessionGetCalls = 0;
let focusedWindowId = 10;

function gatePut(contextId) {
  let release;
  let seen;
  const seenPromise = new Promise((resolve) => {
    seen = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  putGates.set(contextId, { releasePromise, seen });
  return { release, seenPromise };
}

function gateDelete(contextId) {
  let release;
  let seen;
  const seenPromise = new Promise((resolve) => {
    seen = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  deleteGates.set(contextId, { releasePromise, seen });
  return { release, seenPromise };
}

function gateActiveTabQuery(windowId) {
  let release;
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  activeTabQueryGates.set(windowId, releasePromise);
  return () => {
    activeTabQueryGates.delete(windowId);
    release();
  };
}

async function fetchMock(url, options = {}) {
  const value = String(url);
  if (value.endsWith("marine-runtime-config.json")) {
    return {
      ok: true,
      async json() {
        return {
          apiBase: "http://127.0.0.1:10108/v1/marine",
          token: "test-token",
          profileId: "runtime-profile",
        };
      },
    };
  }
  if (value.startsWith("chrome-extension://test/skills/")) {
    const relative = value.slice("chrome-extension://test/".length);
    const contents = fs.readFileSync(new URL("../" + relative, import.meta.url), "utf8");
    return { ok: true, async text() { return contents; } };
  }

  const method = options.method || "GET";
  assert.equal(options.headers?.Authorization, "Bearer test-token");
  const body = options.body ? JSON.parse(options.body) : null;
  const contextId = body?.contextId
    || new URL(value).searchParams.get("contextId")
    || "";
  apiCalls.push({ method, contextId });
  if (method === "PUT") putBodies.push(body);
  if (method === "DELETE") {
    const gate = deleteGates.get(contextId);
    if (gate) {
      gate.seen();
      await gate.releasePromise;
      deleteGates.delete(contextId);
    }
    if (contextId) revokedContextIds.add(contextId);
    return { ok: true, status: 204, async text() { return ""; } };
  }
  if (method === "PUT" && revokedContextIds.has(contextId)) {
    return {
      ok: false,
      status: 409,
      async text() { return "browser target was already revoked"; },
    };
  }
  const gate = method === "PUT" ? putGates.get(contextId) : null;
  if (gate) {
    gate.seen();
    await gate.releasePromise;
    putGates.delete(contextId);
  }
  return { ok: true, status: 200, async text() { return ""; } };
}

const chrome = {
  runtime: {
    onInstalled: installed,
    onMessage: runtimeMessages,
    getURL(relative) {
      return `chrome-extension://test/${relative}`;
    },
  },
  sidePanel: {
    async setPanelBehavior() {},
  },
  storage: {
    local: {
      async get() {
        return {};
      },
    },
    session: {
      async get(key) {
        sessionGetCalls += 1;
        if (sessionGetHangsOnce) {
          sessionGetHangsOnce = false;
          await new Promise(() => {});
        }
        return { [key]: sessionState[key] };
      },
      async set(values) {
        Object.assign(sessionState, values);
      },
    },
    onChanged: storageChanged,
  },
  tabs: {
    onActivated: tabActivated,
    onUpdated: tabUpdated,
    onRemoved: tabRemoved,
    async query({ windowId }) {
      if (activeTabQueryHangsOnce.delete(windowId)) await new Promise(() => {});
      const gate = activeTabQueryGates.get(windowId);
      if (gate) await gate;
      if (activeTabQueryFailures.delete(windowId)) throw new Error("injected tabs.query failure");
      const tabId = activeTabByWindow.get(windowId);
      return tabId == null ? [] : [{ id: tabId, active: true, windowId }];
    },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: windowFocusChanged,
    async get(windowId) {
      if (windowGetHangsOnce.delete(windowId)) await new Promise(() => {});
      return { id: windowId, focused: focusedWindowId === windowId };
    },
  },
};

const helperSource = fs.readFileSync(new URL("../src/scholay-skill.js", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/sw.js", import.meta.url), "utf8");
const workerContext = vm.createContext({
  AbortController,
  URL,
  chrome,
  clearTimeout,
  console,
  fetch: fetchMock,
  importScripts() {},
  Map,
  Promise,
  setTimeout,
  TextEncoder,
});
vm.runInContext(helperSource + "\n" + source, workerContext, {
  filename: "marine-extension/src/sw.js",
});

const onMessage = runtimeMessages.first();

function sendContext(tabId, message, tab = {}) {
  return new Promise((resolve) => {
    const asynchronous = onMessage(
      { __marineRimeContext: true, ...message },
      { tab: { id: tabId, ...tab } },
      resolve,
    );
    assert.equal(asynchronous, true);
  });
}

async function expectAckBefore(promise, timeoutMs, detail) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(detail)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function putMessage(
  contextId,
  revision,
  sourceId = "document-a",
  retainWhenUnfocused = false,
  leaseRenewal = false,
) {
  return {
    op: "put",
    contextId,
    revision,
    sourceId,
    retainWhenUnfocused,
    leaseRenewal,
    context: { contextId },
  };
}

function reserveMessage(contextId, revision, sourceId = "document-a") {
  return {
    op: "reserve",
    contextId,
    revision,
    sourceId,
    retainWhenUnfocused: true,
    leaseRenewal: false,
    context: null,
  };
}

function deleteMessage(contextId, revision, sourceId) {
  return {
    op: "delete",
    contextId,
    revision,
    sourceId,
    context: null,
  };
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, timeoutMs, detail) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(detail);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function workerLeaseSnapshot() {
  return JSON.parse(vm.runInContext(`JSON.stringify({
    phase: marineStatePhase,
    activeTabId: marineActiveTabId,
    focusedWindowId: marineFocusedWindowId,
    suspendedRetainedTabId: marineSuspendedRetainedTabId,
    contexts: Array.from(marineTabContexts.entries()),
    sources: Array.from(marineTabSources.entries()),
    revisions: Array.from(marineLatestRevisions.entries())
  })`, workerContext));
}

function focusWindow(windowId) {
  focusedWindowId = windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId;
  windowFocusChanged.emit(windowId);
}

activeTabByWindow.set(10, 1);
activeTabByWindow.set(11, 99);
const stuckRestoreCleanup = gateDelete(restoredContextId);
const sessionBeforeHungRestore = JSON.stringify(sessionState);
const workerBeforeHungRestore = workerLeaseSnapshot();
const callsBeforeColdBackgroundSender = apiCalls.length;
const coldBackgroundSender = await expectAckBefore(
  sendContext(
    99,
    putMessage("cold-background-sender", 1, "document-cold-background"),
    { active: true, windowId: 11 },
  ),
  1400,
  "a stuck storage.session restore must not outlive the content ACK deadline",
);
assert.equal(coldBackgroundSender.skipped, true);
assert.equal(coldBackgroundSender.deferred, true);
tabUpdated.emit(1, { status: "loading" });
tabRemoved.emit(1);
activeTabByWindow.set(10, 3);
tabActivated.emit({ tabId: 3, windowId: 10 });
focusWindow(10);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(
  apiCalls.length,
  callsBeforeColdBackgroundSender,
  "a message received before restore must not reach localhost",
);
assert.equal(
  JSON.stringify(sessionState),
  sessionBeforeHungRestore,
  "a restore timeout must not overwrite the persisted lease",
);
assert.deepEqual(
  workerLeaseSnapshot(),
  workerBeforeHungRestore,
  "messages and tab/window events must not mutate authority while restore is pending",
);

await waitFor(
  () => sessionGetCalls >= 2,
  1200,
  "the worker did not retry the timed-out storage.session read",
);
await flushTasks();
const restoredWorker = workerLeaseSnapshot();
assert.equal(restoredWorker.phase, "ready");
assert.equal("activeTabId" in restoredWorker, false);
assert.equal("focusedWindowId" in restoredWorker, false);
assert.deepEqual(restoredWorker.contexts, []);
assert.deepEqual(restoredWorker.sources, []);
assert.deepEqual(restoredWorker.revisions, []);
await expectAckBefore(
  stuckRestoreCleanup.seenPromise,
  1400,
  "the invalid restored context was not deleted",
);

// The destructive events tombstone the old lease before ready. Even while its
// exact DELETE is stuck, the old document cannot renew and a fresh sender can
// re-prove current focus without having its ACK blocked by that cleanup.
const callsBeforeRestoredSender = apiCalls.length;
const restoredRenewal = putMessage(
  restoredContextId,
  restoredRevision,
  restoredSourceId,
  true,
  true,
);
assert.equal(
  (await sendContext(1, restoredRenewal, { active: true, windowId: 10 })).skipped,
  true,
);
const recoveredAfterPendingEventsId = "recovered-after-pending-tab-events";
assert.equal(
  (await expectAckBefore(
    sendContext(
      3,
      putMessage(recoveredAfterPendingEventsId, 1, "document-after-pending-events", true),
      { active: true, windowId: 10 },
    ),
    1400,
    "a stuck restored-context DELETE must not block a fresh Rime ACK",
  )).ok,
  true,
);
assert.deepEqual(
  apiCalls.slice(callsBeforeRestoredSender).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: recoveredAfterPendingEventsId }],
  "only the fresh focus-verified sender may reach localhost",
);
stuckRestoreCleanup.release();
await flushTasks();

// A previous context DELETE remains ordered ahead of the next PUT, but a slow
// localhost cleanup must not delay the reservation ACK sent before page grab.
const slowRestoreCleanup = gateDelete(recoveredAfterPendingEventsId);
const replacementReservationId = "reservation-after-restored-context";
const replacementReservation = await expectAckBefore(
  sendContext(
    3,
    reserveMessage(replacementReservationId, 1, "document-after-restore"),
    { active: true, windowId: 10 },
  ),
  1000,
  "a slow old-context cleanup must not block the reservation ACK",
);
assert.equal(replacementReservation.ok, true);
await expectAckBefore(
  slowRestoreCleanup.seenPromise,
  1400,
  "the replaced context cleanup did not start",
);
slowRestoreCleanup.release();
await flushTasks();
tabUpdated.emit(3, { status: "loading" });
activeTabByWindow.set(10, 1);
await flushTasks();

// Chrome focus APIs have occasionally returned Promises that never settle in
// an upgraded live profile. Their timeout must ACK fail-closed, then let the
// same sender prove ownership on its next attempt without reloading extension.
activeTabQueryHangsOnce.add(10);
focusWindow(10);
await new Promise((resolve) => setTimeout(resolve, 450));
windowGetHangsOnce.add(10);
const callsBeforeHungFocusRecovery = apiCalls.length;
const hungFocusAttempt = await expectAckBefore(
  sendContext(
    1,
    reserveMessage("hung-focus-api-recovery", 1, "document-focus-hang"),
    { active: true, windowId: 10 },
  ),
  1400,
  "a stuck focus API must not outlive the content ACK deadline",
);
assert.equal(hungFocusAttempt.skipped, true);
assert.equal(apiCalls.length, callsBeforeHungFocusRecovery);
assert.equal(
  (await sendContext(
    1,
    reserveMessage("hung-focus-api-recovery", 1, "document-focus-hang"),
    { active: true, windowId: 10 },
  )).ok,
  true,
  "the next focus check must recover without reloading the extension",
);
assert.equal(
  (await sendContext(
    1,
    putMessage("hung-focus-api-recovery", 1, "document-focus-hang", true),
    { active: true, windowId: 10 },
  )).ok,
  true,
);
tabUpdated.emit(1, { status: "loading" });
await flushTasks();

tabActivated.emit({ tabId: 1, windowId: 10 });
await flushTasks();
const firstGate = gatePut("tab-one-old");
const oldPut = sendContext(1, putMessage("tab-one-old", 1));
await firstGate.seenPromise;
tabActivated.emit({ tabId: 2, windowId: 10 });
firstGate.release();
assert.equal((await oldPut).skipped, true);
assert.deepEqual(
  apiCalls.filter((call) => call.contextId === "tab-one-old"),
  [
    { method: "PUT", contextId: "tab-one-old" },
    { method: "DELETE", contextId: "tab-one-old" },
  ],
  "an in-flight PUT from the old tab must be conditionally undone",
);

assert.equal((await sendContext(2, putMessage("tab-two-current", 1))).ok, true);
const callsBeforeStaleRevision = apiCalls.length;
assert.equal((await sendContext(2, putMessage("tab-two-stale", 0))).skipped, undefined);
// Revision zero is reserved for compatibility and is therefore accepted.
assert.equal(apiCalls.length, callsBeforeStaleRevision + 1);

assert.equal((await sendContext(2, putMessage("tab-two-new", 3))).ok, true);
const callsBeforeOldRevision = apiCalls.length;
assert.equal((await sendContext(2, putMessage("tab-two-too-old", 2))).skipped, true);
assert.equal(apiCalls.length, callsBeforeOldRevision);

const navigationGate = gatePut("navigation-old");
const navigationPut = sendContext(2, putMessage("navigation-old", 4));
await navigationGate.seenPromise;
tabUpdated.emit(2, {
  url: "https://www.bilibili.com/video/BVNEW",
  status: "loading",
});
navigationGate.release();
assert.equal((await navigationPut).skipped, true);
assert.ok(
  apiCalls.some((call) => call.method === "DELETE" && call.contextId === "navigation-old"),
  "navigation must invalidate and remove an in-flight context",
);

const callsBeforeNewDocument = apiCalls.length;
assert.equal(
  (await sendContext(2, putMessage("new-document-revision-one", 1, "document-b"))).ok,
  true,
  "a new document must restart at revision one",
);
assert.deepEqual(
  apiCalls.slice(callsBeforeNewDocument).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "new-document-revision-one" }],
);

const callsBeforeRetiredDocument = apiCalls.length;
assert.equal(
  (await sendContext(2, putMessage("retired-document-late", 99, "document-a"))).skipped,
  true,
  "late messages from a retired document must be ignored",
);
assert.equal(apiCalls.length, callsBeforeRetiredDocument);

await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(
  sessionState.marineRimeLeaseStateV1.tabs["2"].contextId,
  "new-document-revision-one",
  "the active lease must survive an MV3 service-worker restart via storage.session",
);

// Focusing another Chrome window does not emit tabs.onActivated. The service
// worker must still resolve that window's active tab and retire the previous
// window's target.
activeTabByWindow.set(20, 3);
focusWindow(20);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  (await sendContext(3, putMessage("second-window", 1, "document-c"))).ok,
  true,
  "the active tab in a newly focused Chrome window must be accepted",
);
assert.ok(
  apiCalls.some((call) => call.method === "DELETE" && call.contextId === "new-document-revision-one"),
  "switching Chrome windows must clear the previous window's target",
);

// tabs.onActivated also fires when a tab becomes active inside a background
// window. It must not steal the global lease from the focused window.
activeTabByWindow.set(10, 6);
tabActivated.emit({ tabId: 6, windowId: 10 });
await flushTasks();
const callsBeforeBackgroundActivation = apiCalls.length;
const focusedWindowResult = await sendContext(
  3,
  putMessage("focused-window-still-active", 2, "document-c"),
);
assert.equal(
  focusedWindowResult.skipped,
  undefined,
  "activating a tab in a background window must not replace the focused tab",
);
assert.deepEqual(
  apiCalls.slice(callsBeforeBackgroundActivation).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "focused-window-still-active" }],
);

// Focus queries can resolve in reverse order. Only the newest focus epoch may
// commit, even if an older window's tabs.query finishes last.
activeTabByWindow.set(50, 7);
activeTabByWindow.set(60, 8);
const releaseOlderFocusQuery = gateActiveTabQuery(50);
const releaseNewerFocusQuery = gateActiveTabQuery(60);
focusWindow(50);
focusWindow(60);
releaseNewerFocusQuery();
await flushTasks();
releaseOlderFocusQuery();
await flushTasks();
const callsBeforeReverseQueryPut = apiCalls.length;
const reverseQueryResult = await sendContext(
  8,
  putMessage("reverse-query-order", 1, "document-reverse-order"),
);
assert.equal(
  reverseQueryResult.skipped,
  undefined,
  "an older tabs.query result must not overwrite the newest focused window",
);
assert.deepEqual(
  apiCalls.slice(callsBeforeReverseQueryPut).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "reverse-query-order" }],
);

// Chrome reports a focused-window change before tabs.query has resolved the
// active tab. A context PUT can arrive in that gap. It must remain fail-closed
// initially, then be replayed by the service worker as soon as Chrome confirms
// that same tab, without waiting for the content script's long refresh timer.
activeTabByWindow.set(30, 4);
const releaseFocusQuery = gateActiveTabQuery(30);
focusWindow(30);
await flushTasks();
const callsBeforeOldWindowDuringQuery = apiCalls.length;
const oldWindowDuringQuery = await sendContext(
  8,
  putMessage("old-window-during-focus-query", 2, "document-reverse-order"),
  { active: true, windowId: 60 },
);
assert.equal(oldWindowDuringQuery.skipped, true);
assert.equal(oldWindowDuringQuery.deferred, true);
assert.deepEqual(
  apiCalls.slice(callsBeforeOldWindowDuringQuery).filter((call) => call.method === "PUT"),
  [],
  "the previously focused window must stay fail-closed while the new active tab is unresolved",
);
tabRemoved.emit(8);
await flushTasks();
const callsBeforeInverseFocusRace = apiCalls.length;
const inverseFocusRace = await sendContext(
  4,
  putMessage("inverse-focus-race", 1, "document-d"),
  { active: true, windowId: 30 },
);
assert.equal(inverseFocusRace.skipped, true);
assert.equal(inverseFocusRace.deferred, true);
assert.deepEqual(
  apiCalls.slice(callsBeforeInverseFocusRace).filter((call) => call.method === "PUT"),
  [],
  "an unconfirmed cross-window target must not reach the API",
);
releaseFocusQuery();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(
  apiCalls.slice(callsBeforeInverseFocusRace).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "inverse-focus-race" }],
  "the service worker must replay the skipped PUT after active-tab confirmation",
);

// The event order can be even less favorable: the new window's content script
// publishes before windows.onFocusChanged itself is delivered. Keep the PUT
// local until that later focus event confirms the tab, then replay it once.
activeTabByWindow.set(40, 5);
const callsBeforePutFirstRace = apiCalls.length;
const putFirstRace = await sendContext(
  5,
  putMessage("put-before-focus-event", 1, "document-e"),
  { active: true, windowId: 40 },
);
assert.equal(putFirstRace.skipped, true);
assert.equal(putFirstRace.deferred, true);
assert.equal(apiCalls.length, callsBeforePutFirstRace);
focusWindow(40);
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(
  apiCalls.slice(callsBeforePutFirstRace).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "put-before-focus-event" }],
  "a PUT delivered before the focus event must converge without a content-script resend",
);

// WINDOW_ID_NONE is an explicit no-focused-window state, not startup
// uncertainty. A late content message must remain local until Chrome reports
// that a window is focused again.
activeTabByWindow.set(70, 9);
const releaseUnfocusedQuery = gateActiveTabQuery(70);
focusWindow(70);
focusWindow(chrome.windows.WINDOW_ID_NONE);
releaseUnfocusedQuery();
await flushTasks();
const callsBeforeStaleUnfocusedQuery = apiCalls.length;
const staleUnfocusedQueryPut = await sendContext(
  9,
  putMessage("stale-query-after-window-none", 1, "document-stale-unfocused"),
  { active: true, windowId: 70 },
);
assert.equal(staleUnfocusedQueryPut.skipped, true);
assert.equal(staleUnfocusedQueryPut.deferred, true);
assert.equal(
  apiCalls.length,
  callsBeforeStaleUnfocusedQuery,
  "a query started before WINDOW_ID_NONE must not restore an obsolete active tab",
);
tabRemoved.emit(9);
await flushTasks();
const callsBeforeNoFocusedWindow = apiCalls.length;
const noFocusedWindowPut = await sendContext(
  5,
  putMessage("no-focused-window", 2, "document-e"),
  { active: true, windowId: 40 },
);
assert.equal(noFocusedWindowPut.skipped, true);
assert.equal(noFocusedWindowPut.deferred, true);
assert.equal(apiCalls.length, callsBeforeNoFocusedWindow);
focusWindow(40);
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(
  apiCalls.slice(callsBeforeNoFocusedWindow).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "no-focused-window" }],
  "an explicit no-window state must not self-promote a late tab message",
);

const callsBeforeOversized = apiCalls.length;
const oversized = putMessage("oversized-context", 2, "document-e");
oversized.context.payload = { comments: { agentMd: "界".repeat(700_000) } };
const oversizedResult = await sendContext(5, oversized);
assert.equal(oversizedResult.ok, false);
assert.match(oversizedResult.error, /安全传输上限/);
assert.equal(apiCalls.length, callsBeforeOversized, "oversized context must never reach the API");

// A one-off tabs.query failure must not strand the worker in a state where
// every later PUT merely expires as deferred. The next verified active sender
// should be able to recover without another window/tab event.
activeTabByWindow.set(80, 10);
activeTabQueryFailures.add(80);
focusWindow(80);
await flushTasks();
const callsBeforeQueryFailureRecovery = apiCalls.length;
const recoveredAfterQueryFailure = await sendContext(
  10,
  putMessage("query-failure-recovery", 1, "document-query-recovery"),
  { active: true, windowId: 80 },
);
assert.equal(recoveredAfterQueryFailure.ok, true);
assert.deepEqual(
  apiCalls.slice(callsBeforeQueryFailureRecovery).filter((call) => call.method === "PUT"),
  [{ method: "PUT", contextId: "query-failure-recovery" }],
  "a verified sender must recover after a transient active-tab query failure",
);

// Both Marine actions declare requiresFocus=false. Losing Chrome focus must
// park the exact retained lease even if its first localhost PUT is still in
// flight; another tab/source/revision must not gain authority in that gap.
const retainedContextId = "marine-action-retained-across-window-blur";
const retainedPutGate = gatePut(retainedContextId);
const callsBeforeRetainedPut = apiCalls.length;
assert.equal(
  (await sendContext(
    10,
    reserveMessage(retainedContextId, 2, "document-query-recovery"),
    { active: true, windowId: 80 },
  )).ok,
  true,
  "the exact target must be reserved before the slow page grab starts",
);
assert.equal(
  apiCalls.length,
  callsBeforeRetainedPut,
  "a pre-grab reservation must not expose an incomplete action to localhost",
);
focusWindow(chrome.windows.WINDOW_ID_NONE);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(
  sessionState.marineRimeLeaseStateV1.tabs["10"].reservation.contextId,
  retainedContextId,
  "the focus-verified reservation must survive WINDOW_ID_NONE and an MV3 restart",
);
const retainedPutPromise = sendContext(
  10,
  putMessage(retainedContextId, 2, "document-query-recovery", true),
  { active: true, windowId: 80 },
);
await retainedPutGate.seenPromise;
const callsBeforeRetainedBlur = apiCalls.length;
const callsBeforePendingIntruders = apiCalls.length;
for (const result of await Promise.all([
  sendContext(11, putMessage(
    retainedContextId, 2, "document-query-recovery", true,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    retainedContextId, 3, "document-query-recovery", true,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    retainedContextId, 2, "different-document", true,
  ), { active: true, windowId: 80 }),
])) {
  assert.equal(result.skipped, true);
}
assert.equal(
  apiCalls.length,
  callsBeforePendingIntruders,
  "no competing message may reach localhost while the first retained PUT is suspended",
);
retainedPutGate.release();
assert.equal((await retainedPutPromise).ok, true);
assert.deepEqual(
  apiCalls.slice(callsBeforeRetainedPut).filter(
    (call) => call.contextId === retainedContextId,
  ),
  [{ method: "PUT", contextId: retainedContextId }],
  "the first retained PUT must finish without a compensating DELETE after WINDOW_ID_NONE",
);
assert.equal(
  apiCalls.slice(callsBeforeRetainedBlur).some(
    (call) => call.method === "DELETE" && call.contextId === retainedContextId,
  ),
  false,
  "a retained Marine action must survive Chrome WINDOW_ID_NONE",
);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(
  sessionState.marineRimeLeaseStateV1.suspendedRetainedTabId,
  10,
  "the retained tab must be persisted while Chrome focus is outside the browser",
);
assert.equal(
  sessionState.marineRimeLeaseStateV1.tabs["10"].retainWhenUnfocused,
  true,
  "the persisted context must retain its explicit unfocused-lifetime capability",
);

// A pure timestamp renewal reuses the exact acknowledged revision. Repeating
// it models the minute timer running beyond the server's five-minute TTL: every
// tick must reach localhost without re-granting ownership to any other sender.
const callsBeforeRetainedRenewals = apiCalls.length;
for (let minute = 1; minute <= 6; minute++) {
  const renewal = putMessage(
    retainedContextId,
    2,
    "document-query-recovery",
    true,
    true,
  );
  renewal.context.updatedAt = 1_000_000 + minute * 60_000;
  const result = await sendContext(10, renewal, { active: true, windowId: 80 });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
}
assert.equal(
  apiCalls.slice(callsBeforeRetainedRenewals).filter(
    (call) => call.method === "PUT" && call.contextId === retainedContextId,
  ).length,
  6,
  "the exact suspended lease must remain renewable for longer than five minutes",
);

const callsBeforeRejectedRenewals = apiCalls.length;
const rejectedRenewals = [
  sendContext(11, putMessage(
    retainedContextId, 2, "document-query-recovery", true, true,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    retainedContextId, 2, "document-other", true, true,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    retainedContextId, 3, "document-query-recovery", true, true,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    "different-context", 2, "document-query-recovery", true, true,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    retainedContextId, 2, "document-query-recovery", true, false,
  ), { active: true, windowId: 80 }),
  sendContext(10, putMessage(
    retainedContextId, 2, "document-query-recovery", false, true,
  ), { active: true, windowId: 80 }),
];
for (const result of await Promise.all(rejectedRenewals)) {
  assert.equal(result.skipped, true);
  assert.equal(result.deferred, undefined);
}
assert.equal(
  apiCalls.length,
  callsBeforeRejectedRenewals,
  "another tab/source/revision/context or a non-retained PUT must not renew the suspended lease",
);
assert.equal(
  sessionState.marineRimeLeaseStateV1.tabs["10"].contextId,
  retainedContextId,
  "rejected renewals must not mutate the tracked retained context",
);

focusWindow(80);
await flushTasks();
assert.equal(
  apiCalls.slice(callsBeforeRetainedBlur).some(
    (call) => call.method === "DELETE" && call.contextId === retainedContextId,
  ),
  false,
  "returning to the same Chrome tab must restore the parked Marine action",
);

activeTabByWindow.set(80, 11);
tabActivated.emit({ tabId: 11, windowId: 80 });
await flushTasks();
assert.equal(
  apiCalls.slice(callsBeforeRetainedBlur).some(
    (call) => call.method === "DELETE" && call.contextId === retainedContextId,
  ),
  true,
  "switching away from the Marine target tab must revoke the retained action",
);

// Closing the actual retained target while Chrome is unfocused is different
// from a renewal: the same source may advance its revision and DELETE must hit
// localhost immediately instead of waiting for browser focus to return.
const closeWhileUnfocusedId = "marine-target-closed-while-unfocused";
assert.equal(
  (await sendContext(
    11,
    putMessage(closeWhileUnfocusedId, 1, "document-close-target", true),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
focusWindow(chrome.windows.WINDOW_ID_NONE);
await flushTasks();
const callsBeforeCloseWhileUnfocused = apiCalls.length;
const closedWhileUnfocused = await sendContext(
  11,
  deleteMessage(closeWhileUnfocusedId, 2, "document-close-target"),
  { active: true, windowId: 80 },
);
assert.equal(closedWhileUnfocused.ok, true);
assert.deepEqual(
  apiCalls.slice(callsBeforeCloseWhileUnfocused).filter(
    (call) => call.contextId === closeWhileUnfocusedId,
  ),
  [{ method: "DELETE", contextId: closeWhileUnfocusedId }],
  "closing the retained target must revoke it immediately during WINDOW_ID_NONE",
);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(sessionState.marineRimeLeaseStateV1.suspendedRetainedTabId, null);

// The content transport gives up waiting for an ACK before the worker's fetch
// timeout. A higher-revision close must therefore cancel the exact pending PUT
// synchronously, even though its DELETE operation queues behind that fetch.
focusWindow(80);
await flushTasks();
const slowContextId = "retained-put-closed-before-slow-ack";
assert.equal(
  (await sendContext(
    11,
    reserveMessage(slowContextId, 1, "document-slow-close"),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
const slowPutGate = gatePut(slowContextId);
const callsBeforeSlowClose = apiCalls.length;
const slowPutPromise = sendContext(
  11,
  putMessage(slowContextId, 1, "document-slow-close", true),
  { active: true, windowId: 80 },
);
await slowPutGate.seenPromise;
focusWindow(chrome.windows.WINDOW_ID_NONE);
await flushTasks();
const slowDeletePromise = sendContext(
  11,
  deleteMessage(slowContextId, 2, "document-slow-close"),
  { active: true, windowId: 80 },
);
await flushTasks();
slowPutGate.release();
const [slowPutResult, slowDeleteResult] = await Promise.all([
  slowPutPromise,
  slowDeletePromise,
]);
assert.equal(slowPutResult.skipped, true);
assert.equal(slowDeleteResult.ok, true);
assert.deepEqual(
  apiCalls.slice(callsBeforeSlowClose).filter((call) => call.contextId === slowContextId),
  [
    { method: "PUT", contextId: slowContextId },
    { method: "DELETE", contextId: slowContextId },
    { method: "DELETE", contextId: slowContextId },
  ],
  "a close arriving before the slow PUT ACK must revoke and tombstone that exact lease",
);

// A browser/extension can activate another tab while Chrome itself is not the
// focused application. That owner-window tab switch still revokes the parked
// lease; an activation in an unrelated Chrome window does not.
focusWindow(80);
await flushTasks();
const activationContextId = "retained-revoked-by-unfocused-tab-activation";
assert.equal(
  (await sendContext(
    11,
    reserveMessage(activationContextId, 3, "document-slow-close"),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
assert.equal(
  (await sendContext(
    11,
    putMessage(activationContextId, 3, "document-slow-close", true),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
focusWindow(chrome.windows.WINDOW_ID_NONE);
await flushTasks();
const callsBeforeOtherWindowActivation = apiCalls.length;
tabActivated.emit({ tabId: 99, windowId: 999 });
await flushTasks();
assert.equal(
  apiCalls.length,
  callsBeforeOtherWindowActivation,
  "an unrelated background-window activation must not revoke the owner lease",
);
tabActivated.emit({ tabId: 12, windowId: 80 });
await flushTasks();
assert.equal(
  apiCalls.slice(callsBeforeOtherWindowActivation).some((call) =>
    call.method === "DELETE" && call.contextId === activationContextId),
  true,
  "a different tab activated in the owner window must revoke the suspended lease",
);

// A normal same-window tab switch revokes and tombstones the old tab's server
// context. The old ID must stay rejected after return; content converges by
// deleting that obsolete activation idempotently, reserving a fresh ID at a
// higher revision, and publishing the full replacement context.
activeTabByWindow.set(80, 13);
focusWindow(80);
await flushTasks();
const foregroundContextId = "same-editor-before-tab-away";
assert.equal(
  (await sendContext(
    13,
    putMessage(foregroundContextId, 1, "document-tab-return", true),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
const callsBeforeForegroundTabAway = apiCalls.length;
activeTabByWindow.set(80, 14);
tabActivated.emit({ tabId: 14, windowId: 80 });
await flushTasks();
assert.deepEqual(
  apiCalls.slice(callsBeforeForegroundTabAway).filter(
    (call) => call.contextId === foregroundContextId,
  ),
  [{ method: "DELETE", contextId: foregroundContextId }],
  "switching tabs must first revoke the previously published context",
);
activeTabByWindow.set(80, 13);
tabActivated.emit({ tabId: 13, windowId: 80 });
await flushTasks();
const callsBeforeForegroundReassert = apiCalls.length;
const tombstonedRenewal = putMessage(
  foregroundContextId,
  1,
  "document-tab-return",
  true,
  true,
);
tombstonedRenewal.context.updatedAt = 2_000_000;
const tombstonedRenewalResult = await sendContext(
  13,
  tombstonedRenewal,
  { active: true, windowId: 80 },
);
assert.equal(tombstonedRenewalResult.ok, false);
assert.match(tombstonedRenewalResult.error, /HTTP 409/);
assert.deepEqual(
  apiCalls.slice(callsBeforeForegroundReassert).filter(
    (call) => call.contextId === foregroundContextId,
  ),
  [{ method: "PUT", contextId: foregroundContextId }],
  "production tombstones must reject attempts to renew the deleted activation ID",
);

const replacementContextId = "same-editor-new-activation-after-tab-return";
assert.notEqual(replacementContextId, foregroundContextId);
assert.equal(
  (await sendContext(
    13,
    deleteMessage(foregroundContextId, 2, "document-tab-return"),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
assert.equal(
  (await sendContext(
    13,
    reserveMessage(replacementContextId, 3, "document-tab-return"),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
const callsBeforeReplacementPut = apiCalls.length;
assert.equal(
  (await sendContext(
    13,
    putMessage(replacementContextId, 3, "document-tab-return", true),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
assert.deepEqual(
  apiCalls.slice(callsBeforeReplacementPut).filter(
    (call) => call.contextId === replacementContextId,
  ),
  [{ method: "PUT", contextId: replacementContextId }],
  "a fresh activation ID must converge to an actionable context after tab return",
);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(
  sessionState.marineRimeLeaseStateV1.tabs["13"].contextId,
  replacementContextId,
  "the replacement context must again become the worker's tracked lease",
);
assert.ok(putBodies.length > 0, "the worker must publish at least one Rime context");
assert.equal(
  putBodies.every((body) => body.profileId === "runtime-profile"),
  true,
  "every Rime context must carry the runtime-stamped Marine profile identity",
);

console.log("Marine extension Rime service-worker smoke: OK");
