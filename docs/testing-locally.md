# Testing locally

Run MarimoHub on your own machine with **no external services** — a quick way to
try it out or develop against it before wiring up real backends.

## Prerequisites

- Node ≥ 22.12 and pnpm 10.20.0
- For local kernels: `uv` + Python on the host

## Run it

```bash
pnpm install
cp apps/server/.env.example .env
```

Set the dependency-free local stack in `.env`:

```bash
MARIMOHUB_STORAGE_BACKEND=memory
MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true   # memory store is non-durable; opt-in required
MARIMOHUB_COMPUTE_BACKEND=local          # spawns `uv run marimo edit` subprocesses
MARIMOHUB_AUTH_BACKEND=dev               # fixed local identity — never use in production
```

```bash
pnpm dev        # runs the server alongside the web dev server
```

`pnpm dev` uses the `memory` / `local` / `dev` backends automatically. The server
listens on `PORT` (default 3000) and serves both the API and the web UI.

## What you're running

These local backends stand in for the real ones you'll choose when you deploy:

| Part    | Local default        | Production swap                             |
| ------- | -------------------- | ------------------------------------------- |
| Storage | in-memory (volatile) | CAIOS / S3 / R2 → [Storage](./storage.md)   |
| Compute | local subprocess     | CoreWeave / Modal → [Compute](./compute.md) |
| Auth    | dev bypass           | OIDC / Access → [Auth](./auth.md)           |

The local stack is for evaluation and development only — it stores nothing
durably and the `dev` auth bypass authenticates everyone as a fixed user.

## Next

When you're ready for a real deployment, see [Getting started](./getting-started.md)
to choose your backends and [Deploying](./deploying/) for platform guides.
