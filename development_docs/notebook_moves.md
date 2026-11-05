# Notebook moves

**Move to project…** requires manager/admin access, `project.read`, and
`notebook.manage` in both projects. Token scopes and security labels apply.
The destination must preserve inherited security restrictions.

`POST /api/v1/projects/{pid}/notebooks/{nid}/move` takes
`{ "destination_project_id": "proj-…" }` and `If-Match` (the notebook's
`updated_at`). Repeating the request resumes an interrupted move.
`DELETE …/notebooks/{nid}/move` cancels a move that has not published.

- **Preserved:** notebook ID, content, versions, thumbnails, proposals, jobs,
  run history, outputs, and prepared previews. App slugs follow the move.
- **Indexes:** one catalog CAS updates both projects and job indexes.
  Search hides stale results and requests fresh crawls for both projects.
- **Git:** configuration and history remain intact and must pass destination
  repository policy. Pull sources require destination checkout support and branch
  access. Push sources need a new sync token and destination CI URL.
- **Project resources:** destination integrations, credentials, membership, and
  alerts apply. Chats, session records, and existing audit events stay in the
  source project. Filesystem caches are reclaimed. Old notebook URLs return 404.

Before moving, stop sessions, finish jobs and sandbox cleanup, and complete or
cancel uploads. Preview preparation and admissions must finish.

## Fencing

Ordinary notebook reads and writes pay nothing for moves. Every writer already
reads or compare-and-swaps `meta.json`, so the move stamps `move_id` into that
record (and into each hidden runtime's `preview-runtime.json`). The stamping
CAS also proves the metadata still matches the request's `If-Match`. While the
stamp is present, `getNotebook` returns 404, which stops editors, the job
scheduler, previews, and uploads. The move then takes the workspace mutation
lease once so writers admitted before the stamp finish first.

Destination copies carry the same stamp until the catalog publishes the move.
The destination stamp is then cleared and the source objects are deleted,
`meta.json` first.

## Leases and retries

The record at `_system/notebook-moves/{nid}.json` is leased by its executor for
one minute and renewed while it runs. Repeating the request after the lease
expires takes the move over and resumes from the last phase (`preparing`,
`copying`, `published`, `complete`). Retries verify copied bytes before
publication. An executor re-checks its lease before the catalog write and before
deleting source objects, so a stale executor stops instead of publishing. A
completed record is kept until the notebook moves again, so a replayed request
returns the result without a second copy.

## Stuck moves

- **Preflight failures** (sessions, runs, uploads, previews, or a changed
  notebook) release the notebook at once. No record remains.
- **Failures while copying** (lost connection, authorization revoked,
  destination limits) leave the notebook hidden in both projects. Repeat the
  request to resume, or `DELETE …/move` to remove the destination copies and
  restore the source. Cancellation waits for a live lease to expire and refuses
  once the catalog shows the publication.
- **Failures after publication** only need the request repeated. The notebook
  is already served from the destination.
- **A stamp without a record** can only come from a lost move. `DELETE …/move`
  clears it.

Catalog recovery refuses to run while a move is unpublished. There is no offline
recovery step for moves.
