# marimo Notebooks — Object-Storage Backend

**Schema Design, Storage Architecture & CRUD API**

> Scale target: 10 Projects × 100 Notebooks · Iceberg-inspired metadata layer · No database

---

## 1. Overview & Design Principles

This document defines the bucket schema for marimo notebook create, read,
update, and delete operations. It uses the `Bucket` port without an external
database. The content model follows the Apache Iceberg metadata
indirection pattern. `catalog.json` is the only mutable content pointer, and
immutable snapshots and versions retain history. `_system/` also stores mutable
coordination records outside the content snapshot chain.

> **Core invariant:** `catalog.json` is the only content pointer overwritten in
> place. Every content-history write creates a new object. `_system/` stores
> mutable sessions (§4.8), app claims (§4.8.1), editor claims (§4.8.2),
> identities (§4.10), and tokens (§4.11). These records do not participate in
> the snapshot chain. Each CAS-managed record is written through its owning core
> service.

### Design Goals

- No database — the configured `Bucket` adapter is the persistence layer
- O(1) reads for listing projects and notebooks — no object scanning
- Immutable snapshots give audit history for free
- Self-describing notebooks — each notebook folder is a complete, portable unit
- A local notebook has a latest-only `workspace/`. A Git-synced notebook stores each pushed workspace inside its immutable version.
- Typed source pointer — `local` notebooks store source in the workspace. `git` notebooks receive pushed revisions from an external workflow.
- Append-only audit events — one immutable object per event
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

Every snapshot carries a `schema_version` field. When the snapshot structure
changes, the service upgrades the current snapshot in memory before it writes
the next snapshot. It does not rewrite old snapshots.

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
│   │   └── {project-id}/
│   │       └── {session-id}.json            ← kernel session record
│   ├── version-prune-cutoffs/
│   │   └── {project-id}/
│   │       └── {notebook-id}.json           ← monotonic version boundary for new sessions (CAS)
│   ├── proposal-payloads/
│   │   └── {project-id}/
│   │       └── {notebook-id}/
│   │           └── {proposal-id}.json       ← immutable payload-expiry marker
│   ├── apps/
│   │   └── {project-id}/
│   │       └── {notebook-id}.json           ← app-session singleton claim (CAS)
│   ├── editors/
│   │   └── {project-id}/
│   │       └── {notebook-id}.json           ← persistent-editor claim (CAS)
│   ├── reconcile/
│   │   └── orphans/
│   │       └── {sandbox-id}.json            ← first-seen marker for an undated orphan
│   ├── identities/
│   │   └── {user-id}.json                  ← user display identity (mutable, CAS-managed)
│   ├── tokens/
│   │   └── {token-id}.json                 ← personal access token record (mutable, last-writer-wins)
│   ├── cli-authorizations/
│   │   └── {authorization-id}.json         ← short-lived PKCE login grant (CAS-claimed)
│   ├── cli-device-user-codes/
│   │   └── {user-code}.json                ← immutable lookup claim for a device grant
│   ├── integrations/                       ← organization-wide integrations (§4.12)
│   │   ├── _names/
│   │   │   └── {name}.json                 ← name claim (CAS, app-claim pattern)
│   │   └── {integration-id}/
│   │       ├── integration.json            ← CAS-managed head
│   │       └── versions/
│   │           └── {000001}.json           ← immutable configuration version
│   ├── idempotency/
│   │   └── {digest}.json                   ← replay record with a 24h TTL
│   ├── events/
│   │   └── {YYYY-MM-DD}/
│   │       └── {event-id}.json             ← one immutable object per event
│   ├── _maintenance.lock                   ← advisory maintenance lease
│   └── _session_lifecycle.lock             ← advisory session-lifecycle lease
│
└── projects/
    └── {project-id}/
        ├── project.json                    ← project metadata
        ├── alerts.json                     ← project alert destinations (CAS-owned, encrypted)
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
                ├── source.json             ← `local` or `git` source metadata
                ├── integration_sync_token.json ← push-sync token hash (push-mode Git sources only)
                ├── fs_snapshot.json        ← optional provider filesystem-snapshot pointer
                ├── workspace/              ← local sources only: latest sandbox workspace
                │   ├── notebook.py          ← latest local code
                │   ├── pyproject.toml      ← latest local dependencies
                │   └── data/cars.csv       ← optional persisted runtime file
                ├── proposals/
                │   └── {proposal-id}/
                │       ├── proposal.json    ← immutable capture manifest
                │       ├── changes/
                │       │   └── {index}      ← temporary changed-file bytes
                │       └── publication.json ← CAS-managed publication state
                └── versions/
                    └── {version-id}/
                        ├── version.json
                        ├── notebook.py         ← local source snapshot
                        ├── pyproject.toml      ← local dependency snapshot
                        ├── workspace/          ← Git sources only: complete synced tree
                        ├── git/                ← pull-mode Git sources only: credential-free `.git` payload
                        ├── notebook.html       ← optional snapshot (see below)
                        └── session.json        ← optional snapshot (see below)
