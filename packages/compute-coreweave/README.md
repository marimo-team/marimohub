# @marimo-hub/compute-coreweave

Compute adapter for CoreWeave Sandboxes, using the `@coreweave/cwsandbox` SDK.
Requires Node.js and uses Sandbox v1 over gRPC.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## File uploads

Gateway batches allow up to eight active write RPCs per sandbox. Direct and
`auto` modes allow two across workspace, injection, bridge uploads, and all
handles to that sandbox, leaving runner admission headroom for commands.
Other sandboxes have independent slots. This is a provider-local bound
(normally one server process), not a distributed quota; the runner still
controls admission across clients.
W&B's Gateway-only file adapter also keeps eight slots.
Each file has a 60 s budget starting at its first RPC; retries and later queue
waits consume that same budget. Initial queueing does not. A retry releases its
RPC slot while waiting.
All destinations must be unique absolute paths.
The adapter validates and copies the destinations before it waits for sandbox readiness.

`UNAVAILABLE` and `RESOURCE_EXHAUSTED` file writes retry at most three times,
using 250, 1,000, and 3,000 ms backoff or a longer server-suggested delay.
Server delays above 10 s fail without retrying early. A retry is not dispatched
after the file's budget expires. Each SDK call receives its remaining time and
an abort signal, and the adapter also enforces that deadline.
Persistent admission/quota failures still fail after the bounded retries.
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
