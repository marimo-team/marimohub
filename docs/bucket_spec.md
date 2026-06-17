# marimo Notebooks — S3-compatible Backend

**Schema Design, Storage Architecture & CRUD API**

> Scale target: 10 Projects × 100 Notebooks · Iceberg-inspired metadata layer · No database

---

## 1. Overview & Design Principles

This document specifies the full bucket schema and architecture for running marimo notebook CRUD operations against S3-compatible storage, with no external database. The design is inspired by Apache Iceberg's metadata indirection pattern: a single atomic pointer (`catalog.json`) is the only mutable file in the system. Everything else is either immutable or append-only.

> **Core Invariant:** `catalog.json` is the only file ever overwritten in place. Every other write creates a new object. Reads are always consistent and concurrent writes are safe via conditional PUT (`If-Match` on ETag).

### Design Goals

- No database — S3-compatible storage is the only persistence layer
- O(1) reads for listing projects and notebooks — no object scanning
- Immutable snapshots give audit history for free
- Self-describing notebooks — each notebook folder is a complete, portable unit
- `notebook/` inner namespace hides implementation details from the API surface
- Typed source pointer — v1 ships `local` storage only; the `source.json` envelope is designed so other backends can be added later without touching the rest of the system
- Append-only system logs — never mutate, only write new objects
- Scales comfortably to 10 projects × 100 notebooks per project (1,000 total)

### Storage Requirements

Because there is no database, the object store itself must provide the guarantees the design leans on:

- **Strong read-after-write consistency** — a read (or list) immediately following a write reflects the latest data, so a writer always sees the snapshot it just committed.
- **Conditional writes (compare-and-swap)** — `If-Match` on ETag for the atomic `catalog.json` swap, returning `412 Precondition Failed` on mismatch; `If-None-Match: *` (create-if-absent) for first-write bootstrapping.

AWS S3 provides both (strong read-after-write consistency since 2020; `If-Match` / `If-None-Match` on `PutObject` since 2024). **Verify these for any other S3-compatible target** (MinIO, Ceph RGW, Backblaze B2, Tigris, …) — conditional-write support in particular varies by implementation and version. This is the single most important portability constraint for the design.

---

## 2. Metadata Layer

The `_system/` namespace is the heart of the architecture. Understanding it first makes the rest of the schema obvious.

### How the metadata layer works

```
catalog.json  →  snapshots/{id}.json  →  full project + notebook index
     ↑
only file ever mutated in place
```

`catalog.json` is a tiny pointer file — it names the current snapshot. Every write operation clones the current snapshot, applies changes, writes a new immutable snapshot, then atomically swaps `catalog.json` to point at it using a conditional PUT on ETag. If two writers race, one gets a `412 Precondition Failed` and retries. No corruption is possible.

A single GET on the current snapshot returns the complete project and notebook listing — all metadata, no code. At 10 projects × 100 notebooks with ~200 bytes of metadata per notebook, the snapshot is roughly 200KB. That's the entire index in one fast GET.

### Snapshot schema versioning

Every snapshot carries a `schema_version` field. When the snapshot structure changes, the Worker reads the version and applies a migration before writing the next snapshot. Old snapshots are never rewritten — they remain as a faithful record of the index at that point in time.

---

## 3. Full Bucket Schema

### 3.1 Top-Level Layout

```
s3-bucket/
├── _system/
│   ├── catalog.json                        ← THE single mutable pointer
│   ├── snapshots/
│   │   └── {snapshot-id}.json              ← immutable, one per write
│   ├── sessions/
│   │   └── {session-id}.json               ← active kernel sessions
│   ├── logs/
│   │   └── {YYYY-MM-DD}.log                ← append-only, rolled daily
│   └── events/
│       └── {YYYY-MM-DD}/
│           └── {event-id}.json             ← one immutable object per event
│
└── projects/
    └── {project-id}/
        ├── project.json                    ← project metadata
        └── notebooks/
            └── {notebook-id}/
                ├── meta.json               ← notebook metadata (title, author, tags…)
                ├── README.md               ← human description
                └── notebook/               ← implementation namespace (never exposed directly)
                    ├── source.json         ← typed source pointer (v1: local)
                    ├── notebook.py          ← latest code
                    ├── pyproject.toml      ← python dependencies
                    └── versions/
                        └── {version-id}/
                            ├── notebook.py
                            ├── pyproject.toml
                            └── version.json
```

### 3.2 Complete Path Reference

