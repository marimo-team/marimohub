# Technologies

This document records the concrete libraries and runtimes marimohub uses.
Where [`architecture.md`](./architecture.md) describes the _components_ and their
interfaces (ports), this maps each one to the _technology_ that implements it,
using the **Cloudflare Workers** deployment shape as the worked example. Swapping
a provider means swapping the library noted here — the ports stay fixed.

## Port → technology

| Component (port)                 | Cloudflare shape                              | Alternatives                       |
| -------------------------------- | --------------------------------------------- | ---------------------------------- |
| Notebook Storage (`Bucket`)      | Cloudflare R2 (native binding)                | AWS S3 / MinIO / Tigris via S3 SDK |
| Compute (`SandboxProvider`)      | Cloudflare Containers + `@cloudflare/sandbox` | Modal / local Docker               |
| Authentication (`Authenticator`) | Cloudflare Access (OIDC) + `jose`             | OIDC or trusted SSO proxy          |
| Authorization (`Authorizer`)     | roles in storage (no extra tech)              | same                               |
| API                              | `hono` + `@hono/zod-openapi` + `zod`          | same (portable)                    |
| Frontend                         | React 19 + Vite + Tailwind v4 (shadcn-style)  | same (portable)                    |

---

## Runtime & Hosting (Cloudflare shape)

### Cloudflare Workers

Serverless JavaScript/TypeScript runtime at the edge. Hosts the Hono API
(`@marimo-hub/api`) and holds the R2 and Durable Object bindings. The Workers
entrypoint is `examples/cloudflare-worker/` (`src/index.ts`), configured via
`examples/cloudflare-worker/wrangler.jsonc`; `nodejs_compat_v2` is enabled.

### Cloudflare R2 — Storage adapter

S3-compatible object storage, used as the sole data store — **no separate
database** (the bucket is the database, and the one thing to back up — see
[`operations.md`](./operations.md)).
Accessed through the **native R2 binding** (`R2BucketAdapter`), which the rest of
the system sees only as the generic `Bucket` port. The atomicity model depends on
R2's **conditional `put` (`If-Match` on ETag)** for the catalog compare-and-swap.
The on-bucket schema (Iceberg-inspired catalog → snapshots → notebook folders) is
specified in [`bucket_spec.md`](./bucket_spec.md).

### Cloudflare Containers (Durable Objects) — Compute adapter

Stateful container instances managed through the Durable Object API; each sandbox
runs an isolated marimo kernel. The `Sandbox` class from `@cloudflare/sandbox` is
re-exported for wrangler to discover, and wrapped by `CloudflareSandboxProvider`
behind the `SandboxProvider` port.

The example sandbox image (`examples/cloudflare-worker/sandbox.Dockerfile`) is
built on `cloudflare/sandbox:0.7.1`:

- **`uv`** (from `ghcr.io/astral-sh/uv`) for Python/dependency management
- **Python 3.13** project with `marimo[mcp,recommended,ai,lsp]`, `nbformat`, and
  `nbconvert[webpdf]`
- **`@anthropic-ai/claude-code`** installed globally (AI tooling available inside
  the kernel container)
- marimo serves the notebook on port **2718**; the sandbox SDK uses port **3000**

### Cloudflare Access — Authentication adapter

A managed OIDC front door for multi-user deployments. The worker reads the
`CF-Access-JWT-Assertion` header and verifies it against the team's JWKS endpoint.
Access is a hosted OIDC gateway. Node deployments can use OIDC, Google IAP, or
trusted headers from an isolated SSO proxy.

---

## Backend

### Hono

Lightweight web framework for the edge. Provides routing, middleware, and typed
context (`Hono<{ Bindings: Env }>`). Auth and catalog-init run as `/api/v1/*`
middleware; route groups are mounted per resource (`projects`, `notebooks`,
`sessions`, `sandbox`).

### @hono/zod-openapi + zod

The API layer. Routes are declared with Zod schemas, which serve simultaneously as
**runtime request/response validation** and as the source for the published
**OpenAPI 3.1 document** (served at `/api/v1/doc`). The spec therefore cannot drift
from the implementation. `zod` also defines the on-bucket data model
(`packages/core/src/schema.ts`): catalog, snapshot, project, notebook meta, source,
version, session, and event shapes.

### jose

JWT verification for Cloudflare Access, OIDC, and Google IAP. `createRemoteJWKSet` caches remote keys and handles rotation.

