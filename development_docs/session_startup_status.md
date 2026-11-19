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

## Recovery boundary

The launch route still waits for provisioning. A starting record does not prove
accepted admission, and persisted status does not resume interrupted provisioning.
Create-if-absent prevents session-ID reuse from overwriting an existing record.

MO-8528 still needs request replay, durable provisioning inputs, worker ownership
and scheduling, provider reconciliation, and cross-process crash tests.
An absent provider lookup alone cannot justify retrying an uncertain create.
