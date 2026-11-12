# Migrations

Project access summaries and session indexes migrate automatically in the background.
Normal upgrades require neither shell access nor a rebuild command.

## Automatic background migrations

`MigrationService` runs the registry in
`packages/core/src/services/catalog/migrations.ts`. Each migration has a permanent ID.
Each tick visits ready migrations in registry order and runs at most one successful bounded batch:

1. `project-access-v1` updates catalog summaries.
2. `session-index-v1` builds per-user session indexes. It sets `after: []`, so it
   does not wait for `project-access-v1`.

A migration waits for the IDs in its `after` list, or for every earlier migration
when `after` is omitted.

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
  possible. Otherwise, another attempt waits for expiry. After a failure, the next
  ready migration runs in the same tick. Dependents wait for completion.
- After three consecutive failures, a process backs off that migration: 30 seconds,
  doubling to a 10-minute cap. Backoff is in memory and resets on success or restart.
- Invalid or unknown checkpoint formats fail without overwriting stored state.
  They require repair.

Progress and completion emit `migration_progress` and `migration_completed` logs.
Node reports failures through its background-loop logs and, on maintenance
replicas, the loop health endpoint. Worker failures reject the scheduled handler
after the other scheduled work finishes.

### Admin progress and manual attempts

Session-authenticated super admins can open **Admin → Migrations** to inspect
progress, dependencies, completion receipts, and safe failure messages. Inspection
reads known checkpoints without storage listings, domain scans, or repairs.
Retired migrations appear separately; unknown historical IDs remain untouched.

**Request attempt** registers one bounded attempt, without targeting a row or
bypassing dependencies, leases, or backoff. Closing the browser does not cancel it.
Registration is not durable: process death can lose a request. Startup and scheduled
attempts resume from saved checkpoints.

Node uses a 55-second deadline and rejects registration during shutdown or queue
saturation. Worker requests use invocation-local `waitUntil` with a 20-second
cancellation budget. Automatic Worker continuation requires cron; the page does
not verify live scheduler health. Hosts without registration support disable the action.

Progress counts committed visits, including skipped and already-current entries,
not unique items. A legacy cursor starts a partial counter labeled “visited since
tracking began”. Missing telemetry means unavailable, not zero. Older writers can
discard telemetry during rolling deployments without changing execution semantics.

Check server logs to diagnose failures. Invalid checkpoints block dependents while
independent migrations can continue. Failed attempts retain saved progress;
shutdown cancellation is not an operator failure.

### Project access v1

`ProjectService.migrateAccessSummaries` processes up to 25 projects in stable ID
order. Each changed batch publishes one catalog snapshot. It rereads authoritative
metadata on every catalog CAS attempt and leaves project metadata unchanged.

Current summaries carry `access.version: 1`. Readers trust a summary only under the
[projection rules](./bucket_spec.md#42-_systemsnapshotsidjson); otherwise they read metadata.
Routine projections, migration, and forced access rebuilds preserve newer summaries unchanged.
Updates to supported or legacy summaries preserve unknown fields and replace known permission fields.

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
({
	...bucketMigration({
		id: 'session-index-v1',
		bucket,
		prefix: paths.sessionsPrefix,
		migrate: (key, signal) => sessions.migrateSessionIndexEntry(key, signal),
	}),
	after: [],
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

Recovery scans and pre-migration cap scans skip an invalid record unless its raw `user_id` names the target user.
The explicit rebuild command fails on any invalid record.

Every session creation requires successful index registration, including before migration completes.
Admission uses session scans until the background runner observes the completion receipt.
`isComplete(id)` reads only process memory.
Each replica activates indexed reads independently, including after restart.
Worker HTTP isolates use `refreshCompleted()` through deferred background work because cron can run in another isolate.
The framework coalesces these read-only checks and limits retries to once per five seconds.
After completion, it stops storage reads. A refresh failure leaves scans active and logs the error.
The [session index invariants](./bucket_spec.md#per-user-session-index) cover ranking, missing indexes, and repair.

The optional repair command remains available after migration:

```sh
pnpm --filter @marimo-hub/server session-index:rebuild
# Packaged installation:
node dist/session-index-rebuild.mjs
```

### Adding and retiring migrations

1. Add a permanent ID, such as `project-access-v2`. Never reuse an ID or change
   its cursor semantics.
2. Use `bucketMigration` for object traversal. Supply a prefix and an idempotent visitor
   that delegates writes to the owning service. Use `runBatch` for other batch shapes.
3. Check cancellation before storage work and publication. Preserve domain concurrency safeguards.
4. Keep readers compatible with unmigrated data. Keep checkpoint reads out of domain request methods.
5. Test interruption, competing replicas, lost responses, corrupt records,
   concurrent mutations, retirement, and completed migrations without repeated I/O.
6. Retain definitions required by supported upgrades. A replacement must handle
   all earlier supported data shapes, or retain its prerequisites in registry order.
   Set `after` to the IDs it needs; omitting it waits for every earlier migration.
7. Remove obsolete definitions when supported upgrades no longer need them.
   Retain their receipts and move display metadata to `retiredMigrations`.
   Remove stale dependencies. Missing historical receipts display “Not recorded”.
   Update readiness consumers to use the replacement migration or the current format.

A registry entry supplies execution and display metadata:

```ts
{
	id: 'widget-index-v1',
	title: 'Index widgets',
	description: 'Build widget summaries in bounded batches.',
	impact: 'The app stays available. Reads use existing data until the index is ready.',
	progressUnit: 'widgets',
	after: [],
	runBatch: async ({ cursor, signal }) => {
		signal?.throwIfAborted();
		return widgets.migrateIndex({ cursor, signal });
	},
}
```

The owner-service batch returns `{ done, cursor?, progress: { delta } }`.
Compute `delta` inside each successful domain CAS attempt, including the final batch.
Do not increment a counter outside a retry callback. Return
`waiting_reason: 'waiting_for_initialization'` without progress when initialization is required.
A fixed work set can also return `progress.total`; it must cover all committed visits.
The page and API require no migration-specific code.

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
