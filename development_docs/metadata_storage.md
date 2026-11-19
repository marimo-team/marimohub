# PostgreSQL metadata storage

The PostgreSQL adapter stores metadata bytes in `hub_metadata.records`. Artifact bytes remain in the configured bucket.
The default metadata backend remains `bucket`. The public API and stored domain formats remain unchanged.

The adapter and runtime composition are implemented. Offline bucket-to-SQL transfer and resumable activation are implemented. Reverse transfer is implemented. Scoped session creation and capture transactions are implemented; coverage is listed below.
The storage-parity release gates are not complete. Schema creation alone does not activate a deployment.

## Runtime composition

`packages/metadata-postgres` uses PostgreSQL 17 or later through `pg`.
Only config imports the concrete adapter. Core services use `HubStorage` and the metadata ports.

The logical bucket routes keys through the versioned placement manifest.
Unknown keys and backend control records fail closed.
Metadata reads never fall back to old bucket objects.

Each operation holds a shared lock on its deployment row until the transaction completes.
The deployment must remain active at the configured epoch, with the expected artifact-store identity.
A missing deployment or an epoch mismatch is an availability error, not a missing object.

The runtime keeps existing domain CAS protocols and session-index writes.
Session scans can use indexed SQL candidates. Core still validates sessions and applies capacity and lifecycle policy.
User admission ranking retains the existing index registration order.

## Schema administration

The administrative commands use `MARIMOHUB_METADATA_ADMIN_POSTGRES_URL`.
Runtime replicas use `MARIMOHUB_METADATA_POSTGRES_URL` with a separate database role.
Neither command prints connection URLs or record bodies.

Run schema migrations with the schema-owner credential:

```sh
pnpm --filter @marimo-hub/server metadata:migrate-schema
```

The command uses an advisory lock and records each migration checksum in the same transaction.
Startup checks these checksums. HTTP requests never apply DDL.

Inspect the artifact marker, placement counts, and optional SQL deployment state:

```sh
pnpm --filter @marimo-hub/server metadata:inspect
```

Inspection counts unknown keys and reports SQL transfer state. Transfer validates records with owner schemas and checks catalog, notebook, publication, and session references before activation.

## Runtime database role

The schema owner also owns the deployment-lock function.
The runtime role does not own the schema and cannot change deployment state.
The following grants use `hub_runtime` as the runtime role name:

```sql
GRANT USAGE ON SCHEMA hub_metadata TO hub_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON hub_metadata.records, hub_metadata.scopes TO hub_runtime;
GRANT SELECT ON hub_metadata.deployments, hub_metadata.schema_migrations TO hub_runtime;
GRANT EXECUTE ON FUNCTION
    hub_metadata.prepare_record(),
    hub_metadata.session_time(text),
    hub_metadata.guard_deployment(text, bigint, uuid)
    TO hub_runtime;
```

PostgreSQL requires update privilege for `SELECT FOR SHARE`.
Migration 2 provides a restricted `SECURITY DEFINER` function that checks identity and acquires the shared lock.
Its search path is fixed. The function grants no deployment-write operation to its caller.

A namespace separates deployments within one database. It does not provide authorization between mutually untrusted deployments.
Those deployments require separate database roles and databases.

## Host lifecycle

The Node server supplies `nodeMetadataFactory` from `@marimo-hub/config/metadata.node`.
Embedded Node hosts must supply the same factory and await `deps.storageLifecycle.ready()` before they serve requests.
They must stop requests and background writers before they call `deps.storageLifecycle.close()`.

SQL operations fail before readiness and after shutdown.
Readiness requires an active PostgreSQL marker in the artifact bucket, matching namespace, epoch, and artifact-store identity.
An absent marker does not authorize SQL initialization.

The Worker supports bucket metadata only. It rejects PostgreSQL configuration and incompatible backend markers before requests or scheduled writes.
The Node factory remains outside the platform-neutral config entrypoint.

## Validation

For local tests without Docker, install PostgreSQL 17 or later:

```sh
brew install postgresql@17
pnpm --filter @marimo-hub/metadata-postgres test:local
```

The command finds binaries through `PG_BINDIR`, `PATH`, or Homebrew.
It creates a temporary cluster with a private Unix socket and random credentials.
It checks the connection with `psql`, runs the live suite, then stops and removes the cluster.
It does not start a persistent service or use an existing database.
Each run supplies a unique test URL, so the task cache cannot replace the live database checks.

