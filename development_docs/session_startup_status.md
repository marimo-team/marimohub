# Session startup status

`SessionService.getStartupStatus(projectId, sessionId)` reads the stored snapshot.
`watchStartupStatus(projectId, sessionId, signal)` yields changed snapshots,
starting with an immediate read. It polls every second until the status leaves
`starting`, then yields that status and ends. Storage errors reject the iterator.
Cancellation stops observation without changing the session.

Callers must authorize access before each read or delivery. The snapshot excludes
credentials and runtime URLs. Adapters must omit the internal `startup.sandbox_id`
from public messages and preserve stored timestamps in SSE responses.

| Field               | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `session_id`        | Stable session identity                                                |
| `status`            | Current lifecycle status                                               |
| `status_changed_at` | Persisted UTC transition time, or null for older records               |
| `startup`           | Latest persisted phase snapshot, or null before the first stored phase |
| `error`             | Sanitized failure code and message, or null                            |

The startup snapshot contains `phase`, optional `detail`, `attempt`,
`sandbox_id`, `started_at`, and `observed`. Phases advance through
`allocating`, `workspace`, and `starting`. `started_at` records when the
reporter observed the phase. `attempt` identifies a sandbox attempt within one launch.

`SessionService` uses ETag compare-and-swap to reject stale progress and writes
after startup ends. Replacing a sandbox clears its old phase snapshot.
Detail-only changes do not trigger writes.
With a background-work host, the writer retains one pending snapshot while storage is busy. Intermediate writes run in host-managed
tasks. Errors are logged and disable further intermediate writes for that launch.
Without a background-work host, only the final snapshot is persisted.

Running and failed publication commit the latest phase with the status transition.
They do not wait for intermediate writes. Terminal writes and authorization checks
remain blocking. Late progress writes cannot change terminal state.
Background writes still incur storage I/O and can cause CAS retries.
Local SSE progress is a live hint and can precede persistence; stored snapshots
remain authoritative across replicas.

Subscribers read storage across replicas without notification dependencies.
Reconnects and slow consumers receive current state, with no intermediate-event
replay guarantee. `observed` lists phases seen by the reporter, not an event journal.

## Runtime finalization recovery

Persistent editors record an internal `startup_completion` receipt after workspace
preparation, kernel readiness, and exposure. Optional context publication remains
asynchronous and does not gate recovery. The receipt stores the sandbox identity,
connection details, progress, and original runtime deadlines. It carries no caller
credentials or authority. API responses and startup snapshots exclude it.

If final status publication fails, the owner can retry the start request on any
replica within five minutes of preparation. Recovery checks current access,
account suspension, editor ownership, authorization deadlines, and runtime
readiness. A conditional write publishes the stored runtime details. Recovery
preserves the original runtime deadlines and does not create compute or repeat
workspace preparation. Concurrent retries reuse one session. Stop and sandbox
replacement fence completion, and delayed requests cannot destroy a recovered
runtime through compensation.

Transient storage and readiness failures retain the receipt for retry. Definitive
authorization, deletion, expiry, or claim failures reject only the matching runtime
and invoke retirement. A failed receipt write can reject a session only while no
receipt exists. If storage remains unavailable, stale-session maintenance can
reclaim the runtime after storage recovers and heartbeats stop.

Recovery requires strict `connectExisting` support and a fresh authenticated owner
passed to `recoverNotebookSessionStart`. It runs on request retry, without a
background worker. Temporary editors, apps, previews, and takeover launches keep
their existing lifecycle.

The [storage-cost model](../packages/api/src/testing/performance/README.md) adds
three GETs and one PUT per new editor at both 50 and 10,000 notebooks. The receipt,
fenced status write, and current identity check add three sequential storage
rounds (75 ms at the model's assumed 25 ms per round). Reuse, read, heartbeat, and
app costs do not change. This model excludes compute and network execution time.

## Admission boundary

The launch route waits for provisioning. A starting record does not prove accepted
admission. Recovery starts at the completion receipt. Earlier compute creation,
workspace preparation, and crashes before the receipt remain outside this scope.
Create-if-absent prevents session-ID reuse from overwriting an existing record.

MO-8528 still needs earlier request replay, durable provisioning inputs, worker
ownership and scheduling, provider reconciliation, and cross-process crash
acceptance. An absent provider lookup cannot justify retrying an uncertain create.
