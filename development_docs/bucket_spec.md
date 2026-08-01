# marimo Notebooks — S3-compatible Backend

**Schema Design, Storage Architecture & CRUD API**

> Scale target: 10 Projects × 100 Notebooks · Iceberg-inspired metadata layer · No database

---

## 1. Overview & Design Principles

This document specifies the full bucket schema and architecture for running marimo notebook CRUD operations against S3-compatible storage, with no external database. The design is inspired by Apache Iceberg's metadata indirection pattern: a single atomic pointer (`catalog.json`) is the only mutable file in the system. Everything else is either immutable or append-only.

> **Core Invariant:** `catalog.json` is the only file in the content store ever overwritten in place. Every other content write creates a new object. Reads are always consistent and concurrent writes are safe via conditional PUT (`If-Match` on ETag). Outside the content store, `_system/` carries a small set of mutable operational records — sessions (§4.8), the app claim (§4.8.1), identities (§4.10), tokens (§4.11) — that never touch the snapshot chain; the CAS-managed ones (`catalog.json`, session records, the app claim) are each written through exactly one service method.

### Design Goals

- No database — S3-compatible storage is the only persistence layer
- O(1) reads for listing projects and notebooks — no object scanning
- Immutable snapshots give audit history for free
- Self-describing notebooks — each notebook folder is a complete, portable unit
- `workspace/` mirrors the sandbox working dir — the latest code, deps, and (optionally) runtime files in one place, while control metadata sits outside it
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
│   ├── identities/
│   │   └── {user-id}.json                  ← user display identity (mutable, last-writer-wins)
│   ├── tokens/
│   │   └── {token-id}.json                 ← personal access token record (mutable, last-writer-wins)
│   ├── integrations/                       ← org-wide tier, inherited by every project (§4.12)
│   │   ├── _names/
│   │   │   └── {name}.json                 ← per-name singleton claim (CAS, app-claim pattern)
│   │   └── {integration-id}/
│   │       ├── integration.json            ← head: name/kind/enabled/current_version (CAS-managed)
│   │       └── versions/
│   │           └── {000001}.json           ← immutable config version (create-if-absent)
│   ├── logs/
│   │   └── {YYYY-MM-DD}.log                ← append-only, rolled daily
│   └── events/
│       └── {YYYY-MM-DD}/
│           └── {event-id}.json             ← one immutable object per event
│
└── projects/
    └── {project-id}/
        ├── project.json                    ← project metadata
        ├── secrets/
        │   └── {NAME}.json                 ← project secret entry (mutable, last-writer-wins)
        ├── integrations/
        │   ├── _names/
        │   │   └── {name}.json             ← per-name singleton claim (CAS, app-claim pattern)
        │   └── {integration-id}/
        │       ├── integration.json        ← head: name/kind/enabled/current_version (CAS-managed)
        │       └── versions/
        │           └── {000001}.json       ← immutable config version (create-if-absent)
        └── notebooks/
            └── {notebook-id}/
                ├── meta.json               ← notebook metadata (title, author, tags…)
                ├── README.md               ← human description
                ├── source.json             ← typed source pointer (v1: local) + current_version_id
                ├── workspace/              ← latest-only mirror of the sandbox working dir (NON-versioned)
                │   ├── notebook.py          ← latest code  (always present)
                │   ├── pyproject.toml      ← latest deps  (always present)
                │   └── data/cars.csv       ← runtime files (present only when PERSIST_WORKSPACE=workspace)
                └── versions/
                    └── {version-id}/
                        ├── notebook.py
                        ├── pyproject.toml
                        ├── version.json
                        ├── notebook.html       ← optional snapshot (see below)
                        └── session.json        ← optional snapshot (see below)
