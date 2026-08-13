---
description: Clone and run the full marimohub development stack locally, then verify its API and web app.
---

# Testing locally

Run marimohub on your machine with no external services. This is the fastest way
to evaluate the app and test changes before wiring real storage, compute, and
auth providers.

## Prerequisites

- Node >= 24
- pnpm 10.20.0
- `uv` and Python, required only when you start local kernels

Check the installed versions:

```bash
node --version
pnpm --version
uv --version
python3 --version
```

## Run the dev stack

Clone the repository if you do not already have a checkout, then run from its
root:

```bash
git clone https://github.com/marimo-team/marimohub.git
cd marimohub
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` watches the TypeScript server and runs it with the Vite web server in
parallel. It skips the production server build. The development entrypoint sets:

```bash
MARIMOHUB_STORAGE_BACKEND=memory
MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true
MARIMOHUB_COMPUTE_BACKEND=local
MARIMOHUB_AUTH_BACKEND=dev
MARIMOHUB_SUPER_ADMINS=user@localhost
MARIMOHUB_INTEGRATIONS=on
MARIMOHUB_INTEGRATIONS_PROBE=private
MARIMOHUB_DATA_BROWSER=metadata
```

Startup is ready when the `server` process is listening on port `3000` and the
`web` process prints a Vite local URL on port `5175`. The server owns the API;
the web dev server proxies `/api` requests to it.

`PORT` overrides the API port and `WEB_PORT` overrides the Vite port. For
parallel worktrees, set `DEV_PORT_BASE`; the API uses that port and the web app
uses the next port. Explicit `PORT` and `WEB_PORT` values take precedence:

```bash
DEV_PORT_BASE=4100 pnpm dev
```

## What the local backends mean

| Part    | Local backend           | Production swap                                                         |
| ------- | ----------------------- | ----------------------------------------------------------------------- |
| Storage | `memory`, volatile      | CAIOS, S3, GCS, Azure, or R2 -> [Storage](./storage.md)                 |
| Compute | `local`, host process   | CoreWeave, Modal, Kubernetes, Docker, Podman -> [Compute](./compute.md) |
| Auth    | `dev`, fixed local user | OIDC or Cloudflare Access -> [Auth](./auth.md)                          |

By default, state is held in memory and disappears on restart. The stack starts
kernels on your machine, signs every request in as a fixed super admin, enables
integrations and metadata browsing, and seeds a welcome notebook plus an
org-wide `local-development` environment. Browsing requires a live Trino,
ClickHouse, or Iceberg REST service. None of this changes deployed defaults.

To keep projects and notebooks across restarts, opt into filesystem storage:

```bash
MARIMOHUB_DEV_PERSIST=true pnpm dev
```

This stores local state in `.context/dev-storage`, which is ignored by Git. Stop
the dev stack before clearing it:

```bash
pnpm dev:reset
```

## Run the server manually

The root `pnpm dev` script loads `apps/server/.env` when that file exists. Copy
the example when you want persistent local overrides:

```bash
cp apps/server/.env.example apps/server/.env
```

The development entrypoint overrides storage, compute, auth, access, and feature
values. The file can set other values such as `MARIMOHUB_DEV_PERSIST=true`.
Set port overrides on the root command so the server and web proxy receive the
same values.

## Validate the local run

In another terminal, check the unauthenticated health endpoint:

```bash
curl --fail --silent http://localhost:3000/api/health
```

The expected response is `{"status":"ok"}`. Then:

1. Open `http://localhost:5175`.
2. Open the seeded welcome notebook, or create a project and notebook.
3. Start a kernel. If `uv` and Python are unavailable, stop after step 2.
4. Stop and restart `pnpm dev`.

Projects disappear after restart when you use the default memory storage. That
is expected. Set `MARIMOHUB_DEV_PERSIST=true` for durable local state. Use a
production storage configuration in a deployed environment.

## Next

When you are ready to deploy, go to [Getting started](./getting-started.md) to
choose production backends and generate configuration.
