# Migrations

Project access summaries and session indexes migrate automatically in the background.
Normal upgrades require neither shell access nor a rebuild command.

## Automatic background migrations

`MigrationService` runs the registry in
`packages/core/src/services/catalog/migrations.ts`. Each migration has a permanent
ID and performs one bounded batch per tick, in registry order:

1. `project-access-v1` updates catalog summaries.
2. `session-index-v1` builds per-user session indexes.

`runBatch({ cursor, signal })` returns `{ done: false, cursor }` or `{ done: true }`.
The owning domain service performs all data writes through its existing CAS protocol.

### Scheduling and completion

| Entrypoint        | Schedule                                                                                 | After completion           |
| ----------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| Node server       | Starts immediately; retries every five seconds, independently of the maintenance setting | Stops its migration loop   |
| Cloudflare Worker | One batch per scheduled event; the example cron runs every five minutes                  | Skips completed migrations |

HTTP startup does not wait for migration. Requests never run migration batches.
Node requests use cached readiness without reading checkpoints. Fresh deployments wait for catalog initialization;
new projects already contain current summaries.

The runner owns `_system/migrations/{id}.json`. Each record holds a cursor and
lease until completion, then becomes a permanent receipt. Each process reads
completed receipts once and caches them. Restart processes after replacing or
restoring a bucket.

### Failures and concurrency

- A 60-second lease coordinates replicas. Node cancels a batch after 55 seconds.
  Lease expiry permits takeover but cannot stop storage work already in flight.
- Checkpoint and release writes use the acquisition ETag. A late worker cannot
  overwrite a successor's progress.
- Batches must tolerate replay and overlap. Data can commit before its checkpoint
  response arrives; execution is at least once.
- Failed batches retain the last saved cursor. The runner releases its lease when
  possible; otherwise, another attempt waits for expiry. Later migrations wait
  for their predecessors to complete.
- Invalid or unknown checkpoint formats fail without overwriting stored state.
  They require repair.

Progress and completion emit `migration_progress` and `migration_completed` logs.
Node reports failures through its background-loop logs and, on maintenance
replicas, the loop health endpoint. Worker failures reject the scheduled handler
after the other scheduled work finishes.

### Project access v1

`ProjectService.migrateAccessSummaries` processes up to 25 projects in stable ID
order. Each changed batch publishes one catalog snapshot. It rereads authoritative
metadata on every catalog CAS attempt and leaves project metadata unchanged.

Current summaries carry `access.version: 1`. Old deployment generations do not
establish trust. Readers fall back to metadata for missing or unknown versions,
and for pending permission mutations. Routine projections, migration, and forced access rebuilds preserve newer summaries unchanged.
Updates to supported or legacy summaries preserve unknown fields while replacing known permission fields.