```

### 3.1.1 The `workspace/` folder

`workspace/` is the latest-only mirror of the sandbox working directory. It always holds the two source files — `notebook.py` and `pyproject.toml` — and, when `MARIMOHUB_PERSIST_WORKSPACE=workspace`, any runtime files the notebook produced (e.g. `data/cars.csv`, a parquet file, a `.db`). Key properties:

- **Latest-only and non-versioned.** `workspace/` is overwritten in place on each save/teardown and is **never** touched by version pruning. The immutable per-version record lives under `versions/{vid}/` (§4.7).
- **Runtime files are opt-in.** Under the default `MARIMOHUB_PERSIST_WORKSPACE=source`, `workspace/` contains only `notebook.py` + `pyproject.toml`. Under `workspace`, the sandbox's non-source files are captured here on teardown and restored on the next session (§8).
- **The mount is rooted at `workspace/`.** When a sandbox mounts the bucket, the working dir maps to `workspace/`. Because `meta.json` / `README.md` / `source.json` / `versions/` sit **outside** `workspace/`, control metadata is never exposed to user code in the sandbox.

### 3.2 Complete Path Reference

| Path                                                           | Type     | Description                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_system/catalog.json`                                         | JSON     | Single entry point. Points to the current snapshot. Only file mutated in-place.                                                                                                                                                                                                                                                                                                                                                        |
| `_system/snapshots/{id}.json`                                  | JSON     | Immutable index snapshot. Lists all projects and notebooks with metadata. Written once, never modified.                                                                                                                                                                                                                                                                                                                                |
| `_system/sessions/{pid}/{sid}.json`                            | JSON     | Live session record, partitioned by project so a project-scoped read lists only `_system/sessions/{pid}/`. Created on notebook open, updated by heartbeat, cleaned up on close or TTL expiry.                                                                                                                                                                                                                                          |
| `_system/apps/{pid}/{nid}.json`                                | JSON     | Per-notebook app-singleton claim: names the app session that owns the notebook's shared app sandbox. Written create-if-absent by the create saga, replaced via ETag CAS when stale, CAS'd to a free marker (`session_id: null`) on teardown. All writes go through `SessionService.claimApp`/`releaseApp`. See §4.8.1.                                                                                                                 |
| `_system/identities/{user-id}.json`                            | JSON     | User display identity (`{ id, email, name }`). Upserted on each authenticated request; mutable, last-writer-wins. Resolves opaque `author`/`user_id` ids to a person.                                                                                                                                                                                                                                                                  |
| `_system/tokens/{token-id}.json`                               | JSON     | Personal access token record (`{ id, user_id, name, hash, … }`) keyed by the ULID embedded in the presented `mhub_pat_` bearer, so verification is a single GET. Stores only the SHA-256 of the secret. Mutable, last-writer-wins (coarse `last_used_at` refresh); revocation deletes the object. See §4.11.                                                                                                                           |
| `_system/logs/{YYYY-MM-DD}.log`                                | Text     | Human-readable application log. One file per day. For ops debugging only.                                                                                                                                                                                                                                                                                                                                                              |
| `_system/events/{YYYY-MM-DD}/{event-id}.json`                  | JSON     | Structured event log. One immutable object per event, keyed by a monotonic ULID under a per-day prefix. Primary audit trail.                                                                                                                                                                                                                                                                                                           |
| `_system/idempotency/{digest}.json`                            | JSON     | Recorded `POST`-create response for an `Idempotency-Key`, keyed by `sha256(user:route\nkey)`. Replayed on retry; pruned after 24h. See [`idempotency.md`](./idempotency.md).                                                                                                                                                                                                                                                           |
| `projects/{pid}/project.json`                                  | JSON     | Project metadata: name, description, owner, members, tags.                                                                                                                                                                                                                                                                                                                                                                             |
| `projects/{pid}/secrets/{NAME}.json`                           | JSON     | Project secret entry, keyed by env-var name: a `reference` pointer into an external manager, or a `managed` ciphertext envelope. Mutable, last-writer-wins (no CAS). Never contains plaintext.                                                                                                                                                                                                                                         |
| `projects/{pid}/integrations/{iid}/integration.json`           | JSON     | Integration head: kind, instance name, `enabled`, and the `current_version` pointer. CAS-managed via ETag `mutateObject` — written only by `ProjectIntegrationsStore` (a version bump must be atomic against a concurrent edit). See §4.12.                                                                                                                                                                                            |
| `projects/{pid}/integrations/{iid}/versions/{n}.json`          | JSON     | Immutable integration config version, keyed by zero-padded number so key order == version order. Written create-if-absent; a losing writer takes n+1. Secret fields are `{ "$secret": … }` ciphertext envelopes, never plaintext. Sessions pin these version numbers (the audit trail), so history is never rewritten.                                                                                                                 |
| `projects/{pid}/integrations/_names/{name}.json`               | JSON     | Per-name singleton claim (`{ integration_id, claimed_at }`) anchoring integration-name uniqueness — the same claim class as the app claim, written only by `ProjectIntegrationsStore` via `acquireSingletonClaim`/`releaseSingletonClaim`. See §4.12.                                                                                                                                                                                  |
| `_system/integrations/{iid}/…`                                 | JSON     | Org-wide integration tier: the exact record classes of `projects/{pid}/integrations/{iid}/…` (CAS-managed head, immutable versions, `_names/` claim) rooted at `_system` instead of a project. Heads carry **no** `project_id`. Written only by `OrgIntegrationsStore` (super-admin routes); rendered into every project's sessions unless shadowed by a same-name project instance. See §4.12.                                        |
| `projects/{pid}/notebooks/{nid}/meta.json`                     | JSON     | Notebook metadata: title, description, status, author, tags, last_run_at. Never contains code or paths.                                                                                                                                                                                                                                                                                                                                |
| `projects/{pid}/notebooks/{nid}/README.md`                     | Markdown | Human-readable description and usage notes.                                                                                                                                                                                                                                                                                                                                                                                            |
| `projects/{pid}/notebooks/{nid}/source.json`                   | JSON     | Typed source pointer. Declares where code lives + `current_version_id`. v1 supports `local`.                                                                                                                                                                                                                                                                                                                                           |
| `projects/{pid}/notebooks/{nid}/fs_snapshot.json`              | JSON     | **Optional.** Pointer to the notebook's current CoreWeave-native filesystem snapshot (`{ snapshot_id, captured_at }`). Mutable, last-writer-wins, written only by the teardown snapshot path. Present only under `MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT=true`. The snapshot itself lives in CoreWeave, not the bucket. **Not recommended alongside `MARIMOHUB_PERSIST_WORKSPACE=workspace`** — the two double-persist state. |
| `projects/{pid}/notebooks/{nid}/workspace/notebook.py`         | Python   | Latest notebook code. Always present in `workspace/`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `projects/{pid}/notebooks/{nid}/workspace/pyproject.toml`      | TOML     | Latest Python dependency manifest. Always present in `workspace/`.                                                                                                                                                                                                                                                                                                                                                                     |
| `projects/{pid}/notebooks/{nid}/workspace/{path}`              | any      | Runtime files mirrored from the sandbox working dir (e.g. `data/cars.csv`). Present only under `MARIMOHUB_PERSIST_WORKSPACE=workspace`. Latest-only, non-versioned.                                                                                                                                                                                                                                                                    |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/notebook.py`    | Python   | Immutable version snapshot of the code.                                                                                                                                                                                                                                                                                                                                                                                                |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/pyproject.toml` | TOML     | Dependency snapshot at time of version.                                                                                                                                                                                                                                                                                                                                                                                                |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/version.json`   | JSON     | Version metadata: saved_at, author, message, parent_id, optional snapshot descriptors.                                                                                                                                                                                                                                                                                                                                                 |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/notebook.html`  | HTML     | **Optional.** Rendered HTML snapshot, copied from `__marimo__/notebook.html` on session teardown. Immutable once written.                                                                                                                                                                                                                                                                                                              |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/session.json`   | JSON     | **Optional.** marimo session state (cell outputs), copied from `__marimo__/session/{notebook}.py.json` on teardown. Immutable.                                                                                                                                                                                                                                                                                                         |

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

Contains only notebook-level concerns. No code, no paths, no source details — those live in `source.json` and `workspace/`. This is what the API returns when a user views a notebook listing.

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

### 4.5 `source.json`

The typed source pointer. v1 ships a single `local` source type — code lives in the bucket and `workspace/notebook.py` is always the latest version.

```json
{
	"type": "local",
	"current_version_id": "ver_01HXYZ33333"
}
```

### 4.6 Source extensibility

`source.json` is a discriminated union on `type` precisely so additional backends can be added without touching the snapshot index, `meta.json`, versioning, or sessions — a new backend is a new `type` value plus a resolver in the Worker. **Out of scope for v1.** External-source backends (e.g. a Git-backed source whose code is fetched on demand rather than stored in the bucket) introduce their own read/write, sync, caching, and credential concerns and will be specified separately when prioritized.

### 4.7 `versions/{vid}/version.json`

```json
{
	"version_id": "ver_01HXYZ33333",
	"notebook_id": "nb_01HXYZ22222",
	"saved_at": "2025-03-05T14:22:00Z",
	"author": "user_abc123",
	"message": "Add regional breakdown by Q",
	"parent_id": "ver_01HXYZ22222",
	"html_snapshot": { "captured_at": "2025-03-05T14:40:00Z", "size_bytes": 524288 },
	"session_snapshot": { "captured_at": "2025-03-05T14:40:00Z", "size_bytes": 81920 }
}
```

Versions are immutable once written. `workspace/notebook.py` always reflects the latest. On each save, the Worker writes a new version folder, updates `source.json.current_version_id`, and updates `workspace/notebook.py` in place.

**Optional snapshot descriptors.** `html_snapshot` and `session_snapshot` record the _presence and metadata_ of a rendered HTML snapshot (`notebook.html`) and a marimo session state file (`session.json`) sitting alongside the code in the version folder. They carry `captured_at` and `size_bytes` — **never a storage path** (clients address notebooks by ID, §13). Each field is **absent** when that artifact wasn't captured; both are written only on session teardown (§8) and only if marimo actually produced the source file, so most versions have neither. Adding these optional fields is forward-tolerant — a reader that doesn't know them ignores them — so it requires no breaking migration of existing `version.json` objects.

### 4.8 `_system/sessions/{pid}/{sid}.json`

A session represents a live marimo kernel instance — a running Python process attached to a notebook. Sessions are mutable records (like `catalog.json` and the identity directory, §4.10), but they are independent: session writes never touch the snapshot chain.

Records are partitioned by project (`_system/sessions/{pid}/{sid}.json`) so the interactive reads — `listActiveByProject` (every notebook-table render) and `findReusable` (every session create) — list just that project's prefix instead of scanning every session in the deployment. Deployment-wide sweeps (the stale-expiry and terminal-reap passes, per-user session count) still list the whole `_system/sessions/` prefix recursively. Because the key now carries the project id, the routing token for `proxy` exposure mode encodes `{pid}.{sid}` (see `proxyToken.ts`) so the forwarder can rebuild the key.

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
	"compute_profile": "small",
	"used_fallback": false
}
```