### @cloudflare/sandbox

SDK for the Container Durable Objects — process management, file I/O, bucket
mounting, port exposure, and request proxying. Used only inside the Cloudflare
compute adapter; the domain layer never imports it directly.

### ulidx

Generates the **ULID**-based IDs whose lexicographic time-ordering is
load-bearing: version IDs (`ver_`) and event keys, both via a `monotonicFactory`
so entries created in the same millisecond still sort in creation order.
Resource IDs (`proj-`, `nb-`, `snap-`, `sess-`) are **not** ULIDs — they use a
random 16-char base32 body (subdomain-safe, unguessable, not time-sortable; see
`packages/core/src/ids.ts` and `bucket_spec.md` §5).

---

## Frontend

### React 19

UI framework. Function components with hooks throughout; the only class component
is `ErrorBoundary`. Rendered under `StrictMode`.

### React Router v7

Client-side routing in SPA mode (`BrowserRouter`). Cloudflare serves the SPA with
`not_found_handling: "single-page-application"` so all paths resolve to
`index.html`.

### TanStack Query (`@tanstack/react-query`)

Server-state management — all `/api/*` access goes through query/mutation hooks
(`packages/web/src/api/hooks.ts`), with list views using `useSuspenseQuery`. The
`QueryClient` defaults to a 60s `staleTime` and one retry.
`@tanstack/react-query-devtools` is mounted in development. This replaces a
hand-rolled fetch/loading-state layer; no client-state library (Redux/Zustand) is
needed — React context (e.g. `packages/web/src/context/ThemeContext.tsx`) covers
the remaining UI state.

### Tailwind CSS v4 (`@tailwindcss/vite`)

Utility-first styling, integrated as a Vite plugin (no PostCSS config). Tailwind is
imported and themed directly in CSS (`packages/web/src/index.css`:
`@import 'tailwindcss'`, plus the `tw-animate-css` import and the
`tailwindcss-react-aria-components` plugin). Design tokens (colors, the
IBM-Plex-Mono font, radii, light/dark themes) are declared in an `@theme` block
rather than as hand-written `:root` variables.

### shadcn-style primitives (`class-variance-authority`, `clsx`, `tailwind-merge`)

The in-house component set follows the shadcn/ui pattern: variant-driven components
built with `class-variance-authority` (`cva`) and composed via a `cn()` helper
(`packages/web/src/lib/utils.ts`, `clsx` + `tailwind-merge`). Components live in
`packages/web/src/components/ui/` (`Button`, `TextField`, `Dialog`, `sonner`,
`ErrorBoundary`). Icons come from **`lucide-react`** and toasts from **`sonner`**.

### react-aria-components

Accessible UI primitives that the in-house components build on (behavior delegated
to React Aria, styling via Tailwind). `tailwindcss-react-aria-components` provides
Tailwind variants for React Aria states, so the primitives are styled with utility
classes rather than plain CSS.

### Vite + vite-plus

Build tool and dev server. The web app builds with `vite-plus` (`vp`), using
`@vitejs/plugin-react` for JSX transforms and `@tailwindcss/vite` for
Tailwind. The SPA dev server runs on port **5175** and proxies `/api/*` to the
local Node server (`apps/server`, port 3000); the Cloudflare vite-plugin is
intentionally absent — the SPA is a pure consumer of the API, served as static
assets by whatever fronts the deployment.

---

## Build & Dev

### TypeScript

Strict mode across all targets. A root `tsconfig.json` holds the shared compiler
options; each package, app, and example carries its own `tsconfig.json`
(`packages/*/tsconfig.json`, `apps/server/tsconfig.json`,
`examples/*/tsconfig.json`) that extends it and sets package-specific options.

### oxlint + oxfmt

Linting and formatting via the **oxc** (Rust) toolchain — `oxlint` for lint
(`.oxlintrc.json`) and `oxfmt` for formatting (`.oxfmtrc.json`). These replace the
older ESLint + Prettier pairing with a single fast toolchain.

### Vitest

Test runner. Logic is covered by `*.test.ts` files colocated next to the source
in each package (e.g. `packages/core/src/services`, `packages/api/src/routes`,
`packages/storage-s3/src`, the OIDC/Access/dev auth adapters). The `MemoryBucket`
testing adapter (`packages/core/src/testing`) makes service tests run without any
network or R2 binding.

