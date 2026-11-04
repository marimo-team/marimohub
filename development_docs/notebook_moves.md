# Notebook moves

**Move to project…** requires manager/admin access, `project.read`, and
`notebook.manage` in both projects. Token scopes and security labels apply.
The destination must preserve inherited security restrictions.

`POST /api/v1/projects/{pid}/notebooks/{nid}/move` takes
`{ "destination_project_id": "proj-…" }`, `Idempotency-Key`, and `If-Match`
(the notebook's `updated_at`). Retry failures with the same key.
The browser retains unfinished requests across source-page reloads.

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

## Recovery

Transfer records block writes and hide partial notebooks. Retries check copied
bytes before publication. Source tombstones reject delayed writes.
Admissions and executors never expire because storage writes can finish late.

The CLI supports `s3`, `gcs`, `azure`, and `fs`. Other adapters use `NotebookMoveService.recover` directly.

After a crash or uncertain storage failure:

1. Stop all API, scheduler, maintenance, and sandbox writers.
2. With the deployment's storage environment, run:
   ```sh
   pnpm --filter @marimo-hub/server notebook-moves:recover --writers-stopped
   ```
   In server images, use `node dist/notebook-move-recovery.mjs --writers-stopped`.
3. Restart writers and retry the printed requests as their original actors.

Recovery clears abandoned admissions and executors but retains unfinished move
fences. Complete pending moves before catalog recovery. All writers must support
this protocol before moves are enabled.
