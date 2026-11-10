# @marimo-hub/compute-coreweave

Compute adapter for CoreWeave Sandboxes, using the `@coreweave/cwsandbox` SDK.
Requires Node.js and uses Sandbox v1 over gRPC.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## File uploads

If unary SDK writes would need more than one wave, the adapter uses a packed stream.
That threshold is more than 2 files on `direct` and `auto`, and more than 8 on `gateway` and W&B.
A packed stream sends sequential binary stdin batches of up to 128 files or 4 MiB.
Oversized files occupy their own batch.
Destinations must be unique absolute paths, and payloads never enter command arguments.
Packed writes create mode `0600` files and remove group and other permissions from existing files.

Packed batches have a 60 s deadline per attempt.
They use the same retry delays and server cooldown policy as SDK writes for `UNAVAILABLE` and `RESOURCE_EXHAUSTED`.
Retries release the upload slot during backoff. A failed packed batch stops later batches.

For SDK writes, upload concurrency is limited per batch and per sandbox:

- `direct` and `auto` (default): two active writes.
- `gateway` and W&B: eight active writes.

Handles and upload phases share the sandbox limit within one provider instance.
Other sandboxes and server processes have independent limits. The runner controls admission across clients.
Batch limits let bridge and credential uploads proceed between workspace upload waves.

Each file has a 60 s budget from its first RPC, including retries and subsequent queue waits.
Initial queue time is excluded. Expired retries leave the queue without dispatch.
SDK calls receive the remaining time and an abort signal. The adapter also enforces the deadline.

`UNAVAILABLE` and `RESOURCE_EXHAUSTED` retry at most three times, after 250, 1,000, and 3,000 ms.
A longer server delay takes precedence. Delays over 10 s fail immediately. Retries release their slots during backoff.
A final error stops new writes in that batch. Active writes finish their retries before the batch rejects.
Other batches continue. Completed writes remain in the sandbox.

`coreweave_file_upload_backoff` reports retries, cumulative backoff time, and the outcome once per affected batch.
For repeated direct admission failures, its hint suggests `MARIMOHUB_COMPUTE_COREWEAVE_DATA_PLANE_MODE=gateway`.
The event omits file paths, contents, and server messages.

The adapter checks and copies destinations before sandbox readiness.
The SDK handles parent directories, file-size limits, streaming fallback, and transport routing.

The packed receiver uses `python3` on PATH for `sh -c`, as provided by `images/marimo-sandbox/Dockerfile`.
If the receiver exits 127, the adapter uses unary writes for the remaining files and subsequent transfers.
User-home bootstrap precedes the receiver in the same command, without session environment injection.
For SDK writes, files of at least 4 MiB use `writeStream` when available.

CoreWeave combines workspace files, credentials, bridge files, and agent requests when they are ready together.
Slow credential resolution does not delay workspace uploads. Remaining files transfer before setup.
Ordinary workspaces use bounded file batches. Existing synced archives, snapshot restores, and mounted workspaces keep their existing paths.

## Provision telemetry

`drainCounters()` returns and clears these counters:

| Counter                  | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `reconnect_by_reference` | Resolution attempts with a saved reference                                      |
| `reconnect_by_lookup`    | Lookup-based reconnect attempts, including process-cache lookups                |
| `execs`                  | Blocking `exec` and `execInput` calls                                           |
| `file_writes`            | SDK file writes, including retries                                              |
| `file_write_waves`       | Unary waves or packed batches, including packed retries                         |
| `env_writes`             | Private environment-file writes                                                 |
| `stream_execs`           | All command streams, including environment writes, packed transfers, and launch |
| `status_polls`           | Readiness status requests                                                       |

`drainTimings()` reports the first data-plane call duration once per instance as `first_dataplane`.
The session event uses `provision_first_dataplane_ms`.
Kubernetes reports applicable counters but omits `file_writes` because it uses exec for file transfers.

When files share a transfer, `files`, `inject_files`, and `bridge_prepare` durations overlap.
One packed transfer, one environment write, and one launch count as three command streams.

`prepareExposure` publishes the kernel Ingress while files load. `exposePort` awaits the same publication.
The Kubernetes client reuses HTTPS connections and rereads service-account tokens.
The Service owner reference provides Ingress garbage collection.

## Data-plane mode

With `dataPlaneMode: 'auto'` (the default), an unreachable runner direct endpoint can add up
to 1 s to the first data-plane call per sandbox, and again every 30 s. Use `gateway` when the
hub cannot reach the runner direct endpoints, and `direct` once it can.

## Sandbox resolution

A new sandbox is polled every 250 ms, for up to 60 s. The wait ends on the first poll that
reports one of these statuses:

- `running` or `paused`: the sandbox is ready.
- `completed` (or `unspecified`): the main process exited during boot, so the create fails.
- `failed`, `terminated`, or `terminating`: the create fails at once, without waiting for
  the deadline.

Each `CoreWeaveCompute` instance remembers the provider sandbox it last saw running for a
hub sandbox id, for up to 4,096 ids. Other provider instances do not share these entries.
A new sandbox instance for that id gets the sandbox by id, which skips the tag List.
If that sandbox is not running, is missing, or has a different id, the adapter drops the
entry and uses the tag lookup. Destroy also drops the entry.

## Startup timings

Core emits the provisioning phase timings for every backend. See
[session provision events](../../docs/operations.md#session-provision-events).
On CoreWeave, the first command that needs the private environment file creates it.
Its upload time counts toward that command, not toward `provision_inject_files_ms`.

## Reconnect references

Warm-pool members and running sessions store an opaque `reconnect_reference`.
`SessionService.setRunning` saves the reference after sandbox readiness. It stays out of API responses and contains no credentials.

A reference contains `kind: 'coreweave-v1'`, the Hub sandbox ID, and the provider container ID.
The container ID permits 1–256 UTF-16 code units. The complete reference permits up to 4,096 code units.
The adapter rejects malformed references, extra fields, and mismatched Hub IDs before any network request.

A saved reference lets any replica reconnect with one Get and no tag List.
The Get result must match the container ID and have `running` status.
A reference failure never falls back to discovery or creation.
Records without a reference keep the lookup path, including the process-local cache.
Warm-pool claims also run a command probe after reconnect.

For a reference reconnect, `coreweave_ensure` reports `reconnect_by_reference=true` and `get_ms`.
Its `find_ms`, `create_ms`, and `boot_ms` values are zero.

Destruction with a reference targets only its container ID.
A not-found response counts as deleted. Other errors propagate.
Pool reclamation re-reads ownership and uses tag-based cleanup.
