---
description: Choose shared or exclusive ownership for persistent editor sandboxes.
---

# Editor sessions

`MARIMOHUB_EDITOR_SANDBOX_SHARING` controls who can use a notebook's persistent
editor sandbox. It applies to project editors and administrators. It does not
affect viewer sessions or [notebook apps](./apps.md).

```bash
MARIMOHUB_EDITOR_SANDBOX_SHARING=shared    # default
# or
MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive
```

| Mode        | Persistent sandbox access              | Other editors can                       | Best for                                       |
| ----------- | -------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `shared`    | All project editors and administrators | Attach to, stop, or restart the sandbox | Trusted teams, pair editing, and classrooms    |
| `exclusive` | One editor owns the persistent sandbox | Start a temporary sandbox or take over  | Workflows with user-specific state or settings |

## Shared mode

`shared` keeps one persistent editor sandbox per notebook. Every editor who
opens the notebook attaches to the same marimo session. If project editors do
not trust each other, do not use this mode. marimo handles simultaneous editing,
and marimohub does not make later editors read-only.

Treat a shared sandbox as a shared login. Every attached editor can use the same
Python process, files, environment variables, project secrets, and federated
credentials. The sandbox also uses the configuration and AI identity issued to
the editor who started it. Any editor can stop or restart the sandbox, which
disconnects everyone. Saves are attributed to the editor who started the
sandbox.

## Exclusive mode

`exclusive` gives one editor the persistent sandbox. Other editors see the
owner and the connection state before they start more compute:

- **Active:** The kernel reports one or more connections.
- **Idle:** The kernel reports no connections.
- **Starting:** The sandbox is not ready.
- **Unknown:** marimohub cannot read the connection count. Treat the sandbox as
  active.

A second editor can start an isolated temporary sandbox or take over the
persistent sandbox. A temporary sandbox uses the normal editor compute profile.
Unlike a viewer sandbox, it receives project secrets, federated credentials,
an AI identity for that editor, and project integration configuration.

The temporary sandbox loads a copy of the workspace. It does not save:

- notebook code or versions
- rendered output or marimo session state
- workspace files
- filesystem snapshots

Exclusive mode isolates the live sandbox, not the stored project data. Other
project editors can still read the notebook, version history, and workspace.
The mode does not create a private mount for each user.

## Takeover safety

Takeover always requires confirmation. The warning identifies the current owner
and shows the connection state. After confirmation, marimohub:

1. Reserves the current owner and connection state.
2. Saves the notebook and the files allowed by `MARIMOHUB_PERSIST_WORKSPACE`.
3. Destroys the old sandbox.
4. Allows the new owner to start the replacement sandbox.

The replacement cannot start until the compute provider confirms that the old
sandbox is gone.

If the save fails, marimohub does not destroy the old sandbox or start a
replacement. If destruction fails, the editor claim remains protected and no
replacement starts. Retry the same takeover request to continue the drain.
Reconciliation can also destroy the old sandbox before the retry.

Only one retry can drain the old sandbox at a time. A recovery attempt renews
its lease every minute while it works. Concurrent requests must retry later. A
lease expires after ten minutes without a successful renewal, so another API
replica can continue recovery after the original operation is abandoned.

If the requester has a temporary sandbox, it remains available until the
replacement is running. marimohub then stops that temporary sandbox and
discards its work.

An unused `requested` reservation expires after five minutes. A `draining` or
`ready` reservation does not expire automatically. These states prevent a
second persistent writer after the old sandbox is destroyed. If replacement
provisioning fails, the requester can start it again from the `ready` state.

Provider filesystem snapshots are owner-scoped in exclusive mode. A new owner
does not restore the previous owner's snapshot. Exclusive mode also ignores
legacy snapshots that do not identify an owner. Shared mode can restore the
latest snapshot regardless of who created it.

## Changing the sharing mode

marimohub records the effective sharing mode on each editor session. A
configuration change does not change a running session.

Use a maintenance window in either of these cases:

- You change this setting.
- You upgrade from a release that does not use editor claims.

During the maintenance window:

1. Stop or drain all edit sessions.
2. Stop every old API replica.
3. Apply the setting and start the new replicas.

::: danger Do not mix replicas with different editor-claim protocols
An old replica can start a second persistent writer. A Helm restart after a
ConfigMap change does not drain editor sessions for you.
:::

## Session limits

Each temporary sandbox consumes one slot from the per-user session limit.
Attaching to a shared sandbox does not consume another slot. During a takeover,
the requester's temporary session does not block the replacement under this
limit. marimohub stops the temporary session after the replacement starts.

## Scope

This feature coordinates sandbox ownership. It does not add a conflict-free
replicated data type (CRDT), make other editors read-only, or create per-user
mounts.

## API

Clients can inspect ownership with
`GET /api/v1/projects/{pid}/notebooks/{nid}/editor-session`. In exclusive mode,
a normal create request returns `409 EDIT_SESSION_OWNED` when another editor
owns the sandbox. Send `edit_intent: "temporary"` to create a discard-only
editor sandbox.

To take over an exclusive session:

1. Read the current holder and activity from the editor-session endpoint.
2. Ask the user to confirm the displayed state.
3. Send that holder and activity to the takeover endpoint with a stable
   `takeover_id`.
4. If the endpoint returns `503`, retry the same request and `takeover_id`.
5. After takeover succeeds, create a normal editor session without
   `edit_intent`.

If the holder or activity changes, the takeover returns
`409 EDIT_SESSION_CHANGED`. Read the new state and ask the user to confirm it.
The [OpenAPI document](./api.md) defines both request bodies.
