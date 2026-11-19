# Safe session stops

A normal stop requires durable source, dependencies, and native session outputs for
persistent local editors. Missing or unreadable required artifacts retain the runtime.
HTML, thumbnails, filesystem images, and the ordinary workspace mirror are optional.
Takeover also requires the workspace capture before it releases the editor claim.
Timeouts and missing notebook files do not confirm sandbox absence.

## Sandbox absence

If the provider confirms sandbox absence, the next lifecycle sweep releases the editor
claim and capacity. This includes `retained` and `uncertain` stops, even after non-retryable failures.
The sweep records a new stop attempt with trigger `reconcile` and links it to the previous attempt.
It fences notebook publication, marks the sandbox reclaimed, and finishes as `stopped`.

With connection-aware reaping, the connection probe detects absence for running sessions.
For `runtime_state: 'unknown'`, the runtime status or resume call can confirm absence.

While the sandbox exists, automatic idle and lifetime stops follow the backoff rule in
[Session stop and recovery](../docs/operations.md#session-stop-and-recovery).

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

The capture adapter supports the marimo versions listed in
[Session stop and recovery](../docs/operations.md#session-stop-and-recovery).
The Linux supervisor runs outside the frozen writer tree. Prepare drains accepted
mutations and pauses the marimo process tree. The checkpoint deadline is 60 seconds.
On expiry or abort, the capture fails and the processes resume.
Periodic snapshots, proxy save hints, and host `/save` pause the tree only while they read
the checkpoint artifacts. The tree resumes before any bucket or catalog write.
A stop capture keeps the tree paused through publication until the stop commits.
Commit-stop durably rejects future resume before stopping writers. A delayed token
cannot commit after expiry. Hub recovery reconciles the recorded runtime token before
provider destruction. A dead supervisor recovery resumes an uncommitted checkpoint and
disables further capture until the runtime is replaced; a committed receipt never resumes.
Unreadable local receipts fail closed.

For the deployment and backup rules, see
[Session stop and recovery](../docs/operations.md#session-stop-and-recovery).

## Operations

Monitor `sessions.save.acknowledged`, `sessions.save.hint_failed`,
`sessions.capture.durable`, and `sessions.capture.durable_lag_ms`. The durable-capture
metrics count stop captures, periodic snapshots, and host saves.
`sessions.stop.retained` and `sessions.stop.forced` count outcomes; the
`sessions.stop.pending_age_ms`, `sessions.stop.retained_age_ms`, and matching `_count`
gauges identify stalled work. Telemetry failures do not change save outcomes.

Use a supported Linux container to test successful drain and stop. For native macOS,
other unsupported runtimes, and direct exposure, see
[Session stop and recovery](../docs/operations.md#session-stop-and-recovery).

The hub defers background captures while VS Code or OpenCode can write the workspace. The final
stop closes those surfaces before the capture. If the capture fails after a secondary
surface stops, that surface can restart when the session resumes. A failed secondary
shutdown stays visible as failed and also defers background capture.
A retained session keeps its capacity until [sandbox absence](#sandbox-absence) is confirmed.

## Verification

The normal notebook-bridge Vitest suite runs Python unit discovery. Linux runtime
integration tests also run in the CI runtime-integrations job with its pinned marimo.
To run them locally, use a Linux Python environment with the sandbox image’s pinned marimo version installed:

```sh
cd packages/notebook-bridge/python
python -m unittest test_lifecycle test_lifecycle_linux
```

The native tests cover a save overlapping prepare, checkpoint output restoration,
resume, committed stop, and supervisor crash recovery. On other platforms, the
Linux integration tests skip; the hermetic lifecycle tests still run.