PGlite multiplexes connections over one backend. This suite requires independent database connections for role and lock tests.
Native PostgreSQL preserves those checks. See [PGlite socket limitations](https://pglite.dev/docs/pglite-socket).

The live suite requires a disposable PostgreSQL database with permission to create test roles.
The CI job sets `MARIMOHUB_REQUIRE_POSTGRES_TESTS=1`, so a missing database URL fails the job.

```sh
MARIMOHUB_REQUIRE_POSTGRES_TESTS=1 \
  pnpm --filter @marimo-hub/metadata-postgres test
```

`MARIMOHUB_TEST_POSTGRES_URL` supplies the test connection URL.
The suite exercises the shared storage contract, deployment fencing, role restrictions, pagination, session queries, and domain composition.
The metadata interface has no streaming methods, so three shared streaming cases do not apply.

## Offline transfer and activation

Stop requests, schedulers, maintenance, embedded hosts, and runtimes with storage credentials.
Drain and reclaim sessions. Reconcile uploads, moves, and pending external publications.
Deny old workloads write access with deployment controls or credential revocation.
The marker cannot fence binaries that ignore it.

Create a non-secret input file with a stable transfer UUID:

```json
{ "namespace": "hub", "id": "11111111-1111-4111-8111-111111111111", "pageSize": 100 }
```

Use the same file to resume after a failure:

```sh
pnpm --filter @marimo-hub/server metadata:transfer --input transfer.json --writers-stopped
pnpm --filter @marimo-hub/server metadata:inspect
pnpm --filter @marimo-hub/server metadata:activate --input transfer.json --writers-stopped
```

A transfer freezes the bucket marker and creates an isolated importing namespace.
Pages copy exact bytes, object metadata, and upload timestamps with new ETags.
A second inventory pass reconciles updates and deletions before reference checks.
Unknown keys, invalid records, missing references, and unresolved operations block readiness.
A failed page leaves its SQL checkpoint unchanged. A crashed worker's lease expires after 60 seconds.

Activation commits SQL first, then publishes the matching bucket marker.
If marker publication fails, keep writers stopped and rerun activation with the same ID.
Hosts remain unavailable until both records agree. Inspection shows a ready transfer beside an active deployment during this interval.

For a fresh deployment, add `"fresh":true`. The command rejects any existing bucket object or namespace.
After an interrupted fresh initialization, remove `fresh` and resume with the same transfer ID.
Keep old bucket metadata read-only through the rollback window. SQL never falls back to those objects.

## Reverse transfer and restore

After SQL has accepted writes, returning to bucket metadata requires a new transfer ID.
Set `"direction":"sql_to_bucket"` in the input file and use the same transfer and activation commands.
The command freezes SQL with an exclusive deployment-row lock before exporting.
It replaces stale metadata, verifies exported bytes and object metadata, and removes metadata deleted in SQL.
Artifacts are not rewritten. Exported metadata gets bucket-generated ETags and upload timestamps.
SQL records and transfer receipts remain retained after the namespace is retired.

Before activation, stop all transfer workers as well as runtime writers.
Revoke credentials from abandoned exporters; a database lease cannot cancel an object-store request already in flight.
Keep writers fenced after any uncertain object-store outcome and resume the same transfer to verify the target.
Restart every process after activation to clear caches.

Back up SQL metadata, the artifact bucket, and its backend marker as one deployment set.
Record the namespace, artifact-store UUID, epoch, schema checksums, and backup time with that set.
Keep artifact versions at least as long as the supported metadata restore window.
A SQL point-in-time restore cannot recover artifact bytes deleted outside that window.

Restore with all writers stopped and credentials fenced:

1. Restore the matching artifact data and SQL backup to isolated targets.
2. Restore the matching marker; verify its artifact-store UUID and epoch against SQL.
3. Run `metadata:inspect --audit` with the administrative DSN before allowing traffic.
4. Resolve missing artifacts from the paired artifact backup. Do not start with missing published content.
5. Configure the restored backend and restart hosts only after readiness succeeds.

Never select bucket mode as an outage fallback against stale metadata.

## Transaction coverage

SQL exposes a metadata-only unit of work with sorted user, project, and notebook scopes.
Callbacks share one connection and cannot use their handles after completion.
Known serialization failures and deadlocks retry the complete callback at most three times.
Uncertain commits never retry automatically. Artifact and provider operations stay outside callbacks.

Session creation commits the starting record, prune-cutoff validation, and user-index registration together.
Existing cap ranking, reuse, and compensation remain authoritative.
Capture commits source-head CAS and the session's durable-capture acknowledgement together after artifact upload.
This applies to normal capture and stop capture with an explicit stop lease.
Capture with a custom external ownership callback retains the existing protocol.
Stop intent, runtime stop, provider destruction, and final receipts remain separate durable stages.

App-pool reservations, warm-pool claims, previews, jobs, hidden runtimes, and takeover coordination retain their existing protocols.
Their session creation uses the atomic record/index operation, but admission across those reservations is not one transaction.
No global atomic cap-enforcement or coordination-round-trip reduction is claimed for these paths.