Pending permission and security markers remain intact. Migration can complete
while these projects still use metadata reads. The owning mutation finalizes its
marker; [offline recovery](./operations.md#inspect-and-recover-the-catalog) can resolve
abandoned markers with writers stopped. Recovery rebuilds current summaries and
does not need to erase migration receipts.

Missing metadata for a deleted project is skipped. Missing active-project metadata,
invalid metadata, or storage errors leave the batch incomplete. After repair,
background execution resumes from the saved cursor.

The optional repair command bypasses completion receipts and rereads project
metadata. It preserves pending markers and requires no generation setting:

```sh
# Source checkout:
pnpm --filter @marimo-hub/server project-access:rebuild
# Packaged installation:
node dist/project-access-rebuild.mjs
```

### Session index v1

The second migration uses `bucketMigration`:

```ts
bucketMigration({
	id: 'session-index-v1',
	bucket,
	prefix: paths.sessionsPrefix,
	migrate: (key, signal) => sessions.migrateSessionIndexEntry(key, signal),
});
```

The helper visits at most 100 objects per tick, with at most 16 concurrent visitors.
It handles pagination, cancellation, and draining active visitors after errors.
The runner handles leases, retries, checkpoints, ordering, and permanent completion receipts.
A failed page replays from its preceding checkpoint. Visitors must tolerate partial writes and replay.
New writers must maintain the migrated format, including objects inserted behind the cursor.

`SessionService` merges each live reference through the user index CAS.
Each CAS attempt rereads the session. Missing records are skipped, terminal editors
are excluded, and unreclaimed app sandboxes retain their references.
If a user index is missing, the visitor first rebuilds it from a fresh authoritative session scan.
This recovery can read beyond the current page, including during initial migration.
It prevents index loss between pages from producing an incomplete index.
Corrupt sessions, mismatched IDs, and storage failures prevent completion.

Every session creation requires successful index registration, including before migration completes.
Admission uses session scans until the background runner observes the completion receipt.
`isComplete(id)` reads only process memory.
Each replica activates indexed reads independently, including after restart.
Worker HTTP isolates use `refreshCompleted()` through deferred background work because cron can run in another isolate.
The framework coalesces these read-only checks and limits retries to once per five seconds.
After completion, it stops storage reads. A refresh failure leaves scans active and logs the error.

Missing indexes still trigger strict recovery scans. Missing never means an empty
queue, including for a new user. Normal reads validate the indexed sessions;
lifecycle maintenance repairs membership. See [session index invariants](./bucket_spec.md#per-user-session-index).

The optional repair command remains available after migration:

```sh
pnpm --filter @marimo-hub/server session-index:rebuild
# Packaged installation:
node dist/session-index-rebuild.mjs
```

### Upgrade compatibility

Every concurrent writer must support `access_pending`: invalidate summaries before
permission writes and preserve other writers' markers. Before upgrading from
releases without this protocol, stop all old writers, including maintenance and
command-line processes. Do not roll back to those binaries against migrated storage.
Migration completion cannot prove that incompatible writers have stopped.
Session-index writers must require registration before admitting new sessions.
Stop older writers that omit registration or ignore its failures before upgrading.

An older compatible writer can replace a versioned summary with an unversioned
summary during rollout. Readers then use metadata until a current writer refreshes
it. The repair command can refresh these entries after rollout.

### Adding and retiring migrations

1. Add a permanent ID, such as `project-access-v2`. Never reuse an ID or change
   its cursor semantics.
2. Use `bucketMigration` for object traversal. Supply a prefix and an idempotent visitor
   that delegates writes to the owning service. Use `runBatch` for other batch shapes.
3. Check cancellation before storage work and publication. Preserve domain concurrency safeguards.
4. Keep readers compatible with unmigrated data. Keep checkpoint reads out of domain request methods.
5. Test interruption, competing replicas, lost responses, corrupt records,
   concurrent mutations, and completed migrations without repeated I/O.
6. Retain definitions required by supported upgrades. A replacement must handle
   all earlier supported data shapes, or retain its prerequisites in registry order.
7. Remove obsolete definitions when supported upgrades no longer need them.
   Retain their receipts; the runner ignores removed IDs without listing storage.
   Update readiness consumers to use the replacement migration or the current format.

This runner is unsuitable for non-idempotent external effects or destructive work
that requires exclusive writers.

## Stored schema strategies

| Object                                          | Strategy                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Snapshots                                       | Normalize on read; publish a new immutable snapshot on mutation. Never rewrite history. |
| Project, notebook, source, and version metadata | Use background batches when existing objects need conversion.                           |
| Catalog pointer                                 | Change through `CatalogService`; incompatible formats require a staged rollout.         |
| Audit events                                    | Never migrate history. Readers must accept retained event versions.                     |

`upgradeSnapshot` currently returns v1 snapshots unchanged. Future conversions
belong there. `CatalogService` writes the greater of the supported and stored
snapshot versions, so older replicas cannot lower that version.

## Rolling-deploy compatibility

Within a schema version, changes must be additive. Preserve unknown fields when
reading and writing shared records; `SnapshotSchema` uses `z.looseObject` for this.
For breaking changes, deploy readers that accept both shapes before enabling new writers.

Field preservation does not provide policy enforcement. Before enabling resource
constraints or labels, upgrade every API, proxy, and maintenance replica. All
replicas must use the same resource-security configuration.

Optional session `surfaces` need no backfill: absence means no secondary surfaces.
Missing security-label projections require authoritative metadata reads; routine
projection writes repair them. See [projection contracts](./bucket_spec.md#4-file-schemas).
