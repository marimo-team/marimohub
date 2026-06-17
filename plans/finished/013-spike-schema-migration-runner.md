# Plan 013 (SPIKE): Make the schema forward-tolerant and design the schema_version migration runner

> **Executor instructions**: This is a **design/spike** plan, not a
> build-everything plan. Produce the small forward-compat code change in Part 1,
> then the written design + a thin prototype in Part 2. Do not build the full
> migration system. If a STOP condition occurs, stop and report. When done,
> update this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0565ec6..HEAD -- packages/core/src/schema.ts packages/core/src/services/CatalogService.ts`

## Status

- **Priority**: P2 (the forward-compat fix) / P3 (the runner design)
- **Effort**: M
- **Risk**: MED (schema parsing is load-bearing; a wrong change could reject valid data)
- **Depends on**: 001 (verification baseline)
- **Category**: migration / direction
- **Planned at**: commit `0565ec6`, 2026-06-16

## Why this matters

`bucket_spec.md §9` specifies a complete migration strategy (lazy upgrade for
snapshots; fan-out for `meta.json`/`project.json`/`source.json`; immutable
events), and **every persisted object already carries `schema_version`**. But:

1. **The code cannot roll forward.** Every schema uses `schema_version:
z.literal(1)` and `mutateSnapshot` hard-codes `schema_version: 1` on write.
   `SnapshotSchema.parse` will _throw_ on any object whose `schema_version !== 1`.
   So the moment a `v2` object exists (even written by a newer replica during a
   rolling deploy), older readers crash — the opposite of the documented
   "upgrade-in-place" story. There is no `upgradeSnapshot` function despite the
   spec referencing one.
2. **There is no fan-out migration runner** for the per-object types, so a future
   `meta.json`/`project.json` schema change has no safe, resumable rollout path.

This spike (a) makes parsing forward-tolerant so a version bump is _possible
without a flag day_, and (b) designs the migration runner so it can be built
deliberately when the first real `v2` lands.

## Current state

**`packages/core/src/schema.ts`** — every object schema pins
`schema_version: z.literal(1)` (e.g. `SnapshotSchema`, `ProjectSchema`,
`NotebookMetaSchema`, `LocalSourceSchema`, `VersionSchema`). The `EventSchema`
uses `z.looseObject({... schema_version: z.literal(1) ...})`.

**`packages/core/src/services/CatalogService.ts`** — `mutateSnapshot` reads the
current snapshot via `SnapshotSchema.parse` (lines ~78) and writes the next one
with `schema_version: 1` hard-coded (lines ~84–91). There is no version branch /
`upgradeSnapshot` step (the spec's `writeSnapshot` pseudocode shows one).

**`bucket_spec.md §9`** is the authoritative design (lazy + fan-out + immutable,
with idempotent, paginated/resumable fan-out pseudocode).

## Commands you will need

| Purpose   | Command                              | Expected   |
| --------- | ------------------------------------ | ---------- |
| Test core | `pnpm --filter @marimo-hub/core test` | tests pass |
| Test all  | `pnpm test`                          | all pass   |
| Check     | `pnpm check`                         | exit 0     |

## Scope

**In scope**:

- **Part 1 (code)**: a minimal forward-compat parsing change in
  `packages/core/src/schema.ts` (+ a single `upgradeSnapshot` seam in
  `CatalogService`), with tests.
- **Part 2 (design, no build)**: a design doc
  `docs/migrations.md` (or a section appended to `bucket_spec.md`) plus a thin,
  _unwired_ prototype `packages/core/src/services/MigrationService.ts` with a
  documented interface and one example migration (no cron/route wiring).

**Out of scope** (do NOT build):

- A working v1→v2 migration (there is no v2 yet).
- CLI/cron wiring of the runner.
- Changing any current persisted shape (everything stays `schema_version: 1`).

## Git workflow

- Branch: `advisor/013-migration-spike`
- Commit messages: `core: tolerate forward schema_version on read` (Part 1) /
  `docs: design schema migration runner; add unwired prototype` (Part 2).

## Steps — Part 1 (forward-compat read; this part is real code)

### Step 1: Decide the version field policy and apply it

Pick the least-disruptive change that lets a `schema_version > 1` object be read
without crashing, while keeping writes at `1`:

- Replace `schema_version: z.literal(1)` with
  `schema_version: z.number().int().positive()` on the **read** schemas, OR keep
  a `CURRENT_SCHEMA_VERSION = 1` constant and a discriminated approach. The
  minimal move is `z.number().int().positive()` so parse tolerates future
  versions; the `upgradeSnapshot` seam (Step 2) is where a real upgrade would
  normalize them.

Apply consistently across the object schemas that are read back from storage
(`SnapshotSchema`, `ProjectSchema`, `NotebookMetaSchema`, `SourceSchema`'s
members, `VersionSchema`, `SessionSchema`). Keep `CatalogSchema.version`
(`z.literal(1)`) as-is unless you also handle catalog versioning — note the
decision.

**Verify**: `pnpm --filter @marimo-hub/core test` → existing tests still pass
(all current data is v1, so loosening the literal cannot break them).

### Step 2: Add an `upgradeSnapshot` seam in `CatalogService`

Introduce a pure function `upgradeSnapshot(raw): Snapshot` (today an identity
function for v1) and call it in `mutateSnapshot`/`getCurrentSnapshot` right after
reading, _before_ mutation. This is the documented "lazy migration" hook — a
future v1→v2 upgrade slots in here without touching call sites.

```ts
// today: identity; future versions add branches keyed on raw.schema_version
export function upgradeSnapshot(raw: Snapshot): Snapshot {
	// if (raw.schema_version === 1) return migrateV1toV2(raw);
	return raw;
}
```

Keep writing `schema_version: 1` for now (the current version). Add a
`CURRENT_SNAPSHOT_VERSION = 1` constant and use it in the write instead of a
bare literal, so bumping is a one-line change later.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass. Add a test: a snapshot
JSON with `schema_version: 2` and otherwise-valid fields can be `parse`d (does
not throw) — proving forward-read tolerance.

## Steps — Part 2 (design + unwired prototype; no production wiring)

### Step 3: Write `docs/migrations.md`

Capture, grounded in `bucket_spec.md §9`:

- The three strategies (lazy snapshot upgrade; fan-out for per-object types;
  immutable events) and which object types use which.
- The runner contract: `runMigration(fromVersion, toVersion, targetType,
migrateFn)` — lists affected keys (paginated via the bucket `cursor`), checks
  each object's `schema_version`, applies `migrateFn`, writes back, emits a
  `migration.run` event; **idempotent** (re-running skips already-migrated
  objects) and **resumable** (cursor-based).
- Open questions to resolve before building: where the runner runs (one-off job
  vs. cron), how progress/completion is verified (via the event log), and the
  rollback story.

### Step 4: Add an unwired `MigrationService.ts` prototype

Create `packages/core/src/services/MigrationService.ts` with the interface from
Step 3 and ONE example migration function (e.g. a no-op v1→v1 that demonstrates
the shape), fully typed and unit-tested against `MemoryBucket`, but **not**
exported from any entrypoint, route, or cron. Mark it clearly as a prototype.
Add a test that the runner is idempotent (running twice migrates each object at
most once) using a synthetic `fromVersion`/`toVersion` example.

**Verify**: `pnpm --filter @marimo-hub/core test` → pass; the prototype is not
imported by `apps/server` or `packages/api` (grep confirms it is unwired).

## Test plan

- Part 1: forward-read tolerance test (snapshot with `schema_version: 2` parses);
  existing tests unchanged.
- Part 2: `MigrationService` idempotency test against `MemoryBucket`.
- Verification: `pnpm test`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Read schemas tolerate `schema_version > 1` (no `z.literal(1)` on the
      read-back object schemas; a parse test with version 2 passes).
- [ ] `upgradeSnapshot` seam exists and is called before mutation; writes use a
      `CURRENT_SNAPSHOT_VERSION` constant.
- [ ] `docs/migrations.md` exists with the runner contract and open questions.
- [ ] `MigrationService.ts` prototype exists, is unit-tested (idempotency), and
      is NOT wired into any entrypoint.
- [ ] `pnpm check && pnpm test` exit 0.
- [ ] No production wiring of the runner; no current persisted shape changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- Loosening `schema_version` would weaken a real validation guarantee elsewhere
  (e.g. a discriminated union relies on the literal) — keep the literal there and
  handle version tolerance differently; report the constraint.
- The design surfaces a decision that needs product input (where the runner
  runs, rollback policy) — capture it as an open question in `docs/migrations.md`
  rather than guessing.

## Maintenance notes

- When the first real `v2` ships, this seam is where the lazy upgrade and the
  fan-out runner get implemented and wired (cron in `apps/server`, per
  `bucket_spec.md §9`).
- A reviewer should confirm Part 1 cannot reject any _current_ (v1) object and
  that the prototype stays unwired until deliberately adopted.
