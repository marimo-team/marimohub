# Plan 008: Reclaim storage — delete project/notebook files on hard-delete and prune old notebook versions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/core/src/services/ProjectService.ts packages/core/src/services/NotebookService.ts packages/core/src/ports/bucket.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (introduces destructive deletes; a wrong prefix could remove live data — tests and scoping are critical)
- **Depends on**: 001 (verification baseline); pairs well after 004/006
- **Category**: bug / tech-debt (storage lifecycle)
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

The system promises "the catalog is the single source of truth" and "no
unbounded growth", but two paths leak storage:

1. **`deleteProject` only edits the snapshot** — it filters the project out of
   the catalog but never deletes `project.json` or any of the project's notebook
   files, versions, READMEs, or deps. Every deleted project leaves its entire
   object subtree behind forever.
2. **Notebook versions accumulate without bound** — every code save writes a new
   immutable `versions/{vid}/` folder and nothing ever prunes them. `bucket_spec.md`
   recommends keeping the last N (e.g. 50) and pruning on save.

(Notebook _soft_-delete is intentional and out of scope to change; this plan
adds the _hard_-delete cleanup that the spec defers to a GC pass, plus version
pruning.)

## Current state

**`packages/core/src/services/ProjectService.ts`**, `deleteProject` (lines
~118–125):

```ts
async deleteProject(id: ProjectId, actor: string): Promise<void> {
  await this.getProject(id); // ensure exists
  await this.catalog.mutateSnapshot('project.delete', actor, (snap) => ({
    ...snap,
    projects: snap.projects.filter((p) => p.id !== id),   // snapshot only — files orphaned
  }));
}
```

The snapshot still holds (until this delete) the project's notebooks with their
`key_prefix` (`projects/{pid}/notebooks/{nid}`). After the filter they are gone
from the snapshot, so you must capture them _before_ mutating.

**`packages/core/src/paths.ts`** — a project's objects all live under
`projects/{pid}/` (`paths.project(pid).meta` = `projects/{pid}/project.json`;
each notebook under `projects/{pid}/notebooks/{nid}/…`). So a project's entire
subtree is the `projects/{pid}/` prefix.

**`Bucket` port** (`packages/core/src/ports/bucket.ts`) — `delete(key: string |
string[])` (batch delete supported; S3 adapter chunks into 1000s, R2/Memory
delete arrays directly) and `list({ prefix, cursor, limit, … })` returning
`{ objects, truncated, cursor }`. There is no recursive delete — you list a
prefix (paginating on `cursor`) and pass the keys to `delete`.

**`NotebookService.updateNotebook`** (lines ~197–281) writes a new
`versions/{vid}/` on each code change; `listVersions` (lines ~324–341) lists
`${nb.prefix}versions/` with a delimiter and reads each `version.json`. No
pruning anywhere.

## Commands you will need

| Purpose   | Command                              | Expected   |
| --------- | ------------------------------------ | ---------- |
| Test core | `pnpm --filter @marimo-hub/core test` | tests pass |
| Test all  | `pnpm test`                          | all pass   |
| Check     | `pnpm check`                         | exit 0     |

## Scope

**In scope**:

- `packages/core/src/services/ProjectService.ts` — delete the project subtree on
  `deleteProject`.
- `packages/core/src/services/NotebookService.ts` — prune old versions after a
  save; optionally add a `hardDeleteNotebook` for the deferred GC of
  soft-deleted notebooks.
- A small shared helper to list-all-keys-under-prefix (paginating) — put it in
  the service or a tiny internal util; do not change the port.
- Tests in `ProjectService.test.ts` and `NotebookService.test.ts`.

**Out of scope** (do NOT touch):

- Notebook _soft_-delete behavior (`deleteNotebook` keeps setting `status:
'deleted'`) — unchanged.
- The 30-day grace period / scheduled GC orchestration (when to _call_ hard
  delete) — this plan provides the operations; wiring a cron is a follow-up.
- Pruning of `_system/snapshots/` (90-day retention) — separate concern.

## Git workflow

- Branch: `advisor/008-storage-gc`
- Commit message: `Delete project files on hard-delete; prune old notebook versions`.

## Steps

### Step 1: Add a paginating "list all keys under prefix" helper

The default list page is 1000 keys; a project subtree or a long version history
can exceed that. Add a private helper (in `ProjectService`, or a shared internal
module imported by both services) that loops on `cursor` until `!truncated` and
returns every key under a prefix:

```ts
async function listAllKeys(bucket: Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const res = await bucket.list({ prefix, cursor });
		for (const o of res.objects) keys.push(o.key);
		cursor = res.truncated ? res.cursor : undefined;
	} while (cursor);
	return keys;
}
```

**Verify**: `pnpm check` exits 0.

