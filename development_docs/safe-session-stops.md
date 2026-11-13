# Safe session stops

A normal stop requires durable source, dependencies, and native session outputs for
persistent local editors. Missing or unreadable required artifacts retain the runtime.
HTML, thumbnails, filesystem images, and the ordinary workspace mirror are optional.
Takeover also requires the workspace capture before releasing editor ownership.

## API decisions

Send `DELETE /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}?wait=true`
with an `Idempotency-Key` header. Force defaults to false.

| Response                           | Meaning                                                         | Next action                                          |
| ---------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| 200                                | Writers stopped and sandbox reclamation confirmed               | Refresh session state                                |
| 202                                | A durable attempt is still pending or cleanup is unresolved     | Poll the session GET endpoint                        |
| 409 `SESSION_PERSISTENCE_REQUIRED` | Capture failed or remains uncertain                             | Read the safe `stop` projection and choose an action |
| 409 `CONFLICT`                     | Another attempt owns the operation, or the predecessor is stale | Refresh session state                                |

Retry uses a new key and `previous_attempt_id` from the observed ended attempt.
Force uses the same predecessor rule with `force=true` and the same stop permission.
A busy attempt cannot be upgraded to force. Keep running sends no new stop request.
The server retains a bounded receipt ring; evicted replays remain fenced by their
old predecessor. Internal causes, runtime paths, tokens, and lease IDs are omitted
from public responses. MCP `stop_session` exposes the same deliberate retry fields
and reports retained or pending outcomes explicitly.

## Publication and runtime recovery

NotebookService is the sole writer of local `source.json` publication heads.
It stages immutable code, dependencies, and capture sidecars, then publishes their
references with one ETag CAS. Every successful capture advances the generation,
including captures with unchanged bytes. Ownership transfer fences old tokens before
admitting a successor. Readers, restore, export, and search use the published references.
Workspace files are projections. GC lists candidates before its publication barrier
and preserves all retained or pinned references.

The marimo 0.24.x adapter and Linux supervisor are tested with 0.24.0 and 0.24.2.
The Linux supervisor lives outside the frozen writer tree. Prepare drains accepted
mutations and pauses writers for a bounded checkpoint. Abort or expiry resumes them.
Commit-stop durably rejects future resume before stopping writers. A delayed token
cannot commit after expiry. Hub recovery reconciles the recorded runtime token before
provider destruction. A dead supervisor recovery resumes an uncommitted checkpoint and
disables further capture until the runtime is replaced; a committed receipt never resumes.
Unreadable local receipts fail closed.

Deploy publication readers, writers, and runtime support together. Stop or drain all
old hub writers before admitting sessions with this protocol. Mixed workers that write
mutable source files or destroy after best-effort save cannot provide this guarantee.
Back up publication heads and referenced immutable payloads together.

## Operations

Monitor `sessions.save.acknowledged`, `sessions.save.hint_failed`,
`sessions.capture.durable`, and `sessions.capture.durable_lag_ms`.
`sessions.stop.retained` and `sessions.stop.forced` count outcomes; the
`sessions.stop.pending_age_ms`, `sessions.stop.retained_age_ms`, and matching `_count`
gauges identify stalled work. Telemetry failures do not change save outcomes.

Unsupported runtime capabilities retain the editor and permit an explicit force stop.
Native macOS local development remains usable; use a supported Linux container to test
successful drain and stop. Direct exposure relies on periodic capture rather than
proxy save observation. Background captures are deferred while VS Code or OpenCode
can write the workspace; final stop closes those surfaces before capture. External provider kills and unsaved browser buffers remain
outside the stop guarantee. Retained sessions continue to consume their capacity.

## Verification

The normal notebook-bridge Vitest suite runs Python unit discovery. Linux runtime
integration tests also run in the CI runtime-integrations job with its pinned marimo.
To run them locally, use a Linux Python environment with marimo 0.24.x installed:

```sh
cd packages/notebook-bridge/python
python -m unittest test_lifecycle test_lifecycle_linux
```

The native tests cover a save overlapping prepare, checkpoint output restoration,
resume, committed stop, and supervisor crash recovery. On other platforms, the
Linux integration tests skip; the hermetic lifecycle tests still run.