### wrangler

Cloudflare's CLI for deploying the Workers entrypoint and generating binding types
(via `wrangler types`). Configuration lives in
`examples/cloudflare-worker/wrangler.jsonc`, including the `production` environment;
the worker's binding types are declared in `examples/cloudflare-worker/env.d.ts`.

### @cloudflare/workers-types

TypeScript definitions for Worker APIs (`R2Bucket`, `DurableObjectNamespace`, …)
used by the Cloudflare Workers entrypoint (`examples/cloudflare-worker/`).

---

## Design System

### IBM Plex Mono

Primary typeface — a monospace font used throughout for a CLI-inspired aesthetic.
It is declared as both `--font-sans` and `--font-mono` in the Tailwind `@theme`
block, so the monospace identity is preserved everywhere.

### shadcn-style tokens (Tailwind `@theme`)

Design tokens live in `packages/web/src/index.css`. The palette is the shadcn/ui
token set — `oklch` color variables (`--background`, `--foreground`, `--primary`,
`--muted`, `--accent`, `--destructive`, `--border`, `--ring`, chart and sidebar
colors) defined in `:root` and overridden under `.dark` — mapped into Tailwind
utilities via the `@theme inline` block. Both **light and dark** themes are
supported; `--radius: 0` gives the sharp-cornered look.

### Component Library (shadcn-style)

Shared primitives in `packages/web/src/components/ui/`, built with
`class-variance-authority` (`cva`) + the `cn()` helper and layered over
`react-aria-components` for accessible behavior:

- `Button` — variant-driven (`cva`), styled with Tailwind utility classes
- `TextField` — labeled text input
- `Dialog` — accessible modal dialog
- `sonner` — `Toaster` wrapper for toast notifications
- `ErrorBoundary` — class-component fallback UI

---

## Key Dependencies

| Package                             | Purpose                    | Layer / Port |
| ----------------------------------- | -------------------------- | ------------ |
| `hono`                              | HTTP routing & middleware  | API          |
| `@hono/zod-openapi`                 | Typed routes + OpenAPI 3.1 | API          |
| `zod`                               | Validation & data schemas  | API / domain |
| `jose`                              | JWT / OIDC verification    | AuthN        |
| `@cloudflare/sandbox`               | Container DO management    | Compute      |
| `ulidx`                             | ULID ID generation         | domain       |
| `react` / `react-dom`               | UI framework               | Frontend     |
| `react-router-dom`                  | Client-side routing        | Frontend     |
| `@tanstack/react-query`             | Server-state management    | Frontend     |
| `react-aria-components`             | Accessible UI primitives   | Frontend     |
| `tailwindcss` / `@tailwindcss/vite` | Utility-first styling (v4) | Frontend     |
| `class-variance-authority`          | Component variants (cva)   | Frontend     |
| `clsx` / `tailwind-merge`           | `cn()` class composition   | Frontend     |
| `lucide-react`                      | Icon set                   | Frontend     |
| `sonner`                            | Toast notifications        | Frontend     |
| `vite` / `vite-plus`                | Build tool & dev server    | Dev          |
| `@vitejs/plugin-react`              | JSX transform              | Dev          |
| `@cloudflare/workers-types`         | Worker API types           | Dev          |
| `typescript`                        | Type checking              | Dev          |
| `oxlint` / `oxfmt`                  | Lint & format (oxc)        | Dev          |
| `vitest`                            | Test runner                | Dev          |
| `wrangler`                          | Deploy & type generation   | Dev          |
| `tslib`                             | TypeScript runtime helpers | Dev          |

---

## What's NOT Used (and Why)

| Omitted                               | Reason                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Database (D1, SQLite, Postgres)       | The object store is the single source of truth — see [`bucket_spec.md`](./bucket_spec.md) |
| ORM (Drizzle, Prisma)                 | No database to abstract                                                                   |
| Component framework (MUI, Chakra)     | shadcn-style primitives on Tailwind v4 + react-aria-components, owned in-repo             |
| Client-state library (Redux, Zustand) | TanStack Query handles server state; React context covers the rest                        |
| ESLint / Prettier                     | Replaced by the faster oxc toolchain (`oxlint` / `oxfmt`)                                 |
| Custom auth / password store          | Authentication is delegated entirely to OAuth/OIDC providers                              |
