# Operations runbook

MarimoHub has **no separate database** — but that does not mean "no ops." The
object store _is_ the database: it is the single source of truth and the one
thing you must back up, monitor, and recover. This document is the operator's
counterpart to [`bucket_spec.md`](./bucket_spec.md) (the schema) and
[`architecture.md`](./architecture.md) (the components). It covers the six
operational concerns the storage design implies.

| #   | Concern                       | Mechanism                                                            |
| --- | ----------------------------- | -------------------------------------------------------------------- |
| 1   | Backup & disaster recovery    | Object versioning + lifecycle + (optionally) replication             |
| 2   | Corruption recovery           | The deletion invariant + a mechanical pointer-rollback procedure     |
| 3   | The single-cron guarantee     | A `replicas: 1` maintenance Deployment + a bucket-CAS advisory lease |
| 4   | Rolling-upgrade compatibility | Forward-tolerant reads + forward-compatible writes + a deploy policy |
| 5   | Snapshot & event growth       | `MaintenanceService` retention (the Iceberg "snapshot-expiry" pass)  |
| 6   | Observability                 | A `Metrics` port + one wide event per maintenance cycle              |

---

## 1. Backup & disaster recovery

**The bucket is the database. Back it up.** "No database to back up" is true only
of a _separate_ RDBMS; everything durable — notebook code, metadata, project
membership, the catalog pointer, snapshots, the audit log — lives in the bucket.
Losing or corrupting the bucket is total data loss.

Recommended posture (all at the storage layer, no app involvement):

- **Enable native object versioning** (S3 Versioning / R2 object versions). This
  is the cheap safety net _beneath_ the snapshot layer. It specifically rescues
  the one mutable-in-place content object — `notebook/notebook.py`, overwritten
  on every save (§7.3 of the spec) — which the snapshot chain does **not**
  version. (Resolves the "object-store versioning" open question in the spec.)
- **Lifecycle/expiry on noncurrent versions** so versioning cost stays bounded
  (e.g. expire noncurrent versions after 30–90 days). The app's own retention
  (§5 below) prunes _current_ objects; lifecycle handles the version tail.
- **Cross-region or cross-bucket replication** for DR if the deployment's RPO
  warrants it. Replication is async — treat the replica as "near-current," not
  transactionally consistent.

### Point-in-time restore has referential subtleties

A consistent restore is **not** "restore `catalog.json`." The pointer is only
meaningful together with what it names:

1. The `_system/catalog.json` pointer at time _T_, **and**
2. the exact snapshot it names (`current_snapshot_id`), **and**
3. the content objects that snapshot references (`notebook.py`, `pyproject.toml`,
   `meta.json`, … per `key_prefix`).

Pitfalls:

- Restoring the pointer alone, to a snapshot that was later pruned by retention
  (§5), yields a dangling pointer — see §2.
- Restoring the index to time _T_ does **not** roll back `notebook.py`, which is
  overwritten in place. To roll back code you must also restore the relevant
  immutable `notebook/versions/{vid}/` objects (or rely on object versioning).

### Test-restore procedure (do this before you need it)

1. Restore the bucket (or a prefix) into a scratch bucket.
2. Point a staging deployment at it (`MARIMOHUB_STORAGE_*`).
3. Hit `GET /api/projects` — that exercises `catalog.json` → current snapshot
   (the 2-GET read path). A clean listing means the pointer + snapshot restored
   consistently.
4. Open a notebook and a prior version to confirm content + `versions/` restored.

---

## 2. Corruption recovery

**Deletion invariant (state it, rely on it):** _a writer only ever deletes a
snapshot it itself wrote and never committed._

- The loser of a CAS race deletes the orphan snapshot it just wrote, before
  retrying (`CatalogService.mutateSnapshot`, `initialize`).
- Retention never deletes the snapshot `catalog.json` points at or its
  `previous_snapshot_id` (`MaintenanceService.expireSnapshots`).

Because no code path deletes a _committed_ snapshot, the system can never orphan
its own live pointer. Snapshots are immutable and independently named, which
turns "the pointer points at a missing snapshot" (from an out-of-band deletion,
a misfired cleanup, or a bug) into a clean, mechanical rollback rather than data
loss.

### Recover a dangling catalog pointer

`GET /api/projects` failing with a "snapshot not found" / `NotInitializedError`
is the symptom: `catalog.json` names a snapshot that no longer exists.

1. Read `_system/catalog.json` → note `current_snapshot_id` and
   `previous_snapshot_id`.
2. If `previous_snapshot_id` exists and its object is present, that is your
   rollback target.
3. Otherwise list `_system/snapshots/` and pick the newest surviving snapshot
   **by `created_at` (or object `uploaded`), NOT by key order** — snapshot IDs
   are random, not time-sortable (spec §5).
4. Write the chosen snapshot back under a **new** ID, then CAS-swap
   `catalog.json` to point at it (the normal commit path; do not hand-edit the
   pointer past the CAS). This restores the index; restore content per §1 if the
   loss extended to notebook objects.

> Always go through the CAS path to update the pointer — never a plain `PUT` —
> so a concurrent writer can't be clobbered mid-recovery.

---

## 3. The single-cron guarantee

The maintenance sweep (expire/reap sessions, prune snapshots/events) must run on
**exactly one** writer — two reapers racing on deletes is a real failure mode.
Two layers enforce this:

**Deployment layer (primary).** A dedicated `replicas: 1` Deployment,
`marimohub-maintenance`, owns the cron; the API Deployment runs with
`MARIMOHUB_RUN_MAINTENANCE=false` (`apps/server/k8s/deployment.yaml`). It uses
`strategy: Recreate` (not the default `RollingUpdate`, which can briefly surge to
two pods). The API tier stays free to scale horizontally. On **Cloudflare**, the
`scheduled()` trigger is a platform singleton, so no extra coordination is
needed there.

**Application layer (defense-in-depth).** Inside the sweep, a bucket-CAS advisory
lease (`MaintenanceLock`, `packages/core/src/services/MaintenanceLock.ts`) is
acquired before any delete and released after. It is built on the _same_
compare-and-swap primitive as the catalog (`onlyIfNotExists` to claim,
`onlyIfEtagMatches` to steal an expired lease) — **no etcd, no `Lease`, nothing
to provision.** If a misconfiguration or a bad rollout ever runs two reapers,
only the lease holder proceeds, so deletes never race. The lease has a 10-minute
TTL (comfortably longer than one 5-minute cycle) and the same holder renews it.

> We deliberately avoid a Kubernetes `Lease`/leader-election primitive: it would
> couple the provider-agnostic core to k8s. The CAS lease works identically on
> Cloudflare, Docker, and k8s.

---

## 4. Rolling-upgrade schema compatibility

During a rolling deploy, old and new replicas run **simultaneously**. The
compatibility policy and its code enforcement live in
[`migrations.md`](./migrations.md#rolling-deploy-compatibility); the operator
summary:

- **Both directions are handled in code.** New code reads old (forward-tolerant
  `schema_version` + lazy `upgradeSnapshot`); old code tolerates new
  (`SnapshotSchema` preserves unknown fields, and `mutateSnapshot` never
  downgrades the version).
- **Additive-only changes within a schema version** are safe to ship as a normal
  rolling deploy.
- **A breaking schema change is a two-phase deploy:** ship the readers (a release
  that understands both shapes) and let it fully roll out, _then_ ship the
  writers. Never both in one release.

Operationally: a standard release needs no special handling. A release that bumps
a `schema_version` should be checked against the two-phase rule before rollout.

---

## 5. Snapshot & event growth

Every commit writes a new immutable snapshot, and every mutation writes an
immutable event object. At ~20 writes/day that is thousands of objects per year —
they need their own expiry (the same reason Apache Iceberg has snapshot expiry),
or every prefix scan slowly degrades.

`MaintenanceService` (`packages/core/src/services/MaintenanceService.ts`), run by
the maintenance cron (§3), handles this:

- **`expireSnapshots`** — deletes snapshots older than the retention window
  (default 90 days), keeping a floor of the most recent `keepLast` (default 20),
  and **never** the current or previous snapshot (the §2 invariant). Recency is
  taken from object `uploaded`, since snapshot IDs aren't time-sortable.
- **`pruneEvents`** — deletes whole event-day folders
  (`_system/events/YYYY-MM-DD/`) older than the retention window.

Adjacent, already-handled growth: **notebook versions** are pruned per-save by
`NotebookService.pruneVersions` (last 50). **Session records** are reaped by
`SessionService.reapTerminated` (24h after going terminal).

Tune retention/floor by passing options to the service if a deployment needs a
different policy; the defaults suit the spec's 10×100 scale target.

---

## 6. Observability

A human-readable ops log isn't enough: an operator needs CAS contention, snapshot
growth, live-session count, and reaper activity — none of which is inferable from
request logs. These flow through a `Metrics` port
(`packages/core/src/ports/metrics.ts`); the default is a no-op, and entrypoints
inject a real emitter.

The Node server uses `WideEventMetrics` (`apps/server/src/metrics.ts`), which
accumulates counters/gauges and is flushed as **one wide event per maintenance
cycle** — the `maintenance_cycle` log line (canonical "wide event"; see the
logging-best-practices skill). Counters are cumulative since boot, so derive
rates from deltas between lines.

Signals emitted today:

| Signal                                               | Type    | Source                          |
| ---------------------------------------------------- | ------- | ------------------------------- |
| `catalog.cas.attempt` / `.conflict` / `.exhausted`   | counter | `CatalogService.mutateSnapshot` |
| `sessions.live`                                      | gauge   | `SessionService.expireStale`    |
| `sessions.expired` / `sessions.reaped`               | counter | `SessionService`                |
| `snapshots.count` / `snapshots.bytes`                | gauge   | `MaintenanceService`            |
| `maintenance.snapshots_pruned` / `.events_pruned`    | counter | `MaintenanceService`            |
| Per-cycle: `sessions_expired`, `snapshots_pruned`, … | fields  | the `maintenance_cycle` event   |

What to watch / alert on:

- **CAS conflict rate climbing** (`catalog.cas.conflict` / `attempt`) → write
  contention on the catalog; `catalog.cas.exhausted` > 0 means writes are being
  rejected with `409 CONFLICT`.
- **`snapshots.count` / `snapshots.bytes` trending up** without bound → retention
  isn't running (check the maintenance Deployment / lease).
- **`maintenance_cycle` line missing** for multiple intervals → the reaper is
  down or not the lease holder.
- **`sessions.live`** → the live sandbox/session count; pair it with
  **provider-side cost**. Sandbox _cost_ is intentionally not emitted here — the
  `SandboxProvider` port doesn't expose billing — so derive cost from the compute
  provider (Modal/Cloudflare) keyed on live count.

A pull-based **Prometheus `/metrics`** endpoint is a drop-in alternative: provide
a `Metrics` adapter backed by a registry and expose it. The port is the seam; the
wide-event emitter is the batteries-included default.
