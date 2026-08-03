# RFC: marimohub — A Self-Hostable Platform for marimo Notebooks

|             |             |
| ----------- | ----------- |
| **Author**  | marimo-team |
| **Created** | 2026-06-17  |

---

## 1. Summary

marimohub is a self-hostable platform for storing, organizing, and running [marimo](https://marimo.io) notebooks. It is built as a small set of modular components connected by stable TypeScript interfaces (**ports**), with concrete technologies plugging in behind them (**adapters**). It has **no separate database** — an S3-compatible object store is the single source of truth (and therefore the one stateful tier to back up and operate, §5.6) — and it **deploys anywhere** (a single Docker container, Cloudflare Workers, or Kubernetes) by changing only the entrypoint and the loaded adapters.

The v1 trust model is **single-tenant, trusted users**: one team sharing one deployment. That assumption is load-bearing — it lets v1 skip read-side tenant isolation, cross-user content sandboxing, and several hardening concerns that a multi-tenant or untrusted-user product would require (see §4 and §9).

This RFC proposes shipping that v1 and lays out the rationale, the rejected alternatives, the accepted risks, and the companion modules that were deliberately split out of the initial scope (**AI**, **secrets**, and **workload identity federation**, §10).

---

## 2. Motivation

### 2.1 The problem

marimo notebooks are reactive Python programs stored as plain `.py` files. A single user is well served by local files plus git. A **team** is not: they need a shared place to store notebooks, browse and organize them, see history, and — critically — **run** them on managed compute without every member standing up their own environment. All without handing their code and data to a third party, or operating heavyweight infrastructure.

### 2.2 What marimohub is for

A **self-hostable, low-ops, marimo-native hub** that a team runs on **its own storage and compute**, deploys in **whatever shape its infrastructure prefers**, and operates with **nothing to provision beyond a bucket**.

marimohub is meant to be used by enterprises, classrooms, and small data science teams.

---

## 3. Goals and Non-Goals

### 3.1 Goals

1. **Provider-agnostic core.** No domain or API code imports a vendor SDK. Every external dependency (storage, compute, identity) sits behind a port.
2. **No _separate_ database.** All durable state lives in the object store — no second stateful tier (RDBMS/KV) to provision or migrate. The bucket _is_ the database (rationale in §6.2; operability in §5.6).
3. **Bring your own storage and compute.** Operators plug in their own object store and kernel runtime; marimohub provides the ports and reference adapters.
4. **Deploy anywhere.** The same core runs on a single Docker host, Cloudflare Workers, or a Kubernetes cluster — entrypoint and adapters change, domain logic does not.
5. **The API is the contract.** A versioned OpenAPI 3.1 document is the single boundary between any client and the backend, and it cannot drift from the implementation.
6. **Config for the common case, library for the complex case.** A standard deployment is pure environment configuration; bespoke needs drop down to importing the packages and wiring adapters in code.

### 3.2 Non-Goals (v1)

1. **Multi-tenant / untrusted users.** v1 serves one trusted team. Untrusted, internet-facing multi-tenancy is out of scope (see §4, §9).
2. **Read-side tenant isolation is opt-in.** By default every authenticated user can _see_ the whole catalog; writes are role-gated. Setting `MARIMOHUB_DEFAULT_ROLE=none` turns on per-caller catalog filtering (a non-member cannot see a project), implemented via a denormalized `member_ids` on each snapshot entry so the read model stays 2 GETs ([`bucket_spec.md` §12, §15](./bucket_spec.md)). Fine-grained multi-tenancy (per-notebook ACLs, per-user indexes) remains out of scope.
3. **A query layer.** No "find notebooks by tag/author across projects" beyond what a single snapshot read supports. No DB means no ad-hoc queries by design.
4. **Realtime multi-user editing of a notebook.** Collaborative editing remains the kernel/marimo runtime's concern. The hub coordinates one persistent sandbox per notebook through a CAS claim. It supports shared or exclusive ownership but does not implement document synchronization.
5. **Managed secrets and AI governance.** Not core concerns; handled by dedicated modules (§10).
6. **Defending against malicious insiders or cross-user XSS.** Out of scope under the trusted-user assumption (§4, §8).

---

## 4. Assumptions and Operating Context

These assumptions found the design; if any changes, large parts of this RFC must be revisited. Each recurs in the trade-offs (§7) and security (§8) sections.

1. **Single-tenant, trusted users.** One deployment serves one team whose members trust each other. **Consequence:** v1 does not iframe/sandbox user-generated notebook content against cross-user XSS, and does not isolate the catalog per-caller. This is a deliberate scope cut: the main source of v1 simplicity, and the first thing to revisit before serving untrusted users.
2. **No database is a feature, not a limitation.** Trading a more careful write path (CAS on one catalog pointer) for exactly one stateful tier to operate is deliberate — "low-ops" means one stateful tier (the bucket), not zero. Rationale in §6.2; backup/recovery in §5.6.
3. **Operators want to bring their own storage and compute.** The product's job is to provide clean ports and good reference adapters, not to be opinionated about which object store or kernel runtime a team uses.
4. **Deployment must be versatile.** Teams run on a single Docker host, on Cloudflare, or on Kubernetes. No single-platform assumption may leak into the core.
5. **TypeScript/JavaScript is the implementation language.** Chosen because it is fast to build with, has the largest relevant ecosystem, gives one language across frontend and backend (shared types, one toolchain), and — because JS needs no compilation step — keeps the door open to **loading custom modules at runtime** for bespoke extension work (see §6.1). The Python that actually runs notebooks lives in the _kernel sandbox_, behind the Compute port — not in the control plane.

---

## 5. Proposed Design (Overview)

Summary; the authoritative detail is in [`architecture.md`](./architecture.md) (components, ports, deployment shapes) and [`bucket_spec.md`](./bucket_spec.md) (storage schema and protocols).

### 5.1 Shape: ports and adapters

```
        Frontend (React SPA)
               │  HTTP — OpenAPI 3.1
               ▼
      ┌─────────────────────────────────────────────┐
      │           API layer (OpenAPI 3.1)           │
      │  AuthN → AuthZ → Domain services (no SDKs)  │
      └───────┬───────────────┬──────────────┬──────┘
              │               │              │
        Authenticator    Authorizer      Domain core
         (AuthN port)   (roles in store)  (services)
              │                              │
              ▼                              ▼
        ┌───────────┐                 ┌──────────────┐
        │  Bucket   │                 │   Sandbox    │
        │  (port)   │                 │   (port)     │
        ├───────────┤                 ├──────────────┤
        │ CAIOS /   │                 │ CoreWeave /  │
        │ S3 / R2   │                 │ Modal        │
        └───────────┘                 └──────────────┘
```

Four ports define every external dependency. Each is a TypeScript interface in `@marimo-hub/core`; each adapter is its own package; the core and API import none of them:

| Port        | Interface (abridged)                                                                                         | Adapters                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Storage** | `Bucket` — `get/head/put/delete/list`, conditional `put` (CAS on ETag)                                       | S3-compatible (AWS S3, CoreWeave CAIOS, MinIO) · Cloudflare R2 (binding) · `memory` (tests) |
| **Compute** | `SandboxProvider.create(id)` → `SandboxInstance`; `proxy(request)`; optional `listActive()` (reconciliation) | CoreWeave · Modal · Cloudflare Containers (DO) · `none` (browse-only)                       |
| **AuthN**   | `Authenticator.authenticate(request)` → `AuthUser \| null`                                                   | OIDC · Cloudflare Access · `dev` bypass                                                     |
| **AuthZ**   | `Authorizer.can(user, action, resource)` — reads roles from `Bucket`                                         | roles in storage (no extra tech)                                                            |

### 5.2 No database: object store as the single source of truth

All durable state — notebook code, metadata, project membership, versions, sessions, audit events — lives in the object store under an **Iceberg-inspired** schema: a single mutable pointer (`_system/catalog.json`) names an immutable snapshot that holds the full project/notebook index. Writes clone the snapshot, write a new immutable one, and **atomically swap the pointer with a conditional PUT (`If-Match` on ETag)**, retrying on conflict. Listing everything is **2 GETs** regardless of scale; the audit log is append-only immutable objects.

The one hard requirement this places on any storage adapter is **strong read-after-write consistency plus _atomic_ conditional writes** — the catalog compare-and-swap (and create-if-absent init) depend on it. We **bless a small set of backends because they provide this**: **AWS S3, Cloudflare R2, CoreWeave CAIOS, and MinIO** — each supports conditional writes (`If-Match` / `If-None-Match`) with strong read-after-write consistency. These are what the config path selects and the deployment shapes (§5.5) target.

A boot self-check refuses to start on a store that doesn't honor conditional writes, so a misconfigured or unsuitable store fails fast instead of corrupting the catalog later. Other S3-compatible stores can be used at the operator's discretion — see §11.3. The non-durable in-memory backend is dev/test-only (gated behind `MARIMOHUB_ALLOW_EPHEMERAL_STORAGE`). Full protocol in [`bucket_spec.md` §2–§7](./bucket_spec.md).

### 5.3 API as contract

The contract is a versioned **OpenAPI 3.1 document** (served at `/api/v1/doc`), generated from the route definitions rather than hand-maintained, so it cannot drift from the code. Its biggest payoff is **client generation** — typed clients for the frontend, server-to-server callers, and a CLI all come from the one document. Every response uses one envelope (`{ success, data }` / `{ success, error: { code, message } }`). Clients address notebooks by opaque, subdomain-safe `{project_id, notebook_id}` IDs (random 16-char bodies — _not_ time-sortable; only version IDs are ULIDs) and never see storage paths or credentials.

The full surface — all paths under `/api`, authenticated except `/health`, with `…` = `/projects/{pid}/notebooks`:

| Methods              | Path                                           | Purpose                                        |
| -------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `GET`                | `/me` · `/health` · `/doc`                     | current user · liveness (public) · OpenAPI doc |
| `GET` `POST`         | `/projects`                                    | list · create                                  |
| `GET` `PUT` `DELETE` | `/projects/{pid}`                              | get · update · delete a project                |
| `GET` `POST`         | `…`                                            | list · create notebooks                        |
| `GET` `PUT` `DELETE` | `…/{nid}`                                      | get · update · soft-delete                     |
| `GET`                | `…/{nid}/content` · `…/{nid}/versions[/{vid}]` | resolved code · version history                |
| `POST` `DELETE`      | `…/{nid}/sessions[/{sid}[/heartbeat]]`         | provision · terminate · heartbeat a kernel     |
| `POST` `DELETE`      | `/sandbox[/{id}[/exec]]`                       | low-level kernel provision / exec              |

### 5.4 Compute / sessions

A "session" is a live marimo kernel. The provider-agnostic `SandboxProvisioner` creates a sandbox, makes notebook files available (mount the bucket, or fall back to copying files in), starts `marimo edit` on port 2718, waits for the port, and exposes a URL; teardown reverses it. Session _records_ live in the object store; sub-second kernel state stays in the runtime. Because provisioning a sandbox (billable compute) and writing its record are two non-atomic writes, a periodic **reconciliation** sweep cross-checks the provider's live sandboxes (via the Compute port's `listActive()`) against records — reclaiming leaked sandboxes and marking sessions whose sandbox has vanished as terminated. See [`architecture.md` §3.2](./architecture.md) and [`bucket_spec.md` §8](./bucket_spec.md).

