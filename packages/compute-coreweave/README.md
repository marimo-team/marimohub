# @marimo-hub/compute-coreweave

Compute adapter for CoreWeave Sandboxes, using the `@coreweave/cwsandbox` SDK.
Requires Node.js and uses Sandbox v1 over gRPC.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## File uploads

A batch runs up to eight SDK writes at the same time.
Each sandbox allows eight active write RPCs across all its phases, so sessions never queue behind each other.
Each write has a 60 s deadline. A write that waits to retry releases its RPC slot.
All destinations must be unique absolute paths.
The adapter validates and copies the destinations before it waits for sandbox readiness.

Only `UNAVAILABLE` causes a retry, after 250, 1,000, and 3,000 ms.
Any other error, or a write that runs out of retries, stops new uploads in that batch, including uploads that wait for a slot.
Active uploads finish their retries, and then the batch rejects.
Other batches continue. Completed writes stay in the sandbox.

The SDK creates parent directories and handles file-size limits, streaming fallback, and direct mTLS or Gateway routing.
File contents go directly to the SDK.

## Data-plane mode

With `dataPlaneMode: 'auto'` (the default), an unreachable runner direct endpoint can add up
to 1 s to the first data-plane call per sandbox, and again every 30 s. Use `gateway` when the
hub cannot reach the runner direct endpoints, and `direct` once it can.

## Sandbox resolution

A new sandbox is ready when a status poll reports `running`. Polls run every 250 ms, for up
to 60 s.

Each process remembers the provider sandbox it last saw running for a hub sandbox id, for
up to 4,096 ids. A new instance for that id gets the sandbox by id, which skips the tag List.
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