```

### 3.1.1 Local and Git workspaces

For a `local` source, the notebook-level `workspace/` folder is the latest
mirror of the sandbox working directory. It contains `notebook.py` and
`pyproject.toml`. It can also contain runtime files when
`MARIMOHUB_PERSIST_WORKSPACE=workspace`.

- **Latest-only and non-versioned.** `workspace/` is overwritten in place on each save/teardown and is **never** touched by version pruning. The immutable per-version record lives under `versions/{vid}/` (§4.7).
- **Runtime files are opt-in.** Under the default `MARIMOHUB_PERSIST_WORKSPACE=source`, `workspace/` contains only `notebook.py` + `pyproject.toml`. Under `workspace`, the sandbox's non-source files are captured here on teardown and restored on the next session (§8).
- **The mount is rooted at `workspace/`.** When a sandbox mounts the bucket, the working dir maps to `workspace/`. Because `meta.json` / `README.md` / `source.json` / `versions/` sit **outside** `workspace/`, control metadata is never exposed to user code in the sandbox.

For a `git` source, each sync writes a complete tree under
`versions/{vid}/workspace/`. The source pointer selects one immutable version.
The notebook has no mutable workspace mirror. A session receives a copy of the
selected version and cannot write changes back.

### 3.2 Complete Path Reference

| Path                                                                      | Type     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_system/catalog.json`                                                    | JSON     | Single entry point. Points to the current snapshot. This is the only mutable content pointer.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `_system/snapshots/{id}.json`                                             | JSON     | Immutable index snapshot. Lists all projects and notebooks with metadata. Written once, never modified.                                                                                                                                                                                                                                                                                                                                                                                                |
| `_system/sessions/{pid}/{sid}.json`                                       | JSON     | Live session record, partitioned by project so a project-scoped read lists only `_system/sessions/{pid}/`. Created on notebook open, updated by heartbeat, and retired by an explicit stop or lifecycle deadline. Closing a browser tab does not immediately delete it.                                                                                                                                                                                                                                |
| `_system/version-prune-cutoffs/{pid}/{nid}.json`                          | JSON     | Monotonic `{ cutoff_version_id }` advanced before pruning old version folders. A new source-pinned session writes its record and then rejects itself if its version is at or before the cutoff; otherwise a later cutoff advance must see and protect that session. CAS updates are owned by `SessionService`. Hard deletion removes the record.                                                                                                                                                       |
| `_system/proposal-payloads/{pid}/{nid}/{proposal-id}.json`                | JSON     | Immutable expiry marker listing the temporary proposal change objects eligible for retention cleanup. It remains until every listed payload is deleted successfully.                                                                                                                                                                                                                                                                                                                                   |
| `_system/apps/{pid}/{nid}.json`                                           | JSON     | Per-notebook app-singleton claim: names the app session that owns the notebook's shared app sandbox. Written create-if-absent by the create saga, replaced via ETag CAS when stale, CAS'd to a free marker (`session_id: null`) on teardown. All writes go through `SessionService.claimApp`/`releaseApp`. See §4.8.1.                                                                                                                                                                                 |
| `_system/editors/{pid}/{nid}.json`                                        | JSON     | Per-notebook persistent-editor claim. Records the shared/exclusive mode, names the only session allowed to save, and records idempotent takeover phases. All writes go through `SessionService`. See §4.8.2.                                                                                                                                                                                                                                                                                           |
| `_system/identities/{user-id}.json`                                       | JSON     | User display identity (`{ id, email, name, picture_url?, suspended_at? }`). Owned and CAS-updated by `IdentityService`. Resolves opaque `author`/`user_id` IDs to a person and gates suspended users at authentication time.                                                                                                                                                                                                                                                                           |
| `_system/tokens/{token-id}.json`                                          | JSON     | Personal access token record (`{ id, user_id, name, hash, … }`) keyed by the ULID embedded in the presented `mhub_pat_` bearer, so verification is a single GET. Stores only the SHA-256 of the secret. Mutable, last-writer-wins (coarse `last_used_at` refresh); revocation deletes the object. See §4.11.                                                                                                                                                                                           |
| `_system/cli-authorizations/{authorization-id}.json`                      | JSON     | Ten-minute browser-to-CLI PKCE grant. Stores hashes/challenges, never a PAT or plaintext authorization secret. `CliAuthorizationService` CAS-claims it before minting one token, then deletes it. See §4.11.1.                                                                                                                                                                                                                                                                                         |
| `_system/cli-device-user-codes/{user-code}.json`                          | JSON     | Create-if-absent lookup claim from an eight-letter device user code to its short-lived CLI authorization. `CliAuthorizationService` owns the claim. It deletes the claim after exchange and prunes it after ten minutes. See §4.11.1.                                                                                                                                                                                                                                                                  |
| `_system/events/{YYYY-MM-DD}/{event-id}.json`                             | JSON     | Structured event log. One immutable object per event, keyed by a monotonic ULID under a per-day prefix. Primary audit trail.                                                                                                                                                                                                                                                                                                                                                                           |
| `_system/idempotency/{digest}.json`                                       | JSON     | Recorded `POST`-create response for an `Idempotency-Key`, keyed by `sha256(user:route\nkey)`. Replayed on retry; pruned after 24h. See [`idempotency.md`](./idempotency.md).                                                                                                                                                                                                                                                                                                                           |
| `_system/reconcile/orphans/{sandbox-id}.json`                             | JSON     | First-seen Unix timestamp for an active sandbox that has no session record and no provider creation time. The reconciler creates and deletes these markers.                                                                                                                                                                                                                                                                                                                                            |
| `_system/_maintenance.lock`                                               | JSON     | Advisory lease for snapshot and event retention. `MaintenanceLock` owns this key.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `_system/_session_lifecycle.lock`                                         | JSON     | Advisory lease for the session lifecycle and reconciliation sweep. The lifecycle loop owns this key.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `projects/{pid}/project.json`                                             | JSON     | Project metadata: name, description, owner, members, tags.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `projects/{pid}/alerts.json`                                              | JSON     | Project-scoped Slack and signed-webhook destinations. CAS-managed and written only by `ProjectAlertStore`; endpoint URLs and signing secrets are path-bound managed ciphertext. The record is retained through the soft-delete window so the final project deletion alert can be delivered.                                                                                                                                                                                                            |
| `projects/{pid}/integrations/{iid}/integration.json`                      | JSON     | Integration head: kind, instance name, `enabled`, and the `current_version` pointer. CAS-managed via ETag `mutateObject` — written only by `ProjectIntegrationsStore` (a version bump must be atomic against a concurrent edit). See §4.12.                                                                                                                                                                                                                                                            |
| `projects/{pid}/integrations/{iid}/versions/{n}.json`                     | JSON     | Immutable integration config version, keyed by zero-padded number so key order matches version order. Written create-if-absent. Secret fields contain managed ciphertext envelopes or external reference markers, never resolved plaintext. Sessions pin these version numbers, so history is never rewritten.                                                                                                                                                                                         |
| `projects/{pid}/integrations/_names/{name}.json`                          | JSON     | Per-name singleton claim (`{ integration_id, claimed_at }`) anchoring integration-name uniqueness — the same claim class as the app claim, written only by `ProjectIntegrationsStore` via `acquireSingletonClaim`/`releaseSingletonClaim`. See §4.12.                                                                                                                                                                                                                                                  |
| `_system/integrations/{iid}/integration.json`                             | JSON     | Organization-wide integration head. It has the same fields as a project integration head, except it has no `project_id`. `OrgIntegrationsStore` is its only writer. See §4.12.                                                                                                                                                                                                                                                                                                                         |
| `_system/integrations/{iid}/versions/{n}.json`                            | JSON     | Immutable organization-wide configuration version. It follows the same create-if-absent and secret-handling rules as a project integration version.                                                                                                                                                                                                                                                                                                                                                    |
| `_system/integrations/_names/{name}.json`                                 | JSON     | Organization-wide name claim. Claims are unique within this tier, so a project integration can use the same name.                                                                                                                                                                                                                                                                                                                                                                                      |
| `projects/{pid}/notebooks/{nid}/meta.json`                                | JSON     | Notebook metadata: title, description, status, author, tags, last_run_at. Never contains code or paths.                                                                                                                                                                                                                                                                                                                                                                                                |
| `projects/{pid}/notebooks/{nid}/README.md`                                | Markdown | Human-readable description and usage notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `projects/{pid}/notebooks/{nid}/source.json`                              | JSON     | Typed source record. `local` stores the current version pointer. `git` stores Git coordinates, mode, sync state, and the current synced version.                                                                                                                                                                                                                                                                                                                                                       |
| `projects/{pid}/notebooks/{nid}/integration_sync_token.json`              | JSON     | Push-sync credential for one notebook. The record stores a token hash, not the plaintext token. Present only for push-mode Git notebooks.                                                                                                                                                                                                                                                                                                                                                              |
| `projects/{pid}/notebooks/{nid}/fs_snapshot.json`                         | JSON     | **Optional.** Pointer to the notebook's current CoreWeave-native filesystem snapshot (`{ snapshot_id, captured_at, owner_user_id }`). Mutable, last-writer-wins, written only by the teardown snapshot path. Exclusive editors restore snapshots only for the same owner; shared editors may restore across starters. Present only under `MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT=true`. **Not recommended alongside `MARIMOHUB_PERSIST_WORKSPACE=workspace`** — the two double-persist state. |
| `projects/{pid}/notebooks/{nid}/proposals/{proposal-id}/proposal.json`    | JSON     | Immutable proposal manifest containing capture strategy, author/session provenance, pinned Git source revision, and ordered change hashes. Created with create-if-absent.                                                                                                                                                                                                                                                                                                                              |
| `projects/{pid}/notebooks/{nid}/proposals/{proposal-id}/changes/{index}`  | any      | Temporary bytes for a non-delete proposal change. The index corresponds to `proposal.json.changes`; delete changes have no object. These objects may be deleted after retention expires even though their manifest remains.                                                                                                                                                                                                                                                                            |
| `projects/{pid}/notebooks/{nid}/proposals/{proposal-id}/publication.json` | JSON     | CAS-managed proposal publication state owned by `NotebookProposalService`. It records either pending state or the durable provider change-request result. For an updated change request, the root proposal's `head_commit` advances as the shared current-head pointer after each child result is durable.                                                                                                                                                                                             |
| `projects/{pid}/notebooks/{nid}/workspace/notebook.py`                    | Python   | Latest local notebook code. Present only for a `local` source.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `projects/{pid}/notebooks/{nid}/workspace/pyproject.toml`                 | TOML     | Latest local Python dependency manifest. Present only for a `local` source.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `projects/{pid}/notebooks/{nid}/workspace/{path}`                         | any      | Runtime files mirrored from a local notebook sandbox. Present only under `MARIMOHUB_PERSIST_WORKSPACE=workspace`. Latest-only and non-versioned.                                                                                                                                                                                                                                                                                                                                                       |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/notebook.py`               | Python   | Immutable version snapshot of the code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/pyproject.toml`            | TOML     | Dependency snapshot at time of version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/version.json`              | JSON     | Version metadata: saved_at, author, message, parent_id, optional snapshot descriptors.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/workspace/`                | any      | Complete immutable tree from one Git sync. Present only for a `git` source version.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/git/`                      | any      | Immutable credential-free `.git` payload for a pull-mode source version. Restored into the sandbox workdir at provision and pruned with the enclosing version.                                                                                                                                                                                                                                                                                                                                         |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/notebook.html`             | HTML     | **Optional.** Rendered HTML snapshot, copied from `__marimo__/notebook.html` on session teardown. Immutable once written.                                                                                                                                                                                                                                                                                                                                                                              |
| `projects/{pid}/notebooks/{nid}/versions/{vid}/session.json`              | JSON     | **Optional.** marimo session state (cell outputs), copied from `__marimo__/session/{notebook}.py.json` on teardown. Immutable.                                                                                                                                                                                                                                                                                                                                                                         |