When a session goes `failed`, `markFailed` may persist an optional sanitized `error` object so the client polling the record can render _why_ instead of a bare `failed`. It is omitted on healthy records and never carries secret material:

```json
{ "status": "failed", "error": { "code": "SERVICE_UNAVAILABLE", "message": "Sandbox unreachable" } }
```

**Valid `status` values:** `starting` · `running` · `idle` · `terminated` · `expired`

`sandbox_id` / `sandbox_url` link the record to the live kernel runtime (a separate container/compute service); `compute_profile` records the configured profile name used at launch and is absent when profiles are unset; `used_fallback` records whether a fallback runtime was used. The optional field is forward-compatible with existing records and requires no migration.

**Session lifecycle:**

1. `POST /sessions` → Worker creates session record, status `starting`; once the kernel runtime is provisioned, status `running` (records `sandbox_url`)
2. Kernel sends heartbeat every 30s → Worker updates `last_heartbeat` (see §8 on bounding this write volume)
3. User closes tab → `DELETE /sessions/{id}` → status `terminated`
4. No heartbeat for 5 minutes → scheduled job sets status `expired`
5. `terminated`/`expired` records older than the retention window (24h) are deleted by the scheduled reaper (see §8)

> **On object storage vs. a live state store for sessions:** the object store is appropriate for session _records_ — created on open, updated periodically, read for display — and the record carries `sandbox_id` / `sandbox_url` pointing at the live kernel runtime (a separate container/compute service). It is not appropriate for sub-second kernel state (output streaming, variable inspection); that lives in the kernel runtime itself, backed by a low-latency state store (in-memory cache / stateful coordinator) if cross-request coordination is needed. For MVP — tracking who has what open, TTL cleanup — the object store is sufficient.

**App sessions.** A session record may carry `mode: "app"`: the notebook served as a read-only application via `marimo run` instead of the editor. App sessions are **per-notebook singletons shared by all editors** (reuse is user-blind; `user_id` is attribution only), are provisioned copy-only (never a bucket mount), and are **never written back** — no version, HTML/session snapshot, workspace mirror, or FS-snapshot pointer advances from an app sandbox. App-only fields: `source_version_id` (the notebook's head version at provision — staleness detection), `active_connections` + `connections_checked_at` (the lifecycle sweep's last kernel connection probe). Absent `mode` = `edit`.

### 4.8.1 `_system/apps/{pid}/{nid}.json`

The app-singleton claim anchors "one app sandbox per notebook" against concurrent `Run as app` requests. Beside `catalog.json` and the session records, it is the third CAS-managed mutable object in the store.

```json
{ "session_id": "sess_01HXYZ44444", "claimed_at": "2025-03-05T14:30:00Z" }
```

`session_id: null` is the **free marker** a release writes in place of the value — see rule 3.

Write discipline (all through `SessionService.claimApp` / `releaseApp`, which delegate to the generic `acquireSingletonClaim`/`releaseSingletonClaim` primitives beside `withCasRetry` — a future lease of the same shape reuses them, not this object):

1. The create saga's `app_claim` step writes the claim **create-if-absent** (`If-None-Match: *`) after the session record and before any compute call — exactly one of N concurrent creates wins; losers attach to the winner's session via the user-blind reuse path.
2. A claim whose holder session is terminal, absent, or a wedged `starting` record past the provision window is **stale** and replaced via ETag CAS.
3. Every teardown path (explicit stop, lifecycle reaper, reconciliation, saga compensation) **frees** the claim when it names the session being torn down, by CAS'ing `session_id` to `null` rather than deleting the object. There is no conditional-delete primitive, so a read-then-delete would drop a claim a new holder acquired between the read and the delete — freeing the singleton under a running app and letting a third session acquire it. The CAS loses that race instead, leaving the new holder's claim intact. The cost is a pointer that outlives the app; rule 5's cleanup removes it.
4. The create saga **re-asserts** the claim after the session is marked `running`: a slow provision can look like a wedged holder (rule 2) and lose the claim mid-provision, and a running holder is never stale — so the recheck is the last point a steal can be detected. A loser compensates (sandbox destroyed, record terminated) and attaches to the current holder.
5. Cleanup deletes, outside `claimApp`/`releaseApp`: deleting a notebook (soft or hard) or hard-deleting a project also deletes the claim object(s) under it, so no claim outlives its notebook.

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