### 5.5 Deployment shapes

|            | Kubernetes                       | Docker (single host) | Cloudflare                            |
| ---------- | -------------------------------- | -------------------- | ------------------------------------- |
| Entrypoint | Node container on k8s            | Node (`apps/server`) | Worker (`examples/cloudflare-worker`) |
| Storage    | S3-compatible (S3, CAIOS, MinIO) | S3 / MinIO           | R2 binding                            |
| Compute    | CoreWeave / Modal                | Modal / Docker       | Containers (DO)                       |
| AuthN      | OIDC                             | OIDC / dev           | Cloudflare Access                     |
| Scaling    | horizontal (k8s)                 | single host          | automatic (edge)                      |

The API tier is stateless — all state is in the storage and compute layers — so the Kubernetes and Docker shapes scale by running more replicas. The maintenance sweep (§5.6) must be a singleton: it runs on a dedicated `replicas: 1` `marimohub-maintenance` Deployment (the API replicas set `MARIMOHUB_RUN_MAINTENANCE=false`); on Cloudflare it is the platform's `scheduled()` trigger. Any Kubernetes distribution runs the same Node entrypoint.

### 5.6 Operability (the bucket is the database)

Because the object store is the only stateful tier, it carries a real operational story — detailed in [`operations.md`](./operations.md):

