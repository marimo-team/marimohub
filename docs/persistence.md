# Persistence and recovery

Recovery uses artifacts published to the configured bucket. Provider deletion, node loss, and forced destruction can lose changes after the last successful capture.

## What survives

| Content          | Persistence                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Notebook source  | Persistent local editors publish the actual entrypoint, including imported paths.                                      |
| Dependencies     | Capture includes `pyproject.toml` when present, not installed packages or virtual environments.                        |
| HTML             | Capture copies available `__marimo__/notebook.html`. It is optional and can be stale.                                  |
| Session snapshot | Capture copies available `__marimo__/session/notebook.py.json`. Imported entrypoints use corresponding artifact paths. |
| Generated data   | Workspace mode captures eligible files during teardown. Periodic capture excludes workspace data.                      |
| Kernel memory    | Capture does not preserve arbitrary Python objects, open connections, or running computations.                         |

Capture does not force fresh HTML or session exports. Unreadable dependency files or session snapshots can block critical capture.
Optional HTML failure does not block source publication.

App, ephemeral, and remote-source sessions do not write edits back, even in workspace mode.
Explicit source-control operations follow their own publication rules.

Workspace capture applies size limits and excludes regenerable caches, Git hooks, and directories marked with `CACHEDIR.TAG`.
Captured hidden files can expose secrets to notebook readers. See [workspace configuration](./configuration.md) and [security](./security.md).

## Stops and failures

Normal persistent-editor stops require successful critical capture before destruction. Capture failure retains the runtime for retry.
An uncertain publication or receipt is not a successful stop. Inspect the stop outcome before retrying.
Force-stop permits data loss. The stop protocol cannot prevent external provider destruction.

Workspace capture and native filesystem snapshots are optional. Their failure can leave source durable but generated data unsaved.
The workspace mirror is not an atomic checkpoint across files.

Hub shutdown drains background work within its budget, without capturing every live sandbox.
After restart, maintenance resumes from persisted session records. Surviving sandboxes may still contain unpublished edits.

## Cadence and diagnosis

`MARIMOHUB_SESSION_SNAPSHOT_INTERVAL_SECONDS` defaults to 120. This is a target cadence, not a maximum loss window. Zero disables periodic capture.
Dirty-save notifications can request earlier capture, subject to attempt throttling and maintenance scheduling.
Maintenance delays, runtime unavailability, storage failures, and retries extend the gap between successful captures.

For faster source recovery, evaluate a 30–60 second interval against measured runtime pauses and storage requests.
Unchanged artifacts can reuse cached content, but hashing, ownership checks, and publication still cost resources.
A shorter interval does not protect data directories.

| Session field             | Meaning                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `last_capture_attempt_at` | Last recorded attempt, not proof of durability.                   |
| `last_durable_capture`    | Last acknowledged critical publication: timestamp and version ID. |
| `save_dirty`              | Runtime saves awaiting durable acknowledgement.                   |
| `stop`                    | Stop outcome, runtime state, and safe failure code.               |

Capture age is `now - last_durable_capture.at`. No receipt means unknown age, not zero.
Do not use `last_snapshot_at` as proof of publication: remote-source checks can advance it without saving edits.

`session_capture_incomplete` reports critical and workspace status, a safe critical failure code, and prior acknowledged capture age.
Age is null before the first acknowledgement. Workspace-only failure can accompany durable source.
This event excludes exception messages and notebook contents. Resume failures use `session_capture_resume_failed`.

`sessions.capture.durable` counts acknowledged captures. `sessions.capture.durable_lag_ms` measures lag from dirty-save acknowledgement.
Alert on increasing capture age and repeated failures, rather than relying on the configured interval.

## Data-directory decision

Keep periodic capture source-only. Use explicit application checkpoints in object storage or a database for durable generated results.

Automatic directory streaming adds scan, transfer, and retention costs. Watchers can miss events, and copying active files can preserve partial writes.
Database files require database-specific backup protocols.

A future incremental checkpoint feature needs:

- Immutable chunks and a manifest published through compare-and-swap. Interrupted uploads must leave the previous checkpoint readable.
- Flushed or quiescent files, consistent deletion handling, and recovery from a complete manifest with a timestamp.
- Per-file and total-byte limits, bounded uploads, retention limits, and cleanup of abandoned chunks.
- Existing ownership, workspace exclusions, and app, ephemeral, and remote-source no-write-back rules.
