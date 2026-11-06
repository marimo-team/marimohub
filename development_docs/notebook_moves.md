# Notebook moves

`NotebookMoveService` moves one notebook and its hidden preview runtimes to another project.
The [user guide](../docs/organizing-projects.md#move-a-notebook-to-another-project) lists what
moves, what stays, and what must finish before a move.

## Requests

`POST /api/v1/projects/{pid}/notebooks/{nid}/move` takes `{ "destination_project_id": "proj-…" }`.
`If-Match` carries the notebook's `updated_at`. Repeating the request resumes an interrupted move.
The caller needs a manager or admin role, `project.read`, and `notebook.manage` in both projects.
Token scopes and the notebook's security labels apply.
The destination project or the notebook must keep at least the source project's label restrictions.

`DELETE …/notebooks/{nid}/move` cancels a move that has not published.
It needs `project.read` and `notebook.manage` in the source, with the notebook's labels.

## Fence

The move writes `move_id` into the notebook's `meta.json` and each hidden runtime's
`preview-runtime.json`. Every writer already reads or compare-and-swaps these records, so ordinary
reads and writes pay no extra cost. The fencing CAS also proves that the metadata still matches
the request's `If-Match`.

While the fence is present, `getNotebook` throws `MoveInProgressError` (409 `MOVE_IN_PROGRESS` in
the API). This stops editors, the job scheduler, previews, and uploads. The error extends
`NotFoundError`, so internal callers that skip missing notebooks also skip a moving one. Examples
are search crawls, schedulers, and session reconciliation. The move then takes the workspace
mutation lease and each job operation claim once, so writers admitted before the fence finish first.

After the fence, one catalog CAS sets `moving: { move_id, destination_project_id }` on the source
catalog entry. List responses show `moving: { destination_project_id }` from the snapshot they
already read, so lists pay no extra cost. A resumed or taken-over move finds its own stamp and skips
the write. Cancellation and preflight failures clear the catalog stamp before they delete the
record. A leftover catalog stamp therefore always has a record that `DELETE …/move` can clear.

## Copy and publication

Each record owner copies its own records under the move record through a `copyForMove` helper.
The owners are notebooks, thumbnails, uploads, jobs, job runs, proposals, sessions, and previews.
The copies carry the same fence. They are not in the destination catalog, so a direct read returns
404 until the copied `meta.json` lands, and 409 after it.

One `mutateSnapshot` write publishes the move. It removes the source entry, adds the destination
entry with its job index, and sets `search_refresh` on both projects. Search hides stale results
and crawls both projects again. The executor then clears the destination fence, finishes the other
owners' cleanup, and deletes the source objects, `meta.json` first.

## Leases and retries

The record at `_system/notebook-moves/{nid}.json` moves through the phases `preparing`, `copying`,
`published`, and `complete`. Its executor holds a one-minute lease and renews it while it runs.
An executor that fails drops its lease, so a repeated request resumes at once. While another
executor holds a live lease, a repeated request or a cancellation returns 409. After the lease
expires, a repeated request takes the move over and resumes from the last phase.

Retries verify copied bytes before publication. An executor re-checks its lease before the catalog
write and before it deletes source objects, so a stale executor stops instead of publishing. A
completed record stays until the notebook moves again or is hard-deleted. A replayed request then
returns the result without a second copy.

## Stuck moves

- **Preflight failures** (sessions, runs, uploads, previews, or a changed notebook) release the
  notebook at once. No record remains.
- **Failures while copying** (lost connection, revoked authorization, destination limits) leave the
  notebook unopenable in both projects. The source list shows it as moving. Repeat the request to
  resume, or call `DELETE …/move` to remove the destination copies and restore the source.
  Cancellation refuses once the catalog shows the publication.
- **Failures after publication** need only a repeated request. The destination already serves the
  notebook.
- **A fence without a record** comes only from a lost move. `DELETE …/move` clears it.

Catalog recovery refuses to run while any move is not `complete`. Repeat or cancel each move
through the API before you stop the writers.
