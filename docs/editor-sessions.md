---
description: Choose shared or exclusive ownership for persistent editor sandboxes.
---

# Editor sessions

`MARIMOHUB_EDITOR_SANDBOX_SHARING` controls who can use a notebook's persistent
editor sandbox. It applies to project editors, managers, and admins. It does not
affect viewer sessions or [notebook apps](./apps.md).

```bash
MARIMOHUB_EDITOR_SANDBOX_SHARING=shared    # default
# or
MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive
```

| Mode        | Persistent sandbox access                         | Other editors can                       | Best for                                       |
| ----------- | ------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `shared`    | All project editors, managers, and administrators | Attach to, stop, or restart the sandbox | Trusted teams, pair editing, and classrooms    |
| `exclusive` | One editor owns the persistent sandbox            | Start a temporary sandbox or take over  | Workflows with user-specific state or settings |

## Shared mode

`shared` keeps one persistent editor sandbox per notebook. Every editor who
opens the notebook attaches to the same marimo session. If project editors do
not trust each other, do not use this mode. marimo handles simultaneous editing,
and marimohub does not make later editors read-only.

Treat a shared sandbox as a shared login. Every attached editor can use the same
Python process, files, integration configuration, and federated credentials.
The sandbox also uses the configuration and AI identity issued to
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

The displayed connection state can use a stored observation less than 30 seconds old.
Before a takeover, marimohub always checks live activity. If the activity changed, you must confirm the takeover again.

A second editor can start an isolated temporary sandbox or take over the
persistent sandbox. A temporary sandbox uses the normal editor compute profile.
Unlike a restricted viewer sandbox, it receives integration configuration,
federated credentials, and an AI identity for that editor.

[Session surfaces](./surfaces.md) share the sandbox's lifetime: a takeover or
teardown stops VS Code and OpenCode together with marimo.

The temporary sandbox loads a copy of the workspace. It does not save:

- notebook code or versions
- rendered output or marimo session state
- workspace files
- filesystem snapshots

Exclusive mode isolates the live sandbox, not the stored project data. Other
project editors can still read the notebook, version history, and workspace.
The mode does not create a private mount for each user.

On CoreWeave, `MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_TEMPLATE_ID` names a
sandbox template that mounts the per-user VAST directory. Persistent and
temporary editor sandboxes then expose the authenticated user's directory at
`/mnt/<lowercase-email>`; writes there outlive marimohub's notebook and
workspace lifecycle. Apps and viewer sandboxes are never created from that
template.

## Browse and edit workspace files

**Browse files** on a notebook page opens the workspace mirror that the
sandbox mounts (`workspace/` in the bucket). Project editors can create, edit,
rename, copy, move, and delete files and directories there without starting a
sandbox. Viewers can browse and download only.

<figure class="doc-screenshot">
  <a href="/screenshots/workspace-files.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Workspace browser with a file tree and README editor (new tab)">
    <img src="/screenshots/workspace-files.png" alt="Workspace browser with a file tree and README editor" width="1062" height="390" loading="lazy" decoding="async" />
  </a>
  <figcaption>Browse the workspace and edit files beside the file list.</figcaption>
</figure>

The browser is read-only when:

- the notebook is Git-synced (`git_source`): the workspace is an immutable
  copy of the last sync;
- you are a project viewer (`viewer`);
- an editor session is running (`active_session`): the sandbox owns the files
  until it stops, so its next save does not overwrite yours.

The notebook's entrypoint (`notebook.py` unless imported with a different entry
file) and `pyproject.toml` are protected. Editing them saves a new notebook
version through the normal save path. They cannot be renamed, moved, deleted, or
replaced by a copy.

If a move fails while deleting its source, the complete destination remains.
A storage delete can complete after an error, even if the source initially
appears intact. Keep the destination copy until you have recovered the files;
do not delete it to retry the move.

Operators can configure the workspace limits. The defaults stay unchanged.

| Environment variable                 | Default                     | Allowed values        |
| ------------------------------------ | --------------------------- | --------------------- |
| `MARIMOHUB_WORKSPACE_MAX_FILE_BYTES` | 26,214,400 bytes (25 MiB)   | 1 byte to 5 GiB       |
| `MARIMOHUB_WORKSPACE_MAX_BYTES`      | 104,857,600 bytes (100 MiB) | Positive safe integer |
| `MARIMOHUB_WORKSPACE_MAX_FILES`      | 1,000 files                 | Positive safe integer |