---

## 4. File Schemas

### 4.1 `_system/catalog.json`

The single mutable entry point. Overwritten atomically using conditional PUT with `If-Match` on the current ETag.

```json
{
	"version": 1,
	"updated_at": "2025-03-05T14:22:00Z",
	"current_snapshot_id": "snap-7h2k9qm4xz7rp3w8",
	"current_snapshot_key": "_system/snapshots/snap-7h2k9qm4xz7rp3w8.json",
	"previous_snapshot_id": "snap-5g43rv2s9pfw8w4d"
}
```

### 4.2 `_system/snapshots/{id}.json`

Written once per mutating operation and never modified. The `schema_version`
field controls how the service reads the structure.

```json
{
	"snapshot_id": "snap-7h2k9qm4xz7rp3w8",
	"schema_version": 1,
	"created_at": "2025-03-05T14:22:00Z",
	"operation": "notebook.create",
	"actor": "user_abc123",
	"projects": [
		{
			"id": "proj-7h2k9qm4xz7rp3w8",
			"name": "Data Science",
			"description": "Exploratory analysis notebooks",
			"owner": "user_abc123",
			"created_at": "2025-01-10T09:00:00Z",
			"updated_at": "2025-03-05T14:22:00Z",
			"notebook_count": 3,
			"notebooks": [
				{
					"id": "nb-5g43rv2s9pfw8w4d",
					"title": "Revenue Analysis",
					"description": "Monthly revenue breakdown",
					"status": "active",
					"source_type": "local",
					"author": "user_abc123",
					"created_at": "2025-01-15T10:00:00Z",
					"updated_at": "2025-03-05T14:22:00Z",
					"tags": ["finance", "monthly"],
					"last_run_at": "2025-03-04T08:30:00Z",
					"key_prefix": "projects/proj-7h2k9qm4xz7rp3w8/notebooks/nb-5g43rv2s9pfw8w4d"
				}
			]
		}
	]
}
```

> `key_prefix` is an internal physical locator. The service removes it from API
> responses. Clients address notebooks by `{project_id, notebook_id}`.

### 4.3 `projects/{pid}/project.json`

