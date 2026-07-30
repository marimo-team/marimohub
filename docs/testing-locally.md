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

`pnpm dev` builds the server package, watches it, runs the Node server, and runs
the web dev server. It sets the local backend selectors for you:

```bash
MARIMOHUB_STORAGE_BACKEND=memory
MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true
MARIMOHUB_COMPUTE_BACKEND=local
MARIMOHUB_AUTH_BACKEND=dev
```

Startup is ready when the `server` process is listening on port `3000` and the
`web` process prints a Vite local URL on port `5175`. The server owns the API;
the web dev server proxies `/api` requests to it.

## What the local backends mean

| Part    | Local backend           | Production swap                                                         |
| ------- | ----------------------- | ----------------------------------------------------------------------- |
| Storage | `memory`, volatile      | CAIOS, S3, GCS, Azure, or R2 -> [Storage](./storage.md)                 |
| Compute | `local`, host process   | CoreWeave, Modal, Kubernetes, Docker, Podman -> [Compute](./compute.md) |
| Auth    | `dev`, fixed local user | OIDC or Cloudflare Access -> [Auth](./auth.md)                          |

The local stack is not a production mode. It stores nothing durably, starts
kernels on your machine, and authenticates every request as a fixed development
user.

## Run the server manually

The root `pnpm dev` script loads `apps/server/.env` when that file exists. Copy
the example when you want persistent local overrides:

```bash
cp apps/server/.env.example apps/server/.env
```

The script's in-memory storage, local compute, and development-auth defaults
take precedence over the file.

## Validate the local run

In another terminal, check the unauthenticated health endpoint:

```bash
curl --fail --silent http://localhost:3000/api/health
```

It should return `{"status":"ok"}`. Then:

1. Open `http://localhost:5175`.
2. Create a project.
3. Create or upload a notebook.
4. Start a kernel. If `uv` and Python are unavailable, stop after step 3.
5. Stop and restart `pnpm dev`.

The project will disappear after restart when you use memory storage. That is
expected. The local trial succeeded if the health check passed, the web app
loaded, and you could create a project. Switch to a durable storage backend
before keeping real notebooks.

## Next

When you are ready to deploy, go to [Getting started](./getting-started.md) to
choose production backends and generate configuration.