| Path                                                                    | Type     | Description                                                                                                                  |
| ----------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `_system/catalog.json`                                                  | JSON     | Single entry point. Points to the current snapshot. Only file mutated in-place.                                              |
| `_system/snapshots/{id}.json`                                           | JSON     | Immutable index snapshot. Lists all projects and notebooks with metadata. Written once, never modified.                      |
| `_system/sessions/{id}.json`                                            | JSON     | Live session record. Created on notebook open, updated by heartbeat, cleaned up on close or TTL expiry.                      |
| `_system/logs/{YYYY-MM-DD}.log`                                         | Text     | Human-readable application log. One file per day. For ops debugging only.                                                    |
| `_system/events/{YYYY-MM-DD}/{event-id}.json`                           | JSON     | Structured event log. One immutable object per event, keyed by a monotonic ULID under a per-day prefix. Primary audit trail. |
| `projects/{pid}/project.json`                                           | JSON     | Project metadata: name, description, owner, members, tags.                                                                   |
| `projects/{pid}/notebooks/{nid}/meta.json`                              | JSON     | Notebook metadata: title, description, status, author, tags, last_run_at. Never contains code or paths.                      |
| `projects/{pid}/notebooks/{nid}/README.md`                              | Markdown | Human-readable description and usage notes.                                                                                  |
| `projects/{pid}/notebooks/{nid}/notebook/source.json`                   | JSON     | Typed source pointer. Declares where code lives. v1 supports `local`.                                                        |
| `projects/{pid}/notebooks/{nid}/notebook/notebook.py`                   | Python   | Latest notebook code.                                                                                                        |
| `projects/{pid}/notebooks/{nid}/notebook/pyproject.toml`                | TOML     | Python dependency manifest.                                                                                                  |
| `projects/{pid}/notebooks/{nid}/notebook/versions/{vid}/notebook.py`    | Python   | Immutable version snapshot of the code.                                                                                      |
| `projects/{pid}/notebooks/{nid}/notebook/versions/{vid}/pyproject.toml` | TOML     | Dependency snapshot at time of version.                                                                                      |
| `projects/{pid}/notebooks/{nid}/notebook/versions/{vid}/version.json`   | JSON     | Version metadata: saved_at, author, message, parent_id.                                                                      |

---

## 4. File Schemas

### 4.1 `_system/catalog.json`

The single mutable entry point. Overwritten atomically using conditional PUT with `If-Match` on the current ETag.

```json
{
	"version": 1,
	"updated_at": "2025-03-05T14:22:00Z",
	"current_snapshot_id": "snap_01HXYZ9ABC",
	"current_snapshot_key": "_system/snapshots/snap_01HXYZ9ABC.json",
	"previous_snapshot_id": "snap_01HXYZ8DEF"
}
```

### 4.2 `_system/snapshots/{id}.json`

Written once per mutating operation. Never modified. The `schema_version` field governs how the Worker interprets the structure — bumped on any breaking change to the snapshot shape.

```json
{
	"snapshot_id": "snap_01HXYZ9ABC",
	"schema_version": 1,
	"created_at": "2025-03-05T14:22:00Z",
	"operation": "notebook.create",
	"actor": "user_abc123",
	"projects": [
		{
			"id": "proj_01HXY11111",
			"name": "Data Science",
			"description": "Exploratory analysis notebooks",
			"owner": "user_abc123",
			"created_at": "2025-01-10T09:00:00Z",
			"updated_at": "2025-03-05T14:22:00Z",
			"notebook_count": 3,
			"notebooks": [
				{
					"id": "nb_01HXYZ22222",
					"title": "Revenue Analysis",
					"description": "Monthly revenue breakdown",
					"status": "active",
					"source_type": "local",
					"author": "user_abc123",
					"created_at": "2025-01-15T10:00:00Z",
					"updated_at": "2025-03-05T14:22:00Z",
					"tags": ["finance", "monthly"],
					"last_run_at": "2025-03-04T08:30:00Z",
					"key_prefix": "projects/proj_01HXY11111/notebooks/nb_01HXYZ22222"
				}
			]
		}
	]
}
```

> `key_prefix` is an **internal** physical locator the Worker uses to address objects. It is stored in the snapshot but stripped from every API response (§13) — clients address notebooks by `{project_id, notebook_id}` and never see storage paths.

### 4.3 `projects/{pid}/project.json`

```json
{
	"id": "proj_01HXY11111",
	"name": "Data Science",
	"description": "Exploratory analysis notebooks",
	"owner": "user_abc123",
	"members": [
		{ "user_id": "user_abc123", "role": "admin" },
		{ "user_id": "user_def456", "role": "editor" }
	],
	"created_at": "2025-01-10T09:00:00Z",
	"updated_at": "2025-03-05T14:22:00Z",
	"tags": ["analytics", "internal"]
}
```

> **Member roles:** `admin` (full control including delete and member management), `editor` (create and edit notebooks), `viewer` (read-only). See §12 for the authorization model — including which of these roles v1 actually enforces.

### 4.4 `projects/{pid}/notebooks/{nid}/meta.json`

Contains only notebook-level concerns. No code, no paths, no source details — those live inside `notebook/`. This is what the API returns when a user views a notebook listing.

```json
{
	"id": "nb_01HXYZ22222",
	"project_id": "proj_01HXY11111",
	"title": "Revenue Analysis",
	"description": "Monthly revenue breakdown by region",
	"status": "active",
	"author": "user_abc123",
	"created_at": "2025-01-15T10:00:00Z",
	"updated_at": "2025-03-05T14:22:00Z",
	"last_run_at": "2025-03-04T08:30:00Z",
	"tags": ["finance", "monthly"],
	"runtime": {
		"python_version": "3.11",
		"marimo_version": "0.9.0"
	}
}
```