**Event types (emitted today):** every catalog mutation is appended by `CatalogService` after its winning CAS commit (best-effort: a failed append never fails the mutation, it bumps the `events.append_failed` metric). The `event` field is the operation name: `project.create` · `project.update` · `project.members` · `project.delete` · `project.gc` · `notebook.create` · `notebook.update` · `notebook.delete` · `notebook.gc` · `notebook.synced.create` · `notebook.synced.sync`. Context fields (`project_id`, `notebook_id`, …) ride along per operation. Read one day via the admin-only `GET /api/v1/projects/{pid}/events?date=`.

**Planned, not yet emitted:** session lifecycle (`session.create` · `session.terminate` · `session.expired`), `notebook.run`, `notebook.snapshot` (snapshot capture on teardown, §8), and `migration.run`.

### 4.10 `_system/identities/{user-id}.json`

The identity directory maps a stable user id — the auth `sub`, which is what every `author` / `user_id` / `actor` / `owner` field stores — to that user's current human-readable identity. It exists so the UI can render those opaque ids as a person (e.g. "Started by Ada Lovelace", "Created by …") without denormalizing a name/email onto every notebook, session, and snapshot.

```json
// _system/identities/user_abc123.json
{
	"id": "user_abc123",
	"email": "ada@example.com",
	"name": "Ada Lovelace",
	"updated_at": "2025-03-05T14:30:00Z"
}
```

`name` falls back to the email local-part when the identity provider supplies no display name (`AuthUser.name` is optional — the OIDC `name` claim from the `profile` scope, or the Access `name` claim, when present).

**Why this shape — store the id, refresh the directory.** The foreign keys throughout the store (`author`, `session.user_id`, `snapshot.actor`, `project.owner`/`members`) keep storing the **stable id only**, never a name/email copy. A copy denormalized at write time would go stale when a user later changes their display name or email; instead the directory is **refreshed on every authenticated request**, so resolution always reflects the latest known identity. Reads resolve ids → identities in one batch lookup (`GET /api/v1/users?ids=…`, §13) rather than touching the snapshot.

**Mutability & write semantics.** An identity object is **mutable and last-writer-wins** — a plain overwrite of a single per-user key, like a session record (§4.8) and unlike the immutable snapshot/version/event objects. Concurrent logins for the same user converge on whichever write lands last (the desired "latest identity" semantics), so no conditional PUT / CAS is involved; this is independent of the `catalog.json` snapshot chain and never touches it. The key is the URL-encoded user id, so non-subdomain-safe `sub` values (e.g. `auth0|abc`) remain addressable.

**Write volume.** The upsert runs in the auth middleware on every `/api/v1/*` request, but is **write-coalesced**: the service keeps a per-process `id → {email,name}` signature cache and skips the PUT when the incoming identity is unchanged since this process last wrote it (`IdentityService.upsert`, `packages/core/src/services/identity/IdentityService.ts`). So steady-state cost is ~one PUT per user per process lifetime (plus one whenever their email/name actually changes), not one per request. The upsert is best-effort — a failure is logged and never blocks the request.

### 4.11 `_system/tokens/{token-id}.json`

