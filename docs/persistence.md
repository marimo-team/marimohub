# Persistence and recovery

Recovery uses the last successful save to the configured bucket. A lost sandbox can lose everything saved only to its disk.

## What is saved

| Content                              | Persistence                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Notebook source and `pyproject.toml` | Saved periodically and before normal stop. Imported notebooks retain their entrypoint paths.           |
| HTML and session snapshots           | Saved when available. They may be stale; capture does not force a fresh export.                        |
| Generated files                      | Saved at teardown with `MARIMOHUB_PERSIST_WORKSPACE=workspace`, subject to exclusions and size limits. |
| Kernel memory                        | Not preserved. Recovery does not resume arbitrary Python objects or running computations.              |

App, ephemeral, and remote-source sessions do not write edits back.
See [configuration](./configuration.md) for workspace limits and exclusions.

## Shutdown and data loss

If required notebook files cannot be saved, a normal editor stop retains the sandbox. Force-stop and provider deletion can lose unsaved changes.
Workspace capture is optional: source can be saved even if generated files are not.
Hub shutdown does not save every live sandbox before exiting.

`MARIMOHUB_SESSION_SNAPSHOT_INTERVAL_SECONDS` defaults to 120; `0` disables periodic saves.
This interval is a target, not a maximum loss window. Maintenance delays and storage failures can extend it.
Shorter intervals increase capture overhead and do not protect generated files.

For durable generated data, write explicit checkpoints to object storage or a database.
Automatic directory streaming is not supported: it adds storage costs and can copy partial writes.
The teardown workspace copy is not an atomic checkpoint.

## Diagnose failed saves

Check `session_capture_incomplete` for failure codes, workspace status, and time since the prior acknowledged capture.
A null age means no capture was acknowledged. Resume failures use `session_capture_resume_failed`.

The session's `last_durable_capture` records the last acknowledged save and version.
`last_capture_attempt_at` records attempts only. Inspect `stop` for retained or uncertain stop outcomes.
