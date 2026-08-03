# Architecture

marimohub is a self-hostable platform for storing, managing, and running
[marimo](https://marimo.io) notebooks. It is built as a small set of **modular
components connected by stable interfaces**. Each component has one job and one
interface (a _port_); concrete technologies plug in behind that interface as
_adapters_, and every component can be swapped without touching the rest of the
system.

> **The one idea to take away:** marimohub is not tied to any provider. It is a
> provider-agnostic core with interchangeable adapters. Swap the storage adapter
> and it runs on MinIO; swap the compute adapter and it runs on Modal; swap the
> auth adapter and it runs behind any OIDC provider. Nothing in the domain logic
> knows which adapter is loaded.

---

## 1. Design Principles

1. **Ports and adapters.** Every external dependency — object storage, compute,
   identity — sits behind a TypeScript interface. The domain services depend on
   the interface, never on the vendor SDK. New providers are additive: implement
   the interface, register the adapter.
2. **Config-driven for the common case, library-based for the complex case.**
   A standard deployment is configured entirely through prefixed environment
   variables (`MARIMOHUB_*`). When you need behavior the config surface doesn't
   expose — a bespoke storage backend, a custom authorizer, an embedded
   deployment — you import the packages and wire the adapters yourself in code.
3. **No database.** All durable state — notebook content, metadata, project
   membership, audit events — lives in the storage layer. There is no separate
   database to provision or run schema migrations against. The object store
   **is** the database, though: it is the one thing you must back up, and it has
   a real operational story (backup/DR, retention, recovery, rolling-upgrade
   compatibility, observability) — see [`operations.md`](./operations.md). (The
   storage schema itself is in [`bucket_spec.md`](./bucket_spec.md).)
4. **The API is the contract.** The boundary between frontend and backend is a
   versioned OpenAPI 3.1 spec. Any client — the bundled SPA, a CLI, a third-party
   integration — speaks the same documented HTTP surface.
5. **Deploy anywhere.** Because the components are decoupled from their
   providers, the same code deploys to Cloudflare Workers, a single Docker
   container, or a Kubernetes cluster. Only the entrypoint and the loaded
   adapters change.

---

## 2. System Overview

```
                         ┌──────────────────────────┐
                         │   Frontend assets (SPA)   │
                         │   React · static files    │
                         └─────────────┬─────────────┘
                                       │  HTTP (OpenAPI 3.1)
                                       ▼
        ┌──────────────────────────────────────────────────────────┐
        │                      API layer (Hono)                      │
        │   /projects · /notebooks · /sessions · /sandbox · /me      │
        │                                                            │
        │   ┌────────────┐   ┌────────────┐   ┌──────────────────┐   │
        │   │ Authenticator│ │ Authorizer │   │  Domain services │   │
        │   │   (AuthN)   │   │  (AuthZ)   │   │ catalog/notebook │   │
        │   │ OAuth/OIDC  │   │ role check │   │ project/session  │   │
        │   └─────────────┘   └─────┬──────┘   └────┬────────┬────┘   │
        └──────────────────────────│───────────────│────────│────────┘
                                   │               │        │
                  reads roles from │               │        │ provisions
                                   ▼               ▼        ▼
                       ┌────────────────────┐  ┌──────────────────────┐
                       │  Notebook Storage  │  │   Compute / Sandbox  │
                       │      (port)        │  │        (port)        │
                       ├────────────────────┤  ├──────────────────────┤
                       │ S3-compatible      │  │ Cloudflare Containers│
                       │ R2 (binding)       │  │ Modal · CoreWeave    │
                       │ GCS                │  │ Kubernetes · Docker  │
                       │ memory (for tests) │  │ E2B · local (dev)    │
                       └────────────────────┘  └──────────────────────┘
```

A request flows top to bottom: the SPA calls the OpenAPI surface; the API layer
authenticates the caller (AuthN), authorizes the action against roles stored in
the notebook storage (AuthZ), then invokes a domain service, which reads/writes
through the **Storage** port and — when running a notebook — provisions a kernel
through the **Compute** port.

---

## 3. Components

Each component below is independently swappable. The "Port" is the interface the
rest of the system depends on; "Adapters" are the interchangeable
implementations.

### 3.1 Notebook Storage

The durable home of everything: notebook code, notebook metadata, project
records (including membership), versions, sessions, and the audit log. There is
no separate database — **storage is the single source of truth**.

|              |                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port**     | `Bucket` — `get` / `head` / `put` / `delete` / `list`, with conditional `put` (compare-and-swap on ETag) for atomic commits                                                                                                                                                     |
| **Adapters** | **S3-compatible** (AWS S3, Cloudflare R2, MinIO, Tigris, Ceph) · **R2** (Cloudflare Workers binding) · **GCS** (native JSON API, generation-based CAS) · **Azure Blob Storage** (native SDK, ETag-based CAS) · **filesystem** (single process) · **memory** (tests / local dev) |
| **Schema**   | Iceberg-inspired: a single mutable `catalog.json` pointer → immutable snapshots → per-notebook folders, each with a latest-only `workspace/` (code, deps, runtime files) beside an immutable `versions/`. Full detail in [`bucket_spec.md`](./bucket_spec.md).                  |

**Why an object store is enough.** The schema uses an atomic pointer
(`catalog.json`) swapped via conditional PUT (`If-Match` on ETag) as the only
mutable content pointer. Immutable snapshots and versions retain content
history. Mutable operational records, such as sessions and claims, remain
outside that chain and use their own write discipline. This gives consistent
reads, safe concurrent writes, and free audit history without a transactional
database.
The single hard requirement on an adapter is **strong
read-after-write consistency plus conditional writes** — verify these for any
S3-compatible target before adopting it.

**Storage adapter vs. source type — two different axes.** Storage answers two
questions, and they are independent:

- _Where is the catalog/metadata index?_ — Always the object store, behind the
  `Bucket` adapter. This is the **storage adapter** axis (S3-compatible, R2,
  GCS, memory).
- _Where do a notebook's source bytes live?_ — Declared per-notebook in
  `source.json` as a **source type**:
  - `local` — bytes stored in the object store (`workspace/notebook.py`).
  - `git` — an external pusher sends a Git revision to the sync API. The object
    store holds the pushed workspace and Git coordinates. The hub does not pull
    from the repository host.

Each local version stores `notebook.py`, `pyproject.toml`, and `version.json`.
Each Git version stores the pushed tree under `workspace/` and a
`version.json`. A local version can also contain optional HTML and marimo
session snapshots. See [`bucket_spec.md`](./bucket_spec.md) §8.

A source type is **not** a storage adapter. The catalog always lives in the
`Bucket`; an individual notebook's code may come from the bucket (`local`) or a
Git push (`git`). `github` is the current `provider` value inside the `git`
source record. It is not a `source.type` value. See the public
[sync guide](../docs/syncing.md) for the push protocol and token lifecycle.

**Notebook Storage holds authorization data too** — see [§3.4](#34-authorization-authz).

### 3.2 Compute (Sandbox)

Runs a marimo kernel in an isolated environment so users can edit and execute
notebooks. The API never talks to a vendor's container SDK directly; it talks to
the Compute port.

|                   |                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port**          | `SandboxProvider` — `create(id)` → `SandboxInstance`, plus `proxy(request)` for forwarding traffic to a running kernel                                                                                                                                                                                                                                                                                                                 |
|                   | `SandboxInstance` — the kernel control surface: `exec`, `startProcess`, `writeFile`/`readFile`, `mountBucket`, `exposePort`, `destroy`, …                                                                                                                                                                                                                                                                                              |
| **Adapters**      | **Cloudflare Containers** (Durable Object-backed) · **Modal** · **CoreWeave** (CoreWeave Sandboxes via the vendored `@coreweave/cwsandbox` SDK, Node/gRPC) · **Kubernetes** (a Pod + Service + Ingress per session via the cluster API) · **Docker** / **Podman** (a container per kernel through the engine CLI) · **E2B** (E2B sandboxes; bring-your-own `e2b` SDK) · **local** (host subprocess via `uv run marimo edit`, dev only) |
| **Orchestration** | `SandboxProvisioner` is provider-agnostic: it creates a sandbox, makes notebook files available (mount the bucket, or fall back to copying files in), starts marimo, waits for the port, and exposes a URL. Teardown reverses it.                                                                                                                                                                                                      |

**Lifecycle (provider-independent):**

```
provision: create sandbox → mount bucket (or copy files) → start marimo
           → wait for port → expose URL
teardown:  read notebook back → cut a new version (if code changed)
           → copy __marimo__ snapshots (notebook.html / session.json, if present)
           into that version → destroy sandbox
```

> **Teardown versions the session's edits.** Interactive kernel edits land on the
> live `notebook.py` without going through the API write path, so teardown reads
> the notebook back, cuts a new version, and attaches marimo's optional
> `__marimo__/notebook.html` and `__marimo__/session/{notebook}.py.json` to that
> same version — the snapshots are a copy, not an export, and the code/HTML/session
> stay coherent. See [`bucket_spec.md`](./bucket_spec.md) §8.

A new compute backend only has to satisfy the `SandboxProvider` /
`SandboxInstance` contract. `SandboxProvisioner`, sessions, and the API are
unchanged whether the kernel runs in a Cloudflare Container, a Modal sandbox, or
a local host subprocess.

**Editor sessions.** `MARIMOHUB_EDITOR_SANDBOX_SHARING` selects shared or
exclusive access to one persistent sandbox per notebook. In exclusive mode,
other editors can start a temporary sandbox or confirm a takeover. A CAS claim
at `_system/editors/{pid}/{nid}.json` permits only its holder to save. See
[`docs/editor-sessions.md`](../docs/editor-sessions.md).

**App sessions (`mode: "app"`).** Besides the persistent edit session, a notebook
can be served as a read-only application via `marimo run` — a second session
class sharing the same provision/teardown machinery with three deliberate
differences:

- **Shared singleton.** One app sandbox per notebook, shared by everyone
  admitted to it: reuse is user-blind, any editor may stop/restart it, and a
  CAS'd claim object (`_system/apps/{pid}/{nid}.json`) prevents concurrent
  starts from double-provisioning. Liveness is collective — any open app tab
  heartbeats it.
- **Copy-only, never written back.** The app sandbox loads a copy of the
  workspace at provision time (never a read-write mount — app code must not
  write through to the mirror the edit session owns) and skips every
  persistence path at teardown: no version, no HTML/session snapshot, no
  workspace mirror, no FS-snapshot capture. Consequently an app serves a
  snapshot; edits made after it started don't appear until it is restarted
  (the UI surfaces this via `source_version_id` staleness).
- **Kernel-per-viewer memory model.** `marimo run` spawns one kernel per
  connected browser inside the single sandbox, so memory scales with concurrent
  viewers in a fixed-size sandbox; marimo's default session TTL garbage-collects
  disconnected viewers' kernels. Size app-heavy deployments accordingly.

**Apps are editor-only by default; viewer access is a deployment opt-in.**
Under the default `MARIMOHUB_VIEWER_MODE=static`, viewers cannot start, open,
or reach an app: session create, heartbeat, and stop require editor+, the
proxy re-authorizes every HTTP request (WebSockets at each upgrade — an
established socket lives until it closes) in `proxy` exposure, and — because in
`subdomain` exposure the kernel URL itself is the access capability (kernels
run `--no-token`; see docs/security.md) — the session read projections
(list/get) withhold `sandbox_url` from callers the kernel gates would reject.
The UI says so rather than dangling an unopenable indicator. The reason is
credential exposure: app sandboxes keep WIF credentials and project
secrets injected (apps commonly exist to query project data), and `marimo run`
exposes UI-driven inputs into arbitrary notebook code — acceptable inside the
editor trust boundary (editors can already reach those credentials via an edit
session), but a real exfiltration surface for an untrusted audience. Setting
`MARIMOHUB_VIEWER_MODE=applications` (or its superset `ephemeral-sandbox`)
accepts that trade-off deployment-wide: viewers may then start, open, and
heartbeat the shared app — it is the same full-fat singleton regardless of who
started it — while stop/restart stays editor+. All of these decisions flow
from one pure evaluator in core (`sessionCan`/`canStartSessionMode` in
`services/runtime/sessionAuthz.ts`, over the `VIEWER_SESSION_MODES` admission
table in `constants.ts`): the API's throwing gates (`assertSessionControl`,
`assertSessionAccess`), the `sandbox_url` projection, and the per-caller
`can: { attach, stop }` grants shipped on every session response are the same
function applied to the same facts — and the web renders from `session.can`
and `capabilities.viewer_session_modes` instead of re-deriving policy, so
client and server cannot disagree. Apps skip
managed-AI injection (no editor surface). They are excluded from the per-user
_edit_ cap; instead they are capped per project
(`MARIMOHUB_MAX_APPS_PER_PROJECT`) and per starter (the per-user cap also
bounds apps a user has started, so freely creatable projects are not a
cost-ceiling escape).

### 3.3 Authentication (AuthN)

Establishes _who_ is making a request. **Authentication is OAuth/OIDC only** —
there is no password store, no bespoke credential handling. marimohub delegates
identity entirely to an external provider and consumes the resulting token.

|                  |                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port**         | `Authenticator` — `authenticate(request) → AuthUser \| null` (`AuthUser` = `{ id, email }`)                                                                                                                                                                                                             |
| **Adapters**     | **OIDC** (any compliant provider: Auth0, Google, Okta, Keycloak, GitHub OAuth) · **Cloudflare Access** (a managed OIDC front door; the worker verifies the `CF-Access-JWT-Assertion` JWT against the team JWKS) · **dev bypass** (no network identity — a fixed local user, for local development only) |
| **Verification** | JWT signature + audience validated against the provider's JWKS endpoint (cached, auto-rotating) via `jose`.                                                                                                                                                                                             |

All production adapters are OAuth/OIDC under the hood — Cloudflare Access is
simply a hosted OIDC gateway. The **dev bypass** is not an auth mode in the
product sense; it is an explicit "no identity" shortcut for running the stack
locally without a provider, and should never be enabled in a deployment that
serves real users.

### 3.4 Authorization (AuthZ)

Establishes _what_ an authenticated user may do. **Authorization data lives in
the notebook storage**, not in a separate service: each `project.json` carries a
`members` list mapping `user_id` → `role`.

|                     |                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Port**            | `Authorizer` — `can(user, action, resource) → boolean`, resolved by reading project membership from the Storage port |
| **Roles**           | `admin` (full control, incl. delete + membership) · `editor` (create/edit notebooks) · `viewer` (read-only)          |
| **Source of truth** | `projects/{pid}/project.json` → `members[]`, read through the same `Bucket` adapter as everything else               |

Because membership is just more metadata in the store, authorization needs no
extra infrastructure: the authorizer loads the relevant `project.json`, finds
the caller's role, and allows or denies. This keeps the "no database" property
intact all the way through access control.

> **Scaling note.** The global catalog snapshot lists projects by `owner` only;
> per-project `members` live in `project.json`. Authorized listing for a
> non-owner therefore costs more than the 2-GET "list everything" path — it must
> consult membership. This trade-off (and options like denormalizing membership
> into the snapshot) is tracked in [`bucket_spec.md`](./bucket_spec.md).

### 3.5 API Layer (OpenAPI)

The single HTTP contract between any client and the backend. Routes are defined
with `@hono/zod-openapi`, so the **Zod schemas, runtime validation, and the
published OpenAPI 3.1 document are one and the same** — the spec can never drift
from the implementation.

- **Served at** `/api/v1/doc` (machine-readable spec); routes under `/api/v1/*`.
- **Envelope** — JSON responses use `{ success: true, data }` or
  `{ success: false, error: { code, message } }`. The HTML snapshot route
  returns raw HTML on success.
- **Middleware chain** — `AuthN` (reject unauthenticated) → auto-initialize
  catalog → route handler. Handlers resolve services per-request from the
  configured adapters (no global singletons).

| Group        | Representative routes                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Auth         | `GET /api/v1/me` · `POST/GET /api/v1/me/tokens` · `DELETE /api/v1/me/tokens/{tokenId}`                                  |
| Projects     | `GET/POST /api/v1/projects` · `GET/PATCH/DELETE /api/v1/projects/{pid}` · project members and events                    |
| Notebooks    | `GET/POST …/{pid}/notebooks` · `GET/PATCH/DELETE …/{nid}` · code, Git sync, versions, restore, and duplicate routes     |
| Sessions     | `GET …/{pid}/sessions` · create/get/heartbeat/delete a notebook session · inspect/take over editor ownership            |
| Integrations | Discover kinds · manage project or organization instances · list versions · copy a project instance · test connectivity |
| Secrets      | List, store, delete, and test project secret references                                                                 |
| System       | `GET /api/v1/version` · `GET /api/v1/capabilities` · `GET /api/health`                                                  |

Notebooks are addressed by `{project_id, notebook_id}`. Clients never receive
raw storage paths. The API owns ID generation, source handling, snapshot
management, and event logging. Storage credentials are never exposed to
clients.

### 3.6 Frontend Assets

A React 19 single-page application, built to static files and served by whatever
fronts the deployment (Cloudflare's asset handler, an nginx sidecar in Docker, a
CDN in front of k8s). The SPA is a pure consumer of the OpenAPI surface — it
holds no server secrets and could be replaced by any other client.

- **Stack** — React 19 + React Router (SPA mode) + TanStack Query for
  server-state, talking exclusively to `/api/*`.
- **Decoupling** — because the frontend depends only on the documented API, a
  generated TypeScript client (`@marimo-hub/client`, from the OpenAPI doc) keeps
  it type-safe without importing any backend or entrypoint code.

### 3.7 Domain Core (Services)

The provider-agnostic heart that the ports serve. These services contain all the
business logic and depend only on interfaces:

- **CatalogService** — owns the atomic snapshot chain (read catalog → mutate →
  write snapshot → compare-and-swap the pointer, with retry).
- **NotebookService / ProjectService** — CRUD + versioning over the Storage port.
- **SessionService** — kernel session records and lifecycle.
- **EventService** — append-only audit log (one immutable object per event).
  `CatalogService` appends one event per successful snapshot commit
  (best-effort: a failed append never fails the mutation); read via the
  admin-only `GET /projects/{pid}/events`.
- **SandboxProvisioner** — orchestrates the Compute port (see [§3.2](#32-compute-sandbox)).

`createServices(bucket)` composes them; nothing here imports a vendor SDK.

---

## 4. Configuration Model

Standard deployments are configured entirely through environment variables.
Every variable is **prefixed by the component it configures**, so it is always
obvious which knob belongs to storage, compute, or auth. The global prefix is
`MARIMOHUB_`.

Each component reads a `*_BACKEND` selector that picks the adapter, followed by
adapter-specific settings.

> The tables below summarize the main knobs. For the **complete, always-current**
> reference (every variable with its description, default, and example), see
> [`docs/configuration.md`](../docs/configuration.md) — it is generated from
> `packages/config/src/spec.ts` and kept in sync by a test, so it never drifts.

### Storage — `MARIMOHUB_STORAGE_*`

| Variable                                 | Purpose                                  |
| ---------------------------------------- | ---------------------------------------- |
| `MARIMOHUB_STORAGE_BACKEND`              | `s3` \| `r2` \| `gcs` \| `memory`        |
| `MARIMOHUB_STORAGE_S3_BUCKET`            | Bucket name (S3-compatible)              |
| `MARIMOHUB_STORAGE_S3_ENDPOINT`          | Endpoint URL (MinIO/Tigris/R2-via-S3)    |
| `MARIMOHUB_STORAGE_S3_REGION`            | Region                                   |
| `MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID`     | Access key (secret)                      |
| `MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY` | Secret key (secret)                      |
| `MARIMOHUB_STORAGE_S3_FORCE_PATH_STYLE`  | `true` for MinIO and most non-AWS stores |

> On Cloudflare Workers, R2 is supplied as a native **binding** rather than
> credentials, so the worker entrypoint uses the `r2` backend and the binding
> name; the `S3_*` keys are for off-Cloudflare deployments.

### Compute — `MARIMOHUB_COMPUTE_*`

| Variable                                        | Purpose                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MARIMOHUB_COMPUTE_BACKEND`                     | `cloudflare` \| `modal` \| `coreweave` \| `kubernetes` \| `docker` \| `e2b` \| `local` \| `none` |
| `MARIMOHUB_COMPUTE_IMAGE`                       | Sandbox image reference                                                                          |
| `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`            | Public hostname used when exposing kernel ports                                                  |
| `MARIMOHUB_COMPUTE_MODAL_TOKEN_ID` / `_SECRET`  | Modal credentials (secret)                                                                       |
| `MARIMOHUB_COMPUTE_COREWEAVE_API_KEY`           | `coreweave` backend: CoreWeave Sandbox API key (secret)                                          |
| `MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE` | `coreweave` backend: public kernel URL scheme (`{sandboxId}`/`{port}`/`{host}`)                  |
| `MARIMOHUB_COMPUTE_LOCAL_HOST`                  | `local` backend: host for the kernel URL (default `localhost`)                                   |

Modal derives its provider-side idle limit as 1.5 times
`MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS`. The record-driven lifecycle sweep
saves and stops the session at the earlier deadline; Modal is only the fallback.

> The `coreweave` backend has no `listActive`, so the reconciler skips
> provider-truth reconciliation for it (the SDK list API does not echo tags, so a
> CoreWeave sandbox can't be mapped back to a session's `sandbox_id`). Session
> lifetime, idle reaping, and periodic saves are instead owned by the
> record-driven lifecycle sweep (`development_docs/operations.md` §7);
> `MARIMOHUB_COMPUTE_COREWEAVE_MAX_LIFETIME_SECONDS` is only the hard orphan
> backstop behind it (defaults to 2× `MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS`,
> must not be set below it).

> On Cloudflare, the sandbox is a Durable Object **binding**; `cloudflare` is the
> backend and the DO is provided by the platform.

### Authentication — `MARIMOHUB_AUTH_*`

| Variable                                | Purpose                                          |
| --------------------------------------- | ------------------------------------------------ |
| `MARIMOHUB_AUTH_BACKEND`                | `oidc` \| `cloudflare-access` \| `dev`           |
| `MARIMOHUB_AUTH_OIDC_ISSUER`            | OIDC issuer URL                                  |
| `MARIMOHUB_AUTH_OIDC_CLIENT_ID`         | OAuth client ID                                  |
| `MARIMOHUB_AUTH_OIDC_CLIENT_SECRET`     | OAuth client secret (secret)                     |
| `MARIMOHUB_AUTH_OIDC_AUDIENCE`          | Expected token audience                          |
| `MARIMOHUB_AUTH_DEV_USER_ID` / `_EMAIL` | Fixed identity for the `dev` bypass (local only) |

> Authorization needs no env vars: roles are data in the notebook storage
> ([§3.4](#34-authorization-authz)).

> **Cloudflare Worker example** — the `examples/cloudflare-worker` entrypoint
> reads a flatter set of vars from the Workers runtime binding
> (not the `MARIMOHUB_AUTH_*` prefix): `AUTH_MODE` (`access` | `dev`),
> `ACCESS_TEAM`, `ACCESS_AUD`. These are set in `wrangler.jsonc` and documented
> in `auth.md`. The worker refuses to start if `AUTH_MODE` is unset or
> unknown.

---

## 5. Two Ways to Run It

### Config-driven (the common case)

Set the `MARIMOHUB_*` variables, point them at your providers, and run a
prebuilt artifact (the Worker, or the Docker image). A small `@marimo-hub/config`
package reads the env, selects each adapter from its `*_BACKEND` selector, and
wires the system together. No code required.

### Library-based (the complex case)

When you need something the config surface doesn't cover — a proprietary storage
backend, a custom `Authorizer`, multi-tenant routing, or embedding marimohub
inside a larger application — import the packages and compose them yourself:

```ts
import { createServices } from '@marimo-hub/core';
import { createApi } from '@marimo-hub/api';
import { S3Storage } from '@marimo-hub/storage-s3';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { MyCustomAuthenticator } from './my-auth';

const storage = new S3Storage({
	/* ... */
});
const services = createServices(storage);
const app = createApi({
	services,
	bucket: storage,
	compute: new ModalCompute({
		/* ... */
	}),
	authenticator: new MyCustomAuthenticator(),
	sandboxBucket: {
		name: 'my-bucket',
		endpoint: 'https://s3.us-east-1.amazonaws.com',
		credentials: { accessKeyId: '...', secretAccessKey: '...' },
	},
	sandboxHostname: 'hub.example.com',
});
// mount `app` in any host: Workers, Node/Hono, etc.
```

The ports are the extension points: anything implementing `Bucket`,
`SandboxProvider`, `Authenticator`, or `Authorizer` drops straight in.

---

## 6. Deployment Variations

The same core runs in three shapes. What changes is the **entrypoint** and the
**loaded adapters** — never the domain logic or the API.

|                | Cloudflare                                          | Docker (single host)                           | Kubernetes                                 |
| -------------- | --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| **Entrypoint** | Workers (`examples/cloudflare-worker/src/index.ts`) | Node server (`@marimo-hub/server`)             | Same Node server, replicated               |
| **Storage**    | R2 (binding)                                        | S3 / MinIO / filesystem / Azure                | S3 / MinIO / Ceph / GCS / Azure            |
| **Compute**    | Cloudflare Containers (DO)                          | Docker/Podman, Modal, E2B (or `local` for dev) | in-cluster pods (`kubernetes`), Modal, E2B |
| **AuthN**      | Cloudflare Access (OIDC)                            | any OIDC provider                              | any OIDC provider                          |
| **Frontend**   | Cloudflare static assets                            | nginx sidecar / same server                    | CDN or ingress                             |
| **Scaling**    | automatic, edge                                     | single host                                    | horizontal (stateless API)                 |

The API tier is **stateless** — all state is in the Storage and Compute layers —
so the Docker and Kubernetes shapes scale by simply running more API replicas
behind a load balancer.

---

## 7. Monorepo & Packages

marimohub is a **TypeScript monorepo** of composable packages. The split mirrors
the ports-and-adapters boundary: the core and the API never import a vendor SDK;
each adapter is its own package; deployable entrypoints compose them.

**Packages:**

```
packages/
  core/                   domain model, services, and the port interfaces
  api/                    OpenAPI/Hono app — wires services to HTTP routes
  config/                 env (MARIMOHUB_*) → adapter selection & wiring
  storage-s3/             S3-compatible adapter (AWS S3 / MinIO / Tigris)
  storage-r2/             Cloudflare R2 binding adapter
  storage-gcs/            Google Cloud Storage adapter (native JSON API)
  storage-azure/          Azure Blob Storage adapter (native SDK)
  compute-cloudflare/     Cloudflare Containers adapter
  compute-modal/          Modal adapter
  compute-coreweave/      CoreWeave Sandboxes adapter (vendored cwsandbox SDK)
  compute-kubernetes/     Kubernetes adapter (Pod + Service + Ingress per session)
  compute-container/      Docker and Podman adapters (a container per kernel)
  compute-e2b/            E2B sandboxes adapter (bring-your-own e2b SDK)
  compute-commons/        vendor-free helpers shared by the compute adapters
  compute-local/          local host-subprocess adapter (dev)
  credentials-coreweave/  CoreWeave CAIOS credential broker (OIDC federation)
  auth-oidc/              generic OIDC adapter
  auth-cloudflare-access/ Cloudflare Access adapter
  auth-dev/               dev-bypass authenticator (local only)
  ts-config/              shared tsconfig bases (+ vendored ts-reset)
  web/                    React SPA (frontend assets)
  client/                 TypeScript API client generated from the OpenAPI doc
apps/
  server/                 Node entrypoint for Docker / Kubernetes (@marimo-hub/server)
examples/
  cloudflare-worker/      Cloudflare Workers entrypoint (R2 + Containers + Access)
  docker-compose/         Docker Compose deployment of @marimo-hub/server
  library-composition/    library-mode example: import packages and wire adapters
```

The deployable entrypoints live under `examples/` and `apps/`: the **Cloudflare
Workers** entrypoint is `examples/cloudflare-worker/` (composing the R2, Cloudflare
Containers, and Cloudflare Access adapters), and the **Node** entrypoint is
`apps/server/` (package `@marimo-hub/server`), used by the Docker/Kubernetes shapes.

A dependency only ever points "inward": adapters depend on `core`'s interfaces;
entrypoints depend on `core`, `api`, and whichever adapters they load. `core` and
`api` depend on no adapter. This is what lets a single change of entrypoint
re-target the whole platform.

Git-synced notebooks use the existing `git` source type. An external workflow
pushes content to `/api/sync/git/v1`. The hub does not fetch repository content.
The sync token has notebook scope. See [§3.1](#31-notebook-storage) and the
[sync guide](../docs/syncing.md).

---

## 8. End-to-End Example: Opening and Running a Notebook

Tracing one user action through every component:

```
1. SPA           GET /api/v1/projects/{pid}/notebooks/{nid}
2. API · AuthN   verify OIDC/Access token → AuthUser
3. API · AuthZ   read project.json from Storage → check caller's role
4. Service       NotebookService reads meta.json + source.json from Storage
                 (local → workspace bytes; git → the last workspace pushed to the store)
5. SPA           POST …/{nid}/sessions      (user clicks "Run")
6. Service       SessionService writes a session record to Storage
7. Compute       SandboxProvisioner.create → mount bucket / copy files
                 → start marimo → wait for port → expose URL
8. API           returns sandbox URL; SPA embeds the live kernel
9. Compute       proxy(request) forwards subsequent kernel traffic to the sandbox
10. Teardown     DELETE …/{sid} → save files back → destroy sandbox
                 → mark session terminated in Storage
```

Every numbered hop crosses a port. Replace any single adapter — S3 for R2, Modal
for Cloudflare Containers, Okta for Access — and the sequence is identical.

---

## Related Documents

- [`bucket_spec.md`](./bucket_spec.md) — the Notebook Storage schema: catalog,
  snapshots, versioning, sessions, events, and the conditional-write protocol.
- [`operations.md`](./operations.md) — the operator runbook: backup/DR,
  corruption recovery, the maintenance cron, rolling-upgrade compatibility,
  retention, and observability.
- [`migrations.md`](./migrations.md) — schema migration & rolling-deploy
  compatibility strategy.
- [`integrations.md`](./integrations.md) — integration kind contracts, schema
  evolution, rendering, probes, and tests.
- [`auth.md`](./auth.md) — authentication backends, setup, redirect URIs, and a
  Google OIDC example.
- [`technologies.md`](./technologies.md) — concrete library and runtime choices.
