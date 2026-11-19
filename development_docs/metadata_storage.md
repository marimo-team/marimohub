# PostgreSQL metadata storage

PostgreSQL stores metadata in `hub_metadata.records`. Artifacts stay in the configured bucket.
The default metadata backend is `bucket`. PostgreSQL requires a Node host, PostgreSQL 17 or later, and an activated deployment.

## Configuration and schema

Set `MARIMOHUB_METADATA_BACKEND=postgres` and `MARIMOHUB_METADATA_NAMESPACE` for runtime replicas.
Use separate database credentials:

| Variable                                | Purpose                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `MARIMOHUB_METADATA_ADMIN_POSTGRES_URL` | Schema-owner credential for administration commands. Keep it out of runtime replicas. |
| `MARIMOHUB_METADATA_POSTGRES_URL`       | Runtime credential with the grants below.                                             |

See [configuration](../docs/configuration.md#metadata-storage) for connection limits and timeouts.

Run migrations with the schema-owner credential:

```sh
pnpm --filter @marimo-hub/server metadata:migrate-schema
```

Migrations use an advisory lock and record checksums in the same transaction. Startup checks those checksums.
Schema creation does not activate a deployment. HTTP requests never apply DDL.

Inspect the bucket marker, key counts, and transfer state:

```sh
pnpm --filter @marimo-hub/server metadata:inspect
```

SQL inspection requires the administrative URL and `MARIMOHUB_METADATA_NAMESPACE`.

## Runtime database role

The schema owner owns the deployment-lock function. The runtime role must not own the schema or change deployment state.
Use these grants for a role named `hub_runtime`:

```sql
GRANT USAGE ON SCHEMA hub_metadata TO hub_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON hub_metadata.records TO hub_runtime;
GRANT SELECT, INSERT, UPDATE ON hub_metadata.scopes TO hub_runtime;
GRANT SELECT ON hub_metadata.deployments, hub_metadata.schema_migrations TO hub_runtime;
GRANT EXECUTE ON FUNCTION
    hub_metadata.prepare_record(),
    hub_metadata.session_time(text),
    hub_metadata.guard_deployment(text, bigint, uuid)
    TO hub_runtime;
```

PostgreSQL requires update privilege for `SELECT FOR SHARE`.
The restricted `SECURITY DEFINER` function acquires this lock without granting deployment-write access. Its search path is fixed.

Namespaces separate data, not database permissions. Mutually untrusted deployments require separate roles and databases.

## Offline transfer and activation

Before either transfer direction:

1. Stop requests, schedulers, maintenance, embedded hosts, and runtimes with storage credentials.
2. Drain and reclaim sessions and pools.
3. Reconcile uploads, moves, previews, and pending external publications.
4. Deny old workloads write access through deployment controls or credential revocation.

The marker cannot stop writes from binaries that ignore it. Keep writers stopped until activation completes.

For bucket-to-SQL transfer, create `transfer.json` with an unused namespace and a stable transfer UUID:

```json
{ "namespace": "hub", "id": "11111111-1111-4111-8111-111111111111", "pageSize": 100 }
```

Run these commands in order:

```sh
pnpm --filter @marimo-hub/server metadata:transfer --input transfer.json --writers-stopped
pnpm --filter @marimo-hub/server metadata:inspect
pnpm --filter @marimo-hub/server metadata:activate --input transfer.json --writers-stopped
```

The transfer freezes the bucket marker and copies metadata into an isolated SQL namespace.
It preserves bytes, object metadata, and upload timestamps, with new ETags.
A second inventory pass reconciles updates and deletions. Owner-schema and reference checks block invalid records, unsafe workspace paths, missing artifacts, and unresolved operations.

A failed page leaves its SQL checkpoint unchanged. A crashed worker's lease expires after 60 seconds.
To resume, use the same input file and transfer ID.

Activation commits SQL first, then publishes the matching bucket marker. Hosts require both records to agree.
If activation fails, keep writers stopped. Rerun activation with the same ID.
Complete pending activation before starting another transfer.

For an empty deployment, add `"fresh":true`. This rejects any existing bucket object or namespace.
After interrupted initialization, remove `fresh` and resume with the same ID.
Keep old bucket metadata read-only through the rollback window.

## Reverse transfer

To return to bucket metadata, use the active SQL namespace and a new transfer ID.
Set `"direction":"sql_to_bucket"` in the input file. Use the same transfer and activation commands.

Reverse transfer freezes SQL under an exclusive deployment lock.
It copies current metadata, checks bytes and object metadata, and deletes stale bucket metadata. Artifacts stay unchanged.
Exported objects receive bucket-generated ETags and upload timestamps. Activation retires the SQL namespace but retains its records and receipts.

Before activation, stop all transfer workers. Revoke credentials from abandoned exporters.
A database lease cannot cancel an object-store request already in flight.
After an uncertain write, keep writers stopped. Resume the same transfer to check the target.
After activation, restart every process to clear caches.
For a later bucket-to-SQL transfer, use a new namespace.

## Backup and restore

Back up SQL, the artifact bucket, and its backend marker as one deployment set.
Record the namespace, artifact-store UUID, epoch, schema checksums, and backup time.
Retain artifact versions for at least the metadata restore window. A SQL restore cannot recover deleted artifact bytes.

With all writers stopped and their write access revoked:

1. Restore matching artifacts and SQL data to isolated targets.
2. Restore the matching marker.
3. Check its artifact-store UUID and epoch against SQL.
4. Run `metadata:inspect --audit` with the administrative URL.
5. Recover missing artifacts from the paired backup.
6. Configure the restored backend.
7. After the audit passes, restart hosts. Keep traffic blocked until readiness succeeds.

Never select bucket mode as an outage fallback against stale metadata.

## Runtime behavior

Only config imports the PostgreSQL adapter. Core services use `HubStorage` and metadata ports.
The logical bucket routes keys through a versioned placement manifest. Unknown keys and backend control records fail closed.
External adapters need placement rules and owner schemas. SQL reads never fall back to old bucket metadata.

Each SQL operation holds a shared deployment lock until its transaction ends.
The deployment must be active and match the configured namespace, epoch, and artifact-store identity.
A mismatch is an availability error, not a missing object.
SQL session queries return candidates. Core retains schema checks, lifecycle policy, user-index writes, and admission ranking.

Embedded Node hosts must supply `nodeMetadataFactory` from `@marimo-hub/config/metadata.node`.
Await `deps.storageLifecycle.ready()` before serving requests.
Stop requests and background writers before calling `deps.storageLifecycle.close()`.
Operations fail before readiness and after shutdown. Readiness requires a matching active marker in the artifact bucket.

The Worker supports bucket metadata only. It rejects PostgreSQL configuration and incompatible markers before requests or scheduled work.
Its default bundle excludes the PostgreSQL adapter and driver.

## Transaction coverage

Transactions lock user, project, and notebook scopes in a stable order. When a callback ends, its handles expire.
Serialization failures and deadlocks allow at most three attempts of the complete callback. Uncertain commits never retry automatically.
Artifact uploads and provider calls stay outside transactions.

| Operation                                                   | Atomic metadata changes                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Session creation                                            | Starting record, prune-cutoff check, and user-index registration.                                          |
| Ordinary persistent-editor admission                        | Policy-revision checks, user-cap ranking, editor claim, and source fence. Provider boot follows admission. |
| Normal capture and stop capture with an explicit stop lease | Source-head CAS and durable-capture acknowledgement, after artifact upload.                                |

App pools, warm pools, previews, jobs, hidden runtimes, and takeover retain their existing admission protocols. Their session creation is atomic.
Capture with a custom ownership callback retains its existing protocol.
Stop intent, runtime stop, provider destruction, and final receipts remain separate durable stages.
These paths do not provide global atomic cap enforcement.

## Tests and performance

For local tests without Docker:

```sh
brew install postgresql@17
pnpm --filter @marimo-hub/metadata-postgres test:local
```

The runner finds binaries through `PG_BINDIR`, `PATH`, or Homebrew.
It creates a temporary cluster with a private Unix socket and random credentials, then checks the connection with `psql`.
After the tests, it stops and deletes the cluster. It never uses an existing database.
Each run uses a unique URL to prevent cached test results. Role and lock tests use independent connections.

For an existing disposable database, set `MARIMOHUB_TEST_POSTGRES_URL` with permission to create test roles:

```sh
MARIMOHUB_REQUIRE_POSTGRES_TESTS=1 \
  pnpm --filter @marimo-hub/metadata-postgres test
```

CI requires this URL. Three streaming contract cases do not apply to the metadata interface.
The suites cover:

- Storage contracts, namespace isolation, role restrictions, pagination, and SQL-injection payloads.
- Catalog races, editor claims, session lifecycle, capture failures, notebook moves, deletion, and retained artifacts across memory, filesystem, and SQL storage.
- Admission and capture transactions, lease takeover, stale checkpoints, interrupted activation, and both transfer directions.

Local performance reports compare bucket metadata, SQL with existing protocols, and SQL with scoped transactions.
Each cohort uses 30 samples with the same artifact backend, content, and session history.
Reports include cold, median, and p95 time, storage calls, and metadata bytes. Heartbeat measurements use the persistence-throttled path.
They exclude provider latency, remote storage latency, and pool saturation. These measurements do not establish an end-to-end speedup.
