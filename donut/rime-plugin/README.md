# Marine action plugin for Rime Buffer

Marine bundles `manifest.json` and synchronizes it atomically at startup to:

```text
~/Library/RimeBuffer/plugins/marine/manifest.json
```

The installed manifest is durable metadata. Marine replaces it only when the
existing and bundled manifests both declare the `marine` plugin id. The
manifest stays installed after Marine exits; only the authenticated runtime
lease is removed. Its `version` describes this cross-application contract, not
the Marine application version.

## Current contract (`0.5.0`)

Contract `0.4.0` moved model execution entirely into Rime Buffer. Marine no
longer authorizes or invokes an AI provider. Each action uses `preparePath` to
obtain a bounded, target-bound `blocks-v1` prompt; Rime Buffer then runs the
user-selected Codex CLI, Claude Code CLI, or OpenAI-compatible connector and
owns progress, streaming, block assembly, and cancellation.

Contract `0.5.0` adds `requiresFocus: false` to both generation actions. A
selected browser comment target may therefore remain available while the user
opens Rime's workbench. Rime may generate into its buffer without a live text
delivery focus; inserting a selected result into an application remains a
separate, focus-validated operation.

Marine writes `etinput-runtime.json` when its authenticated localhost API
starts. Rime Buffer discovers the loopback endpoint and bearer token from that
file. The runtime file declares `pluginId: "marine"`, and Rime must match it to
the installed manifest before using the capability.

The browser extension publishes either a `direct` or `reply` target. The two
wire actions retain distinct ids and prompts, but share `presentationId` and
`presentationTitle`, so Rime renders one stable **生成评论** control:

- `marine.generate-direct` for a page, video, answer, or note-level comment;
- `marine.generate-reply` for the exact selected comment target.

Neither Marine nor Rime submits the website form automatically.

## Prepare protocol

Rime sends `POST /rime/prepare` with the exact `pluginId`,
`runtimeInstanceId`, `requestId`, `actionId`, and `contextId`. Marine validates
the runtime binding and current target lease, then returns:

- `protocolVersion: 1`;
- `resultFormat: "blocks-v1"`;
- the same five identity fields;
- a bounded `prompt` and optional `targetSummary`.

The prompt contains Marine's talk-track instructions and the selected page
context, but no provider credentials, model selection, CLI arguments, tools,
or generated text. Rime rechecks the target before delivery and keeps late or
stale results in its own review flow instead of writing to the browser.

Runtime files use Unix seconds. Browser context/status `updatedAt` accepts
legacy seconds and current Unix milliseconds. Browser contexts expire after
five minutes. Navigation, target removal, and explicit cancellation revoke the
lease immediately.
