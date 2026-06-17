# Plan 004: Stop wiping `pyproject.toml` when a notebook's code is updated without resending deps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/core/src/services/NotebookService.ts`
> If `NotebookService.ts` changed since this plan was written, compare the
> "Current state" excerpt against the live code; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (data loss)
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

`NotebookService.updateNotebook` re-writes the notebook's dependency file
(`pyproject.toml`) on **every code update**, sourcing it from
`input.deps ?? ''`. The API's `UpdateNotebookBody` makes `deps` optional, and a
realistic client edits notebook _code_ and submits a save without resending the
dependency manifest. When that happens, the live `pyproject.toml` is overwritten
with an **empty string**, and the new immutable version snapshot also records
empty deps — so the dependencies are lost from both the working copy _and_ the
version history for that save. On the next session, the sandbox copies an empty
`pyproject.toml` into the kernel and the notebook's packages are gone. This is
silent data loss on a core write path.

## Current state

**`packages/core/src/services/NotebookService.ts`**, `updateNotebook` (lines
~197–281). The code-change branch (only runs when `input.code` is provided):

```ts
// Write new version if code changed
if (input.code !== undefined && source.type === 'local') {
	const versionId = createVersionId();
	const version: Version = { /* ... */ parent_id: source.current_version_id };
	const newSource: Source = { schema_version: 1, type: 'local', current_version_id: versionId };

	const ver = nb.version(versionId);
	await Promise.all([
		this.bucket.put(nb.code, input.code),
		this.bucket.put(nb.source, JSON.stringify(newSource)),
		this.bucket.put(nb.deps, input.deps ?? ''), // <-- BUG: '' wipes deps
		this.bucket.put(ver.code, input.code),
		this.bucket.put(ver.deps, input.deps ?? ''), // <-- BUG: version records '' too
		this.bucket.put(ver.meta, JSON.stringify(version)),
	]);
}
```

Relevant paths (`packages/core/src/paths.ts`): for a notebook,
`nb.deps = projects/{pid}/notebooks/{nid}/notebook/pyproject.toml`, and
`nb.code = .../notebook/notebook.py`. `ver.code`/`ver.deps` are the immutable
per-version copies under `.../notebook/versions/{vid}/`.

For contrast, `createNotebook` (lines ~144–158) _intentionally_ uses
`input.deps ?? ''` — that is correct for a brand-new notebook (there is no prior
deps to preserve). The bug is specific to **update**: an update must preserve
the existing deps when the caller does not supply new ones.

The `bucket.get` for the current deps is available via `nb.deps`. `getNotebook`
already loads `meta` + `source` (used at the top of `updateNotebook`); it does
NOT load deps, so you must read `nb.deps` when needed.

## Commands you will need

| Purpose   | Command                              | Expected   |
| --------- | ------------------------------------ | ---------- |
| Test core | `pnpm --filter @marimo-hub/core test` | tests pass |
| Test all  | `pnpm test`                          | all pass   |
| Check     | `pnpm check`                         | exit 0     |

## Scope

**In scope**:

- `packages/core/src/services/NotebookService.ts` — `updateNotebook` only.
- `packages/core/src/services/NotebookService.test.ts` — add regression tests.

**Out of scope** (do NOT touch):

- `createNotebook` — its `input.deps ?? ''` is correct for creation.
- The API route (`packages/api/src/routes/notebooks.ts`) or the
  `UpdateNotebookBody` schema — keep `deps` optional; the fix is in the service.
- The `meta`/`readme`/`title`/`description` update logic — unchanged.

## Git workflow

- Branch: `advisor/004-fix-update-deps-dataloss`
- Commit message: `Preserve notebook deps when code is updated without new deps`.

## Steps

### Step 1: Resolve the deps to write before the version block

In `updateNotebook`, when `input.code !== undefined && source.type === 'local'`,
compute the deps to persist as **`input.deps` if provided, else the existing
`pyproject.toml`** (falling back to `''` only if the notebook genuinely has no
deps file yet).

