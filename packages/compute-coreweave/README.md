# @marimo-hub/compute-coreweave

Compute adapter for CoreWeave Sandboxes, using the `@coreweave/cwsandbox` SDK.
Requires Node.js and uses Sandbox v1 over gRPC.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## File uploads

Uploads use up to four concurrent SDK writes per batch and sixteen active RPCs per
process, across sessions and phases. Retry delays release their RPC slots.
All destinations must be unique absolute paths. The adapter validates and copies
the destinations before sandbox readiness.

Only `UNAVAILABLE` triggers retries, after 250, 1,000, and 3,000 ms.
Other errors or exhausted retries stop new uploads in that batch, including uploads
queued for a slot. Active uploads finish their retry loops before the batch rejects.
Other batches continue. Completed writes remain in the sandbox.

The SDK handles parent directories, file-size limits, streaming fallback, and direct
mTLS or Gateway routing. File contents pass directly to the SDK.

## Startup timings

| Field                            | Measures                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `provision_files_ms`             | Workspace restoration, including readiness waits.                                                |
| `provision_files_waitready_ms`   | One shared readiness wait across workspace and Git restores.                                     |
| `provision_files_non_waiting_ms` | Workspace duration minus that wait, including storage reads, queueing, uploads, and preparation. |
| `provision_inject_files_ms`      | Session file preparation, uploads, and installation.                                             |
| `provision_inject_env_ms`        | Environment configuration calls, concurrent with session file uploads.                           |

The command that creates the private environment file accounts for that upload time.
Phases overlap. Use `provision_total_ms` for total provisioning time.