**Valid `status` values:** `draft` · `active` · `archived` · `deleted`

### 4.5 `notebook/source.json`

The typed source pointer. v1 ships a single `local` source type — code lives in the bucket and `notebook.py` is always the latest version.

```json
{
	"type": "local",
	"current_version_id": "ver_01HXYZ33333"
}
```

### 4.6 Source extensibility

`source.json` is a discriminated union on `type` precisely so additional backends can be added without touching the snapshot index, `meta.json`, versioning, or sessions — a new backend is a new `type` value plus a resolver in the Worker. **Out of scope for v1.** External-source backends (e.g. a Git-backed source whose code is fetched on demand rather than stored in the bucket) introduce their own read/write, sync, caching, and credential concerns and will be specified separately when prioritized.

### 4.7 `notebook/versions/{vid}/version.json`

```json
{
	"version_id": "ver_01HXYZ33333",
	"notebook_id": "nb_01HXYZ22222",
	"saved_at": "2025-03-05T14:22:00Z",
	"author": "user_abc123",
	"message": "Add regional breakdown by Q",
	"parent_id": "ver_01HXYZ22222"
}
```

Versions are immutable once written. `notebook.py` in the parent `notebook/` folder always reflects the latest. On each save, the Worker writes a new version folder, updates `source.json.current_version_id`, and updates `notebook.py` in place.

### 4.8 `_system/sessions/{id}.json`

A session represents a live marimo kernel instance — a running Python process attached to a notebook. Sessions are the only other mutable records in the system besides `catalog.json`, but they are independent: session writes never touch the snapshot chain.

```json
{
	"session_id": "sess_01HXYZ44444",
	"notebook_id": "nb_01HXYZ22222",
	"project_id": "proj_01HXY11111",
	"user_id": "user_abc123",
	"status": "running",
	"started_at": "2025-03-05T14:30:00Z",
	"last_heartbeat": "2025-03-05T14:35:00Z",
	"runtime": {
		"python_version": "3.11",
		"marimo_version": "0.9.0"
	},
	"sandbox_id": "sbx_01HXYZ55555",
	"sandbox_url": "https://sandbox.example.com/sess_01HXYZ44444",
	"used_fallback": false
}
```

**Valid `status` values:** `starting` · `running` · `idle` · `terminated` · `expired`

`sandbox_id` / `sandbox_url` link the record to the live kernel runtime (a separate container/compute service); `used_fallback` records whether a fallback runtime was used.

**Session lifecycle:**

1. `POST /sessions` → Worker creates session record, status `starting`; once the kernel runtime is provisioned, status `running` (records `sandbox_url`)
2. Kernel sends heartbeat every 30s → Worker updates `last_heartbeat` (see §8 on bounding this write volume)
3. User closes tab → `DELETE /sessions/{id}` → status `terminated`
4. No heartbeat for 5 minutes → scheduled job sets status `expired`
5. `terminated`/`expired` records older than the retention window (24h) are deleted by the scheduled reaper (see §8)

> **On object storage vs. a live state store for sessions:** the object store is appropriate for session _records_ — created on open, updated periodically, read for display — and the record carries `sandbox_id` / `sandbox_url` pointing at the live kernel runtime (a separate container/compute service). It is not appropriate for sub-second kernel state (output streaming, variable inspection); that lives in the kernel runtime itself, backed by a low-latency state store (in-memory cache / stateful coordinator) if cross-request coordination is needed. For MVP — tracking who has what open, TTL cleanup — the object store is sufficient.

### 4.9 `_system/events/{YYYY-MM-DD}/{event-id}.json`

The event log is the primary audit trail. Object stores provide no atomic append, and a single shared per-day file would lose events under concurrent writers (a read-modify-write race). So **each event is written as its own immutable object**, keyed by a monotonic ULID under a per-day prefix. This is write-safe with no locking, and because ULIDs sort lexicographically by time, listing a day's prefix returns events in append order.

Every event carries a `schema_version` field so the log stays parseable as the event shape evolves. Reading a day = list `_system/events/{date}/` and parse each object. A scheduled job may optionally compact a finished day into a single archive file for export/analytics.

```json
// _system/events/2025-03-05/01HXYZ9ABCDEFGHJKMNPQRSTVW.json
{
	"id": "01HXYZ9ABCDEFGHJKMNPQRSTVW",
	"schema_version": 1,
	"ts": "2025-03-05T14:22:00Z",
	"event": "notebook.create",
	"actor": "user_abc123",
	"project_id": "proj_01HXY11111",
	"notebook_id": "nb_01HXYZ22222",
	"snapshot_id": "snap_01HXYZ9ABC"
}
```

**Event types:** `notebook.create` · `notebook.update` · `notebook.run` · `notebook.delete` · `session.create` · `session.heartbeat` · `session.terminate` · `session.expired` · `project.create` · `project.update` · `migration.run`

