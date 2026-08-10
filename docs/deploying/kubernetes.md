---
description: Deploy marimohub and isolated notebook kernels on a Kubernetes cluster.
---

# Deploying on Kubernetes (native kernels)

Run marimohub on any Kubernetes cluster with the **`kubernetes`** compute
backend: each notebook kernel becomes a native **Pod + Service + Ingress** that
marimohub creates through the cluster API. This is the portable, cluster-agnostic
alternative to the CoreWeave-Sandbox backend (see [CKS](./cks.md)); it works on
EKS, GKE, AKS, or self-managed clusters.

> **Why native Pods and not the marimo-operator CRD?** marimohub copies notebook
> files into the kernel and runs `uv run marimo edit` itself, which requires a Pod
> it can `exec` into. The marimo-operator's declarative `MarimoNotebook` resource
> runs marimo for you and exposes no exec/file API, so it doesn't fit.

## How it works

For each session the adapter (`@marimo-hub/compute-kubernetes`) creates, in the
kernel namespace:

- a **Pod** `mh-<id>` running the sandbox image with a keep-alive command;
  marimo is started later by `exec`-ing `uv run marimo edit` into it,
- a **ClusterIP Service** `mh-<id>` targeting the kernel port (2718),
- an **Ingress** `mh-<id>` with host `<id>.<hostname>` routing to the Service.

In `subdomain` exposure (the default) the browser connects **directly** to
`https://<id>.<hostname>` (websockets included) through your ingress controller —
marimohub does not proxy kernel traffic. (With `proxy` exposure it forwards kernel
traffic through the app instead; see [Security → Kernel exposure](/security#kernel-exposure).)
Teardown deletes all three objects; background maintenance lists Pods by
the `app.kubernetes.io/managed-by=marimohub` label to find leaked ones.

## Prerequisites

1. **The k8s client in the image.** `@kubernetes/client-node` is a bring-your-own
   runtime dependency (kept out of the lean default image). Add it to your server
   image build: `pnpm add @kubernetes/client-node`.
2. **A sandbox image** with marimo + uv + python3 + git on the PATH
   (`MARIMOHUB_COMPUTE_IMAGE`).
3. **An ingress controller** (Traefik, nginx, …), a **wildcard DNS** record
   `*.<hostname>` pointing at it, and a **wildcard TLS secret** for `*.<hostname>`
   so each `<id>.<hostname>` kernel URL resolves over HTTPS.
4. **RBAC**: marimohub's ServiceAccount needs create/get/list/delete on
   `pods`, `services`, `pods/exec`, and `ingresses` in the kernel namespace (see
   the manifests in `examples/kubernetes`).

## Configuration

```bash
MARIMOHUB_COMPUTE_BACKEND=kubernetes
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=sandboxes.example.net     # kernels at https://<id>.sandboxes.example.net (separate domain from the app)
MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=marimo-kernels
MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS=traefik
MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET=marimo-kernels-wildcard-tls
MARIMOHUB_EDITOR_SANDBOX_SHARING=shared                     # shared | exclusive
# Optional per-kernel resources / scheduling:
# MARIMOHUB_COMPUTE_KUBERNETES_CPU=2
# MARIMOHUB_COMPUTE_KUBERNETES_MEMORY=4Gi
# MARIMOHUB_COMPUTE_KUBERNETES_GPU=1
# MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT=marimo-kernel
# MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET=regcred
# MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY=IfNotPresent   # default: Always for :latest, else IfNotPresent
# MARIMOHUB_COMPUTE_KUBERNETES_POD_READY_TIMEOUT_SECONDS=120
```

See [Configuration → Compute → Kubernetes](../configuration.md#compute) for every
variable. Before you change the sharing mode, follow the drain procedure in
[Editor sessions](../editor-sessions.md#changing-the-sharing-mode). The same
procedure applies when you upgrade from a release without editor claims.

## Startup latency

Each session boots a fresh Pod, so start time is dominated by scheduling and
the image pull. If starts are slow:

1. **Pin the sandbox image by digest** (`image@sha256:…`) or an immutable
   version tag, and roll `MARIMOHUB_COMPUTE_IMAGE` to ship a new one. A pinned
   image gets `imagePullPolicy: IfNotPresent`, so a node that has it never
   contacts the registry; a `:latest`/untagged image gets `Always` (it would go
   stale otherwise) and pays a registry round-trip on every start. Override
   with `MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY` if you know better.
2. **Pre-pull the image on kernel nodes.** The first session on a new node
   pays the full pull. Run a small DaemonSet with the sandbox image, or an
   image-cache operator such as
   [kube-fledged](https://github.com/senthilrch/kube-fledged).
3. **Check scheduling.** Tight CPU/memory/GPU requests, taints, or a cold
   autoscaler show up as a large `schedule_ms` and `FailedScheduling` events.

### Where the time went

Every session start logs a `session_provision` event on the server. Key tags:

| Tag                                 | Meaning                              |
| ----------------------------------- | ------------------------------------ |
| `provision_reachable_schedule_ms`   | Pod created → scheduled              |
| `provision_reachable_image_pull_ms` | image pull (`0` = cached)            |
| `provision_reachable_pod_ready_ms`  | Pod created → ready                  |
| `provision_files_ms`                | workspace copy into the sandbox      |
| `provision_waitport_ms`             | marimo launch until its port answers |

Each boot also logs one `k8s_ensure` line with the cluster-side rows (create,
boot, schedule, image pull, pod ready); `files` and `waitport` appear only on
`session_provision`. From the cluster side:

```bash
kubectl -n marimo-kernels describe pod mh-<id>       # conditions + events
```

Large `image_pull_ms` → steps 1–2. Large `schedule_ms` → step 3. Large
`waitport_ms` with the others small → the kernel env itself is slow to boot
(e.g. `uv` resolving packages on first run — see
[Sandbox image](../sandbox-image.md)).

## Topology

- **API Deployment** — 2+ replicas, runs in the cluster with a ServiceAccount
  bound to the kernel-namespace Role.
- **Maintenance** — a single-replica Deployment with `MARIMOHUB_RUN_MAINTENANCE=true`
  cleans up finished kernel Pods.
- **Kernel namespace** — `marimo-kernels`, where per-session Pods/Services/Ingresses
  live (isolated from marimohub via RBAC and, optionally, NetworkPolicy).

## Validate

1. Check API Deployment readiness and `/api/health`.
2. Create a notebook and start a kernel.
3. Confirm the kernel Pod, Service, and Ingress appear in the kernel namespace.
4. Confirm `https://<id>.<hostname>` resolves and serves the kernel.
5. Stop the session and confirm the per-session objects are deleted.

## Caveats (validate before production)

- Kernel Pods are **bare Pods** (no Deployment/restart): a node failure ends the
  session. That matches the ephemeral one-kernel-per-session model; a `Failed` Pod
  is treated as terminal.
- marimo runs **tokenless** behind marimohub's own auth (the provisioner passes
  `--no-token`); do not expose `*.<hostname>` without marimohub in front.
- The Ingress/TLS scheme is cluster-specific — confirm your ingress controller
  honours per-host rules and the wildcard certificate.
- The per-session Ingress route is created but not waited on, so the kernel
  URL can 404/502 briefly after a session starts. If the window is long, check
  your ingress controller's sync latency.

## Troubleshooting

See [Troubleshooting](../troubleshooting.md), especially kernel reachability and
file-IO errors.

## See also

- [Compute](../compute.md), [Storage](../storage.md), [Auth](../auth.md)
- `examples/kubernetes` — RBAC + Deployment manifests.
- [Configuration](../configuration.md) for every variable.
