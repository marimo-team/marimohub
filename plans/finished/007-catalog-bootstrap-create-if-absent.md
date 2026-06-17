# Plan 007: Make catalog bootstrap concurrency-safe with a create-if-absent conditional write

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/core/src/ports/bucket.ts packages/core/src/services/CatalogService.ts packages/core/src/services/index.ts packages/storage-s3/src/index.ts packages/storage-r2/src/index.ts packages/core/src/testing/MemoryBucket.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (extends the Bucket port; every adapter and the contract test must implement the new option consistently)
- **Depends on**: 001 (verification baseline) recommended first
- **Category**: bug (correctness / concurrency)
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

The whole storage design rests on conditional writes, but **first-write
bootstrap is not conditional**. `CatalogService.initialize` does `get(catalog)`;
if absent, it writes the initial snapshot and then `put(catalog)` _with no
precondition_. The auto-init middleware (`ensureInitialized`) runs on every
request and, on a cold/empty bucket, multiple concurrent first requests can all
see "no catalog", each create a snapshot, and each unconditionally overwrite
`catalog.json` — last-writer-wins. In the worst case an `initialize` that read
"absent" late can clobber a catalog another request already populated, and the
default-project creation can run twice. The bucket spec explicitly calls for
`If-None-Match: *` (create-if-absent) for bootstrapping, but the `Bucket` port
has no such primitive. This plan adds it and uses it so bootstrap is atomic.

## Current state

**Port** — `packages/core/src/ports/bucket.ts`:

```ts
export interface BucketPutOptions {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
	onlyIfEtagMatches?: string; // compare-and-swap (If-Match)
	// NO create-if-absent option exists
}
```

**`CatalogService.initialize`** — `packages/core/src/services/CatalogService.ts`
(lines ~12–42):

```ts
async initialize(actor: string): Promise<Snapshot> {
  const existing = await this.bucket.get(paths.catalog);
  if (existing) return this.getCurrentSnapshot();
  // ... build snapshot ...
  await this.bucket.put(paths.snapshot(snapshotId), JSON.stringify(snapshot));
  const catalog: Catalog = { /* ... */ };
  await this.bucket.put(paths.catalog, JSON.stringify(catalog));   // <-- UNCONDITIONAL
  return snapshot;
}
```

**`ensureInitialized`** — `packages/core/src/services/index.ts` (lines ~31–46):

```ts
export async function ensureInitialized(bucket: Bucket, actor: string): Promise<void> {
	const exists = await bucket.head(paths.catalog);
	if (exists) return;
	const services = createServices(bucket);
	await services.catalog.initialize(actor);
	const snapshot = await services.catalog.getCurrentSnapshot();
	if (snapshot.projects.length === 0) {
		await services.projects.createProject(
			{ name: 'My Projects', description: 'Default project' },
			actor,
		);
	}
}
```

(`createProject` writes via `mutateSnapshot`, which is already CAS-protected — so
the _default-project_ double-create is bounded by CAS, but two empty initial
catalogs can still race at the `initialize` step.)

**Adapters** that must implement the new option:

- `packages/storage-s3/src/index.ts` — `put` maps `onlyIfEtagMatches` →
  `input.IfMatch = "..."` and converts a 412 to `PreconditionFailedError`. S3
  supports `If-None-Match: '*'` for create-if-absent (since 2024).
- `packages/storage-r2/src/index.ts` — `put` maps `onlyIfEtagMatches` →
  `onlyIf: { etagMatches }` and treats a `null` return as
  `PreconditionFailedError`. R2 supports `onlyIf: { etagDoesNotMatch: '*' }` /
  the documented create-if-absent form.
- `packages/core/src/testing/MemoryBucket.ts` — `put` checks
  `if (options?.onlyIfEtagMatches) { … throw PreconditionFailedError }`.
- The contract test `packages/core/src/testing/bucketContract.ts` (run by
  `bucketContract.test.ts` for MemoryBucket and by `storage-s3/src/index.test.ts`
  when a live S3 endpoint is configured) defines the behavior every adapter must
  satisfy — extend it so all adapters are held to the new option.

## Commands you will need

| Purpose   | Command                                    | Expected                                                             |
| --------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Test core | `pnpm --filter @marimo-hub/core test`       | tests pass                                                           |
| Test s3   | `pnpm --filter @marimo-hub/storage-s3 test` | tests pass (live-S3 cases skip without `MARIMOHUB_TEST_S3_ENDPOINT`) |
| Test all  | `pnpm test`                                | all pass                                                             |
| Check     | `pnpm check`                               | exit 0                                                               |

## Scope

**In scope**:

- `packages/core/src/ports/bucket.ts` — add `onlyIfNotExists?: boolean` to
  `BucketPutOptions`.
- `packages/storage-s3/src/index.ts` — honor it (`If-None-Match: '*'`).
- `packages/storage-r2/src/index.ts` — honor it (R2 create-if-absent).
- `packages/core/src/testing/MemoryBucket.ts` — honor it.
- `packages/core/src/testing/bucketContract.ts` — add contract assertions.
- `packages/core/src/services/CatalogService.ts` — use it in `initialize`.
- `packages/core/src/services/index.ts` — make `ensureInitialized` tolerate a
  lost bootstrap race.
- `packages/core/src/services/CatalogService.test.ts` and/or
  `services/init.test.ts` — concurrency test.

**Out of scope** (do NOT touch):

- `mutateSnapshot`'s CAS loop — it already uses `onlyIfEtagMatches` correctly.
- The compute/auth adapters.
- `getCurrentSnapshot` semantics.

## Git workflow

- Branch: `advisor/007-create-if-absent`
- Commit message: `Add create-if-absent put; make catalog bootstrap atomic`.

## Steps

### Step 1: Add the port option

In `packages/core/src/ports/bucket.ts`, extend `BucketPutOptions`:

```ts
export interface BucketPutOptions {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
	/** Compare-and-swap: only write if the current ETag matches (If-Match). */
	onlyIfEtagMatches?: string;
	/** Create-if-absent: only write if the key does not exist (If-None-Match: *).
	 *  On a losing race the adapter throws PreconditionFailedError. */
	onlyIfNotExists?: boolean;
}
```

Document that `onlyIfEtagMatches` and `onlyIfNotExists` are mutually exclusive;
adapters may treat both-set as an error.

**Verify**: `pnpm check` exits 0.

### Step 2: Implement in `MemoryBucket`

In `packages/core/src/testing/MemoryBucket.ts` `put`, before the existing
etag-match check, add:

```ts
if (options?.onlyIfNotExists && this.store.has(key)) {
	throw new PreconditionFailedError(`Key "${key}" already exists`);
}
```

(Place it so create-if-absent and etag-match cannot both apply; if both options
are set, throw a plain `Error('onlyIfEtagMatches and onlyIfNotExists are mutually exclusive')`.)

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 3: Implement in the S3 adapter

In `packages/storage-s3/src/index.ts` `put`, when `options?.onlyIfNotExists` is
set, send `IfNoneMatch: '*'` (instead of `IfMatch`). The existing
`isPreconditionFailed(err)` → `throw new PreconditionFailedError(...)` mapping
already covers the 412 the store returns when the key exists.

```ts
if (options?.onlyIfEtagMatches !== undefined) {
	input.IfMatch = `"${options.onlyIfEtagMatches}"`;
} else if (options?.onlyIfNotExists) {
	input.IfNoneMatch = '*';
}
```

**Verify**: `pnpm --filter @marimo-hub/storage-s3 test` → pass (the live-S3
create-if-absent case only runs if `MARIMOHUB_TEST_S3_ENDPOINT` is set; the
contract still typechecks).

### Step 4: Implement in the R2 adapter

In `packages/storage-r2/src/index.ts` `put`, map `onlyIfNotExists` to R2's
create-if-absent precondition. R2's `onlyIf` accepts `etagDoesNotMatch`; the
documented create-if-absent form is `onlyIf: { etagDoesNotMatch: '*' }`
(equivalent to `If-None-Match: *`). A failed precondition makes `r2.put` resolve
to `null`, which the adapter already turns into `PreconditionFailedError`.

```ts
if (options?.onlyIfEtagMatches) {
	r2Options.onlyIf = { etagMatches: options.onlyIfEtagMatches };
} else if (options?.onlyIfNotExists) {
	r2Options.onlyIf = { etagDoesNotMatch: '*' };
}
```

If the installed `@cloudflare/workers-types` does not type `etagDoesNotMatch:
'*'`, consult the R2 conditional-put docs for the exact field and adjust; if no
create-if-absent form is available in this types version, see STOP conditions.

**Verify**: `pnpm check` exits 0 (R2 has no unit test suite; typecheck is the
gate).

### Step 5: Extend the bucket contract

In `packages/core/src/testing/bucketContract.ts`, add assertions that any
conforming bucket:

- `put(k, v, { onlyIfNotExists: true })` succeeds when `k` is absent;
- a second `put(k, v2, { onlyIfNotExists: true })` throws
  `PreconditionFailedError` and leaves the original value intact.

