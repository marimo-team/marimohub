# How it works

How MarimoHub fits together, so the choices in
[Getting started](/getting-started) make sense.

## Ports and adapters

MarimoHub depends on three external systems — **storage**, **compute**, and
**identity** — through narrow TypeScript interfaces (_ports_). Each provider is
an _adapter_ behind its port, so you swap providers without touching the domain
logic, and you can switch later without migrating notebooks.

| Port        | What it does            | Adapters                                                                                                 |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **Storage** | Holds all state         | `s3`, `gcs`, `r2`, `memory` — [Storage](/storage)                                                        |
| **Compute** | Runs notebook kernels   | `coreweave`, `modal`, `kubernetes`, `docker`, `e2b`, `local`, `cloudflare`, `none` — [Compute](/compute) |
| **Auth**    | Decides who can sign in | `oidc`, `cloudflare-access`, `dev` — [Auth](/auth)                                                       |

You select an adapter per port with the `*_BACKEND` env vars, and the server
wires everything up. See [Deployment options](/deployment-options) for the
config-driven vs. library-composition paths.

## No database — the object store is the source of truth

There is no separate database. Notebooks, version history, sessions, and a small
`_system/catalog.json` index all live in the object store. That's why the only
hard requirement on storage is **atomic conditional writes**: the catalog
pointer is updated with a compare-and-swap so concurrent edits never corrupt it,
and everything else is immutable or append-only. One consequence: **backing up =
backing up the bucket** (see [Operations](/operations#backups-restore)).

## Request and kernel flow

1. A user signs in through your identity provider; MarimoHub issues a signed
   session cookie.
2. The SPA (served by the same server) calls the JSON API to browse and edit
   notebooks, which read/write the object store.
3. Starting a notebook provisions a **kernel** via the compute adapter — a
   fresh, isolated sandbox running marimo. The notebook's source is copied in
   from storage.
4. The browser reaches the kernel (embedded in a sandboxed iframe) one of two
   ways, set by `MARIMOHUB_SANDBOX_EXPOSURE`: **directly** on a separate domain
   (`subdomain`, the default), or **through the app** at `/proxy/<token>/`
   (`proxy`). See [Security → Kernel exposure](/security#kernel-exposure).
5. On teardown, source (and optionally the whole workspace) is persisted back to
   storage. A single background maintenance loop reaps idle sessions and orphaned
   sandboxes.

## The tiers you deploy

- A **stateless API + web tier** (scale horizontally) that serves the SPA and
  the `/api/*` routes.
- A **single maintenance worker** (`MARIMOHUB_RUN_MAINTENANCE=true` on one
  replica).
- Your **storage**, **compute**, and **identity** providers.

See [Deploying](/deploying/) for platform-specific topologies, and
[Security](/security) for the isolation and trust model.