---

## 5. ID Scheme

Resource IDs (`proj-`, `nb-`, `snap-`, `sess-`) are a short prefix plus a 16-character lowercase base32 random body — **subdomain-safe and unguessable, but NOT time-sortable** (see `packages/core/src/ids.ts` / `schema.ts`). Only **version** IDs (`ver_`) remain uppercase ULIDs, because their lexicographic order is load-bearing for version pruning (keep the most recent N). The examples below are illustrative; the regex in `schema.ts` is authoritative.

> **Do not infer recency from snapshot key order.** Because snapshot IDs are random, listing `_system/snapshots/` does **not** return entries in creation order. The current snapshot is always the one named by `catalog.json` — never the "last" key. Where chronological order is needed (retention, recovery), use each object's storage timestamp (`uploaded` / `LastModified`) or the snapshot's `created_at` field, not the ID.

> **The current snapshot is always the one named by `catalog.json`.** An interrupted write can momentarily create a snapshot it never commits (the writer deletes it on conflict — see §7.3 / §11). `catalog.json` is the single source of truth for "current."

| ID Format     | Usage                                                       |
| ------------- | ----------------------------------------------------------- |
| `proj-{rand}` | Project — random 16-char body, e.g. `proj-7h2k9qm4xz7rp3w8` |
| `nb-{rand}`   | Notebook — e.g. `nb-5g43rv2s9pfw8w4d`                       |
| `snap-{rand}` | Snapshot — random, **not** time-sortable, e.g. `snap-…`     |
| `ver_{ulid}`  | Notebook version — uppercase ULID, time-sortable on purpose |
| `sess-{rand}` | Session — e.g. `sess-…`                                     |
| `user_{…}`    | User/actor — passed in from auth layer                      |

---

## 6. Source Types

A notebook's `source.json` declares where its code lives. The Worker reads `source.type` and routes to the appropriate resolver. Everything else in the system — the snapshot index, `meta.json`, versioning, sessions — is identical regardless of source type.

| `source.type` | Code location                 | `notebook.py` in the bucket? | Write path               |
| ------------- | ----------------------------- | ---------------------------- | ------------------------ |
| `local`       | bucket `notebook/notebook.py` | Yes — always current         | Written directly on save |

v1 ships `local` only. The `source.type` discriminator exists so additional backends can be added later (see §4.6) — a new `type` value plus a resolver in the Worker, with nothing else in the system changing.

---

## 7. CRUD Operations

### 7.1 Read: List All Projects & Notebooks

Exactly **2 S3-compatible storage GETs** regardless of scale.

```
GET _system/catalog.json
  → { current_snapshot_key: '_system/snapshots/snap_01HXYZ9ABC.json' }

GET _system/snapshots/snap_01HXYZ9ABC.json
  → Full project + notebook index (metadata only, no code)
```

### 7.2 Read: Open a Notebook

```
// Step 1: Fetch metadata in parallel
GET projects/{pid}/notebooks/{nid}/meta.json
GET projects/{pid}/notebooks/{nid}/README.md
GET projects/{pid}/notebooks/{nid}/notebook/source.json

// Step 2: Resolve code based on source.type
if source.type === "local":
  GET projects/{pid}/notebooks/{nid}/notebook/notebook.py
```

### 7.3 Write: Create or Update a Notebook

Every write follows the same atomic sequence. Steps 1–2 are safe to retry independently. Step 5 is the commit.

```
// Step 1: Write notebook content files
PUT projects/{pid}/notebooks/{nid}/meta.json
PUT projects/{pid}/notebooks/{nid}/README.md
PUT projects/{pid}/notebooks/{nid}/notebook/source.json
PUT projects/{pid}/notebooks/{nid}/notebook/notebook.py       // local only
PUT projects/{pid}/notebooks/{nid}/notebook/pyproject.toml

// Step 2: Write immutable version snapshot
PUT projects/{pid}/notebooks/{nid}/notebook/versions/{vid}/notebook.py
PUT projects/{pid}/notebooks/{nid}/notebook/versions/{vid}/pyproject.toml
PUT projects/{pid}/notebooks/{nid}/notebook/versions/{vid}/version.json

// Step 3: Read catalog + current snapshot
GET _system/catalog.json  →  save ETag as current_etag
GET _system/snapshots/{current_snapshot_id}.json

// Step 4: Write new snapshot
PUT _system/snapshots/{new_snapshot_id}.json

// Step 5: Atomic catalog swap (conditional PUT)
PUT _system/catalog.json  If-Match: {current_etag}

// If 412 Precondition Failed:
//   DELETE _system/snapshots/{new_snapshot_id}.json   ← remove the orphan
//   then retry from Step 3

// Step 6: Write event object (best-effort, non-blocking)
PUT _system/events/{today}/{event-id}.json
```

