# Session startup status

Startup status is not a separate object. It is two fields on the session record at
`_system/sessions/{pid}/{sid}.json`:

| Field               | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `status_changed_at` | UTC time of the last status transition. Older records do not have it.     |
| `startup`           | Latest stored phase snapshot. It is absent before the first stored phase. |

The `startup` snapshot contains `sandbox_id`, `phase`, optional `detail`, `attempt`,
`started_at`, and `observed`. The current phases are `allocating`, `workspace`, and
`starting`. `started_at` is the time the reporter first saw the phase. `attempt`
identifies a sandbox attempt within one launch. `observed` lists the phases the reporter
saw. It is not an event journal.

The stored schema accepts any short phase string, so a record written by a newer replica
still parses on an older one. `SessionService.getStartupStatus` returns `startup: null` for
an unknown phase and drops unknown entries from `observed`.

## Writers

All writes go through `SessionService` with ETag compare-and-swap.

- `SessionService.mutate` sets `status_changed_at` on every status change.
- `recordStartupProgress` writes intermediate phases while the session is `starting`.
  It ignores a phase that does not advance, a different sandbox, and an older attempt.
- `setRunning`, `completeStartup`, and `markFailedWithOutcome` commit the final phase
  together with the status change.
- `replaceStartingSandbox` clears `startup` and `startup_completion`.

The launch route in `packages/api/src/routes/sessions.ts` sends phases to `durableStartup`.
Intermediate writes run only on hosts with background work. Each launch has at most one
pending snapshot. Detail-only changes do not cause a write. A write error is logged as
`background_work_failed` and stops intermediate writes for that launch. Without a
background-work host, only the final phase is stored. The status transition does not
wait for intermediate writes, and a late progress write cannot change a terminal status.

## Expiry

The fields have no expiry of their own. The lifecycle sweep retires a `starting` record
that stops advancing like any other stale session.

## Readers

No route reads these fields yet. `toSessionResponse` omits them, and
`schema-conformance.test.ts` lists them as internal. The startup SSE stream sends
in-process progress from the launching request only; it does not read storage.

`SessionService.getStartupStatus` and `watchStartupStatus` read the stored fields, and only
tests call them. `watchStartupStatus` polls storage every second until the status leaves
`starting`. A route that exposes them must authorize each read and omit `startup.sandbox_id`.

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
one GET and one PUT per new editor at both 50 and 10,000 notebooks.
The receipt adds one sequential storage round (25 ms at the model's assumed latency).
The fresh identity read runs alongside the final authorization checks.

Receipt creation uses the known session value and ETag when no progress write is pending or complete.
Completion uses the value and ETag returned by the receipt write.
Recovery carries the ETag from its initial session read into completion.
Concurrent updates cause a conditional write conflict, followed by a fresh read and retry.
Cached no-op transitions still require a fresh read.

Reuse, read, heartbeat, and app costs do not change.
The steady-state reports also measure recovery on a fresh replica.
Recovery probes kernel readiness once. This network request is outside the storage-cost model.

## Admission boundary

The launch route waits for provisioning. A starting record does not prove accepted
admission. Recovery starts at the completion receipt. Earlier compute creation,
workspace preparation, and crashes before the receipt remain outside this scope.
Create-if-absent prevents session-ID reuse from overwriting an existing record.

An absent provider lookup cannot justify retrying an uncertain create.
