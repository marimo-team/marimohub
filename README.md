# MarimoHub

MarimoHub is a self-hostable, provider-agnostic platform for storing, managing,
and running [marimo](https://marimo.io) notebooks. It is built as
**ports-and-adapters** with **no separate database** — an object store is the
single source of truth (and therefore the one thing you back up; see
[`development_docs/operations.md`](./development_docs/operations.md)), and every
external dependency (storage, compute, identity) sits behind a stable TypeScript
interface so providers can be swapped without touching the domain logic.
Cloudflare (Workers + R2 + Containers + Access) is the reference deployment, but
the same core runs on S3/MinIO, Modal, Docker, or Kubernetes. See
[`development_docs/architecture.md`](./development_docs/architecture.md) for the
full design.

## Quickstart

Requires **Node >= 22.12** and **pnpm 10.20.0** (see `package.json`).

```bash
pnpm install
pnpm check     # typecheck + lint
pnpm test      # run all package tests
pnpm build     # build all packages
```

`pnpm check` runs `vp check` (vite-plus): it typechecks and lints. `pnpm test`
runs every package's `test` script (vitest); `pnpm build` builds every package.

## Local development

For a zero-dependency local run, copy the server env template and select the
in-memory / no-op adapters:

```bash
cp apps/server/.env.example .env
# then set, for a dependency-free local stack:
#   MARIMOHUB_STORAGE_BACKEND=memory
#   MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true
#   MARIMOHUB_COMPUTE_BACKEND=local
#   MARIMOHUB_AUTH_BACKEND=dev
```

With these selectors, storage is held in memory (requires
`MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true`), compute uses the local subprocess
adapter (`uv run marimo edit` — requires `uv` + Python on the host), and
authentication uses a fixed local identity (the `dev` bypass — never enable it
in a deployment that serves real users). The full `MARIMOHUB_*` configuration
surface (storage / compute / auth backends and their adapter-specific settings)
is documented in [`docs/configuration.md`](./docs/configuration.md).

There is also a `pnpm dev` script that builds the server and runs it alongside
the web dev server using the `memory` / `local` / `dev` adapters (with
`MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true`).

## Packages

This is a pnpm + vite-plus TypeScript monorepo. Dependencies point **inward
only**: `core` and `api` never import an adapter; adapters depend on `core`'s
port interfaces; `config` is the only package that imports concrete adapters.

| Package                           | Responsibility                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/core`                   | Domain model, services, and the port interfaces (no vendor SDK)                    |
| `packages/api`                    | OpenAPI/Hono app — wires services to HTTP routes (`@hono/zod-openapi`)             |
| `packages/config`                 | Reads `MARIMOHUB_*` env → selects and wires adapters (only package importing them) |
| `packages/storage-s3`             | S3-compatible storage adapter (AWS S3, MinIO, Tigris, Ceph) + catalog schema       |
| `packages/storage-r2`             | Cloudflare R2 binding storage adapter                                              |
| `packages/storage-gcs`            | Google Cloud Storage adapter (native JSON API, generation-based CAS)               |
| `packages/compute-local`          | Local subprocess compute adapter (`uv run marimo edit`; dev only)                  |
| `packages/compute-cloudflare`     | Cloudflare Containers (Durable Object) compute adapter                             |
| `packages/compute-modal`          | Modal compute adapter                                                              |
| `packages/compute-coreweave`      | CoreWeave Sandboxes compute adapter (vendored `@coreweave/cwsandbox` SDK)          |
| `packages/compute-kubernetes`     | Kubernetes compute adapter (a Pod + Service + Ingress per session)                 |
| `packages/compute-docker`         | Docker compute adapter (a container per kernel on a local/remote engine)           |
| `packages/compute-e2b`            | E2B compute adapter (E2B sandboxes; bring-your-own `e2b` SDK)                      |
| `packages/compute-commons`        | Vendor-free helpers shared by the compute adapters                                 |
| `packages/credentials-coreweave`  | CoreWeave CAIOS credential broker (Workload Identity Federation)                   |
| `packages/auth-oidc`              | Generic OIDC authentication adapter                                                |
| `packages/auth-cloudflare-access` | Cloudflare Access authentication adapter                                           |
| `packages/auth-dev`               | Dev-bypass authenticator (fixed local user; local development only)                |
| `packages/ts-config`              | Shared tsconfig bases (+ vendored ts-reset)                                        |
| `packages/web`                    | React 19 SPA (Tailwind v4 + shadcn-style UI, TanStack Query, React Router)         |
| `packages/client`                 | TypeScript API client                                                              |
| `apps/server`                     | Node entrypoint for Docker / Kubernetes                                            |

Examples (not workspace packages unless noted):

| Example                        | What it shows                                                       |
| ------------------------------ | ------------------------------------------------------------------- |
| `examples/cloudflare-worker`   | Cloudflare Workers entrypoint (R2 + Containers + Access)            |
| `examples/library-composition` | Composing the packages by hand (the library-based / "complex" case) |
| `examples/docker-compose`      | A `docker-compose.yml` for a single-host deployment                 |

## Documentation

**User docs** (`docs/` — getting started + deploying MarimoHub):

- [`docs/getting-started.md`](./docs/getting-started.md) — run it locally and
  understand the moving parts.
- [`docs/deployment-options.md`](./docs/deployment-options.md) — config-driven
  vs. SDK/library composition.
- [`docs/auth.md`](./docs/auth.md), [`docs/storage.md`](./docs/storage.md),
  [`docs/compute.md`](./docs/compute.md) — the three pluggable ports.
- [`docs/deploying/`](./docs/deploying) — platform guides (CKS, GCP, AWS,
  Cloudflare).
- [`docs/configuration.md`](./docs/configuration.md) — the complete, generated
  `MARIMOHUB_*` reference.

**Contributor docs** (`development_docs/` — engineering internals):

- [`development_docs/architecture.md`](./development_docs/architecture.md) —
  design principles, ports & adapters, components, deployment shapes.
- [`development_docs/bucket_spec.md`](./development_docs/bucket_spec.md) — the
  Notebook Storage schema and conditional-write protocol.
- [`development_docs/auth.md`](./development_docs/auth.md),
  [`development_docs/operations.md`](./development_docs/operations.md),
  [`development_docs/migrations.md`](./development_docs/migrations.md),
  [`development_docs/technologies.md`](./development_docs/technologies.md).

Coding agents should also read [`CLAUDE.md`](./CLAUDE.md). Outstanding work is
tracked in [`plans/`](./plans).