```json
{
	"id": "proj-7h2k9qm4xz7rp3w8",
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

> **Member roles:** `manager` has full project control, including member management. `editor` can change notebooks. `viewer` has read-only access. `admin` is reserved for the project owner, deployment super admins, and grandfathered member rows. See §12.

### 4.4 `projects/{pid}/notebooks/{nid}/meta.json`

Contains only notebook-level concerns. No code, no paths, no source details — those live in `source.json` and `workspace/`. This is what the API returns when a user views a notebook listing.

```json
{
	"id": "nb-5g43rv2s9pfw8w4d",
	"project_id": "proj-7h2k9qm4xz7rp3w8",
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

The source record selects a local workspace or an immutable Git-synced
workspace. A local source uses this shape:

```json
{
	"schema_version": 1,
	"type": "local",
	"current_version_id": "ver_01ARZ3NDEKTSV4RRFFQ69G5FAV"
}
```

A Git source stores `type: "git"`, a provider, `sync_mode: "push" | "pull"`,
Git coordinates, and sync timestamps. `current_version_id` is `null` before the
first successful sync.

### 4.6 Source types

`source.json` is a discriminated union on `type`. The current schema supports
`local` and `git` records. A `local` record points to the current version in the
bucket. A `git` record stores Git coordinates, its push or pull mode, and the
state of the last sync.

In push mode, an external workflow sends the workspace to `/api/sync/git/v1`
with a notebook-scoped sync token. Pull mode has no token. The hub reads the
GitHub branch and creates a credential-free shallow Git directory through the
source-control adapter. Both modes store repository files under
`versions/{vid}/workspace/`. Pull mode also stores `.git` content under the
sibling `versions/{vid}/git/` prefix.
See the [sync guide](../docs/syncing.md) for the API and token lifecycle.

### 4.7 `versions/{vid}/version.json`

```json
{
	"version_id": "ver_01ARZ3NDEKTSV4RRFFQ69G5FAV",
	"notebook_id": "nb-5g43rv2s9pfw8w4d",
	"saved_at": "2025-03-05T14:22:00Z",
	"author": "user_abc123",
	"message": "Add regional breakdown by Q",
	"parent_id": "ver_01ARZ3NDEKTSV4RRFFQ69G5FA0",
	"html_snapshot": { "captured_at": "2025-03-05T14:40:00Z", "size_bytes": 524288 },
	"session_snapshot": { "captured_at": "2025-03-05T14:40:00Z", "size_bytes": 81920 }
}
```

Versions are immutable once written. A local save writes a new version, updates
`source.current_version_id`, and updates the notebook-level workspace. A Git
sync writes the complete workspace inside the new version. It then advances the
source pointer with CAS.

**Optional snapshot descriptors.** `html_snapshot` and `session_snapshot` record the _presence and metadata_ of a rendered HTML snapshot (`notebook.html`) and a marimo session state file (`session.json`) sitting alongside the code in the version folder. They carry `captured_at` and `size_bytes` — **never a storage path** (clients address notebooks by ID, §13). Each field is **absent** when that artifact wasn't captured; both are written only on session teardown (§8) and only if marimo actually produced the source file, so most versions have neither. Adding these optional fields is forward-tolerant — a reader that doesn't know them ignores them — so it requires no breaking migration of existing `version.json` objects.

### 4.8 `_system/sessions/{pid}/{sid}.json`

A session represents a live marimo kernel instance — a running Python process attached to a notebook. Sessions are mutable records (like `catalog.json` and the identity directory, §4.10), but they are independent: session writes never touch the snapshot chain.

Records are partitioned by project (`_system/sessions/{pid}/{sid}.json`) so the interactive reads — `listActiveByProject` (every notebook-table render) and `findReusable` (every session create) — list just that project's prefix instead of scanning every session in the deployment. Deployment-wide sweeps (the stale-expiry and terminal-reap passes, per-user session count) still list the whole `_system/sessions/` prefix recursively. Because the key now carries the project id, the routing token for `proxy` exposure mode encodes `{pid}.{sid}` (see `proxyToken.ts`) so the forwarder can rebuild the key.

```json
{
	"session_id": "sess-4m8v6k2q9r5t7w3x",
	"notebook_id": "nb-5g43rv2s9pfw8w4d",
	"project_id": "proj-7h2k9qm4xz7rp3w8",
	"user_id": "user_abc123",
	"status": "running",
	"started_at": "2025-03-05T14:30:00Z",
	"last_heartbeat": "2025-03-05T14:35:00Z",
	"authorization_expires_at": "2025-03-05T15:30:00Z",
	"runtime": {
		"python_version": "3.11",
		"marimo_version": "0.9.0"
	},
	"sandbox_id": "sb-3f6h9k2m5p8r4t7v",
	"sandbox_url": "https://sandbox.example.com/sess-4m8v6k2q9r5t7w3x",
	"compute_profile": "small",
	"used_fallback": false
}
```

When a session goes `failed`, `markFailed` may persist an optional sanitized `error` object so the client polling the record can render _why_ instead of a bare `failed`. It is omitted on healthy records and never carries secret material:

```json
{ "status": "failed", "error": { "code": "SERVICE_UNAVAILABLE", "message": "Sandbox unreachable" } }
```

**Valid `status` values:** `starting` · `running` · `terminating` · `terminated` · `failed` · `expired`

`sandbox_id` / `sandbox_url` link the record to the live kernel runtime (a separate container/compute service); `compute_profile` records the configured profile name used at launch and is absent when profiles are unset; `used_fallback` records whether a fallback runtime was used. The optional field is forward-compatible with existing records and requires no migration.

`authorization_expires_at` exists only for sessions authorized by an OIDC group policy. It copies the signed browser session's JWT `exp` value. The lifecycle never extends this deadline. At expiry, it destroys direct subdomain kernels. HTTP proxy requests fail closed, and the Node proxy closes established WebSockets. This teardown skips the final capture so that the kernel stops promptly. Periodic snapshots limit potential data loss. The session API does not return this internal field.

**Session lifecycle:**

1. `POST /sessions` creates a `starting` record. Successful provisioning changes it to `running` and records the sandbox location.
2. A heartbeat updates `last_heartbeat`. The service coalesces bucket writes to one write per minute.
3. `DELETE /sessions/{id}` changes the record to `terminating`. Teardown changes it to `terminated` after the sandbox is gone.
4. The lifecycle sweep changes an overdue live session to `expired`.
5. The reaper deletes old `terminated`, `failed`, and `expired` records after the retention period.

> **On object storage vs. a live state store for sessions:** the object store is appropriate for session _records_ — created on open, updated periodically, read for display — and the record carries `sandbox_id` / `sandbox_url` pointing at the live kernel runtime (a separate container/compute service). It is not appropriate for sub-second kernel state (output streaming, variable inspection); that lives in the kernel runtime itself, backed by a low-latency state store (in-memory cache / stateful coordinator) if cross-request coordination is needed. For MVP — tracking who has what open, TTL cleanup — the object store is sufficient.

**App sessions.** A session record may carry `mode: "app"`: the notebook served as a read-only application via `marimo run` instead of the editor. App sessions are **per-notebook singletons shared by all editors** (reuse is user-blind; `user_id` is attribution only), are provisioned copy-only (never a bucket mount), and are **never written back** — no version, HTML/session snapshot, workspace mirror, or FS-snapshot pointer advances from an app sandbox. App-only fields: `source_version_id` (the notebook's head version at provision — staleness detection), `active_connections` + `connections_checked_at` (the lifecycle sweep's last kernel connection probe). Absent `mode` = `edit`.

### 4.8.1 `_system/apps/{pid}/{nid}.json`

The app-singleton claim anchors "one app sandbox per notebook" against concurrent `Run as app` requests. Beside `catalog.json` and the session records, it is the third CAS-managed mutable object in the store.

```json
{ "session_id": "sess-4m8v6k2q9r5t7w3x", "claimed_at": "2025-03-05T14:30:00Z" }
```

`session_id: null` is the **free marker** a release writes in place of the value — see rule 3.

Write discipline (all through `SessionService.claimApp` / `releaseApp`, which delegate to the generic `acquireSingletonClaim`/`releaseSingletonClaim` primitives beside `withCasRetry` — a future lease of the same shape reuses them, not this object):

1. The create saga's `app_claim` step writes the claim **create-if-absent** (`If-None-Match: *`) after the session record and before any compute call — exactly one of N concurrent creates wins; losers attach to the winner's session via the user-blind reuse path.
2. A claim whose holder session is terminal, absent, or a wedged `starting` record past the provision window is **stale** and replaced via ETag CAS.
3. Every teardown path (explicit stop, lifecycle reaper, reconciliation, saga compensation) **frees** the claim when it names the session being torn down, by CAS'ing `session_id` to `null` rather than deleting the object. There is no conditional-delete primitive, so a read-then-delete would drop a claim a new holder acquired between the read and the delete — freeing the singleton under a running app and letting a third session acquire it. The CAS loses that race instead, leaving the new holder's claim intact. The cost is a pointer that outlives the app; rule 5's cleanup removes it.
4. The create saga **re-asserts** the claim after the session is marked `running`: a slow provision can look like a wedged holder (rule 2) and lose the claim mid-provision, and a running holder is never stale — so the recheck is the last point a steal can be detected. A loser compensates (sandbox destroyed, record terminated) and attaches to the current holder.
5. Cleanup deletes, outside `claimApp`/`releaseApp`: deleting a notebook (soft or hard) or hard-deleting a project also deletes the claim object(s) under it, so no claim outlives its notebook.

### 4.8.2 `_system/editors/{pid}/{nid}.json`

The editor claim is the persistence fence for edit sandboxes. Exactly one
non-ephemeral session holds it. Under `shared`, every editor attaches to that
holder. Under `exclusive`, only the holder attaches; another editor explicitly
chooses a discard-only temporary session or a takeover.

```json
{
	"session_id": "sess-…",
	"sharing": "exclusive",
	"claimed_at": "2026-07-31T12:00:00Z",
	"transfer": {
		"takeover_id": "client-idempotency-key",
		"requested_by": "user_b",
		"phase": "draining",
		"requested_at": "2026-07-31T12:10:00Z",
		"drain_lease_id": "server-attempt-id",
		"drain_lease_expires_at": "2026-07-31T12:20:00Z",
		"drain_lease_stage": "capturing",
		"drain_lease_progress_deadline_at": "2026-07-31T12:40:00Z"
	}
}
```

Claim acquisition, stale-holder replacement, release, and takeover phase
changes use ETag CAS. Snapshot and teardown operations write notebook content
only when the session still holds the claim.

A takeover moves through three phases:

1. `requested` reserves the expected holder and connection state.
2. `draining` protects ownership while save or sandbox destruction retries. A
   CAS-acquired lease serializes recovery so concurrent retries cannot save or
   destroy the old sandbox twice. The holder renews its ten-minute deadline
   every minute until it atomically moves the claim to `ready`. An expired lease
   cannot be renewed by its former holder. Renewal is also capped at 30 minutes
   without progress. Finishing notebook capture, filesystem snapshotting, or
   sandbox destruction starts a new 30-minute progress window. Another replica
   can therefore recover a drain whose worker stopped or whose current operation
   is permanently stuck.
3. `ready` permits only the requester to create the replacement session.

The create route completes the transfer after the replacement reaches
`running`. A save or destruction failure does not create the replacement.

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
	"project_id": "proj-7h2k9qm4xz7rp3w8",
	"notebook_id": "nb-5g43rv2s9pfw8w4d",
	"snapshot_id": "snap-7h2k9qm4xz7rp3w8"
}
```

**Event types (emitted today):** every catalog mutation is appended by `CatalogService` after its winning CAS commit (best-effort: a failed append never fails the mutation, it bumps the `events.append_failed` metric). The `event` field is the operation name: `project.create` · `project.update` · `project.members` · `project.delete` · `project.gc` · `notebook.create` · `notebook.update` · `notebook.delete` · `notebook.gc` · `notebook.synced.create` · `notebook.synced.sync`. Context fields (`project_id`, `notebook_id`, …) ride along per operation. Project managers read one day with `GET /api/v1/projects/{pid}/events?date=`. Super admins read a paginated deployment stream with `GET /api/v1/events`. Each deployment query covers at most 30 UTC days.

**Planned, not yet emitted:** session lifecycle (`session.create` · `session.terminate` · `session.expired`), `notebook.run`, `notebook.snapshot` (snapshot capture on teardown, §8), and `migration.run`.

### 4.10 `_system/identities/{user-id}.json`

The identity directory maps a stable user id — the auth `sub`, which is what every `author` / `user_id` / `actor` / `owner` field stores — to that user's current human-readable identity. It exists so the UI can render those opaque ids as a person (e.g. "Started by Ada Lovelace", "Created by …") without denormalizing a name/email onto every notebook, session, and snapshot.

```json
// _system/identities/user_abc123.json
{
	"id": "user_abc123",
	"email": "ada@example.com",
	"name": "Ada Lovelace",
	"picture_url": "https://idp.example.com/avatar/ada",
	"suspended_at": "2026-08-11T18:00:00Z",
	"updated_at": "2026-08-11T18:00:00Z"
}
```

If the identity provider supplies no display name, `name` uses the email local-part. `AuthUser.name` is optional. OIDC reads the `name` claim from the `profile` scope. Access reads its `name` claim. The optional `picture_url` must be an HTTPS URL from the identity provider. An absent `suspended_at` means the user is active; a timestamp blocks browser sessions and personal access tokens at authentication time.

**Why this shape — store the id, refresh the directory.** The foreign keys throughout the store (`author`, `session.user_id`, `snapshot.actor`, `project.owner`/`members`) keep storing the **stable id only**, never a name/email copy. A copy denormalized at write time would go stale when a user later changes their display name or email; instead the directory is **refreshed on every authenticated request**, so resolution always reflects the latest known identity. Reads resolve ids → identities in one batch lookup (`GET /api/v1/users?ids=…`, §13) rather than touching the snapshot.

**Mutability & write semantics.** An identity object is mutable and owned by `IdentityService`. Profile and suspension updates use ETag compare-and-swap with retries. A profile refresh applies the latest IdP fields while preserving `suspended_at`, including when it races a suspension update on another replica. This record is independent of the `catalog.json` snapshot chain and never touches it. The key is the URL-encoded user id, so non-subdomain-safe `sub` values (e.g. `auth0|abc`) remain addressable.

**Suspension cache.** Authentication reads status by the requested user key; it never scans the directory. Each process caches active results as fresh for 10 seconds, serves them stale while revalidating until a hard age of 30 seconds, then blocks for storage and fails closed if status cannot be verified. Suspended results are fresh for five minutes and remain denied while stale revalidation runs. Cache loads are single-flighted and bounded to 10,000 least-recently-used entries per process.

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

### 4.11.1 CLI authorization records

A loopback grant binds the user, PAT lifetime, and PKCE challenge to a one-time
`mhub_cli_…` code. A device grant starts without a user. It has an eight-letter,
base-20 user code. The create-if-absent user-code claim provides an exact lookup.
Browser approval uses CAS to add the user and PAT lifetime. Grants expire after
ten minutes.

The CLI receives the authorization secret. Storage contains only its SHA-256
hash. Device polling must also supply the PKCE verifier before it reveals the
grant status. User codes are case-insensitive. Each process limits approval
attempts to five per user and limits polling separately.

`CliAuthorizationService` is the only writer. Exchange uses CAS to change the
grant from `pending` to `claimed` before it creates the PAT. This step prevents
replay and concurrent token creation. Exchange deletes the grant and user-code
claim. Creating a loopback grant prunes at most 100 expired authorization records.
Creating a device grant prunes the same records and at most 100 expired user-code
claims. Device approval, exchange, and polling do not prune records.

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

**Mutability and write semantics.** Version records are immutable and use
create-if-absent writes. A concurrent writer that loses a version number uses
the next number. Every head update uses ETag CAS through `mutateObject`.
`ProjectIntegrationsStore` is the only writer for a project head.

Two concurrent configuration edits both create history records. The head points
to the larger committed version number. Session records pin each rendered
integration as `{ id, name, kind, version }`. This pin identifies the exact
configuration while the integration exists.

The head and its configuration form one concurrency unit. There is no separate
mutable object for an individual secret field. API clients update the complete
integration with the head ETag.

Replacing an inline secret writes new ciphertext into a new immutable version.
It does not overwrite ciphertext in an older version. Old ciphertext remains
until deletion removes the entire integration history. This is an explicit
retention tradeoff of versioned integration storage.

Deletion removes the head first. A concurrent head update then fails its CAS
and removes the version that it appended. The delete operation then removes the
remaining integration objects. Session pins and `integration.*` events retain
the audit identity, but they do not retain deleted secret configuration.

Secret fields contain managed ciphertext envelopes or external reference
markers. A reference marker contains only its backend and locator. The resolver
fetches its value during a supported connection test or session rendering. A
save validates the reference shape and configured backend without fetching the
value.

The managed encryption context includes the head path and field path. As a
result, a copied envelope cannot decrypt at a different path. A copy decrypts
and encrypts each managed value for its destination. It keeps reference markers
unchanged. The store rejects secret boxes outside registered secret fields.

**The name claim** (`_names/{name}.json`, name URI-encoded) anchors "one instance per name" the same way the app claim anchors "one app per notebook": `{ integration_id, claimed_at }`, acquired via `acquireSingletonClaim` (create-if-absent, ETag-CAS replace when stale) and released by CAS-ing `integration_id` to the free marker `null`, never a bare delete. Writers put the **head first, then claim** — a holder is _live_ iff its head still exists under that name, so the claim self-heals after a crash between the two writes, and two concurrent creates are arbitrated by the claim key: the loser deletes its own just-written objects. A rename claims the new name (reverting the head on conflict, so a combined rename+config PATCH that loses commits nothing) and then frees the old; delete frees the name last. Sole writer: `ProjectIntegrationsStore`. `_names/` cannot collide with an instance directory (ids are always `intg-…`), and listings skip it.

**The organization tier** stores the same head, version, and name-claim records
under `_system/integrations/`. `OrgIntegrationsStore` is the only writer, and
the API limits its management routes to super admins. Organization heads do not
contain `project_id`. Identity validation rejects a record loaded through the
wrong tier.

Organization managed values use an HKDF context from the `_system/` head path.
As a result, an envelope from one tier cannot be decrypted in the other tier.

For a new non-ephemeral session, the project store combines both tiers. It uses
an enabled organization integration unless the project has an integration with
the same name. The project integration takes precedence even when it is
disabled, which supports both overrides and opt-outs. Name claims are unique
only within one tier, so both tiers can contain an integration named
`warehouse`.

---

## 5. ID Scheme

Resource IDs (`proj-`, `nb-`, `snap-`, `sess-`) are a short prefix plus a 16-character lowercase base32 random body — **subdomain-safe and unguessable, but NOT time-sortable** (see `packages/core/src/ids.ts` / `schema.ts`). Only **version** IDs (`ver_`) remain uppercase ULIDs, because their lexicographic order is load-bearing for version pruning (keep the most recent N). The examples below are illustrative; the regex in `schema.ts` is authoritative.

> **Do not infer recency from snapshot key order.** Because snapshot IDs are random, listing `_system/snapshots/` does **not** return entries in creation order. The current snapshot is always the one named by `catalog.json` — never the "last" key. Where chronological order is needed (retention, recovery), use each object's storage timestamp (`uploaded` / `LastModified`) or the snapshot's `created_at` field, not the ID.

> **The current snapshot is always the one named by `catalog.json`.** An interrupted write can momentarily create a snapshot it never commits (the writer deletes it on conflict — see §7.3 / §11). `catalog.json` is the single source of truth for "current."

| ID Format     | Usage                                                              |
| ------------- | ------------------------------------------------------------------ |
| `proj-{rand}` | Project — random 16-char body, for example `proj-7h2k9qm4xz7rp3w8` |
| `nb-{rand}`   | Notebook — for example `nb-5g43rv2s9pfw8w4d`                       |
| `snap-{rand}` | Snapshot — random, **not** time-sortable, for example `snap-…`     |
| `ver_{ulid}`  | Notebook version — uppercase ULID, time-sortable on purpose        |
| `sess-{rand}` | Session — for example `sess-…`                                     |
| opaque string | User/actor — the authentication provider supplies this value       |
| `intg-{rand}` | Integration — random 16-character body                             |
| `sb-{rand}`   | Sandbox — random 16-character body                                 |

---

## 6. Source Types

A notebook's `source.json` declares where its code lives. The service reads
`source.type` and selects the correct load path. The snapshot index,
`meta.json`, versioning, and session model do not depend on the source type.

| `source.type` | Code location               | Write path                                      |
| ------------- | --------------------------- | ----------------------------------------------- |
| `local`       | Notebook-level `workspace/` | The API and session teardown save the workspace |
| `git`         | `versions/{vid}/workspace/` | An external workflow pushes a complete revision |

Both source types keep files in the bucket. A `git` source has
`provider: "github"` and `sync_mode: "push"`. Its `current_version_id` selects
the active immutable workspace. The hub does not pull from the repository host.
See §4.6 and the [sync guide](../docs/syncing.md).

---

## 7. CRUD Operations

### 7.1 Read: List All Projects & Notebooks

Exactly **2 bucket GETs** regardless of scale.

```
GET _system/catalog.json
  → { current_snapshot_key: '_system/snapshots/snap-7h2k9qm4xz7rp3w8.json' }

