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
const putGates = new Map();
const sessionState = {};
const activeTabByWindow = new Map();
const activeTabQueryGates = new Map();
const activeTabQueryFailures = new Set();
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
        return { apiBase: "http://127.0.0.1:10108/v1/marine", token: "test-token" };
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
  const gate = method === "PUT" ? putGates.get(contextId) : null;
  if (gate) {
    gate.seen();
    await gate.releasePromise;
    putGates.delete(contextId);
  }
  return { ok: true, status: method === "DELETE" ? 204 : 200 };
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
      return { id: windowId, focused: focusedWindowId === windowId };
    },
  },
};

const helperSource = fs.readFileSync(new URL("../src/scholay-skill.js", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/sw.js", import.meta.url), "utf8");
vm.runInNewContext(helperSource + "\n" + source, {
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
}, { filename: "marine-extension/src/sw.js" });

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

function focusWindow(windowId) {
  focusedWindowId = windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId;
  windowFocusChanged.emit(windowId);
}

// A service worker can start because a background window's content script
// published first. `tab.active` is only window-local and must not promote that
// sender without also verifying the focused window and its active tab.
activeTabByWindow.set(10, 1);
activeTabByWindow.set(11, 99);
const callsBeforeColdBackgroundSender = apiCalls.length;
const coldBackgroundSender = await sendContext(
  99,
  putMessage("cold-background-sender", 1, "document-cold-background"),
  { active: true, windowId: 11 },
);
assert.equal(coldBackgroundSender.skipped, true);
assert.equal(coldBackgroundSender.deferred, true);
assert.equal(
  apiCalls.length,
  callsBeforeColdBackgroundSender,
  "a cold-start background sender must not establish the active lease",
);
tabRemoved.emit(99);
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

// XHS uses one shared reply editor. The selected reply remains semantically
// open while focus moves to Rime/Codex, so Chrome losing focus must park that
// lease instead of deleting it. Returning to the same tab restores ownership;
// switching to another tab still revokes it deterministically.
const retainedContextId = "xhs-reply-retained-across-window-blur";
assert.equal(
  (await sendContext(
    10,
    putMessage(retainedContextId, 2, "document-query-recovery", true),
    { active: true, windowId: 80 },
  )).ok,
  true,
);
const callsBeforeRetainedBlur = apiCalls.length;
focusWindow(chrome.windows.WINDOW_ID_NONE);
await flushTasks();
assert.equal(
  apiCalls.slice(callsBeforeRetainedBlur).some(
    (call) => call.method === "DELETE" && call.contextId === retainedContextId,
  ),
  false,
  "a retained XHS reply must survive Chrome WINDOW_ID_NONE",
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
  "returning to the same Chrome tab must restore the parked XHS reply",
);

activeTabByWindow.set(80, 11);
tabActivated.emit({ tabId: 11, windowId: 80 });
await flushTasks();
assert.equal(
  apiCalls.slice(callsBeforeRetainedBlur).some(
    (call) => call.method === "DELETE" && call.contextId === retainedContextId,
  ),
  true,
  "switching away from the XHS page must revoke the retained reply context",
);

// Closing the actual retained target while Chrome is unfocused is different
// from a renewal: the same source may advance its revision and DELETE must hit
// localhost immediately instead of waiting for browser focus to return.
const closeWhileUnfocusedId = "xhs-reply-closed-while-unfocused";
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

console.log("Marine extension Rime service-worker smoke: OK");
