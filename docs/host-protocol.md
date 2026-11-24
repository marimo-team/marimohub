# Host protocol

marimohub serves a subset of the [marimo host protocol](https://github.com/marimo-team/marimo/tree/main/protocols/host)
at `/api/host/v1`. This endpoint is separate from REST and MCP. Responses use protocol JSON,
RFC 9457 problem responses, and server-sent events (SSE).

## Connect

```text
URL: https://hub.example.com/api/host/v1
Authorization: Bearer <hub-token>
```

Use a personal access token, a service-account token, or a configured external access token.
Hub authorization rules apply: permissions, notebook security labels, token grants, and account
suspension. Browser cookies do not authorize requests.

The upstream transport is loopback-only. This endpoint adds authenticated remote connections.
It has no local discovery record and does not claim full v1 conformance.

The [upstream TypeScript client](https://github.com/marimo-team/marimo/tree/main/packages/client)
accepts the explicit URL and bearer token. Its reducer examples replace state on `reset` and
finish a snapshot on `ready`. Custom transports must forward the cursor and server filters on
every connection. Local event filtering alone does not avoid runtime discovery work. Close
streams when their consumer exits.

## Operations

All paths are relative to `/api/host/v1`.

| Operation           | Endpoint                                               | Owner                   |
| ------------------- | ------------------------------------------------------ | ----------------------- |
| Catalog stream      | `GET /events`                                          | Hub                     |
| `notebook.create`   | `POST /notebooks`                                      | Hub                     |
| `notebook.update`   | `PATCH /notebooks/{id}`                                | Hub                     |
| Notebook stream     | `GET /notebooks/{id}/events`                           | Hub and runtime         |
| `runtime.start`     | `PUT /notebooks/{id}/runtime`                          | Hub and runtime         |
| `notebook.edit`     | `POST /notebooks/{id}/edits`                           | Runtime                 |
| `notebook.save`     | `POST /notebooks/{id}/save`                            | Runtime and hub storage |
| `runtime.run`       | `POST /notebooks/{id}/runtime/runs`                    | Runtime                 |
| `runtime.cancel`    | `DELETE /notebooks/{id}/runtime/runs/{run_id}`         | Runtime                 |
| `input.reply`       | `POST /notebooks/{id}/runtime/inputs/{input_id}/reply` | Runtime                 |
| `runtime.execute`   | `POST /notebooks/{id}/runtime/execute`                 | Runtime                 |
| `runtime.interrupt` | `POST /notebooks/{id}/runtime/interrupt`               | Runtime                 |

The `host` event lists the implemented operations. Project and notebook records list the
operations that the caller can use, even before a runtime starts.

The hub owns notebook IDs. Each ID combines the project and notebook IDs with `:`. Treat these
IDs as opaque.

- Projects have `root: null`. Notebooks have `path: null` and expose their modification time as `modified_at`.
- `notebook.create` requires `project_id` and `name`. A `path` returns `400`.
- `notebook.update` changes `name` and keeps the ID. A `path` returns `501`.

Creation and renaming need no compute. Notebook streams, edits, saves, and execution requests
start or reuse an editor sandbox. They require editor-session permissions. Readers can use the
catalog but cannot open notebook streams, even with `kinds=cell,document`.

- `runtime.run` runs notebook cells. Its body is `{ "cells": [{ "id": "c1", "etag": "..." }] }`.
  Each cell's `etag` is optional.
- `runtime.execute` runs scratch Python with `{ "code": "..." }`. Assignments stay local to the
  call, but changes to shared objects persist.
- `runtime.cancel` targets one run. `runtime.interrupt` interrupts active work and cancels queued
  runs. Both requests have no body and return `202` acknowledgements. Stream events report completion.
- Cancellation, interruption, and input replies require an existing runtime. Without one, they
  return `409 no-runtime` and start nothing.

An operation that starts a sandbox, such as `runtime.start`, waits up to 60 seconds for it to
become ready. Then it returns `503` and releases the `Idempotency-Key` claim. Retry with the same
key.

The runtime handles document parsing, cell etags, atomic edits, execution, and interruption.
`notebook.save` writes the runtime document, then captures the session into hub storage.
Git-backed notebooks do not advertise save.

The hub does not support notebook deletion, host UI opening, or runtime stop and restart. It does
not keep runtime results or document revision history across sandbox replacement.

## Editor ownership

Shared mode reuses the existing editor sandbox. Exclusive mode keeps the current editor's
ownership, also when the deployment default changes.

If another user owns an exclusive editor, the host returns a `409` problem response of type
`urn:marimo:problem:decision-required`. Its decision has three options:

| Option      | Result                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `cancel`    | Nothing changes. The request returns `409`.                                   |
| `takeover`  | Saves and stops the current editor, then starts a persistent editor.          |
| `temporary` | Starts or reuses your own separate sandbox. It does not save to the notebook. |

To choose, send the decision ID and option ID to `PUT /notebooks/{id}/runtime` with a new
`Idempotency-Key`:

```json
{ "decisions": { "<decision-id>": "takeover" } }
```

A decision ID binds the choice to the observed holder and activity. If either changes before
takeover, the host asks for confirmation again. Takeovers use the same authorization,
retirement, audit, and notification logic as REST. A failed save or shutdown never starts a
replacement.

A temporary runtime returns a distinct `notebook_id`. Use that ID for its stream, edits, runs,
and interrupts. Only its owner sees it in the catalog, with a `(temporary)` name suffix and no
save or rename capability. The ID includes the session ID, because the protocol requires
separate notebooks for concurrent runtimes. The ID disappears when the session ends. Requests to
it never start a replacement.

## Runtime connection

The sandbox image must support the [pinned host protocol contract](https://github.com/marimo-team/marimo/blob/ce8f85a2635fe1b79302f8b0fd9af1d7e0f85474/protocols/host/spec.md). The hub installs no dependencies.

The host relay is a Python client that the hub runs inside the sandbox. It identifies the marimo
process and reads that process's private discovery record from its state directory. It checks
ownership, permissions, process lifetime, loopback address, port, and API path. The discovery
token stays inside the sandbox.

Over loopback, the host relay reads the runtime's project and notebook records. It selects the
notebook by its exact workspace path. The hub maps notebook IDs and prefixes runtime IDs with the
session ID. Cell IDs, run IDs, etags, and code do not change.

The host relay reads events in bounded batches through the compute port and resumes the
upstream cursor.

## Retries

Every mutation requires an `Idempotency-Key` of 1–256 characters. The key is scoped to the
authenticated user across all routes.

- Shared storage claims each key before work starts. Successful responses stay available for
  five minutes, across API instances and process restarts.
- While a claim or unexpired receipt exists, a changed method, path, body, or `If-Match` value
  with the same key returns `409`.
- Concurrent identical requests share work. A concurrent request on another instance waits up to
  five seconds, plus storage latency, for a receipt. Then it returns `503`. Retry with the same
  key.
- Rejected requests release unbound keys. This includes definitive `4xx` rejections of hub-owned
  mutations. Only an unknown outcome keeps a claim.
- Runtime requests bind to a session before dispatch. Retries use that session and never start a
  replacement after a lost reply.
- Retries of `runtime.run` and `runtime.execute` refresh the run record for the first four minutes.
  Later retries return the stored response, without dispatch to the runtime.
- Retries of accepted cancellations and interruptions return the original acknowledgement. They
  do not interrupt later work, even after runtime replacement.

| Claim                                                                                       | Release                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did not reach its mutation, for example after a crash during authorization or sandbox start | After five minutes.                                                                                                                               |
| Bound to a runtime                                                                          | Two to four minutes after the first claim. A retry re-dispatches to the same runtime with the same key. The runtime answers from its own receipt. |
| Any other dispatched claim                                                                  | Never. A crashed process or a lost hub write acknowledgement cannot prove that the mutation failed.                                               |

Before you recover a claim that never expires, inspect the notebook. A new key can duplicate the
mutation.

Maintenance compacts expired receipts in pages of 100 records and deletes them 24 hours later.
It keeps unresolved claims. Maintenance instances share cleanup progress.

Request cancellation stops the wait. It cannot terminate a dispatched sandbox command or undo an
accepted mutation. Use `runtime.cancel` to stop one run, or `runtime.interrupt` to interrupt all work.
If the original session is available, retry a cancelled save with the same key to finish storage capture.

## Streams

Both streams accept `kinds`. Unknown kinds return `400`. Notebook streams also accept `run_id`.
The hub forwards both filters to the runtime. Execution results use `output` events.
A filter that includes `output` also includes `output.removed` events.

- Heartbeat comments arrive every 15 seconds.
- Reconnection with `Last-Event-ID` sends `reset` and a fresh snapshot. The hub keeps no
  downstream replay log.
- Notebook streams recheck the bearer token and notebook access when the catalog changes, and at
  least every 30 seconds. A revoked token or permission ends the stream.
- The hub recomputes the catalog when the catalog pointer changes, and otherwise every five
  seconds. Permission and session changes can take that long to appear. Catalog polling can omit
  intermediate states.
- Runtime events keep their upstream order within each batch.

If the compute adapter supports `connectExisting`, catalog discovery uses it. Other adapters
report only the runtime records that this API process already observed. Catalog snapshots can
therefore wait for connections to active runtimes. Clients share one refresh per session, with a
five-second cache between refreshes. If a connection fails, the catalog omits its runtime records
but keeps project and notebook records. Catalog requests never start a sandbox. To skip runtime
discovery, use `kinds=host,project,notebook`.

The hub tracks one client attachment per downstream connection. Client attachments and catalog
change correlation are process-local. For complete attachment presence, route all host streams to
one dedicated API instance. Per-client affinity is not sufficient. Shared mutation receipts do not
make presence information deployment-wide. On Cloudflare Workers, host streams cannot be pinned to
one isolate, so attachment presence in the catalog is partial.

## Limits

Request bodies have a 2 MiB limit. Runtime event batches have an 8 MiB limit. Oversized or
incomplete snapshots return errors, not partial data.

## Examples

Read the catalog:

```sh
curl -N \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_URL/api/host/v1/events"
```

Set `PROJECT_ID` to a project ID from the catalog, then create a notebook:

```sh
curl \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Analysis\"}" \
  "$HUB_URL/api/host/v1/notebooks"
```

Use the returned notebook ID for later requests. To receive execution events, open its notebook
stream before a run.
