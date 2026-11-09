# @marimo-hub/compute-coreweave

Compute adapter for CoreWeave Sandboxes, using the `@coreweave/cwsandbox` SDK.
Requires Node.js and uses Sandbox v1 over gRPC.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## File uploads

Transfers of up to eight files use concurrent SDK writes.
Larger transfers use sequential binary stdin batches of up to 128 files or 4 MiB.
Oversized files occupy their own batch.
Destinations must be unique absolute paths, and payloads never enter command arguments.
Packed writes create mode `0600` files and remove group and other permissions from existing files.

Packed batches have a 60 s deadline per attempt and retry `UNAVAILABLE` up to three times.
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

Destinations must be unique absolute paths. The adapter checks and copies them before sandbox readiness.
The SDK handles parent directories, file-size limits, streaming fallback, and transport routing.

The packed receiver requires `python3` on PATH for `sh -c`, as provided by `images/marimo-sandbox/Dockerfile`.
User-home bootstrap precedes the receiver in the same command, without session environment injection.
For SDK writes, files of at least 4 MiB use `writeStream` when available.

CoreWeave combines workspace files, credentials, bridge files, and agent requests before launch.
Fresh workspaces with more than 256 files can use ZIP restore within extractor limits and the shared memory budget.
The hub reserves peak archive memory before reads and waits for readiness only before transfer.
Archive transfers retain the 256 MiB cap and require an empty workspace.
Otherwise, restoration uses ordinary file batches. Archive failures produce an operational log before fallback.
Snapshot restores and mounted workspaces keep their existing paths.

## Provision telemetry

`drainCounters()` returns and clears these counters:

| Counter            | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `execs`            | Blocking `exec` and `execInput` calls                                           |
| `file_writes`      | SDK file writes, including retries                                              |
| `file_write_waves` | Unary waves or packed batches, including packed retries                         |
| `env_writes`       | Private environment-file writes                                                 |
| `stream_execs`     | All command streams, including environment writes, packed transfers, and launch |
| `status_polls`     | Readiness status requests                                                       |

`drainTimings()` reports the first data-plane call duration once per instance as `first_dataplane`.
The session event uses `provision_first_dataplane_ms`.
Kubernetes reports applicable counters but omits `file_writes` because it uses exec for file transfers.

`files`, `inject_files`, and `bridge_prepare` include the shared transfer, so their durations overlap.
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

## Warm-pool references

A reference holds `kind: 'coreweave-v1'`, the Hub sandbox ID, and a provider container ID of 1–256 UTF-16 code units.
Before any network request, the adapter rejects malformed references, extra fields, and mismatched Hub IDs.
With a reference, a claim does a Get by container ID and a command probe.
Without one, it does a List by Hub tag, a Get, and a probe.
The Get result must have the expected container ID and `running` status.
A handle without status metadata cannot satisfy a reference.

On this path, `coreweave_ensure` reports `reconnect_by_reference=true` and `get_ms`, and zero for `find_ms`, `create_ms`, and `boot_ms`.
Destroying a handle with a reference targets only its container ID.
A not-found response counts as deleted. Other errors propagate.
Pool reclamation re-reads ownership and uses tag-based cleanup.