- **Backup & DR.** The bucket must be backed up. The position is native object versioning + lifecycle expiry as the safety net beneath the snapshot layer, plus optional cross-region replication. Point-in-time restore is referential: the `catalog.json` pointer **plus** the snapshot it names **plus** the content objects that snapshot references.
- **Corruption recovery.** A stated invariant — _a writer only ever deletes a snapshot it itself wrote and never committed_ (the CAS loser's orphan, never a committed snapshot; retention never deletes current/previous) — makes a dangling pointer a mechanical rollback (to `previous_snapshot_id`, or the newest surviving snapshot by `created_at`) rather than data loss.
- **Retention.** Every commit writes a snapshot and every mutation an event, so both need expiry (the Iceberg "snapshot-expiry" problem). `MaintenanceService` prunes snapshots (90-day window, keep-last floor, never current/previous) and event-day folders; notebook versions and session records are already pruned.
- **Single-writer guarantee.** The singleton Deployment is backed up by a bucket-CAS advisory lease (built on the same `If-Match`/`If-None-Match` primitive — no etcd), so two reapers can never race on deletes.
- **Rolling-upgrade compatibility.** Old and new replicas coexist during a deploy. New code reads old (forward-tolerant `schema_version` + lazy upgrade); old code tolerates new (`SnapshotSchema` preserves unknown fields, `mutateSnapshot` never downgrades the version). Policy: additive-only within a version; a breaking change is a two-phase deploy ([`migrations.md`](./migrations.md)).
- **Observability.** A `Metrics` port (no-op default) emits CAS attempt/conflict /exhausted, live-session count, snapshot count/size, and reaper activity as one "wide event" per maintenance cycle; a Prometheus adapter is a drop-in.

---

## 6. Design Rationale and Alternatives Considered

Each subsection states a decision, the alternatives, and why the alternatives lose _given our assumptions_ (§4).

### 6.1 Language: TypeScript over Python / Go / Rust

**Decision:** Implement the control plane (API, services, adapters, frontend) in TypeScript. Python appears only _inside_ the kernel sandbox, behind the Compute port.

**Why:**

- **Build velocity + ecosystem.** TS has the largest ecosystem for the things the control plane is (HTTP, OpenAPI, edge runtimes, S3 SDKs, React) and is fast to iterate in.
- **One language end-to-end.** Frontend and backend share types and a single toolchain; the OpenAPI client is generated TS. A Python control plane would still leave the frontend in JS — two languages, no shared types.
- **Runtime extension without a build step.** Because JS needs no compilation, custom work — a bespoke adapter, an embedding host, eventually dynamically loaded extensions — can be authored and loaded as plain JS modules without recompiling or redeploying the core. This is what makes the "library-based, complex case" path (§6.6) cheap and keeps a future plugin-loading story open.

**Alternatives rejected:**

- **Python** (the obvious choice, since marimo is Python). Rejected for the control plane: it would not remove a language (the SPA stays JS), it has a weaker edge-deployment story, and it gives up the shared-types win. The Python that matters — running notebooks — is exactly where we _do_ use it, isolated in the sandbox.
- **Go / Rust.** Excellent for single-binary distribution and performance, but a smaller ecosystem for this domain, slower iteration, no shared types with the frontend, and no ability to load user-authored extensions without a recompile.

### 6.2 No database, object store as source of truth

**Decision:** Use an S3-compatible object store as the only persistence layer, with an atomic catalog pointer for consistency.

**Why:** The object store is _already required_ for notebook bytes. Adding a database means a second stateful tier to provision, migrate, back up, secure, and keep available — which directly undercuts the "low-ops, deploy-anywhere, stateless API" goals. The Iceberg-inspired scheme buys consistent reads, safe concurrent writes, and free audit history from the object store alone, and the scale target (1,000 notebooks → ~200KB snapshot) fits comfortably in a 2-GET read.

**Alternatives rejected:**

- **SQLite / Cloudflare D1.** Cheap and simple, but reintroduces a stateful file to host, replicate, and back up; complicates the multi-replica/edge story; and the win (rich queries) is one we don't need at this scale.
- **Postgres / managed RDBMS.** The richest option and the right answer _if_ we needed transactions, joins, and per-tenant queries — but it is precisely the operational weight the product is trying to avoid, and it contradicts the no-DB-as-a-feature assumption.
- **Embedded KV (Workers KV, Redis).** Either eventually consistent (unsafe for the catalog CAS) or another stateful service. The object store's conditional writes give us the one consistency primitive we need without a new dependency.

**What we pay:** a more intricate write path (CAS + retry + orphan cleanup), no ad-hoc queries, and an expensive read-side tenant-isolation story. We accept all three under the scale and trust assumptions (§7).

### 6.3 Ports and adapters over direct vendor SDKs

**Decision:** Every external dependency sits behind a port; adapters are additive and independently swappable.

**Why:** It is the only structure that satisfies "bring your own storage and compute" and "deploy anywhere" simultaneously. Because the core never knows its provider, the same code runs unmodified on a Kubernetes cluster (CAIOS/S3 storage, CoreWeave sandboxes, OIDC), a plain Docker host (S3 + Modal), or Cloudflare (R2 + Containers + Access).

**Alternatives rejected:**

- **Build directly against a provider's SDKs** (e.g. Cloudflare). Fastest to a first deployment, but hard vendor lock-in — un-self-hostable elsewhere, and a direct violation of the BYO-storage/compute assumption.
- **Config-only plugin registry (no code escape hatch).** Clean for the common case but too rigid for the genuinely bespoke (a proprietary store, a custom authorizer, embedding in a larger app). We keep both: config for the common case, library composition for the tail (§6.6).

### 6.4 API: an OpenAPI 3.1 contract over tRPC / GraphQL

**Decision:** A versioned OpenAPI 3.1 REST surface as the single client contract, generated from the route definitions so the document can't drift from the code.

**Why:** A language-agnostic HTTP contract means _any_ client speaks the same documented surface, and typed clients for the **frontend, other servers, and a CLI** generate straight from the spec. One definition yields runtime validation, the published document, and those client types at once, so none of them can drift. REST/OpenAPI is also widely tooled, keeping third-party integration friction low.

**Alternatives rejected:**

- **tRPC.** Excellent TS-to-TS DX, but couples clients to a TS server and offers no language-agnostic contract — at odds with "the API is the contract for _any_ client."
- **GraphQL.** Powerful, but overkill for a small, well-known resource model, and it brings caching/complexity costs we don't need at this scale.
- **Hand-written REST + a separately maintained spec.** Guaranteed drift. The whole point of generating the spec from the code is to make drift impossible.

### 6.5 Authentication: OIDC-only, no password store

**Decision:** Authentication is OAuth/OIDC only; there is no password store. Adapters: generic OIDC (full redirect + signed-session-cookie flow), Cloudflare Access (hosted OIDC gateway), and a `dev` bypass for local use only.

**Why:** Delegating identity to an external IdP removes an entire class of liability (no credential database to secure or breach) and aligns with no-DB. Every modern IdP speaks OIDC.

**Alternatives rejected:**

- **Built-in username/password.** A credential store to secure, plus a direct conflict with the no-DB assumption. Rejected outright.
- **SAML.** Heavier and largely superseded by OIDC for new integrations; can be added as another adapter if an enterprise requires it.

### 6.6 Two ways to run it: config-driven and library-based

**Decision:** Standard deployments are pure `MARIMOHUB_*` environment configuration, resolved by `@marimo-hub/config`, which is the _only_ package that imports concrete adapters. When config isn't enough, operators import the packages and wire adapters — including their own — by hand.

**The common case (config-driven).** A standard deployment is just environment variables on the stock Docker image — no code. `createFromEnv()` reads each `*_BACKEND` selector, builds the matching adapter, and hands the wired `ApiDeps` to `createApi`. One typical shape (S3 storage + Modal compute + OIDC):

```bash
# Storage — S3-compatible object store (the single source of truth)
MARIMOHUB_STORAGE_BACKEND=s3
MARIMOHUB_STORAGE_S3_BUCKET=marimohub
MARIMOHUB_STORAGE_S3_ENDPOINT=https://s3.amazonaws.com
MARIMOHUB_STORAGE_S3_REGION=us-east-1
MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID=AKIA…
MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=…

# Compute — Modal sandboxes for kernels
MARIMOHUB_COMPUTE_BACKEND=modal
MARIMOHUB_COMPUTE_MODAL_TOKEN_ID=ak-…
MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET=as-…
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest

# Auth — delegate identity to an OIDC IdP
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.example.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=marimohub
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET=…
```

```bash
docker run --env-file marimohub.env -p 8080:8080 ghcr.io/marimo-team/marimo-hub:latest
```

Switching providers is a selector change, not a code change: `MARIMOHUB_STORAGE_BACKEND=memory` (dev only, behind `MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true`), `MARIMOHUB_COMPUTE_BACKEND=local|none`, or `MARIMOHUB_AUTH_BACKEND=dev` for local use. The Cloudflare selectors (`r2`, `cloudflare`, `cloudflare-access`) need platform bindings rather than env credentials, so they are wired in `examples/cloudflare-worker` instead.

**The complex case (library-based).** When config isn't enough, operators import the packages and wire adapters — including their own — by hand:

```ts
import { createApi } from '@marimo-hub/api';
import { createServices } from '@marimo-hub/core';
import { S3Storage } from '@marimo-hub/storage-s3';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { MyCustomAuthenticator } from './my-auth'; // anything implementing the port

const bucket = new S3Storage({
	/* ... */
});
const app = createApi({
	services: createServices(bucket),
	bucket,
	compute: new ModalCompute({
		/* ... */
	}),
	authenticator: new MyCustomAuthenticator(),
});
// mount `app` in any host — Node, Workers, …
```

**Why:** The config path keeps the 90% case to "set env vars, run an artifact." The library path covers the long tail (proprietary store, custom `Authorizer`, embedding) without us having to anticipate every need in the config surface — and it's cheap precisely because of the JS-module argument in §6.1.

### 6.7 Packaging: a Docker app configured by environment

**Decision:** The primary packaging is the **Node app as a Docker container, configured by `MARIMOHUB_*` environment variables**. It runs the same on a single Docker host or any Kubernetes cluster; Cloudflare (Workers + R2 + Containers + Access) is an equally supported shape with its own entrypoint. No platform is privileged — the deployment shape is selected by configuration alone (§5.5).

**Why:** Docker + env config is the most portable packaging — it runs anywhere Docker runs and is the config-driven common case (§6.6). Because everything sits behind the ports, the same image re-targets any blessed object store (§5.2) and any supported compute provider by swapping configuration, never by changing code.

---

## 7. Trade-offs and Risks

| #   | Trade-off / Risk                                                                                                                                                                                                                                                                                          | Severity (v1)              | Mitigation / Position                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Conditional-write dependency.** The catalog CAS requires _atomic_ `If-Match`; not all S3-compatible stores support it well, and a non-atomic check-then-set corrupts the catalog only under real contention.                                                                                            | Medium                     | Blessed backends with atomic conditional writes (S3, R2, CAIOS, MinIO); boot self-check refuses a non-compliant store (§5.2). Other S3-compatible stores: §11.3 ([`bucket_spec.md` §1](./bucket_spec.md)).         |
| 2   | **Single global catalog pointer.** All writes serialize on one CAS; high write concurrency → more retries.                                                                                                                                                                                                | Low at target scale        | Fine at 1,000 notebooks / ~20 writes/day. Escape hatch: split into per-project manifests + pagination ([`bucket_spec.md` §11](./bucket_spec.md)).                                                                  |
| 3   | **No read-side tenant isolation.** Every authenticated user sees the whole catalog.                                                                                                                                                                                                                       | Acceptable (trusted users) | Matches §4.1. Hard blocker for untrusted multi-tenancy → tracked in §9 / §10.                                                                                                                                      |
| 4   | **No query layer.** Cross-cutting queries (by tag/author) require scanning or a future index.                                                                                                                                                                                                             | Low                        | Out of scope (§3.2). Add a secondary index object if needed.                                                                                                                                                       |
| 5   | **Heartbeat write volume.** Naively persisting kernel heartbeats dominates write cost.                                                                                                                                                                                                                    | Handled                    | v1 coalesces heartbeat persistence to ≤1/60s/session ([`bucket_spec.md` §8](./bucket_spec.md)).                                                                                                                    |
| 6   | **Notebook content overwrite-in-place.** `notebook.py` is last-writer-wins; only immutable `versions/` are authoritative per-version.                                                                                                                                                                     | Low                        | Documented ([`bucket_spec.md` §7.3](./bucket_spec.md)); concurrent edits to one notebook are rare under the trust model.                                                                                           |
| 7   | **Running arbitrary user code** in sandboxes.                                                                                                                                                                                                                                                             | See §8                     | Isolation is the compute adapter's responsibility (DO-backed containers / Modal sandboxes). Hardening details → §8 / §10.                                                                                          |
| 8   | **Content `POST` creates are not idempotent.** A retry can duplicate a project or notebook.                                                                                                                                                                                                               | Handled                    | Optional `Idempotency-Key` on content creates replays the stored result ([`idempotency.md`](./idempotency.md)); session creates reuse the persistent editor claim, caller-owned temporary editor, or notebook app. |
| 9   | **Provider-ism leakage.** Risk that one platform's idioms (CoreWeave, Cloudflare bindings, Modal specifics) quietly leak into the core.                                                                                                                                                                   | Process risk               | Enforced by the dependency rule (core/api import no adapter): the core targets only the port interfaces, and CI exercises more than one adapter set.                                                               |
| 10  | **Session/sandbox drift → leaked billable compute.** Provisioning a sandbox and writing its record are non-atomic; a crash between them — or the record-only reaper deleting a record whose sandbox still runs — orphans billable compute (invisible to a record-only sweep) or leaves a dead kernel URL. | Handled                    | Reconciliation sweep in the maintenance cron destroys leaked/orphaned sandboxes and marks records whose sandbox vanished as terminated (§5.4), via the Compute port's optional `listActive()`.                     |
| 11  | **Unbounded object growth.** Every commit writes a snapshot and every mutation an event, so both accumulate forever (the Iceberg "snapshot-expiry" problem).                                                                                                                                              | Handled                    | `MaintenanceService` prunes snapshots (90-day window, keep-last floor, never current/previous) and event-day folders; versions and session records already pruned. See §5.6.                                       |
| 12  | **Two reapers racing on deletes.** The maintenance sweep must be a singleton; "only one replica runs it" needs a mechanism in multi-replica k8s.                                                                                                                                                          | Handled                    | Singleton `replicas: 1` maintenance Deployment + a bucket-CAS advisory lease (no etcd). See §5.6.                                                                                                                  |
| 13  | **Silent operations.** A bucket-as-database gives an operator no built-in signal for CAS contention, growth, or reaper health.                                                                                                                                                                            | Handled                    | A `Metrics` port (no-op default) emits CAS/reaper/snapshot signals as one wide event per cycle; Prometheus is a drop-in. See §5.6.                                                                                 |
| 14  | **Mixed-version writes during a rolling deploy.** A new replica could write a `schema_version` an old replica then strips or downgrades on re-commit.                                                                                                                                                     | Handled                    | Forward-compatible writes (preserve unknown fields, never downgrade the version; additive-only, breaking changes two-phase). See §5.6 / [`migrations.md`](./migrations.md).                                        |
| 15  | **Cost-DoS via unbounded session creation.** A runaway or buggy client can provision unlimited billable sandboxes even among trusted users.                                                                                                                                                               | Handled                    | Per-user concurrent-session cap (default 10) → `429`; a coarse cost guard, not a general rate-limiter (§8). Complements row 10.                                                                                    |
| 16  | **Audit log is lossy & not tamper-evident.** Events are best-effort, written after the commit they record, and deletable by anyone with bucket write access.                                                                                                                                              | Accepted (trusted users)   | Disclosed in §8; integrity (write-before-commit, restricted-delete / object-lock, or hash-chaining) is deferred. A blocker before untrusted or regulated use.                                                      |

---

## 8. Security Considerations

> **The trust model is the security model for v1.** Because we assume a single tenant of mutually-trusting users (§4.1), v1 deliberately omits defenses that an untrusted-multi-tenant product would consider mandatory. It states exactly what is and isn't defended, making the boundary — and the "must-do before untrusted users" list — explicit.

**Defended in v1:**

- **Identity.** No anonymous access to storage; the API resolves identity (OIDC JWT verified against the IdP JWKS via `jose`, or a signed session cookie) before any handler runs. Failed auth → `401`.
- **Authorization.** Writes are role-gated against the target project (`viewer` < `editor` < `admin`; owner is implicitly admin), enforced server-side per route, never in the client ([`bucket_spec.md` §12](./bucket_spec.md)). Insufficient role → `403`. Reads are gated at `viewer`: open when `MARIMOHUB_DEFAULT_ROLE` is set (the default), membership-gated (non-members get `404`) when it is `none`.
- **Credential containment.** Storage credentials and raw bucket paths are never exposed to clients; everything goes through the API by opaque ID.
- **Request forgery (CSRF).** The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, so a browser won't attach it to a cross-site state-changing request; there is no permissive CORS; and the API additionally rejects any state-changing request whose `Origin` is cross-origin (requests with no `Origin` — non-browser clients like the generated client / CLI — are allowed). Cross-origin mutation → `403`.
- **Session cost cap.** Each session is billable compute, so a per-user concurrent-session cap (`MARIMOHUB_MAX_SESSIONS_PER_USER`, default 10) bounds a runaway client from provisioning unbounded sandboxes — over the cap → `429`. This is a coarse cost guard, not a general request rate-limiter (§7).

**Partially defended in v1 (inside the trust boundary — disclosed, not fully closed):**

- **Sandbox isolation & egress.** Sandboxes run arbitrary user Python: the control plane must be unreachable from inside a sandbox and sandboxes isolated from one another. v1 relies on the **compute adapter** for this (CoreWeave sandboxes / Modal / Cloudflare containers); resource limits and **egress policy** are deployment configuration, not enforced by the core. Harden per adapter before untrusted users.
- **Sandbox credential scoping.** How notebook files reach a sandbox differs by adapter: the **copy-fallback** path (e.g. Modal) ships **no** storage credentials into the sandbox — the control plane copies files in and out — whereas the **bucket-mount** path passes the deployment's **full bucket credentials** today. Prefix-scoped, short-lived keys are **not yet implemented**; this is a real gap for the mount path and should be closed before untrusted users.
- **Audit log integrity.** Events are append-only immutable objects, but each is written **best-effort and _after_** the commit it records — a committed write whose event PUT fails leaves a gap — and event objects are **deletable by anyone with bucket write access**. The log is therefore **lossy and not tamper-evident** in v1. Integrity would need write-before-commit (or an accepted gap) plus restricted-delete / object-lock (WORM) or hash-chaining.
- **Secrets in notebooks.** Users pasting secrets directly into notebook code is addressed by the secrets module (§10.2) — and, for federatable cloud credentials, made unnecessary by workload identity federation (§10.3). Both are opt-in, so a deployment configuring neither still carries this risk.

**Deliberately NOT defended in v1 (depends on the trusted-user assumption):**

- **Cross-user XSS from notebook-rendered content.** Notebooks render HTML/JS-bearing output. v1 does **not** iframe/sandbox that content against other users. Acceptable only because users trust each other. _Before untrusted users: render notebook output in a sandboxed iframe on a separate origin._
- **Read-side isolation.** Every authenticated user can read the entire catalog and all notebook code. Acceptable for one team; a hard blocker otherwise.
- **Malicious insiders.** No defense against an authorized user abusing their granted role.

---

## 9. Out of Scope for v1 (explicitly deferred)

Acknowledged gaps with a known direction, drawn from the design docs and the assumptions — not bugs, scope.

- **Fine-grained / untrusted multi-tenancy.** Project-granularity read isolation is now **implemented** (opt-in via `MARIMOHUB_DEFAULT_ROLE=none`): the model stays intact via **filter-on-read at project granularity** — `member_ids` is denormalized into each snapshot project entry and the list filters in the service, staying **2 GETs** (the filter is in-memory over data already fetched) and costing only one extra catalog CAS per membership edit. What remains deferred is going **finer** — **per-notebook ACLs** (snapshot grows `O(members × notebooks)`; a project becomes partially visible) or **per-user index objects** (read scales with what a user sees, but project/membership writes must fan out to every affected user's index, breaking the single-CAS model) — and true **untrusted** multi-tenancy. That last needs **scoped, short-lived credential vending** (the prefix-scoped-key work flagged open in §8) as the storage-enforced upgrade so a compromised app layer can't read another tenant's bytes. This mirrors how the Iceberg world handles it (§11.2): the metadata stays one canonical document and visibility is enforced at the catalog/service boundary, not in the data. Scope before opening to untrusted users. ([`bucket_spec.md` §12, §15](./bucket_spec.md))
- **Additional notebook source types.** `source.json` is a typed pointer (a discriminated union on `type`), so new code sources are additive. v1 targets **`local`** (bytes in the object store); a `github` source (code fetched from a repo on demand) brings sync, caching, and credential concerns — and, because the control plane would fetch arbitrary repo URLs server-side and then run the fetched code, it is also an **SSRF** surface (fetches pointable at cloud metadata / internal services) and a **supply-chain** surface. It needs URL allowlisting + egress controls designed in from the start, and is deferred until prioritized. ([`bucket_spec.md` §4.6, §6](./bucket_spec.md))
- **Hard-delete GC.** Deletion is soft (a status flag); a grace-period hard-delete sweep is deferred. ([`bucket_spec.md` §7.4, §12](./bucket_spec.md))
- **Live realtime state store** for kernel output streaming / sub-second variable inspection (belongs with the runtime, not the object store). ([`bucket_spec.md` §15](./bucket_spec.md))
- **Open storage questions** — notebook ordering (manual vs. creation-time) and execution-log locality (a central event log vs. per-notebook run logs) are deferred. (Retention, version pruning, and the object-versioning backup posture are part of the operational design — §5.6, [`operations.md`](./operations.md).) See [`bucket_spec.md` §15](./bucket_spec.md).

---

## 10. Companion Modules

### 10.1 AI module

The hub configures the marimo AI assistant to use a managed provider with no user-supplied key: it injects config pointing at its own OpenAI-compatible proxy (`/api/ai/v1`) with a short-lived, session-scoped token, and holds the real provider key server-side — the key never enters a sandbox. See [`docs/ai.md`](../docs/ai.md).

### 10.2 Integration secret sources

Secret fields are part of versioned integrations. A **managed** field stores an
encrypted envelope in the integration version. A **reference** field stores an
external backend and locator. The hub resolves references only for a connection
test or new session. Resolution fails closed. See
[`docs/integration-secrets.md`](../docs/integration-secrets.md).

### 10.3 Workload Identity Federation

For federatable credentials there is no key to store at all: the hub is an OIDC issuer that mints a short-lived, project-scoped JWT per session and exchanges it server-side — via a `CredentialBroker` port with `coreweave` (CAIOS) and `aws` (STS `AssumeRoleWithWebIdentity`) adapters — for temporary cloud credentials injected into the sandbox. Per-project opt-in; which project reaches what is decided by cloud-side policy on the token's `sub`. This also narrows the §8 sandbox-credential-scoping gap for bucket access. See [`docs/workload-identity-federation.md`](../docs/workload-identity-federation.md).

---

## 11. Appendix: Condensed Architecture & Storage Spec

> A self-contained digest of [`architecture.md`](./architecture.md) and [`bucket_spec.md`](./bucket_spec.md). §5 gives the high-level shape; this carries the detail needed to read the RFC standalone. (Both source docs are ~10× longer.)

### 11.1 Architecture

**Domain services** — behind the ports, no vendor SDKs, composed by `createServices(bucket)`:

| Service                              | Responsibility                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CatalogService`                     | Owns the snapshot chain: read → mutate → write new snapshot → CAS the catalog pointer, with retry.                                                                               |
| `NotebookService` · `ProjectService` | CRUD + versioning over the Storage port.                                                                                                                                         |
| `SessionService`                     | Kernel-session records and lifecycle (create, heartbeat, expire, reap).                                                                                                          |
| `EventService`                       | Append-only audit log (one immutable object per event).                                                                                                                          |
| `SandboxProvisioner`                 | Orchestrates the Compute port (provision / teardown).                                                                                                                            |
| `ReconciliationService`              | Reconciles session records against the provider's live sandboxes (`listActive()`): reclaims leaked sandboxes, marks dead sessions terminated, reaps recordless orphans.          |
| `MaintenanceService`                 | Storage retention: prunes index snapshots and event-day folders past the retention window (never the current/previous snapshot). Runs in the maintenance cron under a CAS lease. |

**Source types** — a notebook's code location is a discriminated union in `source.json`, resolved by the domain layer, independent of the storage adapter:

- `local` — bytes in the object store (the v1 source type).
- `github` — fetched from a repo on demand (store keeps metadata + cached SHA); a future source type (§9).

**Sandbox lifecycle** (provider-independent):

```
provision: create sandbox → mount bucket (or copy files in) → start marimo
           (`uv run marimo edit`, port 2718) → wait for port → expose URL
teardown:  save files back (if copy-fallback) → destroy sandbox
```

**Monorepo** — dependencies point inward; `core`/`api` import no adapter:

```
packages/  core (model, services, ports) · api (OpenAPI app)
           config (MARIMOHUB_* → adapter selection)
           storage-s3 · storage-r2 · compute-coreweave · compute-modal · compute-cloudflare
           auth-oidc · auth-cloudflare-access · auth-dev
           web (React SPA) · client (generated TS API client)
apps/      server (Node entrypoint — Docker / k8s)
examples/  cloudflare-worker (Workers entrypoint)
```

**End-to-end — open & run a notebook** (every hop crosses a port; swap any adapter and the sequence is identical):

```
1 SPA      GET /api/v1/projects/{pid}/notebooks/{nid}
2 AuthN    verify OIDC/Access token → AuthUser
3 AuthZ    read project.json → check caller role
4 Service  read meta.json + source.json → resolve code (local: from store)
5 SPA      POST …/{nid}/sessions            (user clicks Run)
6 Service  write session record to storage
7 Compute  provision sandbox → expose URL
8 SPA      embed live kernel; later kernel traffic is proxied
9 Teardown DELETE …/{sid} → save back → destroy → mark session terminated
```

### 11.2 Storage / bucket spec

**Core idea (Iceberg-inspired)** — one mutable pointer, everything else immutable or append-only: `catalog.json` → `snapshots/{id}.json` → the full project + notebook index. The pointer is swapped atomically via conditional PUT (`If-Match` on ETag); a single GET on the current snapshot returns the whole metadata index (no code).

**Bucket layout:**

```
_system/
  catalog.json                 ← the ONLY file overwritten in place (atomic CAS)
  snapshots/{id}.json          ← immutable index, one per write
  sessions/{id}.json           ← live kernel sessions (mutable, independent)
  events/{date}/{ulid}.json    ← append-only audit log (immutable)
  logs/{date}.log              ← human ops log
projects/{pid}/
  project.json                 ← name, owner, members[] + roles, tags
  notebooks/{nid}/
    meta.json                  ← title, status, author, tags (no code, no paths)
    README.md
    source.json                ← typed source pointer (v1: local) + current_version_id
    workspace/                 ← latest-only mirror of the sandbox working dir
      notebook.py · pyproject.toml          ← latest code/deps (+ runtime files under PERSIST_WORKSPACE=workspace)
    versions/{vid}/…           ← immutable per-version snapshots
```

**Atomic write (compare-and-swap):**

```
1 PUT content files (meta, README, source, notebook.py, pyproject)
2 PUT immutable version snapshot under versions/{vid}/
3 GET catalog (save ETag) + current snapshot
4 PUT new snapshot              (new key — never conflicts)
5 PUT catalog If-Match:{etag}   ← the commit
    on 412: DELETE orphan snapshot, retry from 3 (≤5×, backoff)
6 PUT event object             (best-effort)
```

Step-1 content is last-writer-wins on `notebook.py`; the immutable `versions/{vid}/` objects are the authoritative per-version record. Delete is **soft** (status flag in a new snapshot); a deferred GC hard-deletes after a grace period.

**IDs** — resource IDs are a short prefix + a **random** 16-char body (`proj-`, `nb-`, `snap-`, `sess-`): subdomain-safe and unguessable but **not** time-sortable. Only **version** IDs (`ver_`) and event IDs are ULIDs, where lexicographic order is load-bearing (version pruning; per-day event order). The current snapshot is always the one named by `catalog.json` — never inferred from key-listing order (which, for random snapshot IDs, isn't chronological). Recency for retention/recovery comes from `created_at` / object timestamps.

**Sessions** — written straight to `_system/sessions/` (never touch the snapshot chain); status `starting → running → idle → terminated | expired`, with heartbeat persistence coalesced to ≤ 1 / 60 s / session. The 5-min maintenance cron (expire → reconcile → reap → prune) and its single-writer guarantee are described in §5.4 and §5.6.

**Events** — object stores have no atomic append, so each event is its own immutable object under a per-day prefix, keyed by monotonic ULID: concurrency-safe with no locking, and listing a day returns events in order.

**Migrations** (no DB to `ALTER`) — every object carries `schema_version`; snapshots upgrade lazily on read, `meta`/`project`/`source` via an idempotent fan-out job, events never. Rolling-deploy compatibility is covered in §5.6 ([`migrations.md`](./migrations.md)).

**Storage requirement** — strong read-after-write consistency + _atomic_ conditional writes (`If-Match` / `If-None-Match`); blessed backends and the boot check are in §5.2, other S3-compatible stores in §11.3.

**Scale** (10 projects × 100 notebooks = 1,000): ~8,660 objects · ~200 KB snapshot · list-all = **2 GETs** · open a notebook = **4 GETs** · create/update = ~8 PUTs + 2 GETs + 1 CAS PUT + 1 event.

**The Iceberg parallel (and read-side isolation, §9).** The layering maps almost one-to-one, which is why Iceberg's access-control stance carries over directly:

| Iceberg                                                 | marimohub                               |
| ------------------------------------------------------- | --------------------------------------- |
| Catalog (table id → metadata pointer), committed by CAS | `catalog.json` (`If-Match` CAS)         |
| `metadata.json` — one canonical doc, whole-table state  | `snapshots/{id}.json` — the whole index |
| manifest list → manifests → data files                  | notebook content objects                |

Crucially, the Iceberg _format_ has **no per-user visibility**: `metadata.json` is one canonical document every authorized principal reads in full, and access control is pushed **up** to the catalog/governance layer, never into the data. `listTables`/`loadTable` filter the response at the **catalog-service boundary** (→ marimohub's "filter `GET /projects` in the service", §9), and storage-level isolation comes from **credential vending** — the catalog hands back scoped, short-lived, prefix-bound credentials so a client physically cannot read tables it wasn't granted. marimohub's deferred read-side isolation follows the same shape: keep one canonical snapshot, filter on read (project-grained, still 2 GETs), and — for untrusted users — add prefix-scoped key vending (the open §8 gap), since read isolation and sandbox-credential scoping are the same mechanism from two angles.

### 11.3 Other S3-compatible storage

The blessed backends (§5.2) are not the only ones that _can_ work — they are the ones we support and target. Any other S3-compatible store (Ceph RGW, Tigris, Backblaze B2, Wasabi, Google Cloud Storage via S3 interop, …) can back marimohub **provided it offers atomic conditional writes (`If-Match` / `If-None-Match`) and strong read-after-write consistency** — that single property is what the catalog compare-and-swap relies on. Because "S3-compatible" is an API label that does not guarantee these semantics, such stores are **used at the operator's discretion and are not officially supported**. The boot self-check is the backstop: it refuses to start on a store that doesn't honor conditional writes, so an unsuitable target fails fast rather than corrupting the catalog under write contention.

---

## 12. References

- [`architecture.md`](./architecture.md) and [`bucket_spec.md`](./bucket_spec.md) — the source design docs, **condensed in §11**.
- [`operations.md`](./operations.md) — the operator runbook: backup/DR, corruption recovery, the maintenance cron + lease, retention, and observability (the §5.6 detail).
- [`migrations.md`](./migrations.md) — schema migration strategy and the rolling-deploy compatibility policy.
- [`technologies.md`](./technologies.md) — concrete library/runtime choices per port and the "what's NOT used (and why)" table.
- Code anchors: ports in `packages/core/src/ports/` (incl. `metrics.ts`); domain services in `packages/core/src/services/` (incl. `MaintenanceService`, `MaintenanceLock`); config wiring in `packages/config/src/index.ts`; entrypoints in `apps/server/` and `examples/cloudflare-worker/`.