The total includes existing source files. Directory markers do not count as files.
An oversized single request returns `413`. Configured file, workspace, and file-count limits return `429` for chunked uploads.
The browser reads these limits from `/api/v1/capabilities` under `workspace_limits`.

Single-request uploads, downloads, sandbox restore, and capture buffer each whole file.
Restore groups files into 8 MiB batches, but one large file occupies its own batch without being split.
The 64 MiB prefetch budget delays large reads until the sandbox is ready. It does not bound the size of those reads.
Higher limits therefore increase hub memory use and session start time.
Capture reduces concurrent reads when the per-file limit increases, but each read still needs memory for a whole file.
Git fetch, folder archive parsing, and session source-artifact limits stay fixed.

### Resumable uploads

The workspace browser uploads files above the single-request limit in 8 MiB parts.
The single-request limit is the smaller of 25 MiB and the configured file limit.
Each file shows preparation, upload, and publication progress.
After a reload or network failure, select the same file in the same browser tab.
The browser checks its contents and sends only missing parts.
Upload IDs remain in `sessionStorage`; closing the tab removes this local resume information.

Parts can upload while an editor is active. Publication waits until the editor stops.
A `409` response preserves the parts, so select the file again after stopping the editor.
Publication rechecks the current workspace size, file count, path, and overwrite policy.
Notebook source and `pyproject.toml` still use the file editor and normal save path.

Uploads expire after 24 hours. A workspace permits up to 16 unfinished uploads;
their declared sizes must fit its configured total limit.
Cancelling an upload removes its staged parts. Maintenance also removes expired parts.
Completed publication is idempotent. If publication was interrupted before its receipt was saved,
the API returns `409` instead of risking another overwrite. Check the destination before starting a new upload.

The hub stages immutable parts in its storage bucket. At publication, S3, R2, and Azure use native multipart assembly.
FS writes a temporary file incrementally. GCS uses resumable requests.
Custom adapters without either capability support assembly up to 64 MiB.
Upload ingestion has bounded buffers; the whole-file sandbox restore and capture costs above still apply.
Folder ZIP imports retain their existing limits.

API clients use `POST …/workspace/uploads`, then `PUT …/workspace/uploads/{id}/parts/{part}`
with one-based part numbers. `GET …/workspace/uploads/{id}` reports stored parts.
Use `POST …/workspace/uploads/{id}/complete` to publish or `DELETE …/workspace/uploads/{id}` to cancel.

The API exposes the same operations under
`/api/v1/projects/{pid}/notebooks/{nid}/workspace/`, including
`GET …/workspace/search?query=<text>` for a case-insensitive path search
(up to 200 results) and `GET …/workspace/entries?path=/&limit=<n>` for paged
directory listings. See the [API reference](./api.md).

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
lease expires after ten minutes without a successful renewal, and an expired
holder cannot renew it. Renewal also stops after 30 minutes without progress.
Finishing notebook capture, filesystem snapshotting, or sandbox destruction
starts a new 30-minute progress window. Another API replica can then continue
recovery if the original worker stopped or its current operation is stuck.

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

### Session cleanup

If you open a notebook while its previous editor session is still being cleaned
up, the request returns `409 EDIT_SESSION_RETIRING` and the notebook shows a
cleanup message with a **Retry** button. The session lifecycle sweep, the
5-minute maintenance cycle, **Stop**, or an administrator finishes the cleanup.
Cleanup waits for:

- **Provisioning grace.** A session that expired while provisioning gets
  15 minutes from creation, unless its kernel is already ready.
- **Teardown grace.** A fresh Stop or takeover gets 15 minutes to finish.
- **Idle kernel.** Before the session's authorization deadline, automatic
  cleanup must confirm that no editors are connected. After the deadline,
  automatic cleanup does not check. An administrator reclaim never checks.
- **Attachment.** To save edits, the compute provider must attach to the
  existing sandbox. If the sandbox is gone, the claim is released; any other
  attachment error keeps the sandbox and the claim.

Providers that cannot attach (currently Cloudflare) keep sessions that may hold
unsaved edits until a super admin reclaims them without saving. This applies only
before the session's authorization deadline. After it, automatic cleanup destroys the
sandbox without saving. See
[Reclaim a stuck editor sandbox](./operations.md#reclaim-a-stuck-editor-sandbox).

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