A personal access token record — the machine-credential counterpart of a session cookie. A token acts as its issuing user (`user_id` resolves through the identity directory and inherits the user's memberships), so no authz changes hang off this object.

```json
// _system/tokens/01HXY0S6GWMBASVAG3PZ7Y2K5T.json
{
	"id": "01HXY0S6GWMBASVAG3PZ7Y2K5T",
	"user_id": "user_abc123",
	"name": "ci-deploy",
	"hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
	"created_at": "2026-07-24T14:30:00Z",
	"expires_at": "2026-10-22T14:30:00Z",
	"last_used_at": "2026-07-24T15:00:00Z"
}
```

**Why keyed by token id.** The presented bearer is `mhub_pat_<tokenId>_<secret>`, so verification is a **single GET** by the embedded ULID — no scan and, critically, no mutable index object that would need its own CAS discipline. `hash` is the SHA-256 of the secret; the plaintext is returned once at creation and never stored. Per-user listing is a prefix scan of `_system/tokens/` (fine at the 20-per-user cap).

**Mutability & write semantics.** Creation is a plain PUT to a fresh, unique token-id key. The only rewrite is the `last_used_at` refresh, and it is **conditional** — an `If-Match` on the ETag read at load time — so a token revoked (deleted) between load and the touch is not resurrected by a stale write; the touch is also coalesced to once per UTC day, keeping the request hot path read-only. Revocation is a plain DELETE. Positive verifications are cached per process with a short TTL (`TokenService.CACHE_TTL_MS`), which also bounds the cross-replica revocation lag.

### 4.12 `projects/{pid}/integrations/{iid}/…`

A project integration instance — a named, versioned configuration of a code-registered _kind_ (`postgres`, `iceberg_rest`, …) rendered into every session's sandbox as env vars + files. Two records:

```json
// projects/proj-x/integrations/intg-y/integration.json   (head — CAS-managed)
{
	"id": "intg-7h2k9qm4xz7rp3w8",
	"project_id": "proj-7h2k9qm4xz7rp3w8",
	"kind": "postgres",
	"name": "prod",
	"enabled": true,
	"current_version": 3,
	"created_by": "user_abc123",
	"created_at": "2026-07-30T14:30:00Z",
	"updated_at": "2026-07-30T15:00:00Z"
}

// projects/proj-x/integrations/intg-y/versions/000003.json   (immutable)
{
	"schema_version": 1,
	"version": 3,
	"kind": "postgres",
	"kind_schema_version": 1,
	"config": { "host": "db.internal", "password": { "$secret": { "kind": "managed", "envelope": { "kek_id": "…", "alg": "A256GCM", "iv": "…", "ciphertext": "…" } } } },
	"created_by": "user_abc123",
	"created_at": "2026-07-30T15:00:00Z",
	"change_note": "rotate password"
}
```

**Mutability & write semantics.** Version records are **immutable** — written create-if-absent under a zero-padded number key (key order == version order); a losing concurrent writer retries with n+1. The **head** is the third CAS-managed mutable object class in the store (after `catalog.json`/sessions and the app claim): every rewrite goes through an ETag `mutateObject` so a `current_version` bump is atomic against a concurrent edit, and it is written **only** by `ProjectIntegrationsStore`. Two concurrent config edits both land in history; the higher version number wins the pointer regardless of head-commit order. Session records pin `{ id, name, kind, version }` per rendered integration, so a session's exact config is reproducible from the immutable versions **while the integration exists**. Deleting an integration (or hard-deleting its project) removes the head **first** — so a concurrent update's head CAS fails fast and removes its own just-appended version — then the remaining objects; like a project secret, it is gone immediately. The pins on session records (themselves reaped ~24h after termination) and the `integration.*` entries in `_system/events/` remain the durable audit trail of what was configured and when. Secret config fields hold ciphertext envelopes bound (via HKDF context) to the head path + field path — an envelope copied elsewhere fails to decrypt, and a box found outside the kind's registered secret paths (e.g. a bad migration) fails the whole config closed rather than leaking through redaction.

**The name claim** (`_names/{name}.json`, name URI-encoded) anchors "one instance per name" the same way the app claim anchors "one app per notebook": `{ integration_id, claimed_at }`, acquired via `acquireSingletonClaim` (create-if-absent, ETag-CAS replace when stale) and released by CAS-ing `integration_id` to the free marker `null`, never a bare delete. Writers put the **head first, then claim** — a holder is _live_ iff its head still exists under that name, so the claim self-heals after a crash between the two writes, and two concurrent creates are arbitrated by the claim key: the loser deletes its own just-written objects. A rename claims the new name (reverting the head on conflict, so a combined rename+config PATCH that loses commits nothing) and then frees the old; delete frees the name last. Sole writer: `ProjectIntegrationsStore`. `_names/` cannot collide with an instance directory (ids are always `intg-…`), and listings skip it.

**The org tier** (`_system/integrations/{iid}/…`) is the same two record classes plus name claim, rooted at `_system` instead of a project, and written **only** by `OrgIntegrationsStore` behind the super-admin routes. Org heads carry **no** `project_id` — a record reached through the wrong tier's path fails identity validation instead of leaking across scopes — and org secret envelopes are HKDF-bound to the `_system/…` head path, so they cannot be replayed into a project (or vice versa). At session render the project tier merges the org tier in: enabled org instances render into every project's session **unless** the project has an instance with the same name (enabled or not) — the same-name project instance is both the override and the opt-out. Name claims are per-tier, so an org `warehouse` and a project `warehouse` coexist by design; the shadowing rule, not the claim, resolves them.

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

| `source.type` | Code location                  | `notebook.py` in the bucket? | Write path               |
| ------------- | ------------------------------ | ---------------------------- | ------------------------ |
| `local`       | bucket `workspace/notebook.py` | Yes — always current         | Written directly on save |

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
GET projects/{pid}/notebooks/{nid}/source.json

// Step 2: Resolve code based on source.type
if source.type === "local":
  GET projects/{pid}/notebooks/{nid}/workspace/notebook.py
```

### 7.3 Write: Create or Update a Notebook

Every write follows the same atomic sequence. Steps 1–2 are safe to retry independently. Step 5 is the commit.

```
// Step 1: Write notebook content files
PUT projects/{pid}/notebooks/{nid}/meta.json
PUT projects/{pid}/notebooks/{nid}/README.md
PUT projects/{pid}/notebooks/{nid}/source.json
PUT projects/{pid}/notebooks/{nid}/workspace/notebook.py       // local only
PUT projects/{pid}/notebooks/{nid}/workspace/pyproject.toml

// Step 2: Write immutable version snapshot
PUT projects/{pid}/notebooks/{nid}/versions/{vid}/notebook.py
PUT projects/{pid}/notebooks/{nid}/versions/{vid}/pyproject.toml
PUT projects/{pid}/notebooks/{nid}/versions/{vid}/version.json

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

> **Conflict Safety:** If two writers race on Step 5, one receives `412 Precondition Failed` and retries from Step 3. Steps 1–2 are idempotent — re-running them on retry is safe; the content files are already written before the conflict window opens. The loser also deletes the snapshot it wrote in Step 4 before retrying, so a failed attempt never leaves an orphan. Note that the content files in Step 1 are written _before and outside_ the conditional swap: two concurrent saves to the **same** notebook are last-writer-wins on the live `workspace/notebook.py`, while the immutable `versions/{vid}/` objects remain the authoritative per-version record.

### 7.4 Delete: Remove a Notebook

```
// Step 1: Soft-delete — mark status: 'deleted' in new snapshot
//   All objects remain intact for 30-day grace period

// Step 2: Atomic catalog swap (same as 7.3 Steps 3–5)

// Step 3 (deferred, after grace period): Hard delete
DELETE projects/{pid}/notebooks/{nid}/meta.json
DELETE projects/{pid}/notebooks/{nid}/README.md
DELETE projects/{pid}/notebooks/{nid}/source.json
// + all workspace/* objects (notebook.py, pyproject.toml, any runtime files)
// + all versions/{vid}/* objects
```

---

## 8. Sessions

Sessions are managed independently of the snapshot chain. A session write never touches `catalog.json` or any snapshot — it writes directly to `_system/sessions/{pid}/{sid}.json`.

### API routes

| Route                             | Description                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /sessions`                  | Create session, write `_system/sessions/{pid}/{sid}.json`, emit `session.create` event   |
| `PUT /sessions/{id}/heartbeat`    | Update `last_heartbeat` timestamp                                                        |
| `GET /sessions?notebook_id={nid}` | List active sessions for a notebook (reads the `_system/sessions/{pid}/` project prefix) |
| `DELETE /sessions/{id}`           | Terminate session, set status `terminated`                                               |

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

### Versioning & snapshots on teardown

The interactive editing path does **not** go through the §7.3 API write. A user edits in the live kernel, and edits land directly on the live `workspace/notebook.py` — either through the bucket mounted at `workspace/`, or copied back by `commitSession` in the mount-fallback case. Neither route cuts a version or advances `source.current_version_id`, so without the step below an interactive editing session would leave **no version record at all** and the live `workspace/notebook.py` would simply be overwritten in place.

To close that gap, **session teardown cuts a new version** — the same write as an API code-save (§7.3 Step 2) — and attaches any HTML/session artifacts marimo produced to that same new version. marimo writes those artifacts into its `__marimo__/` workspace while the notebook runs: a rendered `__marimo__/notebook.html` and a session-state file `__marimo__/session/{notebook}.py.json` (cell outputs, keyed by the notebook filename). Both are **optional** — marimo may not have produced either.

On teardown, **before destroying the sandbox**, the Worker:

```
// During SandboxProvisioner.teardown, before sandbox.destroy():

// 1. Always read the final notebook back (not only in the mount-fallback case),
//    so the live workspace/notebook.py is persisted and the session's edits are captured.
read notebook.py, pyproject.toml from the sandbox workspace
PUT projects/{pid}/notebooks/{nid}/workspace/notebook.py       // live code
PUT projects/{pid}/notebooks/{nid}/workspace/pyproject.toml    // live deps

// 2. Cut a new version IF the content changed since current_version_id
//    (skip when unchanged, so a read-only session creates no spurious version).
if content != current version:
  vid = ver_{ulid}
  PUT versions/{vid}/notebook.py
  PUT versions/{vid}/pyproject.toml
  PUT versions/{vid}/version.json        // message e.g. "Session edits", author = session user
  update source.json.current_version_id = vid
  prune to MAX_VERSIONS (§7.3)
else:
  vid = current_version_id

// 3. Copy marimo's optional artifacts into THAT version's folder (best-effort).
if exists __marimo__/notebook.html:
  PUT versions/{vid}/notebook.html   Content-Type: text/html
if exists __marimo__/session/{notebook}.py.json:
  PUT versions/{vid}/session.json    Content-Type: application/json
patch versions/{vid}/version.json with html_snapshot / session_snapshot descriptors (§4.7)

// 4. Capture the rest of the workspace IF PERSIST_WORKSPACE=workspace (best-effort).
//    Source files (notebook.py / pyproject.toml) and __marimo__/ are excluded —
//    they are persisted by steps 1–3 — as are regenerable Python artifacts
//    (.venv/, __pycache__/). Everything else is mirrored into workspace/.
if PERSIST_WORKSPACE == "workspace":
  for each runtime file under the working dir (excluding notebook.py, pyproject.toml, __marimo__/, .venv/, __pycache__/):
    PUT projects/{pid}/notebooks/{nid}/workspace/{path}    // binary-safe
  delete workspace/{path} objects no longer present in the sandbox  // mirror deletes

// 5. Emit notebook.update (version) + best-effort notebook.snapshot (artifacts).
```

Steps 1–2 (the version cut) own the source files and are the durable record of the session's edits; step 4 captures the rest of the working dir into `workspace/` and is covered below. The HTML/session step is a **copy, not an export** — no `marimo export` command runs; teardown only persists files marimo already wrote. This extends the `SandboxProvisioner.teardown` → `commitSession` flow (which reads `notebook.py`/`pyproject.toml` back) by routing the persist through the versioning service so a version is cut.

The version cut (steps 1–2) is the **durable record of the session's edits**, so a hard failure there should surface as a teardown error. The artifact copy (step 3) is purely additive and **best-effort/non-fatal** (mirroring version pruning, §7.3): a missing or unreadable `__marimo__` file just means that version has no snapshot. Snapshots are therefore sparse — a version has one only if (a) it was cut by a torn-down session and (b) marimo produced the file — and `version.json` records which (if any) are present.

> Because steps 1–3 target the **same** new version, the saved code, its rendered HTML, and the session outputs are coherent: the `notebook.html` was rendered from exactly the `notebook.py` stored beside it. This is the key reason teardown cuts the version _before_ attaching the snapshots, rather than pinning them onto a stale `current_version_id`.

### Workspace persistence & restore

`MARIMOHUB_PERSIST_WORKSPACE` (`source` (default) | `workspace`) controls whether the sandbox's **non-source runtime files** survive a session. It governs step 4 of teardown above and the restore on the next provision.

| Mode        | What `workspace/` holds                                    | Capture (teardown)                                                        | Restore (provision)                      |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `source`    | `notebook.py` + `pyproject.toml` only                      | source files only (via the version cut)                                   | brings back exactly the source           |
| `workspace` | source files **plus** runtime files (e.g. `data/cars.csv`) | source files via the version cut, then mirror the rest of the working dir | brings back source **and** runtime files |

- **Restore is unconditional.** On provision, the contents of `workspace/` are loaded into the sandbox working dir before marimo starts. Because `workspace/` reflects whatever was last captured, no mode branch is needed — `source` mode simply has only the two source files to restore.
- **Capture is mode-gated and binary-safe.** Under `workspace`, every runtime file under the working dir (excluding `notebook.py`, `pyproject.toml`, `__marimo__/`, and regenerable Python artifacts `.venv/` / `__pycache__/`) is mirrored into `workspace/` byte-for-byte, so parquet, images, and `.db` files round-trip — not just UTF-8 text. **Mirror deletes** keep `workspace/` accurate: any `workspace/` object (other than the source files) no longer present in the sandbox is removed, which also cleans up stale data if a notebook is changed from `workspace` back to `source`.
- **Caps.** Capture is bounded by a max total-bytes and max file-count limit; a file skipped because it would exceed the cap is logged (`console.warn`), never silently truncated.
- **`workspace/` is never pruned.** Version pruning (§11) only reaps `versions/{vid}/`; the latest-only `workspace/` mirror is untouched.

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
| `catalog.json`                               | Migrated in-place as part of the first write after a Worker deploy that bumps catalog schema version. Uses a strict `version` literal, so — unlike the objects above — it is **not** forward-tolerant.                                                                            |

> **No `schema_version` by design:** the mutable, last-writer-wins records — sessions (`_system/sessions/**`), identities (`_system/identities/**`), tokens (`_system/tokens/**`), and `fs_snapshot.json` — carry no `schema_version`. They are rewritten on every write or reaped shortly after creation, so they never need a migration; a shape change is absorbed with optional fields + defaults on read. API response bodies are likewise unversioned per-object — the contract is versioned at the route level (`/api/v1`).

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

| Topic                       | Detail                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention                   | Keep snapshots for 90 days (with a floor of the N most recent), then delete via the maintenance cron — `MaintenanceService.expireSnapshots` (`packages/core/src/services/catalog/MaintenanceService.ts`). Every commit writes a new snapshot, so without this the bucket grows without bound (the Iceberg "snapshot-expiry" problem). |
| Recovery                    | Find the snapshot with the right point in time **by `created_at` / object `uploaded`, not by key order** (§5), write it as a new snapshot with a new ID, then CAS-swap `catalog.json`. See [`operations.md`](./operations.md) §2 for the full procedure.                                                                              |
| Compaction                  | Not needed at this scale. If snapshot exceeds 1MB, split into per-project manifest files referenced by the snapshot instead of embedded.                                                                                                                                                                                              |
| Emergency rollback          | GET any previous snapshot → PUT as new snapshot → CAS `catalog.json`. Restores the **index** in 3 calls. This does _not_ restore notebook content — `workspace/notebook.py` is overwritten in place on each save, so to roll back code you must also restore the relevant immutable `versions/{vid}/` objects.                        |
| Snapshot size at full scale | ~200KB (200 bytes × 1,000 notebooks)                                                                                                                                                                                                                                                                                                  |
| Version-folder artifacts    | The HTML/session snapshots (§8) live **inside** the immutable `versions/{vid}/` folder, not in `_system/snapshots/`. They need no separate retention job: `NotebookService.pruneVersions` deletes the whole version prefix when it ages out of `MAX_VERSIONS`, reaping `notebook.html` / `session.json` along with the code.          |

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

### Authorization (AuthZ) — single-tenant / trusted-org, with opt-in read isolation

**Reads are gated at `viewer`; writes are gated by the role matrix.** The deployment-wide `MARIMOHUB_DEFAULT_ROLE` is the fallback role for a logged-in caller who is neither the `owner` (implicitly `admin`) nor an explicit member:

- With it **set** (`editor`/`viewer`/`admin` — the default is `editor`), every authenticated user is at least a viewer, so reads stay open and "list everything" stays 2 GETs (§7.1) — there is no per-caller filtering to do.
- With it **`none`**, non-members have no role: reads are membership-gated. A non-member cannot see a project at all — `GET` returns **`404`** (existence is not leaked) and the project is omitted from the list.

**Writes** are always enforced against the target project: the Worker loads `project.json`, resolves the caller's effective role, and rejects insufficient roles with `403 FORBIDDEN`. A `viewer` or non-member cannot mutate a project's notebooks.

**Super admins.** `MARIMOHUB_SUPER_ADMINS` lists operators who resolve to `admin` on **every** project, overriding both membership and `MARIMOHUB_DEFAULT_ROLE`. It is the single deployment-wide exception to the per-project model: a super admin sees and lists all projects (even under `none`), reads/writes every notebook and secret, controls any session, and reads the audit trail. An entry containing `@` matches the login email (case-insensitive); any other entry matches the user id (`sub`) exactly — the id and email namespaces do not overlap (`isSuperAdmin`, `packages/core/src/authz.ts`). The elevation flows through the same `effectiveRole` the role matrix uses, so no enforcement path is special-cased; the two invariants that still bind everyone hold for super admins too — a project `owner` cannot be demoted/removed, and a soft-deleted project stays `404`. A PAT minted by a super admin inherits the power.

Read-side isolation under `none` keeps the read model intact (§7.1). Filtering `GET /projects` would otherwise cost a membership check per project, so each catalog snapshot project entry carries a denormalized **`member_ids`** array (owner + members), refreshed in the same CAS as every membership edit. The list filters in-memory over data already fetched — still 2 GETs. Single-project reads (`GET /projects/{id}`, notebook & session reads) load `project.json` and check `viewer` only when `defaultRole` is `none`; with a default role set they short-circuit with no extra load.

### Role → permission matrix

The read row is open to any authenticated user when a default role is set; under `MARIMOHUB_DEFAULT_ROLE=none` it is restricted to the owner and explicit members (non-members get `404`) — plus any super admin, who is `admin` on every project regardless.

| Capability                                                                                 | `viewer` | `editor` | `admin` |
| ------------------------------------------------------------------------------------------ | :------: | :------: | :-----: |
| See & read projects & notebooks; read versions; open & read notebook code                  |    ✓     |    ✓     |    ✓    |
| View a notebook's outputs (HTML snapshot / ephemeral session, per `MARIMOHUB_VIEWER_MODE`) |    ✓     |    ✓     |    ✓    |
| Create/update/delete notebooks; save versions; create sessions (run)                       |          |    ✓     |    ✓    |
| Update/delete projects; manage members                                                     |          |          |    ✓    |

Enforced today (`403 FORBIDDEN` on write failure, `404` on hidden read): notebook create/update/delete and session creation require **editor+** on the project; project update/delete require **admin**; reads require **viewer** (a no-op unless `MARIMOHUB_DEFAULT_ROLE=none`). Creating a _new_ project is open to any authenticated user (no project context yet — the creator becomes its `owner`/`admin`). A project's `owner` is implicitly `admin`. Enforcement lives in the Worker (per-route `assertProjectRole` / `assertProjectVisible`), never in the client.

> Session `heartbeat`/`terminate` also require **editor+** (they keep a kernel alive / tear it down). Hard-delete (the deferred GC pass, §7.4) remains the outstanding authorization work; per-notebook ACLs and per-user index objects are out of scope (they would break the 2-GET read model — see `rfc.md` §8).

**What a viewer sees** is set deployment-wide by `MARIMOHUB_VIEWER_MODE`. `static` (the default) serves the newest version's `notebook.html` snapshot via `GET …/notebooks/{nid}/html` — read-only, no compute, gated like any read. `ephemeral-sandbox` admits viewers to session create/heartbeat/terminate (and the kernel proxy) **for their own sessions only**; such sessions are stamped `ephemeral: true` and every teardown path (explicit stop, idle/lifetime reaper, periodic snapshotter, reconciliation) skips the write-back — no version, HTML/session snapshot, workspace mirror, or FS snapshot is ever cut from a viewer's sandbox, and WIF credentials are never injected into one.

---

## 13. Worker API Layer

The Worker is an authenticated proxy between the marimo frontend and the object store. It owns auth (§12), ID generation, source resolution, snapshot management, session tracking, and event logging. Storage credentials and raw bucket access are never exposed to the client — every object is read and written through the Worker, and clients address notebooks by `{project_id, notebook_id}` only. The physical `key_prefix` is internal to the stored snapshot and is **stripped from all API responses**; clients never receive storage paths.

### The OpenAPI document is the contract

Routes are defined with `@hono/zod-openapi`: each declares typed request and response schemas, and the live spec is served at **`GET /api/v1/doc`** (OpenAPI 3.1). That generated document — not a hand-maintained table — is the source of truth for paths, parameters, request bodies, and response shapes. All routes are mounted under `/api/v1`, in these groups:

- **Auth** — `GET /api/v1/me`
- **Users** — `GET /api/v1/users?ids=…` (batch-resolve user ids → `{ id, email, name }` from the identity directory, §4.10)
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
- **Idempotency** — reads, `PUT`/`PATCH`, and soft-`DELETE` are naturally idempotent. `POST` creates are **not** by default: a retry after a network failure or a `409 CONFLICT` can create a duplicate. Clients that care send an `Idempotency-Key` header on `POST /projects` and `POST …/notebooks` — the server stores `key → result` under `_system/idempotency/` and replays it on retry (24h TTL). `POST …/sessions` is already idempotent on `(user, notebook)` via its reuse path. See [`idempotency.md`](./idempotency.md).

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

| Metric                             | Value                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Projects                           | 10                                                                                                                                       |
| Notebooks per project              | 100                                                                                                                                      |
| Objects per notebook (no versions) | 5 (`meta.json`, `README.md`, `source.json`, `notebook.py`, `pyproject.toml`)                                                             |
| Total notebook objects             | 10 × 100 × 5 = 5,000                                                                                                                     |
| `project.json` files               | 10                                                                                                                                       |
| Snapshots (90-day window @ 20/day) | ~1,800                                                                                                                                   |
| Session records (peak concurrent)  | ~50                                                                                                                                      |
| Event objects (90 days @ ~20/day)  | ~1,800                                                                                                                                   |
| **Total objects (no versions)**    | **~8,660**                                                                                                                               |
| Snapshot size at full scale        | ~200KB                                                                                                                                   |
| Version folders (per notebook)     | ≤ `MAX_VERSIONS` (50), each ~3 objects (`notebook.py`, `pyproject.toml`, `version.json`)                                                 |
| Optional snapshot objects          | + ≤ 2 per version that ran a session (`notebook.html` ~0.5MB, `session.json`); sparse — only versions with a torn-down session have them |

> **Version + snapshot growth is bounded by `MAX_VERSIONS`.** Each notebook keeps at most 50 version folders; the optional HTML/session snapshots add at most two more objects to the versions that captured them. Both are reaped when the version ages out (`pruneVersions`, §11), so a notebook's footprint is capped regardless of edit/run frequency. HTML dominates the bytes (~0.5MB each), so a heavily-run notebook approaches ~50 × 0.5MB ≈ 25MB at the ceiling — size it via `MAX_VERSIONS` if that matters.

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

| Topic                             | Detail                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object-store versioning           | **Position taken** ([`operations.md`](./operations.md) §1): enable native object versioning + lifecycle expiry as the bucket-level backup/DR safety net beneath the snapshot layer. It is the recommended belt to the snapshot suspenders, and the cheap way to recover from an overwrite of in-place `notebook.py`.                                                                                                            |
| Notebook ordering                 | Notebooks currently sort by ULID (creation time). If users want manual ordering, add an `order` field to each notebook entry in the snapshot.                                                                                                                                                                                                                                                                                   |
| Additional source types           | v1 is `local`-only (§4.6). External-source backends (e.g. Git-backed notebooks) bring their own sync, caching, and credential concerns — to be specified separately when prioritized.                                                                                                                                                                                                                                           |
| Read-side tenant isolation        | **Project-granularity isolation resolved** (§12): opt-in via `MARIMOHUB_DEFAULT_ROLE=none`, filtering the list in-memory over the denormalized `member_ids` so reads stay 2 GETs. Still open: finer grains (per-notebook ACLs, per-user indexes — both break the single-CAS / 2-GET model) and true untrusted multi-tenancy (storage-enforced credential vending) — scope before opening the bucket to untrusted users.         |
| Execution logs locality           | Run logs currently go to `_system/events/`. Alternative: `projects/{pid}/notebooks/{nid}/runs/{run-id}.log` for per-notebook locality. Tradeoff is discoverability vs. centralization.                                                                                                                                                                                                                                          |
| Live state for real-time sessions | If kernel output streaming or sub-second variable inspection is needed, live session state belongs in a low-latency store (in-memory cache / stateful coordinator) co-located with the kernel runtime. Object storage retains the durable audit record.                                                                                                                                                                         |
| Version pruning                   | **Resolved.** `NotebookService.pruneVersions` keeps the most recent `MAX_VERSIONS` (50) per notebook, pruning on each save (`packages/core/src/services/content/NotebookService.ts`). Snapshot and event growth are handled separately by `MaintenanceService` ([`operations.md`](./operations.md) §5).                                                                                                                         |
| Configurable version count        | `MAX_VERSIONS` should become a config knob (e.g. `MARIMOHUB_NOTEBOOK_MAX_VERSIONS`) so operators can trade history depth for storage. The same count bounds the optional HTML/session snapshots (§8) — they live inside the version folder, so one ceiling covers all three artifacts (no separate snapshot-retention setting needed).                                                                                          |
| HTML / session snapshots          | Captured on session teardown by copying marimo's `__marimo__/notebook.html` and `__marimo__/session/{notebook}.py.json` into the version teardown cuts for the session's edits (§8); sparse and optional. Open follow-ups: read/download API routes to surface them, and whether to also persist the HTML on a non-session API save (no live kernel then, so it would require an export step — deliberately out of scope here). |