GET _system/snapshots/snap-7h2k9qm4xz7rp3w8.json
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
if source.type === "git" and source.current_version_id === null:
  return NOT_FOUND (the synced notebook has not been synced)
if source.type === "git":
  GET projects/{pid}/notebooks/{nid}/versions/{source.current_version_id}/workspace/{source.entry_notebook}
```

For a `git` source, `source.entry_notebook` is the validated notebook path from
`source.json`, relative to `source.root_path`. A successful push confirms that
this path exists in the immutable workspace before it updates
`source.current_version_id`.

### 7.3 Write: Create or Update a Local Notebook

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

A Git sync uses a different content write. It stores the fetched or uploaded
tree under a new `versions/{vid}/workspace/` prefix. Pull mode also stores Git
metadata under `versions/{vid}/git/`. The sync then advances
`source.current_version_id` with ETag CAS. See §4.6.

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

| Route                                                           | Description                                      |
| --------------------------------------------------------------- | ------------------------------------------------ |
| `GET /projects/{pid}/sessions`                                  | List active project sessions with pagination     |
| `POST /projects/{pid}/notebooks/{nid}/sessions`                 | Create or reuse a notebook session               |
| `GET /projects/{pid}/notebooks/{nid}/sessions/{sid}`            | Get one session                                  |
| `POST /projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat` | Update the session heartbeat                     |
| `DELETE /projects/{pid}/notebooks/{nid}/sessions/{sid}`         | Save if permitted, destroy, and retire a session |
| `GET /projects/{pid}/notebooks/{nid}/editor-session`            | Inspect persistent editor ownership              |
| `POST /projects/{pid}/notebooks/{nid}/editor-session/takeover`  | Take over an exclusive persistent editor         |

### TTL cleanup & reaping

A scheduled job (cron, every 5 minutes) performs two passes over `_system/sessions/`:

1. **Expire** — any session whose `last_heartbeat` is older than 5 minutes is flipped to `expired`.
2. **Reap** — any `terminated`, `failed`, or `expired` record whose `last_heartbeat` is older than 24 hours is deleted.

The reap pass prevents unbounded growth under `_system/sessions/`. The same
maintenance cycle also reconciles provider sandboxes and applies retention to
snapshots, events, idempotency records, and soft-deleted content.

### Heartbeat write volume

Persisting every heartbeat is the dominant session write cost: at 50 concurrent sessions on a 30s interval that is ~50 × 2 × 60 × 24 ≈ **144,000 PUTs/day**, each a read-modify-write on a small object. Two levers bound it, in order of preference:

- **Don't persist routine heartbeats to the bucket.** Liveness belongs in the live kernel runtime; the bucket record only needs to change on create, status transition (`starting`→`running`), and terminate. The expiry sweep can then read liveness from the runtime rather than from `last_heartbeat`. This drops heartbeat writes to ~0.
- **If heartbeats must be persisted, widen the interval** (e.g. 60s) and/or coalesce — the 5-minute expiry TTL tolerates a coarser cadence.

v1 takes the second lever: heartbeat persistence is **coalesced to at most once per 60s** per session (`SessionService.heartbeat` skips the write when the session is already `running` and its stored heartbeat is younger than the interval). This bounds writes to ~1/min/session regardless of client cadence — roughly halving the figure above at a 30s cadence — and stays well within the 5-minute expiry TTL. Moving liveness off the bucket entirely (the first lever) remains a future option.

### Versioning and snapshots on teardown

This write-back path applies to persistent sessions on local notebooks. A user
edits the live workspace. The sandbox can mount that workspace or copy it back
during teardown. Neither path creates an immutable version during the session.

Teardown creates a version from the final local workspace. It can attach the
optional `__marimo__/notebook.html` and
`__marimo__/session/{notebook}.py.json` artifacts to that version.

Git-synced sessions are ephemeral. They load a copy of the selected immutable
workspace and discard all session changes. They do not create teardown
versions or snapshots.

On teardown, **before destroying the sandbox**, the service:

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

> **Prerequisite (satisfied):** every independently migrated object carries a
> `schema_version` field. `catalog.json` uses its `version` field.

### Migration types

| Target                                       | Strategy                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot structure                           | Lazy — the service upgrades the current snapshot in memory before it writes the next snapshot. Old snapshots remain as-is.                                                                                                                                                        |
| `meta.json` / `project.json` / `source.json` | Fan-out migration job — reads all affected objects, rewrites with the new schema, emits `migration.run`. Iterate with pagination and process in chunks so the job stays within the runtime's per-invocation request/time limits (resume via list cursor; idempotent — see below). |
| `_system/events/**`                          | Never migrated — event records are immutable history. New event shapes get a bumped `schema_version` field. Consumers must handle multiple versions.                                                                                                                              |
| `catalog.json`                               | Migrated in place during the first write after a deployment that changes the catalog version. Its strict `version` value is not forward-tolerant.                                                                                                                                 |

> **No `schema_version` by design:** mutable operational records — sessions (`_system/sessions/**`), identities (`_system/identities/**`), tokens (`_system/tokens/**`), CLI authorizations (`_system/cli-authorizations/**`), and `fs_snapshot.json` — carry no `schema_version`. They are rewritten on every write or reaped shortly after creation, so they never need a migration; a shape change is absorbed with optional fields + defaults on read. API response bodies are likewise unversioned per-object — the contract is versioned at the route level (`/api/v1`).

### Migration job pseudocode

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

> **Fan-out safety:** Each migration checks `schema_version` before it writes.
> You can safely run an interrupted migration again. Run migrations during a
> low-traffic period and verify completion in the event log.

---

## 10. Audit Events and Application Logs

The bucket contains structured audit events. Application logs go to the
configured process or platform log destination. The bucket has no
`_system/logs/` tree.

| Path                                          | Purpose                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `_system/events/{YYYY-MM-DD}/{event-id}.json` | Structured audit event. Each event is an immutable object under a UTC-day prefix.                |
| `_system/snapshots/`                          | Immutable catalog history. The maintenance job applies the configured snapshot-retention policy. |

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

Authentication identifies the caller. Authorization controls their actions.
The API resolves identity before it reaches storage.

### Authentication (AuthN)

Identity is resolved per request and controlled by the `AUTH_MODE` setting:

| `AUTH_MODE` | Use case                 | Mechanism                                                                        | Identity                                  |
| ----------- | ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `access`    | Multi-user               | Cloudflare Access JWT (`CF-Access-JWT-Assertion`) verified against the team JWKS | `{ id: sub, email }` from verified claims |
| `none`      | Single-user, self-hosted | None — a fixed singleton user from config                                        | `{ id: USER_ID, email: USER_EMAIL }`      |

A request that fails authentication receives `401 UNAUTHORIZED`. The verified user is attached to the request context and used as the `actor` recorded in snapshots and events.

### Authorization (AuthZ) — single-tenant / trusted-org, with opt-in read isolation

**Reads are gated at `viewer`; writes are gated by the role matrix.** The deployment-wide `MARIMOHUB_DEFAULT_ROLE` is the fallback role for a logged-in caller who is neither the `owner` (implicitly `admin`) nor an explicit member:

- With it **set** (`manager`/`editor`/`viewer` — the default is `editor`), every authenticated user is at least a viewer, so reads stay open and "list everything" stays 2 GETs (§7.1) — there is no per-caller filtering to do.
- With it **`none`**, non-members have no role: reads are membership-gated. A non-member cannot see a project at all — `GET` returns **`404`** (existence is not leaked) and the project is omitted from the list.

**Writes** are always checked against the target project. The service loads
`project.json`, resolves the caller's effective role, and rejects an
insufficient role with `403 FORBIDDEN`.

**Super admins.** `MARIMOHUB_SUPER_ADMINS` grants `admin` on every project. This status overrides membership and `MARIMOHUB_DEFAULT_ROLE`. A super admin can list all projects, including deployments configured with `none`. The operator can also manage notebooks, secrets, sessions, and the audit trail.

An entry that contains `@` matches the login email without case sensitivity. Other entries match the user ID (`sub`) exactly. The ID and email namespaces do not overlap. See `isSuperAdmin` in `packages/core/src/authz.ts`.

All routes use the same `effectiveRole` calculation. Project owners still cannot be demoted or removed. Soft-deleted projects still return `404`. Static super-admin status applies to PATs. OIDC group-derived status applies only to the browser session and does not transfer to PATs.

Read-side isolation under `none` keeps the read model intact (§7.1). Filtering `GET /projects` would otherwise cost a membership check per project, so each catalog snapshot project entry carries a denormalized **`member_ids`** array (owner + members), refreshed in the same CAS as every membership edit. The list filters in-memory over data already fetched — still 2 GETs. Single-project reads (`GET /projects/{id}`, notebook & session reads) load `project.json` and check `viewer` only when `defaultRole` is `none`; with a default role set they short-circuit with no extra load.

### Role → permission matrix

The read row is open to any authenticated user when a default role is set; under `MARIMOHUB_DEFAULT_ROLE=none` it is restricted to the owner and explicit members (non-members get `404`) — plus any super admin, who is `admin` on every project regardless.

| Capability                                                                                 | `viewer` | `editor` | `manager` | `admin` |
| ------------------------------------------------------------------------------------------ | :------: | :------: | :-------: | :-----: |
| See & read projects & notebooks; read versions; open & read notebook code                  |    ✓     |    ✓     |     ✓     |    ✓    |
| View a notebook's outputs (HTML snapshot / ephemeral session, per `MARIMOHUB_VIEWER_MODE`) |    ✓     |    ✓     |     ✓     |    ✓    |
| Create/update/delete notebooks; save versions; create sessions (run)                       |          |    ✓     |     ✓     |    ✓    |
| Update/delete projects; manage members                                                     |          |          |     ✓     |    ✓    |

Notebook changes and session creation require **editor** or higher. Project
changes require **manager** or higher. Reads require **viewer** unless the deployment gives
authenticated users a default role. Any authenticated user can create a
project. Its creator becomes the owner and has the reserved admin role. The API enforces
these rules. The client does not enforce them.

`manager`, `editor`, and `viewer` are assignable through the membership API.
Existing non-owner `admin` rows remain valid but new ones cannot be created.
Because old replicas cannot parse `manager`, deployments must stop all old
replicas before allowing the new role to be assigned. Rolling back afterward
requires converting every manager row to a role understood by the old version.

> Session `heartbeat`/`terminate` also require **editor+** (they keep a kernel alive / tear it down). Hard-delete (the deferred GC pass, §7.4) remains the outstanding authorization work; per-notebook ACLs and per-user index objects are out of scope (they would break the 2-GET read model — see `rfc.md` §8).

**What a viewer sees** is set deployment-wide by `MARIMOHUB_VIEWER_MODE`. `static` (the default) serves the newest version's `notebook.html` snapshot via `GET …/notebooks/{nid}/html` — read-only, no compute, gated like any read. `ephemeral-sandbox` admits viewers to session create/heartbeat/terminate (and the kernel proxy) **for their own sessions only**; such sessions are stamped `ephemeral: true` and every teardown path (explicit stop, idle/lifetime reaper, periodic snapshotter, reconciliation) skips the write-back — no version, HTML/session snapshot, workspace mirror, or FS snapshot is ever cut from a viewer's sandbox, and WIF credentials are never injected into one.

---

## 13. API Layer

The API is an authenticated boundary between the frontend and the `Bucket`
port. It runs in the Node and Cloudflare Worker entrypoints. It owns auth,
resource IDs, source handling, snapshots, sessions, and audit events.

Clients address notebooks by `{project_id, notebook_id}`. They never receive
storage credentials, raw bucket access, or the stored `key_prefix`.

### The OpenAPI document is the contract

Routes are defined with `@hono/zod-openapi`: each declares typed request and response schemas, and the live spec is served at **`GET /api/v1/doc`** (OpenAPI 3.1). That generated document — not a hand-maintained table — is the source of truth for paths, parameters, request bodies, and response shapes. All routes are mounted under `/api/v1`, in these groups:

- **Auth** — current user and personal access token management
- **Users** — identity resolution and directory search
- **Projects** — project, member, and audit-event management
- **Audit** — the super-admin deployment audit stream
- **Notebooks** — local and Git-synced notebooks, content, versions, restore,
  duplicate, HTML snapshots, and sync-token rotation
- **Sessions** — list, create, inspect, heartbeat, stop, editor ownership, and
  exclusive takeover
- **Integrations** — kinds, project and organization instances, versions, copy,
  and connectivity tests
- **System** — deployment version and capability limits

### Error & response model

JSON responses use one envelope. Success:

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
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Notebook nb-… not found" } }
```

The HTML snapshot route returns raw `text/html` on success. Its errors use the
JSON envelope.

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

- **Versioning** — `/api/v1` and the OpenAPI `info.version` identify the current contract. Put a breaking contract under a new route version.
- **Pagination** — project, notebook, notebook-version, project-session, integration-instance, and integration-version lists use opaque keyset cursors. Bounded lists, such as project members and API tokens, return arrays. The OpenAPI response schema is authoritative for each route.
- **Idempotency** — reads, `PUT`/`PATCH`, and soft-`DELETE` are naturally idempotent. `POST` creates are **not** by default: a retry after a network failure or a `409 CONFLICT` can create a duplicate. Clients that care send an `Idempotency-Key` header on `POST /projects` and `POST …/notebooks` — the server stores `key → result` under `_system/idempotency/` and replays it on retry (24h TTL). `POST …/sessions` is already idempotent on `(user, notebook)` via its reuse path. See [`idempotency.md`](./idempotency.md).

### Catalog mutation

All catalog changes use `CatalogService.mutateSnapshot`. It reads the catalog
and current snapshot, applies one mutation, and writes a new immutable snapshot.
It then updates `catalog.json` with an ETag conditional write. If another writer
wins, it removes its uncommitted snapshot and retries against the new catalog.
Only the successful writer appends the mutation event.

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

| Topic                             | Detail                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object-store versioning           | Enable native object versioning and lifecycle expiry as a backup below the snapshot layer. This can recover overwritten latest-only files and out-of-band deletions. See [`operations.md`](./operations.md) §1.                                                                                         |
| Notebook ordering                 | Notebook lists use `created_at` and the random notebook ID as a stable tiebreaker. Manual ordering needs a new explicit field.                                                                                                                                                                          |
| Additional source types           | `local` and push-synced `git` are implemented (§4.6). A future source type must define its write, sync, cache, and credential rules.                                                                                                                                                                    |
| Read-side tenant isolation        | Project-level isolation is implemented (§12). `MARIMOHUB_DEFAULT_ROLE=none` filters snapshot entries by `member_ids`, so the read still uses two GETs. Per-notebook ACLs and storage-enforced isolation for untrusted tenants remain open.                                                              |
| Execution logs locality           | Run logs currently go to `_system/events/`. Alternative: `projects/{pid}/notebooks/{nid}/runs/{run-id}.log` for per-notebook locality. Tradeoff is discoverability vs. centralization.                                                                                                                  |
| Live state for real-time sessions | If kernel output streaming or sub-second variable inspection is needed, live session state belongs in a low-latency store (in-memory cache / stateful coordinator) co-located with the kernel runtime. Object storage retains the durable audit record.                                                 |
| Version pruning                   | **Resolved.** `NotebookService.pruneVersions` keeps the most recent `MAX_VERSIONS` (50) per notebook, pruning on each save (`packages/core/src/services/content/NotebookService.ts`). Snapshot and event growth are handled separately by `MaintenanceService` ([`operations.md`](./operations.md) §5). |
| Configurable version count        | A variable such as `MARIMOHUB_NOTEBOOK_MAX_VERSIONS` can let operators trade history depth for storage. The same count can bound the optional HTML and session snapshots (§8).                                                                                                                          |
| HTML / session snapshots          | Session teardown can capture both files (§8). `GET …/notebooks/{nid}/html` serves the newest HTML snapshot. The session-state JSON has no read route. API saves do not generate HTML because they have no live kernel.                                                                                  |
