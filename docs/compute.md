# Compute

Compute is where each notebook's Python kernel actually runs — in an isolated,
on-demand sandbox that the web UI connects to. Pick the backend that matches
where you're hosting.

Selector: `MARIMOHUB_COMPUTE_BACKEND`. Full variables: [Configuration → Compute](./configuration.md#compute).

## Backends

| Backend    | Selector     | Use for                                           |
| ---------- | ------------ | ------------------------------------------------- |
| CoreWeave  | `coreweave`  | Production on CoreWeave Sandboxes (CKS)           |
| Modal      | `modal`      | Production, serverless sandboxes                  |
| E2B        | `e2b`        | Production — managed code sandboxes (e2b.dev)     |
| Kubernetes | `kubernetes` | Production on your own cluster (native Pods)      |
| Docker     | `docker`     | Self-host, single host — a container per kernel   |
| Local      | `local`      | Dev only — `uv run marimo edit` as a subprocess   |
| Cloudflare | `cloudflare` | Workers — Containers via Durable Object binding   |
| None       | `none`       | No kernels (notebooks browsable but not runnable) |

## Shared settings

Most backends need a sandbox image and a public hostname for kernel ports:

```bash
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest  # marimo + uv + python
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=hub.example.com
MARIMOHUB_COMPUTE_IDLE_TIMEOUT=20m
```

`MARIMOHUB_COMPUTE_IMAGE` is the per-kernel container you bring. See
[Sandbox image](./sandbox-image.md) for the contract it must satisfy and a
ready-to-fork example that pre-warms a uv cache so popular libraries start fast.

## Sandbox exposure

`MARIMOHUB_SANDBOX_EXPOSURE` sets how kernels reach the browser, independent of
the backend: `subdomain` (default — direct to an isolated kernel domain) or
`proxy` (forwarded through the app, authenticated). See
[Security → Kernel exposure](/security#kernel-exposure) for the trust model and
config.

## CoreWeave

<!--@include: ./setup/compute/coreweave.md-->

## Modal

<!--@include: ./setup/compute/modal.md-->

## E2B

<!--@include: ./setup/compute/e2b.md-->

## Kubernetes

<!--@include: ./setup/compute/kubernetes.md-->

## Docker

<!--@include: ./setup/compute/docker.md-->

## Local (dev)

<!--@include: ./setup/compute/local.md-->

## None

<!--@include: ./setup/compute/none.md-->

See platform guides under [Deploying](./deploying/) for end-to-end recipes.