> **Conflict Safety:** If two writers race on Step 5, one receives `412 Precondition Failed` and retries from Step 3. Steps 1–2 are idempotent — re-running them on retry is safe; the content files are already written before the conflict window opens. The loser also deletes the snapshot it wrote in Step 4 before retrying, so a failed attempt never leaves an orphan. Note that the content files in Step 1 are written _before and outside_ the conditional swap: two concurrent saves to the **same** notebook are last-writer-wins on the live `notebook.py`, while the immutable `versions/{vid}/` objects remain the authoritative per-version record.

### 7.4 Delete: Remove a Notebook

```
// Step 1: Soft-delete — mark status: 'deleted' in new snapshot
//   All objects remain intact for 30-day grace period

// Step 2: Atomic catalog swap (same as 7.3 Steps 3–5)

// Step 3 (deferred, after grace period): Hard delete
DELETE projects/{pid}/notebooks/{nid}/meta.json
DELETE projects/{pid}/notebooks/{nid}/README.md
DELETE projects/{pid}/notebooks/{nid}/notebook/source.json
DELETE projects/{pid}/notebooks/{nid}/notebook/notebook.py
DELETE projects/{pid}/notebooks/{nid}/notebook/pyproject.toml
// + all versions/{vid}/* objects
```

---

## 8. Sessions

Sessions are managed independently of the snapshot chain. A session write never touches `catalog.json` or any snapshot — it writes directly to `_system/sessions/{id}.json`.

### API routes

| Route                             | Description                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `POST /sessions`                  | Create session, write `_system/sessions/{id}.json`, emit `session.create` event |
| `PUT /sessions/{id}/heartbeat`    | Update `last_heartbeat` timestamp                                               |
| `GET /sessions?notebook_id={nid}` | List active sessions for a notebook (reads `_system/sessions/` prefix)          |
| `DELETE /sessions/{id}`           | Terminate session, set status `terminated`                                      |

### TTL cleanup & reaping

A scheduled job (cron, every 5 minutes) performs two passes over `_system/sessions/`:

1. **Expire** — any session whose `last_heartbeat` is older than 5 minutes is flipped to `expired`.
2. **Reap** — any `terminated`/`expired` record whose `last_heartbeat` is older than a retention window (24h) is **deleted**.

The reap pass matters because session records are only ever status-flipped, never removed on their own. Without it `_system/sessions/` grows unbounded and every list scan (heartbeat-free liveness checks, `GET /sessions`) gets steadily slower. This is the only background job required for MVP.

### Heartbeat write volume

Persisting every heartbeat is the dominant session write cost: at 50 concurrent sessions on a 30s interval that is ~50 × 2 × 60 × 24 ≈ **144,000 PUTs/day**, each a read-modify-write on a small object. Two levers bound it, in order of preference:

- **Don't persist routine heartbeats to the bucket.** Liveness belongs in the live kernel runtime; the bucket record only needs to change on create, status transition (`starting`→`running`), and terminate. The expiry sweep can then read liveness from the runtime rather than from `last_heartbeat`. This drops heartbeat writes to ~0.
- **If heartbeats must be persisted, widen the interval** (e.g. 60s) and/or coalesce — the 5-minute expiry TTL tolerates a coarser cadence.

v1 takes the second lever: heartbeat persistence is **coalesced to at most once per 60s** per session (`SessionService.heartbeat` skips the write when the session is already `running` and its stored heartbeat is younger than the interval). This bounds writes to ~1/min/session regardless of client cadence — roughly halving the figure above at a 30s cadence — and stays well within the 5-minute expiry TTL. Moving liveness off the bucket entirely (the first lever) remains a future option.

---

## 9. Migrations

Schema migrations are a first-class concern because there is no database to run `ALTER TABLE` against. All migration targets — `catalog.json`, snapshot structure, `meta.json`, `project.json`, `source.json`, and the event log — have different migration strategies.

> **Prerequisite (satisfied):** every independently-migrated object carries a `schema_version` field so the Worker can tell which version it is reading. `catalog.json` (`version`) and snapshots/events were already versioned; `meta.json`, `project.json`, `source.json`, and `version.json` now each carry `schema_version: 1`, so the fan-out migration below can key off it.

### Migration types

| Target                                       | Strategy                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot structure                           | Lazy — Worker reads `schema_version` on every snapshot read and upgrades in memory before writing the next snapshot. Old snapshots remain as-is.                                                                                                                                  |
| `meta.json` / `project.json` / `source.json` | Fan-out migration job — reads all affected objects, rewrites with the new schema, emits `migration.run`. Iterate with pagination and process in chunks so the job stays within the runtime's per-invocation request/time limits (resume via list cursor; idempotent — see below). |
| `_system/events/**`                          | Never migrated — event records are immutable history. New event shapes get a bumped `schema_version` field. Consumers must handle multiple versions.                                                                                                                              |
| `catalog.json`                               | Migrated in-place as part of the first write after a Worker deploy that bumps catalog schema version.                                                                                                                                                                             |

### Migration Worker pseudocode

