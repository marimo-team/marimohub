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

Both URLs must verify the server certificate (`sslmode=verify-full` or `verify-ca`) unless the host is loopback or a Unix socket.
Startup and the administration commands reject other URLs. `MARIMOHUB_METADATA_POSTGRES_ALLOW_INSECURE_TRANSPORT=true` overrides this check.

Each administration command has two forms. From a repository checkout, use `pnpm --filter @marimo-hub/server metadata:<command>`.
In the container image, which has no `tsx`, use `node dist/metadata-<command>.mjs` with the same arguments.

Run migrations with the schema-owner credential:

```sh
pnpm --filter @marimo-hub/server metadata:migrate-schema
# container image
node dist/metadata-migrate-schema.mjs
```

Migration sources live in `packages/metadata-postgres/sql/`.
Migrations use an advisory lock and record checksums in the same transaction. Startup checks those checksums.
Schema creation does not activate a deployment. HTTP requests never apply DDL.

Inspect the bucket marker, key counts, and transfer state:

```sh
pnpm --filter @marimo-hub/server metadata:inspect
# container image
node dist/metadata-inspect.mjs
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

The restricted `SECURITY DEFINER` function reads deployment state without granting deployment-write access. Its search path is fixed.

Namespaces separate data, not database permissions. Mutually untrusted deployments require separate roles and databases.

## Offline transfer and activation

Before either transfer direction:

0. While hosts still run, run `metadata:inspect --audit` to find blockers: undrained pools, live sessions, pending operations, and unclassified keys (`counts.unknown`). Fix them, then run the audit again after step 4.
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
# container image
node dist/metadata-transfer.mjs --input transfer.json --writers-stopped
node dist/metadata-inspect.mjs
node dist/metadata-activate.mjs --input transfer.json --writers-stopped
```

Before it freezes anything, the transfer runs the same reference audit as `metadata:inspect --audit` and stops if the audit fails.
The transfer freezes the bucket marker and copies metadata into an isolated SQL namespace.
It preserves bytes, object metadata, and upload timestamps, with new ETags.
A second inventory pass reconciles updates and deletions without rewriting unchanged SQL records. Owner-schema and reference checks block invalid records, unsafe workspace paths, missing artifacts, and unresolved operations.

A failed page leaves its SQL checkpoint unchanged. A crashed worker's lease expires after 60 seconds.
Transfer steps renew the lease while holding the transfer-row lock, including during object reads and reference audits.
To resume, use the same input file and transfer ID.
The CLI reports transfer errors, such as undrained pools, and hides raw driver errors.

Activation commits SQL first, then publishes the matching bucket marker. Hosts require both records to agree.
If activation fails, keep writers stopped. Rerun activation with the same ID.
Complete pending activation before starting another transfer.

For an empty deployment, add `"fresh":true`. This rejects any existing bucket object or namespace.
After interrupted initialization, remove `fresh` and resume with the same ID.
Keep old bucket metadata read-only through the rollback window.
No command deletes it afterwards. Until you remove it, logical listings also read the stale bucket copies and discard them.

### Abort a transfer

A transfer can stop after the freeze, for example when the final audit reports an undrained pool. Hosts cannot start while the marker is frozen. To return to the source backend, abort with the same input file:

```sh
pnpm --filter @marimo-hub/server metadata:transfer --input transfer.json --writers-stopped --abort
# container image
node dist/metadata-transfer.mjs --input transfer.json --writers-stopped --abort
```

Abort waits for the 60-second lease of a crashed worker to expire. It refuses an activated transfer.
A forward abort deletes the importing namespace, its records, and its transfer rows, then resets the bucket marker to `active`.
A reverse abort sets the SQL deployment back to `active`, deletes the transfer rows, and resets the marker. Bucket objects that the reverse transfer already wrote stay as stale copies; SQL stays authoritative.
After the abort, fix the reported problem with hosts running, then start a new transfer with a new ID.

## Reverse transfer

To return to bucket metadata, use the active SQL namespace and a new transfer ID.
Set `"direction":"sql_to_bucket"` in the input file. Use the same transfer and activation commands.

Reverse transfer freezes SQL under an exclusive deployment lock. The freeze waits for in-flight SQL operations to commit.
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

Each SQL operation holds a shared advisory lock on its namespace until its transaction ends. Freeze and activation take the same lock exclusively. Reads therefore take no row lock and assign no transaction ID.
The deployment must be active and match the configured namespace, epoch, and artifact-store identity.
A mismatch is an availability error, not a missing object. Unavailable storage returns HTTP 503.
Uncertain commits still fail without automatic retries.

Azure listings use native pagination until a service page contains a supplementary Unicode character in an object key or prefix. That page and later logical pages use a sorted scan to preserve UTF-8 order. The scan retains only the requested page plus one entry. Use narrow prefixes and delimiters to bound fallback scans.

SQL session queries return candidates. Core retains schema checks, lifecycle policy, user-index writes, and admission ranking.

Embedded Node hosts must supply `nodeMetadataFactory` from `@marimo-hub/config/metadata.node`.
Await `deps.storageLifecycle.ready()` before serving requests.
Stop requests and background writers before calling `deps.storageLifecycle.close()`.
Operations fail before readiness and after shutdown. Readiness requires a matching active marker in the artifact bucket.

The Worker supports bucket metadata only. It rejects PostgreSQL configuration.
It shares the first successful marker check across requests and scheduled work for each environment. Failed checks can retry.
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

Set `MARIMOHUB_METADATA_BENCHMARK_LOG=1` to print the performance report described below.

CI requires this URL. Three streaming contract cases do not apply to the metadata interface.
The suites cover:

- Storage contracts, namespace isolation, role restrictions, pagination, and SQL-injection payloads.
- Catalog races, editor claims, session lifecycle, capture failures, notebook moves, deletion, and retained artifacts across memory, filesystem, and SQL storage.
- Admission and capture transactions, lease takeover, stale checkpoints, interrupted activation, and both transfer directions.

Local performance reports compare bucket metadata, SQL with existing protocols, and SQL with scoped transactions.
Each cohort uses 30 samples with the same artifact backend, content, and session history.
Reports include cold, median, and p95 time, storage calls, and metadata bytes. Heartbeat measurements use the persistence-throttled path.
They exclude provider latency, remote storage latency, and pool saturation. These measurements do not establish an end-to-end speedup.
