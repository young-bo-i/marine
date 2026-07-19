# Marine action plugin for Rime Buffer

Marine bundles `manifest.json` inside the app and synchronizes it at startup to:

```text
~/Library/RimeBuffer/plugins/marine/manifest.json
```

The sync is atomic and idempotent. A bundled manifest upgrades an installed
manifest only when both declare the `marine` plugin id; an existing manifest
with another or unreadable id is preserved. The manifest remains installed
when Marine exits. Its `version` is the version of this plugin contract, not
the Marine application version, and should be bumped when the manifest's
actions or runtime contract change.

Contract `0.3.0` retains the authenticated streaming protocol introduced in
`0.2.0` and adds contextual presentation metadata. Every runtime credential
file remains bound to its manifest through the required `pluginId` field,
preventing another manifest from borrowing a Marine bearer capability.
Authenticated real-time generation remains available at
`streamPath: "/rime/invoke-stream"`; the legacy JSON `invokePath` remains
available unchanged.

Marine writes `etinput-runtime.json` when its authenticated localhost API
starts. Rime Buffer uses that file to discover the current loopback endpoint
and bearer token. The runtime file also declares `pluginId: "marine"`; Rime
Buffer must match that identity to the installed manifest before it may use
the bearer capability. The browser extension publishes either a `direct` or `reply`
editor target; invoking the matching action generates candidates for the Rime
buffer only. Neither side submits the browser form automatically.

The two wire actions keep their distinct ids and prompts, but both declare the
same `presentationId` and `presentationTitle`. Rime Buffer therefore renders
one stable **生成评论** control and binds it to whichever action id the current
status selects. A video-level editor selects `marine.generate-direct`; a
comment-level reply editor selects `marine.generate-reply`. With no supported
editor context, the same control remains visible but disabled.

Runtime files use Unix seconds. Browser context/status `updatedAt` accepts
legacy seconds and now publishes Unix milliseconds so targets changed within
one second remain ordered. Browser contexts expire after five minutes. Invocation captures the validated
context at request time; Rime rechecks the live status after generation and
routes a late result to its inbox instead of the active buffer.

## Streaming contract (`0.2.0`, unchanged in `0.3.0`)

Rime Buffer sends a JSON `POST` containing the exact `pluginId`,
`runtimeInstanceId`, `requestId`, `actionId`, and `contextId`. Marine rejects a
runtime/plugin mismatch, duplicate request id, changed context, or concurrent
stream before generation. A successful response is
`application/x-ndjson`; each newline-delimited frame repeats those five
identity fields plus `protocolVersion: 1` and a contiguous `seq` starting at
one.

Frame types are `heartbeat`, `block`, `complete`, and `error`. `block` carries
a stable zero-based `index` and the current full text snapshot. `complete`
carries the authoritative final `blocks`; partial blocks are display-only and
must never cause delivery or browser form submission. Heartbeats keep the
loading state alive but do not count as generated content. Disconnecting,
revoking/changing the captured browser context, or exceeding a provider or
wire bound cancels generation and cleans up the provider process.

Protocol v1 uses UTF-8 byte limits on both sides: 2,048 frames total, 20
blocks, 128 printable-ASCII bytes per identity field, 20,000 bytes per block snapshot, 200
bytes per title, 1,000 bytes per target summary, 500 bytes per error message,
512 KiB per emitted frame, and 1 MiB for the complete stream. The RimeBuffer
decoder accepts lines up to 512 KiB so the authoritative `complete` frame can
carry the full block array.