```javascript
async function runMigration(s3, fromVersion, toVersion, migrateFn) {
	// s3.list is paginated; iterate the cursor and process in chunks so the job
	// stays within the runtime's per-invocation request/time limits.
	const keys = await s3.list({ prefix: 'projects/' });

	for (const key of keys.filter((k) => k.endsWith('meta.json'))) {
		const obj = await s3.get(key);
		const data = JSON.parse(obj.body);

		if (data.schema_version === fromVersion) {
			const migrated = migrateFn(data);
			migrated.schema_version = toVersion;
			await s3.put(key, JSON.stringify(migrated));
		}
	}

	await appendEvent(s3, {
		event: 'migration.run',
		from_version: fromVersion,
		to_version: toVersion,
		actor: 'system',
	});
}
```

> **Fan-out safety:** Steps in `meta.json` migrations are idempotent — checking `schema_version` before writing means the Worker can be safely re-run if interrupted. Run migrations during a low-traffic window and verify completion via the event log.

---

## 10. System Logs

`_system/logs/` and `_system/events/` are separate by design. Logs are human-readable for ops; events are machine-readable for audit and analytics.

| Path                                          | Purpose                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `_system/logs/{YYYY-MM-DD}.log`               | Human-readable app log. Rolled daily. Not queried by the application.                                                        |
| `_system/events/{YYYY-MM-DD}/{event-id}.json` | Structured event log. One immutable object per event. Every mutation, sync, run, and session event writes a new object here. |
| `_system/snapshots/`                          | Immutable index history. Point-in-time recovery. Prune snapshots older than 90 days via a scheduled job.                     |

> **Append strategy:** S3-compatible storage has no native append, and read-modify-write on a shared file loses concurrent events. So each event is a separate immutable object keyed by a monotonic ULID (see §4.9) — naturally concurrency-safe, no locking. Reading a day lists that day's prefix. For high event volume, a buffer (in-memory queue / streaming pipeline) can batch writes upstream, but per-event objects are correct and sufficient at this scale.

---

## 11. Snapshot Lifecycle & Retention

| Topic                       | Detail                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention                   | Keep snapshots for 90 days (with a floor of the N most recent), then delete via the maintenance cron — `MaintenanceService.expireSnapshots` (`packages/core/src/services/MaintenanceService.ts`). Every commit writes a new snapshot, so without this the bucket grows without bound (the Iceberg "snapshot-expiry" problem). |
| Recovery                    | Find the snapshot with the right point in time **by `created_at` / object `uploaded`, not by key order** (§5), write it as a new snapshot with a new ID, then CAS-swap `catalog.json`. See [`operations.md`](./operations.md) §2 for the full procedure.                                                                      |
| Compaction                  | Not needed at this scale. If snapshot exceeds 1MB, split into per-project manifest files referenced by the snapshot instead of embedded.                                                                                                                                                                                      |
| Emergency rollback          | GET any previous snapshot → PUT as new snapshot → CAS `catalog.json`. Restores the **index** in 3 calls. This does _not_ restore notebook content — `notebook.py` is overwritten in place on each save, so to roll back code you must also restore the relevant immutable `versions/{vid}/` objects.                          |
| Snapshot size at full scale | ~200KB (200 bytes × 1,000 notebooks)                                                                                                                                                                                                                                                                                          |

> **Deletion invariant (corruption safety).** A writer only ever deletes a snapshot it itself wrote and never committed — the loser of a CAS race deletes the orphan it just wrote (§7.3, `CatalogService.mutateSnapshot`), and retention (`MaintenanceService.expireSnapshots`) refuses to delete the snapshot `catalog.json` currently points at or its `previous_snapshot_id`. Consequently the live pointer can never be left dangling by the system's own writes. If the pointer is ever found pointing at a missing snapshot (e.g. an out-of-band deletion or a bug), recovery is mechanical: roll the pointer back to `previous_snapshot_id`, or to the newest surviving snapshot by `created_at`. The immutable, independently-named snapshots make this a clean rollback rather than a data-loss event — see [`operations.md`](./operations.md) §2.

---

## 12. Authentication & Authorization

Authentication (_who is the caller?_) and authorization (_what may they do?_) are separate concerns. The Worker resolves identity before any handler runs — storage is never reached anonymously — and then applies the authorization model below.

### Authentication (AuthN)

Identity is resolved per request and controlled by the `AUTH_MODE` setting:

| `AUTH_MODE` | Use case                 | Mechanism                                                                        | Identity                                  |
| ----------- | ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `access`    | Multi-user               | Cloudflare Access JWT (`CF-Access-JWT-Assertion`) verified against the team JWKS | `{ id: sub, email }` from verified claims |
| `none`      | Single-user, self-hosted | None — a fixed singleton user from config                                        | `{ id: USER_ID, email: USER_EMAIL }`      |

A request that fails authentication receives `401 UNAUTHORIZED`. The verified user is attached to the request context and used as the `actor` recorded in snapshots and events.

### Authorization (AuthZ) — v1 is single-tenant / trusted-org