Target shape:

```ts
if (input.code !== undefined && source.type === 'local') {
	const versionId = createVersionId();
	// Preserve existing deps when the caller did not send new ones. Sending
	// `input.deps ?? ''` here would wipe pyproject.toml on a code-only save.
	let deps = input.deps;
	if (deps === undefined) {
		const existingDeps = await this.bucket.get(nb.deps);
		deps = existingDeps ? await existingDeps.text() : '';
	}

	const version: Version = {
		/* unchanged */
	};
	const newSource: Source = {
		/* unchanged */
	};
	const ver = nb.version(versionId);
	await Promise.all([
		this.bucket.put(nb.code, input.code),
		this.bucket.put(nb.source, JSON.stringify(newSource)),
		this.bucket.put(nb.deps, deps),
		this.bucket.put(ver.code, input.code),
		this.bucket.put(ver.deps, deps),
		this.bucket.put(ver.meta, JSON.stringify(version)),
	]);
}
```

(Read `nb.deps` once, before the `Promise.all`, so the read is not racing the
write of the same key inside the batch.)

**Verify**: `pnpm check` exits 0.

### Step 2: Add regression tests to `NotebookService.test.ts`

Add tests (model their structure on the existing tests in the same file —
they use `setupTestEnv()` from `@marimo-hub/core/testing` or a `MemoryBucket` +
`createServices`; match whatever the existing `NotebookService.test.ts` uses):

1. **Code update without deps preserves existing deps**: create a notebook with
   `deps: '[project]\ndependencies = ["pandas"]'`; call `updateNotebook` with a
   new `code` and **no** `deps`; then read `nb.deps` from the bucket and assert
   it still equals the original deps (NOT `''`). Also assert the new version's
   `ver.deps` equals the original deps.
2. **Code update WITH deps overwrites deps**: same setup; `updateNotebook` with
   new `code` and new `deps`; assert both `nb.deps` and the new `ver.deps` equal
   the new deps.
3. **Metadata-only update leaves code and deps untouched** (guards against
   regression): `updateNotebook` with only `title`; assert `nb.code` and
   `nb.deps` are unchanged and no new version folder was created.

To read a bucket object's text in the test, use the same `MemoryBucket` the
service was constructed with: `const obj = await bucket.get(paths.project(pid).notebook(nid).deps); expect(await obj!.text()).toBe(original)`.
Import `paths` from `@marimo-hub/core` (it is exported) or reconstruct the key.

**Verify**: `pnpm --filter @marimo-hub/core test` → all pass, including the 3 new
cases.

## Test plan

- New tests live in `packages/core/src/services/NotebookService.test.ts`.
- Cases: (1) the specific data-loss regression this plan fixes, (2) the explicit
  overwrite path, (3) metadata-only no-op guard.
- Verification: `pnpm --filter @marimo-hub/core test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "input.deps ?? ''" packages/core/src/services/NotebookService.ts`
      returns **only** the two lines inside `createNotebook` (the update path no
      longer contains it).
- [ ] The new regression test "code update without deps preserves existing
      deps" exists and passes.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `getNotebook` is refactored to already return deps (drift) — then read from
  there instead of an extra `bucket.get`, and note it.
- A test reveals that `nb.deps` is written elsewhere with `''` on update (a
  second occurrence of the bug) — report it; fix it the same way only if it is
  the same `updateNotebook` method, otherwise stop.

## Maintenance notes

- If a future change adds partial-deps merging (e.g. PATCH semantics for
  dependencies), this read-existing-then-write logic is where it belongs.
- A reviewer should confirm the version snapshot (`ver.deps`) records the
  _preserved_ deps, so version history stays faithful — a notebook rolled back
  to this version must still have its packages.
- Related latent issue (not fixed here): `updateNotebook` silently ignores a
  `code` update when `source.type !== 'local'` (e.g. a future `github` source).
  That is acceptable until the GitHub source type is built (see the direction
  notes in `plans/README.md`).