These run automatically for `MemoryBucket` (via `bucketContract.test.ts`) and
for S3 when a live endpoint is configured.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass (contract test green for
MemoryBucket).

### Step 6: Use create-if-absent in `initialize`

In `CatalogService.initialize`, make the catalog write conditional and handle a
lost race by returning the catalog the winner created:

```ts
await this.bucket.put(paths.snapshot(snapshotId), JSON.stringify(snapshot));
const catalog: Catalog = {
	/* ... */
};
try {
	await this.bucket.put(paths.catalog, JSON.stringify(catalog), { onlyIfNotExists: true });
	return snapshot;
} catch (err) {
	if (err instanceof PreconditionFailedError) {
		// Another initializer won the race. Our snapshot is now unreferenced —
		// delete it best-effort and return the committed state.
		await this.bucket.delete(paths.snapshot(snapshotId)).catch(() => {});
		return this.getCurrentSnapshot();
	}
	throw err;
}
```

(Keep the early `get`/short-circuit at the top — it avoids the work in the common
already-initialized case; the conditional put is the correctness backstop for
the race window between that `get` and the write.)

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

### Step 7: Harden `ensureInitialized`

`ensureInitialized` already re-reads the snapshot and guards default-project
creation with `projects.length === 0`. With Step 6, `initialize` is now safe to
call concurrently. Leave the default-project guard as-is (it relies on
`createProject`'s CAS), but add a comment noting that a concurrent default
create is bounded by CAS + the `length === 0` check, and that a rare duplicate
default project is acceptable (idempotency of project creation is tracked
separately). Do not over-engineer a lock.

**Verify**: `pnpm check` exits 0.

### Step 8: Add a concurrency test

In `CatalogService.test.ts` (or `services/init.test.ts`), simulate the race
using a single `MemoryBucket`: run two `initialize(actor)` calls (or two
`ensureInitialized` calls) concurrently via `Promise.all`, then assert:

- exactly one catalog exists and `getCurrentSnapshot()` succeeds;
- the snapshot count is bounded (no more than 2 snapshot objects — the
  winner's, plus at most the loser's orphan if Step 6's best-effort delete is
  treated as eventual; ideally exactly 1 referenced snapshot);
- the resulting projects length is 0 or 1 (not 2+ duplicate defaults in the
  `ensureInitialized` variant).

Because `MemoryBucket` is single-threaded JS, the "race" is interleaved
deterministically; the test mainly proves the conditional put rejects the second
writer rather than clobbering. If you cannot force a true interleave, at minimum
assert that a second `initialize` after the first does NOT overwrite the catalog
(call `initialize` twice sequentially and confirm the catalog's
`current_snapshot_id` is unchanged after the second call).

**Verify**: `pnpm --filter @marimo-hub/core test` → pass.

## Test plan

- New/updated tests: bucket contract (Step 5), CatalogService/init concurrency
  (Step 8).
- Pattern: existing `CatalogService.test.ts` and `bucketContract.test.ts`.
- Verification: `pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `BucketPutOptions` has `onlyIfNotExists`.
- [ ] S3, R2, and MemoryBucket all honor it (S3/Memory proven by the contract
      test; R2 typechecks).
- [ ] `initialize` writes the catalog with `{ onlyIfNotExists: true }` and
      handles `PreconditionFailedError` by returning `getCurrentSnapshot()`
      (grep: `grep -n "onlyIfNotExists" packages/core/src/services/CatalogService.ts` matches).
- [ ] The contract test asserts create-if-absent rejects a second write.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No files outside the in-scope list modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The installed `@cloudflare/workers-types` does not expose a create-if-absent
  form for `R2PutOptions.onlyIf` — report it; do NOT fake it. (The S3/Memory
  paths can still land; gate the R2 change on a types bump.)
- The live-S3 contract test (with `MARIMOHUB_TEST_S3_ENDPOINT` set) shows the
  store does NOT enforce `If-None-Match: *` — that store cannot safely bootstrap;
  report it (this is the same portability constraint the existing
  `verifyConditionalWrites` boot check guards for `If-Match`).
- Making `initialize` conditional breaks an existing test that wrote the catalog
  twice unconditionally — update that test to reflect atomic bootstrap.

## Maintenance notes

- Consider extending `S3Storage.verifyConditionalWrites` (the boot self-check)
  to also probe `If-None-Match: *`, so a store that supports `If-Match` but not
  create-if-absent is caught at boot rather than at first concurrent cold start.
- A reviewer should confirm both new conditional forms are mutually exclusive in
  every adapter and that the orphan snapshot from a lost bootstrap race is
  cleaned up (or is harmless — it is an empty initial snapshot).