**Visibility is open; writes are role-gated.** Reads (list/get projects & notebooks, versions, content) are open to any authenticated user — the global snapshot lists all projects and "list everything" stays 2 GETs (§7.1) because there is no per-caller filtering. **Writes are enforced against the target project**: the Worker loads `project.json`, resolves the caller's effective role (the `owner` is implicitly `admin`), and rejects insufficient roles with `403 FORBIDDEN`. A `viewer` or non-member therefore cannot mutate a project's notebooks even though they can see them.

This is a deliberate scope cut matching the deployment model — a trusted team sharing one bucket — and it keeps reads O(1). What's deferred is **read-side tenant isolation**: filtering the catalog to the projects a caller belongs to would change the read model (a membership check per project, so the "2 GETs" guarantee no longer holds). Until then, every authenticated user sees the whole catalog but can only write where their role allows.

### Role → permission matrix

v1 enforces the write rows; the read row is open to any authenticated user (visibility is not gated — see above).

| Capability                                                               | `viewer` | `editor` | `admin` |
| ------------------------------------------------------------------------ | :------: | :------: | :-----: |
| List/read projects & notebooks; read versions; open & read notebook code |    ✓     |    ✓     |    ✓    |
| Create/update/delete notebooks; save versions; create sessions (run)     |          |    ✓     |    ✓    |
| Update/delete projects; manage members                                   |          |          |    ✓    |

Enforced today (`403 FORBIDDEN` on failure): notebook create/update/delete and session creation require **editor+** on the project; project update/delete require **admin**. Creating a _new_ project is open to any authenticated user (no project context yet — the creator becomes its `owner`/`admin`). A project's `owner` is implicitly `admin`. Enforcement lives in the Worker (per-route `assertProjectRole`), never in the client.

> Session `heartbeat`/`terminate` are not separately role-gated in v1: they act on a session the caller already created (which required editor+) and don't escalate privilege. Hard-delete (the deferred GC pass, §7.4) and read-side tenant isolation are the remaining authorization work.

---

## 13. Worker API Layer

The Worker is an authenticated proxy between the marimo frontend and the object store. It owns auth (§12), ID generation, source resolution, snapshot management, session tracking, and event logging. Storage credentials and raw bucket access are never exposed to the client — every object is read and written through the Worker, and clients address notebooks by `{project_id, notebook_id}` only. The physical `key_prefix` is internal to the stored snapshot and is **stripped from all API responses**; clients never receive storage paths.

### The OpenAPI document is the contract

Routes are defined with `@hono/zod-openapi`: each declares typed request and response schemas, and the live spec is served at **`GET /api/doc`** (OpenAPI 3.1). That generated document — not a hand-maintained table — is the source of truth for paths, parameters, request bodies, and response shapes. All routes are mounted under `/api`, in these groups:

- **Auth** — `GET /api/me`
- **Projects** — list / get / create / update / delete
- **Notebooks** — list / get / create / update / soft-delete, plus `…/content`, `…/versions`, `…/versions/{vid}`
- **Sessions** — create / heartbeat / terminate (nested under a notebook)
- **Sandbox** — kernel-runtime provisioning & exec

### Error & response model

Every response uses one envelope. Success:

```json
{
	"success": true,
	"data": {
		/* route-specific */
	}
}
```

