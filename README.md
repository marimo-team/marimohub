# marimohub

marimohub is a self-hostable platform for storing, managing, and running
[marimo](https://marimo.io) notebooks. It is built for teams that want to run
notebooks on their own infrastructure while choosing their own storage, compute,
and identity providers.

The hub has no separate database. Notebook metadata, versions, snapshots, and
system records live in an object store, so the object store is the source of
truth you back up and recover. External systems sit behind TypeScript ports, so
operators can swap providers without changing the domain logic.

## What you get

- Bring your own **storage**: CoreWeave CAIOS, S3-compatible storage, Google Cloud
  Storage, Azure Blob Storage, filesystem, or Cloudflare R2.
- Bring your own **compute**: CoreWeave Sandboxes, Modal, Kubernetes, Docker,
  Podman, E2B, Cloudflare Containers, or local subprocesses.
- Bring your own **identity**: OpenID Connect or Cloudflare Access.
- Optional managed AI, versioned integrations, encrypted values, external secret
  references, and short-lived federated cloud access.

Use marimohub when you want a self-hosted notebook hub with a small operational
surface and explicit provider choices. If you want a hosted SaaS or do not want
to operate storage, compute, and auth, this is probably not the right shape yet.

## Try it locally

Requirements: Node >= 24, pnpm 10.20.0, and `uv` plus Python if you want to
start local notebook kernels.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The root `pnpm dev` script runs the server and web app with dependency-free
local backends:

- `memory` storage, which is non-durable
- `local` compute, which starts `uv run marimo edit`
- `dev` auth, which signs everyone in as a fixed local user

See [Testing locally](./docs/testing-locally.md) for the full local path and the
production swaps for each backend.

## Deploy it

Most deployments use the config-driven server image: set `MARIMOHUB_*`
environment variables and let `@marimo-hub/config` select the adapters. Custom
runtimes can compose the packages directly as a library.

Start with [Getting started](./docs/getting-started.md), then choose a deployment
guide:

- [Helm](./docs/deploying/helm.md)
- [CoreWeave (CKS)](./docs/deploying/cks.md)
- [Kubernetes](./docs/deploying/kubernetes.md)
- [AWS](./docs/deploying/aws.md)
- [GCP](./docs/deploying/gcp.md)
- [Cloudflare](./docs/deploying/cloudflare.md)

Useful references:

- [Configuration](./docs/configuration.md) - every `MARIMOHUB_*` variable
- [Storage](./docs/storage.md), [Compute](./docs/compute.md), and
  [Auth](./docs/auth.md) - backend choices
- [Security](./docs/security.md), [Operations](./docs/operations.md), and
  [Troubleshooting](./docs/troubleshooting.md) - production operation
- [API & client](./docs/api.md) - HTTP response envelope and generated client

## Contribute

This is a pnpm and vite-plus TypeScript monorepo.

```bash
pnpm check
pnpm test
pnpm build
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. For
architecture and internal design, start with
[development_docs/architecture.md](./development_docs/architecture.md) and
[development_docs/bucket_spec.md](./development_docs/bucket_spec.md). Integration
kind contributors should also read
[development_docs/integrations.md](./development_docs/integrations.md).

marimohub is licensed under the Apache License, Version 2.0. See
[LICENSE](./LICENSE).
