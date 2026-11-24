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

## Proxy save intent

After a successful runtime save, the proxy persists a new `Session.save_dirty` generation
before it admits capture work. This covers kernel saves and marimo host API saves
(`/api/marimo/v1/notebooks/{id}/save`) sent through the proxy. The response waits for the
persistence attempt, not for artifact capture. Without a background-work host, the proxy
schedules no capture and the lifecycle sweep captures instead.
Persistence failures leave the runtime response unchanged and emit `session_save_intent_failed`.

A hub host protocol save (`/api/host/v1`) persists the generation and captures before it
responds. A capture that is not durable returns a conflict; the intent stays for the sweep.

The local queue admits at most 64 sessions. Each burst makes at most four capture
attempts, with 100, 200, and 400 ms delays after consecutive failures. A capture that
lost editor ownership is not retried.
Overflow, scheduling failure, and process exit leave recorded intent in the session.

Any replica's lifecycle sweep can discover that intent, even with periodic snapshots
disabled. The sweep processes at most eight sessions concurrently, oldest attempt first.
Without an attempt, it uses the save time or session start time.
A retry waits at least one minute after the persisted `last_capture_attempt_at`, or the
configured snapshot interval if shorter. With the default 60-second sweep interval, the
retry runs at most about two minutes after the failed attempt.

Capture still requires editor ownership and the notebook publication fence.
A successful capture clears only the dirty generation it observed.
A newer save remains pending. Remote sources need no capture, so the sweep clears their
observed generation. Periodic capture also reconciles edits without save hints.

## Publication and runtime recovery

`NotebookService.prepareSessionCapture` validates notebook metadata and reads the source head once, without loading the README.
Remote sources need no capture. Local sources return a publication token from that source observation.
The coordinator acquires the token before ownership checks and runtime reads. Publication uses the token's ETag to reject stale captures.

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
`sessions.save.capture_deferred`, `sessions.capture.durable`, and
`sessions.capture.durable_lag_ms`.
`capture_deferred` counts saves that exceed local queue capacity.
`hint_failed` counts persistence, scheduling, and thrown capture failures.
The corresponding `session_save_{intent,schedule,capture}_failed` logs identify the session and cause. The durable-capture
metrics count proxy save captures, host protocol saves, periodic snapshots, and stop captures.
`sessions.stop.retained` and `sessions.stop.forced` count outcomes; the
`sessions.stop.pending_age_ms`, `sessions.stop.retained_age_ms`, and matching `_count`
gauges identify stalled work. Telemetry failures do not change save outcomes.

Capture histograms use the `sessions.capture.` prefix:

| Suffix                                    | Measurement                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `phase_ms`                                | Operation duration, labelled by `phase` and `outcome`, including failures.                                                        |
| `artifact_bytes`                          | UTF-8 artifact payload size, labelled by `artifact`.                                                                              |
| `uploaded_bytes`                          | Successfully uploaded payload size, labelled by `artifact`. Unchanged artifacts emit no sample.                                   |
| `source_visible_ms`                       | Capture start to confirmed source-head publication.                                                                               |
| `durable_ms`                              | Capture start to confirmed publication and durable receipt, excluding optional workspace work.                                    |
| `source_visible_lag_ms`, `durable_lag_ms` | The same endpoints measured from the observed save acknowledgement, including queue delay. Requires a dirty-save acknowledgement. |
| `total_ms`                                | Full capture duration, including workspace work and resume, labelled by critical `status` and `mode` (`background` or `stop`).    |

`runtime_prepare` includes pause and checkpoint creation. `source_publish` includes the
receipt on transactional backends. These captures record durability at commit, before later metadata and catalog work.
Retirement emits `runtime_commit-stop` and `destroy` phases.
Nested phases overlap; do not sum their durations. Byte metrics exclude transport overhead.

Save responses remain asynchronous and do not guarantee durability. Unchanged captures still
advance the source fence. Metric labels exclude notebook contents and runtime error messages.

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

The native tests cover saves overlapping prepare, checkpoint restoration, resume,
and committed stop. They kill the runtime process group, then restore source and
native outputs in a fresh runtime. They also kill the supervisor after its stop
receipt is durable but before it destroys writers. Recovery must finish the stop
without resuming those writers. The Linux tests skip on other platforms.

`apps/server/src/captureDurability.test.ts` kills publisher processes at artifact
upload, source-head publication, and durable-receipt boundaries. Fresh processes
read the persisted source and output pair, check that incomplete captures leave
the save dirty, and retry. Cases include unchanged source with new outputs, stale
publication tokens, replacement editors, and lost publication acknowledgements.
Run this suite with:

```sh
pnpm exec vp test apps/server/src/captureDurability.test.ts
```

Publisher tests use core services and filesystem storage, with one writer at a
time. They do not exercise the capture coordinator, PostgreSQL transactions,
provider destruction, or concurrent replicas. Native tests retain checkpoint
bytes outside the killed runtime to represent a published capture. They do not
send those bytes through hub storage. End-to-end provider recovery needs a
separate acceptance run.
