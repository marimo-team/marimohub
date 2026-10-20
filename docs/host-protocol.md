# Host protocol

marimohub serves a subset of the [marimo host protocol](https://github.com/marimo-team/marimo/tree/main/protocols/host)
at `/api/host/v1`, separate from REST and MCP. Responses use protocol JSON,
RFC 9457 errors, and server-sent events (SSE).

## Connect

```text
URL: https://hub.example.com/api/host/v1
Authorization: Bearer <hub-token>
```

Personal access tokens, service-account tokens, and configured external access
tokens follow hub authorization rules. Permissions, notebook security labels,
token grants, and account suspension apply. Browser cookies do not authorize requests.

This endpoint extends the upstream loopback-only transport to authenticated remote
connections. It has no local discovery record and does not claim full v1 conformance.

## Operations

All paths are relative to `/api/host/v1`.

| Operation           | Endpoint                                       | Owner                   |
| ------------------- | ---------------------------------------------- | ----------------------- |
| Catalog stream      | `GET /events`                                  | Hub                     |
| `notebook.create`   | `POST /notebooks`                              | Hub                     |
| `notebook.update`   | `PATCH /notebooks/{id}`                        | Hub                     |
| Notebook stream     | `GET /notebooks/{id}/events`                   | Hub and runtime         |
| `runtime.start`     | `PUT /notebooks/{id}/runtime`                  | Hub and runtime         |
| `notebook.edit`     | `POST /notebooks/{id}/edits`                   | Runtime                 |
| `notebook.save`     | `POST /notebooks/{id}/save`                    | Runtime and hub storage |
| `runtime.run`       | `POST /notebooks/{id}/runtime/runs`            | Runtime                 |
| `runtime.interrupt` | `DELETE /notebooks/{id}/runtime/runs/{run_id}` | Runtime                 |

The `host` event lists implemented operations. Project and notebook records list
operations permitted for the caller, even before a runtime starts.

The hub owns notebook IDs, which combine project and notebook IDs with `:`.
Clients must treat them as opaque. Projects have `root: null` and notebooks have
`path: null`. Creation requires `project_id` and `name`. Renaming changes `name`
and preserves the ID. Neither operation accepts filesystem paths.

Catalog access, creation, and renaming need no compute. Notebook streams and runtime
operations start or reuse an editor sandbox, with the same permissions
as editor sessions. Readers can use the catalog but cannot open notebook streams,
even with `types=cell,document`.

The runtime handles document parsing, cell etags, atomic edits, execution, and
interruption. Saving writes the runtime document, then captures the session into
hub storage. Git-backed notebooks do not advertise save.

Notebook deletion, host UI opening, and runtime stop/restart are unsupported.
The hub does not retain runtime results or document revision history across sandbox replacement.

## Editor ownership

Shared mode reuses the existing editor sandbox. Exclusive mode preserves the
current editor's ownership, including when the deployment default changes.

If another user owns an exclusive editor, the host returns `409` with problem
type `tag:marimo.io,2026:host/decision-required`. Its decision offers three options:

- `cancel`: do nothing; the request returns `409`.
- `takeover`: save and stop the current editor, then start a persistent editor.
- `temporary`: start or reuse your own separate sandbox, without saving to the notebook.

Send the decision ID and option ID to `PUT /notebooks/{id}/runtime` with a new
`Idempotency-Key`:

```json
{ "decisions": { "<decision-id>": "takeover" } }
```

Decision IDs bind the choice to the observed holder and activity. If either
changes before takeover, the host requires confirmation again. Takeovers use
the same authorization, retirement, audit, and notification logic as REST.
A failed save or shutdown never starts a replacement.

A temporary runtime returns a distinct `notebook_id`. Use that ID for its stream,
edits, runs, and interrupts. The catalog exposes it only to its owner, with a
`(temporary)` name suffix and no save or rename capability. Its ID includes the
session ID because the protocol requires separate notebooks for concurrent runtimes.
It disappears when the session ends; requests to that ID never start a replacement.

## Runtime connection

The sandbox image must already support the host protocol. The hub installs no dependencies.

The bridge identifies the marimo process and reads its private discovery record
from that process's state directory. It checks ownership, permissions, process
lifetime, loopback address, port, and API path. The discovery token stays inside
the sandbox.

Loopback requests select the notebook by its exact workspace path. The hub maps
notebook IDs and prefixes runtime IDs with the session ID. Cell IDs, run IDs,
etags, and code remain unchanged.

The bridge reads events in bounded batches through the compute port, resuming the
upstream cursor. The hub tracks one client attachment for the downstream connection.
If the compute adapter supports `connectExisting`, catalog discovery uses it.
Other adapters report runtime records already observed by this API process.

## Retries and limits

- Every mutation requires an `Idempotency-Key` of 1–256 characters, scoped to the
  authenticated user across routes. Changed methods, paths, bodies, or `If-Match`
  values with the same key return `409`. Concurrent identical requests share work.
- Successful responses remain cached for five minutes. Errors release unbound keys.
  Runs bind their key to a session before dispatch. That binding survives transport
  failures and error responses for the same five-minute window. Retries query the
  original runtime; if it is gone, they fail without starting a replacement sandbox.
- The retry cache and attachment registry exist only in the API process. Use one
  API replica, or route all host clients to one dedicated replica. Per-client
  affinity is insufficient. Process replacement loses both registries.
- Both streams accept `types`. Notebook streams also accept `run_id`. Heartbeat
  comments arrive every 15 seconds. Reconnection with `Last-Event-ID` sends `reset`
  and a fresh snapshot. The hub retains no downstream replay log.
- Catalog polling can omit intermediate states. Runtime events keep their upstream
  order within each batch.
- Request bodies have a 2 MiB limit. Runtime event batches have an 8 MiB limit.
  Oversized or incomplete snapshots return errors rather than partial data.

## Examples

Read the catalog:

```sh
curl -N \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_URL/api/host/v1/events"
```

Set `PROJECT_ID` to a project ID from the catalog. Create a notebook:

```sh
curl \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Analysis\"}" \
  "$HUB_URL/api/host/v1/notebooks"
```

Use the returned notebook ID for subsequent requests. Open its notebook stream
before a run to receive execution events.