### Step 2: Delete the project subtree on `deleteProject`

Delete every object under `projects/{pid}/` and the `project.json`, then mutate
the snapshot. Order: list+delete files first (safe to retry), then commit the
snapshot change last (so a partial failure leaves the catalog pointing at a
still-listable project rather than a dangling reference). Use the project base
prefix from `paths`.

```ts
async deleteProject(id: ProjectId, actor: string): Promise<void> {
  await this.getProject(id); // ensure exists (404 otherwise)
  const prefix = `projects/${id}/`;            // entire project subtree
  const keys = await listAllKeys(this.bucket, prefix);
  if (keys.length > 0) await this.bucket.delete(keys);
  await this.catalog.mutateSnapshot('project.delete', actor, (snap) => ({
    ...snap,
    projects: snap.projects.filter((p) => p.id !== id),
  }));
}
```

(`paths.project(id).meta` = `projects/{id}/project.json` is under this prefix, so
it is included. Confirm the prefix matches `paths` exactly — build it from
`paths` if a helper exists, or assert it equals the documented layout.)

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 3: Prune old versions after a code save

Add a `MAX_VERSIONS` constant (default 50) and, at the end of
`updateNotebook`'s code-change branch (after the new version is written and the
snapshot mutated), list the notebook's version folders, sort by ULID (the `vid`
sorts chronologically — newest last), and delete the folders beyond the newest
`MAX_VERSIONS`. Never delete the version referenced by `source.current_version_id`.

```ts
const MAX_VERSIONS = 50;
// after writing the new version + mutating the snapshot:
await this.pruneVersions(projectId, notebookId, MAX_VERSIONS, /* keep */ versionId);
```

`pruneVersions` lists `${nb.prefix}versions/` (delimiter `/`), sorts the
`delimitedPrefixes` (they end in `versions/{vid}/`), keeps the newest N plus the
`keep` vid, and for each prunable prefix deletes its objects
(`notebook.py`, `pyproject.toml`, `version.json`) via `listAllKeys(prefix)` +
`bucket.delete`.

Make pruning best-effort and non-fatal: wrap it so a prune failure does not fail
the user's save (log/swallow, since the save already committed). Note this in a
comment.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 4 (optional but recommended): `hardDeleteNotebook`

Add `NotebookService.hardDeleteNotebook(projectId, notebookId)` that deletes the
notebook's entire subtree (`projects/{pid}/notebooks/{nid}/`) via the helper.
This is the operation the deferred GC pass (`bucket_spec.md §7.4`) needs for
soft-deleted notebooks past their grace period. Do NOT wire it to a route or
cron in this plan — just provide and test the operation. Guard it so it refuses
unless the notebook's snapshot status is `deleted` (avoid hard-deleting a live
notebook) — read the snapshot/meta to check.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 5: Tests

- **`ProjectService.test.ts`**: create a project with a notebook (+ a version);
  assert objects exist under `projects/{pid}/`; `deleteProject`; assert
  `listAllKeys(projects/{pid}/)` returns `[]` AND the project is gone from
  `listProjects()`.
- **`NotebookService.test.ts`**: create a notebook, then update its code
  `MAX_VERSIONS + 5` times; assert the number of `versions/` folders is
  `<= MAX_VERSIONS` (+ the kept current), the current version still resolves via
  `getVersion`, and the oldest versions were deleted.
- If Step 4 done: hard-delete a soft-deleted notebook and assert its subtree is
  empty; assert hard-deleting a live notebook throws.

**Verify**: `pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] After `deleteProject`, no objects remain under `projects/{pid}/` (proven
      by test).
- [ ] After >`MAX_VERSIONS` saves, version-folder count is bounded and the
      current version still resolves (proven by test).
- [ ] Pruning never deletes the current version and never fails the save.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The project prefix you compute does not exactly match the keys written by
  `createNotebook`/`createProject` (verify by listing a real project's keys in a
  test before wiring the delete) — a mismatched prefix could delete nothing or,
  worse, the wrong things. Confirm the prefix first.
- `bucket.delete` batch size or behavior differs across adapters in a way that
  breaks the test (it should not — S3 chunks at 1000, R2/Memory accept arrays).
- Pruning interacts with the immutable-version guarantee in a way that would
  break version rollback for a version a user might still reference — default to
  keeping more versions and report.

## Maintenance notes

- Wiring `hardDeleteNotebook` and a project-GC sweep into a scheduled job
  (alongside the session reaper in `apps/server/src/cron.ts`) is the natural
  follow-up; this plan deliberately stops at providing safe operations.
- `MAX_VERSIONS` should become configurable (env/config) if users ask for
  longer history; keep the default conservative.
- A reviewer should scrutinize every prefix used with `delete` and confirm tests
  assert _both_ "the right things were deleted" and "live data survived".