Errors (no `data`; a typed `code` plus a human-readable `message`):

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Notebook nb_… not found" } }
```

| HTTP | `code`                | When                                                                       |
| ---- | --------------------- | -------------------------------------------------------------------------- |
| 401  | `UNAUTHORIZED`        | Authentication missing or invalid (§12)                                    |
| 403  | `FORBIDDEN`           | Authorization denied — caller lacks the required role on the project (§12) |
| 404  | `NOT_FOUND`           | Resource does not exist                                                    |
| 409  | `CONFLICT`            | Write conflict — CAS retry budget on `catalog.json` exhausted              |
| 412  | `PRECONDITION_FAILED` | Conditional write mismatch surfaced from storage                           |
| 422  | `VALIDATION_ERROR`    | Request body or params failed schema validation                            |
| 500  | `INTERNAL_ERROR`      | Unexpected server error                                                    |

### API versioning, pagination, idempotency

- **Versioning** — the `/api` base plus the OpenAPI `info.version` (currently `1.0.0`) pin the contract. Treat `/api` as v1; ship breaking changes under `/api/v2` rather than mutating existing shapes.
- **Pagination** — none in v1, by design. At 10×100 the catalog fits in one ~200KB snapshot, so listings return in full. Event-log reads page the storage list cursor internally. When the snapshot is split into per-project manifests (§11 compaction), introduce cursor-based pagination on `GET /projects` and the notebook listing.
- **Idempotency** — reads, `PUT`, and soft-`DELETE` are naturally idempotent. `POST` creates (project, notebook, session) are **not**: a client retry after a network failure or after a `409 CONFLICT` can create a duplicate. v1 accepts this — duplicates are rare, cheap, and user-deletable. When it matters, add an `Idempotency-Key` request header; the Worker stores `key → result` and replays the stored result on retry.

### Core function: `writeSnapshot()`

```javascript
async function writeSnapshot(s3, mutation, actor) {
	let retries = 0;
	while (retries < 5) {
		// 1. Read catalog with ETag
		const { data: catalog, etag } = await s3.getWithETag('_system/catalog.json');

		// 2. Read current snapshot
		const current = await s3.get(catalog.current_snapshot_key);

		// 3. Upgrade snapshot schema if needed (lazy migration)
		const upgraded = upgradeSnapshot(current);

		// 4. Apply mutation
		const next = applyMutation(upgraded, mutation);
		const snapId = 'snap_' + ulid();
		const snapKey = `_system/snapshots/${snapId}.json`;

		// 5. Write new snapshot (new key — never conflicts)
		await s3.put(snapKey, JSON.stringify(next));

		// 6. Conditional catalog swap (If-Match on the catalog's ETag)
		const ok = await s3.putIfMatch(
			'_system/catalog.json',
			{
				version: 1,
				current_snapshot_id: snapId,
				current_snapshot_key: snapKey,
				previous_snapshot_id: catalog.current_snapshot_id,
				updated_at: new Date().toISOString(),
			},
			etag,
		);

		if (ok) {
			await appendEvent(s3, { actor, ...mutation, snapshot_id: snapId });
			return snapId;
		}

		// Lost the race: delete the snapshot we just wrote so it never lingers as
		// an orphan, then retry against the updated catalog state.
		await s3.delete(snapKey);
		retries++;
		await sleep(50 * retries); // exponential backoff
	}
	throw new Error('Write conflict: max retries exceeded');
}
```

---

## 14. Scale Analysis

### Object count at full scale

| Metric                             | Value                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Projects                           | 10                                                                           |
| Notebooks per project              | 100                                                                          |
| Objects per notebook (no versions) | 5 (`meta.json`, `README.md`, `source.json`, `notebook.py`, `pyproject.toml`) |
| Total notebook objects             | 10 × 100 × 5 = 5,000                                                         |
| `project.json` files               | 10                                                                           |
| Snapshots (90-day window @ 20/day) | ~1,800                                                                       |
| Session records (peak concurrent)  | ~50                                                                          |
| Event objects (90 days @ ~20/day)  | ~1,800                                                                       |
| **Total objects (no versions)**    | **~8,660**                                                                   |
| Snapshot size at full scale        | ~200KB                                                                       |

### Object-store request cost per operation

| Operation                     | Request count                                      |
| ----------------------------- | -------------------------------------------------- |
| List all projects + notebooks | 2 GETs                                             |
| Open a notebook               | 4 GETs (meta + README + source + notebook.py)      |
| Create/update notebook        | ~8 PUTs + 2 GETs + 1 conditional PUT + 1 event PUT |
| Delete notebook (soft)        | 2 GETs + 1 PUT + 1 conditional PUT                 |
| Session heartbeat             | 1 PUT                                              |

> **Heartbeat write volume dominates session cost.** At 50 concurrent sessions on a 30s interval, persisted heartbeats are ~144,000 PUTs/day — far more than all CRUD traffic combined. §8 covers how to bound this (don't persist routine heartbeats; widen the interval).

---

## 15. Open Questions

| Topic                             | Detail                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object-store versioning           | **Position taken** ([`operations.md`](./operations.md) §1): enable native object versioning + lifecycle expiry as the bucket-level backup/DR safety net beneath the snapshot layer. It is the recommended belt to the snapshot suspenders, and the cheap way to recover from an overwrite of in-place `notebook.py`. |
| Notebook ordering                 | Notebooks currently sort by ULID (creation time). If users want manual ordering, add an `order` field to each notebook entry in the snapshot.                                                                                                                                                                        |
| Additional source types           | v1 is `local`-only (§4.6). External-source backends (e.g. Git-backed notebooks) bring their own sync, caching, and credential concerns — to be specified separately when prioritized.                                                                                                                                |
| Read-side tenant isolation        | v1 enforces roles on writes but reads are open — every authenticated user sees the whole catalog (§12). Filtering the catalog per caller changes the read model (per-project membership checks, so "2 GETs" no longer holds) — scope this before opening the bucket to untrusted users.                              |
| Execution logs locality           | Run logs currently go to `_system/events/`. Alternative: `projects/{pid}/notebooks/{nid}/runs/{run-id}.log` for per-notebook locality. Tradeoff is discoverability vs. centralization.                                                                                                                               |
| Live state for real-time sessions | If kernel output streaming or sub-second variable inspection is needed, live session state belongs in a low-latency store (in-memory cache / stateful coordinator) co-located with the kernel runtime. Object storage retains the durable audit record.                                                              |
| Version pruning                   | **Resolved.** `NotebookService.pruneVersions` keeps the most recent `MAX_VERSIONS` (50) per notebook, pruning on each save (`packages/core/src/services/NotebookService.ts`). Snapshot and event growth are handled separately by `MaintenanceService` ([`operations.md`](./operations.md) §5).                      |
