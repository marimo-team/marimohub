# Testing locally

Run marimohub on your machine with no external services. This is the fastest way
to evaluate the app and test changes before wiring real storage, compute, and
auth providers.

## Prerequisites

- Node >= 24
- pnpm 10.20.0
- `uv` and Python, required only when you start local kernels

## Run the dev stack

```bash
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

The server listens on `PORT` (default `3000`) and serves the API plus built web
assets. The web dev server also runs for frontend development.

## What the local backends mean

| Part    | Local backend           | Production swap                                                 |
| ------- | ----------------------- | --------------------------------------------------------------- |
| Storage | `memory`, volatile      | CAIOS, S3, GCS, or R2 -> [Storage](./storage.md)                |
| Compute | `local`, host process   | CoreWeave, Modal, Kubernetes, Docker -> [Compute](./compute.md) |
| Auth    | `dev`, fixed local user | OIDC or Cloudflare Access -> [Auth](./auth.md)                  |

The local stack is not a production mode. It stores nothing durably, starts
kernels on your machine, and authenticates every request as a fixed development
user.

## Run the server manually

Use a `.env` file only when you want to run the server outside the root
`pnpm dev` script.

```bash
cp apps/server/.env.example .env
```

Then set the same local backend variables shown above and run the server command
you are testing.

## Validate the local run

1. Open the web app.
2. Create a project.
3. Create or upload a notebook.
4. Start a kernel.
5. Stop and restart the dev process.

The project will disappear after restart when you use memory storage. That is
expected; switch to a durable storage backend before keeping real notebooks.

## Next

When you are ready to deploy, go to [Getting started](./getting-started.md) to
choose production backends and generate configuration.
