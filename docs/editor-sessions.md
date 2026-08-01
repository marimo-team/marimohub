---
description: Choose how editors share or take ownership of notebook sandboxes.
---

# Editor sessions

`MARIMOHUB_EDITOR_SANDBOX_SHARING` controls whether project editors share a
notebook's persistent edit sandbox. It applies only to editor sessions. It does
not affect viewer sessions or [notebook apps](./apps.md).

```bash
MARIMOHUB_EDITOR_SANDBOX_SHARING=shared    # default
# or
MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive
```

## Shared mode

`shared` keeps one persistent edit sandbox per notebook. Every editor who opens
the notebook attaches to that same Marimo session. Use it for trusted
follow-along, classroom, pairing, and kiosk workflows. Marimo controls
simultaneous editing. marimohub does not make later editors read-only.

Treat a shared sandbox as a shared login. Every attached editor can interact
with the same Python process, files, and environment variables. This access
includes project secrets, federated credentials, and the settings of the
starter. Any editor can stop or restart the sandbox. This action disconnects
all users. Session saves use the identity of the starter.

## Exclusive mode

`exclusive` gives one editor the persistent sandbox. Other editors see the
owner's identity and the connection state before compute starts:

- **Active:** the kernel reported one or more connections.
- **Idle:** a successful probe reported zero connections.
- **Starting:** the sandbox has not finished starting.
- **Unknown:** the kernel probe failed. Treat this as potentially active.

A second editor can open an isolated temporary sandbox. The editor can also
take over the persistent sandbox. Temporary sandboxes use the normal editor
compute profile and credentials. These credentials include project secrets,
federated credentials, and the AI identity. A temporary sandbox uses a
copy-only workspace. It does not save these items:

- notebook code or versions
- rendered output or Marimo session state
- workspace files
- filesystem snapshots

Exclusive mode isolates the live sandbox. It does not make the persisted
notebook, version history, or workspace private from other project editors, and
it does not create per-user mounts.

## Takeover safety

Takeover always requires confirmation. The warning names the current owner and
shows the connection state. marimohub saves the current notebook and workspace.
Then it closes the old sandbox. The new sandbox starts only after destruction
of the old sandbox is complete.

If saving fails, the old sandbox remains available and no replacement starts.
If shutdown fails after draining begins, ownership remains protected and no
replacement starts. An idempotent retry completes the shutdown. Reconciliation
can also destroy the old sandbox before the retry. Work in the temporary
sandbox remains available until the replacement starts. marimohub discards
this temporary work after a successful replacement.

An unused `requested` reservation expires after five minutes. A `draining` or
`ready` reservation does not expire automatically. This rule prevents a second
persistent writer after destruction of the old sandbox. If provisioning fails,
the requester can retry from `ready` state.

Provider filesystem snapshots are owner-scoped in exclusive mode. A new owner
does not restore the snapshot of the previous owner. Exclusive mode also
rejects legacy snapshots without owner metadata. Shared mode can restore the
latest snapshot across starters.

## Changing the sharing mode

The system records the effective sharing mode on each new edit session. A
configuration change does not change a running session.

Changing this setting or upgrading from a release without editor claims
requires a maintenance window:

1. Stop or drain all edit sessions.
2. Stop every old API replica.
3. Apply the setting and start the new replicas.

CAUTION: Do not run mixed old and new replicas. An old replica can start a
second persistent writer. The Helm chart restarts pods after a ConfigMap
change. This restart does not replace the required session drain.

Each temporary sandbox consumes a normal per-user session slot. Attaching to a
shared sandbox does not create another slot. A takeover transfers the
persistent slot instead of briefly counting two persistent sessions.

## Non-goals

This feature does not add a CRDT. marimohub does not enforce a read-only
follower mode. It also does not create mounts for individual users.

## API

Clients can inspect ownership with
`GET /api/v1/projects/{pid}/notebooks/{nid}/editor-session`. In exclusive mode,
a normal create request returns `409 EDIT_SESSION_OWNED` for another owner.
Send `edit_intent: "temporary"` to request a discard-only editor sandbox. The
[OpenAPI document](./api.md) defines the takeover request. Send the displayed
holder and activity state. A state change returns `409 EDIT_SESSION_CHANGED`.
The user must confirm the new warning.
