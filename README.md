# MarimoHub

MarimoHub is a self-hostable, provider-agnostic platform for storing, managing,
and running [marimo](https://marimo.io) notebooks. It is built as
**ports-and-adapters** with **no separate database** — an object store is the
single source of truth (and therefore the one thing you back up; see
[`docs/operations.md`](./docs/operations.md)), and every external dependency
(storage, compute, identity) sits behind a stable TypeScript interface so
providers can be swapped without touching the domain logic. Cloudflare (Workers + R2 + Containers + Access) is the
reference deployment, but the same core runs on S3/MinIO, Modal, Docker, or
Kubernetes. See [`docs/architecture.md`](./docs/architecture.md) for the full
design.

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
#   MARIMOHUB_COMPUTE_BACKEND=none
#   MARIMOHUB_AUTH_BACKEND=dev
```

With these three selectors, storage is held in memory, no kernel sandbox is
provisioned, and authentication uses a fixed local identity (the `dev` bypass —
never enable it in a deployment that serves real users). The full
`MARIMOHUB_*` configuration surface (storage / compute / auth backends and their
adapter-specific settings) is documented in
[`docs/architecture.md` §4](./docs/architecture.md#4-configuration-model).

There is also a `pnpm dev` script that builds the server and runs it alongside
the web dev server using the `memory` / `none` / `dev` adapters.

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
| `packages/compute-cloudflare`     | Cloudflare Containers (Durable Object) compute adapter                             |
| `packages/compute-modal`          | Modal compute adapter                                                              |
| `packages/auth-oidc`              | Generic OIDC authentication adapter                                                |
| `packages/auth-cloudflare-access` | Cloudflare Access authentication adapter                                           |
| `packages/auth-dev`               | Dev-bypass authenticator (fixed local user; local development only)                |
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

- [`docs/architecture.md`](./docs/architecture.md) — design principles, ports &
  adapters, components, the `MARIMOHUB_*` configuration model, deployment shapes.
- [`docs/bucket_spec.md`](./docs/bucket_spec.md) — the Notebook Storage schema:
  catalog, snapshots, versioning, sessions, events, and the conditional-write
  protocol.
- [`docs/auth.md`](./docs/auth.md) — authentication backends (OIDC, Cloudflare
  Access, dev), setup, redirect URIs, and a Google example.
- [`docs/technologies.md`](./docs/technologies.md) — concrete library and runtime
  choices.

Coding agents should also read [`CLAUDE.md`](./CLAUDE.md). Outstanding work is
tracked in [`plans/`](./plans).
