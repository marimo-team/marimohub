# Schema migrations

> **Status:** design + unwired prototype. There is no live `v2` of any schema
> yet, so no migration runs in production. This document captures the strategy so
> the runner can be built deliberately when the first real `v2` lands. It is
> grounded in [`bucket_spec.md` §9](./bucket_spec.md#9-migrations).

The backend has no database, so there is no `ALTER TABLE` to run. Every
independently-migrated object instead carries a `schema_version` field, and the
Worker decides how to roll a schema forward per object type. Three strategies
cover all object types.

## Strategies

| Object type                                                   | `schema_version` field | Strategy                                                                                                                                                                |
| ------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot (`_system/snapshots/{id}.json`)                      | `schema_version`       | **Lazy upgrade.** Read schema tolerates any version; the read path normalizes to the current shape before writing the next snapshot. Old snapshots are never rewritten. |
| `meta.json` / `project.json` / `source.json` / `version.json` | `schema_version`       | **Fan-out migration job.** List all affected objects, rewrite each with the new schema, emit `migration.run`. Idempotent + resumable.                                   |
| `catalog.json`                                                | `version`              | **In-place on first write** after a deploy that bumps the catalog schema version. (Single object; no fan-out needed.)                                                   |
| Events (`_system/events/**`)                                  | `schema_version`       | **Never migrated.** Event records are immutable history. New event shapes bump `schema_version`; consumers must handle multiple versions.                               |

### 1. Lazy snapshot upgrade

Snapshots are an append-only chain: each mutation writes a brand-new snapshot
object and swaps the catalog pointer. We never need to rewrite the whole history
to roll the schema forward — we only need the **next** write to be in the new
shape. So the upgrade happens lazily, on read:

1. The read schema (`SnapshotSchema` in `packages/core/src/schema.ts`) accepts
   **any** positive-integer `schema_version`, so a snapshot written by a newer
   replica during a rolling deploy parses without throwing.
2. `CatalogService.upgradeSnapshot(raw)` normalizes a parsed snapshot to the
   current in-memory shape. Today it is the identity function (only v1 exists);
   a future v1→v2 upgrade slots in here as a branch keyed on
   `raw.schema_version`.
3. Every read path (`getCurrentSnapshot`, `mutateSnapshot`) runs the snapshot
   through `upgradeSnapshot` before mutating, and writes always stamp
   `CURRENT_SNAPSHOT_VERSION`. So the next written snapshot is automatically in
   the current shape.

This means a snapshot schema bump is **not a flag day**: forward-tolerant reads
plus a lazy upgrade seam let old and new replicas coexist during a rolling
deploy.

### 2. Fan-out migration for per-object types

`meta.json`, `project.json`, `source.json`, and `version.json` are not part of
the snapshot chain — they are addressed directly by key and are not rewritten on
every mutation. A schema change to one of them therefore needs an explicit
batch job that walks every affected key and rewrites it. This is the
`runMigration` contract below.

### 3. Immutable events

`_system/events/**` records are never migrated. They are a faithful audit log of
what happened. A new event shape simply carries a higher `schema_version`;
readers fan out over versions rather than rewriting old records.

## Rolling-deploy compatibility

Session records may now include an optional `surfaces` map. `SessionSchema`
remains a `z.looseObject`, so an old replica preserves this field during a CAS
read-modify-write. New replicas treat an absent map as a session with no started
secondary surfaces. No stored-data migration is required.

Lazy/fan-out migration handles the **old data → new code** direction. The
dangerous direction during a rolling deploy is the opposite one: a **new-version
replica writes an object an old-version replica then reads, mutates, and
re-commits.** Both versions run simultaneously for the duration of the rollout,
so the policy must make that safe — otherwise the old replica corrupts the new
replica's data.

Two complementary rules, in code:

1. **New code reads old** — forward-compatible readers. `SchemaVersionSchema`
   accepts any positive integer, and `upgradeSnapshot` normalizes an
   older-shaped snapshot to the current in-memory shape before use. (This is the
   lazy-upgrade strategy above.)
2. **Old code tolerates new** — forward-compatible writers:
   - `SnapshotSchema` is a `z.looseObject` (not a strict `object`). A strict
     object would **silently strip** fields a newer replica added when an older
     replica round-trips the snapshot, destroying the new data. `looseObject`
     preserves unknown keys through the read→mutate→write cycle.
   - `CatalogService.mutateSnapshot` stamps
     `schema_version = max(CURRENT_SNAPSHOT_VERSION, currentSnapshot.schema_version)`
     — a **downgrade-guard**, so an old replica can never roll a `v2` snapshot
     back to `v1`.

   Together these let an old replica safely re-commit a snapshot a newer replica
   wrote, without losing fields or downgrading the version. There is a test for
   both halves in `CatalogService.test.ts` ("rolling-deploy write compatibility").

The standing **policy** that keeps this working:

- **Additive-only changes within a schema version.** Add fields; never remove,
  rename, or repurpose a field that a deployed reader depends on. Old code must
  keep working when it encounters the new shape.
- **A genuinely breaking change is a two-phase deploy.** Ship the readers first
  (a release that understands both the old and the new shape), let it roll out
  fully, then ship the writers that emit the new shape. Never do both in one
  release — that is the flag-day the lazy/loose design exists to avoid.
- The same reasoning applies to the fan-out objects (`meta.json`,
  `project.json`, `source.json`, `version.json`): bump `schema_version`, keep
  readers tolerant, and run the fan-out job to roll the rest forward
  out-of-band. (These are not round-tripped by _other_ writers the way snapshots
  are, so stripping is not a concern for them — but the additive-only rule still
  protects mixed-version reads.)

## The `runMigration` contract

```ts
runMigration(
  fromVersion: number,
  toVersion: number,
  targetType: MigrationTargetType,   // 'meta' | 'project' | 'source' | 'version'
  migrateFn: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<MigrationResult>
```

Semantics (matching `bucket_spec.md` §9 pseudocode):

1. **List affected keys, paginated.** Use the bucket `cursor` to iterate the
   target prefix in chunks so the job stays within the runtime's per-invocation
   request/time limits. Filter to the file suffix for `targetType` (e.g.
   `meta.json`).
2. **Per object: check `schema_version`.** Skip anything whose version is not
   `fromVersion` (already migrated, or a different version). This is the
   idempotency guard.
3. **Apply `migrateFn`,** stamp `schema_version = toVersion`, and write the
   object back.
4. **Emit `migration.run`** to the event log on completion (`from_version`,
   `to_version`, counts), so progress and completion are verifiable from the
   immutable event log.

Properties:

- **Idempotent.** Re-running skips objects already at `toVersion` (the
  `schema_version === fromVersion` check), so an interrupted job can be re-run
  safely and migrates each object at most once.
- **Resumable.** Driven by the bucket list `cursor`, so a job that hits a
  runtime time limit can resume from where it stopped.

A thin, fully-typed prototype of this contract — **not wired into any
entrypoint, route, or cron** — lives in
`packages/core/src/services/catalog/MigrationService.ts`, with an idempotency test
against `MemoryBucket`.

## Open questions (resolve before building the real runner)

These need a deliberate decision (some need product/ops input) and are
intentionally **not** guessed at in the prototype:

1. **Where does the runner run?** A one-off job triggered on deploy, a Cloudflare
   cron, or a manual ops invocation? `bucket_spec.md` §9 suggests running during
   a low-traffic window. The prototype is deliberately unwired so this choice
   stays open.
2. **How is completion verified?** Via the `migration.run` event log only, or
   also a re-scan that asserts zero remaining `fromVersion` objects? The
   resumable/idempotent design supports either; we should pick one.
3. **Rollback story.** Fan-out migrations rewrite objects in place (the old shape
   is gone once overwritten). Do we need a reverse `migrateFn`, a pre-migration
   backup/snapshot of affected keys, or is "roll forward only" acceptable for
   these object types? Events and snapshots are immutable, so this question is
   specific to the fan-out targets.
4. **Concurrency with live traffic.** A fan-out migration runs while the app may
   be reading/writing the same objects. Do we require a maintenance window, or a
   CAS-on-write (`onlyIfEtagMatches`) so a concurrent app write is not clobbered
   by the migration's rewrite?
