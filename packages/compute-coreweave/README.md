# @marimo-hub/compute-coreweave

Compute adapter running kernel sandboxes on CoreWeave Sandboxes via the `@coreweave/cwsandbox` SDK (Sandbox v1; Node runtimes only; gRPC transport).

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## File-transfer concurrency

Workspace restore, integration files, and notebook bridge uploads use up to four
single-file SDK writes concurrently per batch, rather than the SDK array helper's
two-file waves. A process-wide semaphore caps in-flight file writes at sixteen
across sessions and phases. The adapter validates the whole set before dispatch,
passes binary content directly, and leaves parent-directory creation to the SDK.

Only files receiving `UNAVAILABLE` are retried. Permanent failures stop further
batch dispatch, and started uploads finish before the caller can retry or destroy
the sandbox. Direct mTLS versus Gateway routing remains the SDK's responsibility.
These limits bound fan-out; they do not change workspace persistence or place
credentials/file contents in command arguments.

## Startup timing interpretation

`provision_files_ms` includes waiting for sandbox readiness. The additional
`provision_files_waitready_ms` reports that wait once, even if workspace and Git
restores wait concurrently. `provision_files_non_waiting_ms` is the remainder:
object listing/reads, copies, and workspace preparation, not just network time.

`provision_inject_files_ms` and `provision_inject_env_ms` distinguish integration
file writes from environment configuration calls, which still run in parallel.
A lazy adapter's later private environment-file upload remains charged to the
command phase that materializes it. Phase durations overlap; use
`provision_total_ms` for end-to-end provisioning rather than adding every field.
