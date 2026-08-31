---
description: Deploy marimohub and isolated notebook kernels on a Kubernetes cluster.
---

# Deploying on Kubernetes (native kernels)

The **`kubernetes`** compute backend runs each kernel in a native **Pod** behind a
**Service**. Subdomain exposure also creates an **Ingress**. This backend works
on EKS, GKE, AKS, and self-managed clusters. For CoreWeave, see [CKS](./cks.md).

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
- in `subdomain` exposure, an **Ingress** `mh-<id>` with host
  `<id>.<hostname>` routing to the Service.

In default `subdomain` exposure, the browser connects directly to
`https://<id>.<hostname>` through the ingress controller. In `proxy` exposure,
the app forwards traffic to
`http://mh-<id>.<namespace>.svc.cluster.local:2718`. Proxy exposure creates no
Ingress. See [Security → Kernel exposure](/security#kernel-exposure).

Teardown deletes the resources for the selected mode. Maintenance finds leaked
Pods by the `app.kubernetes.io/managed-by=marimohub` label.

## Prerequisites

1. **The k8s client in the image.** `@kubernetes/client-node` is a bring-your-own
   runtime dependency (kept out of the lean default image). Add it to your server
   image build: `pnpm add @kubernetes/client-node`.
2. **A sandbox image** with marimo + uv + python3 + git on the PATH
   (`MARIMOHUB_COMPUTE_IMAGE`).
3. For `subdomain` exposure, configure an **ingress controller** and a
   `*.<hostname>` DNS record. Use a matching wildcard certificate or the
   controller default.
4. **RBAC**: marimohub's ServiceAccount needs create/get/list/update/delete on
   `pods`, `services`, and `pods/exec` in the kernel namespace. Subdomain
   exposure also needs the listed `ingresses` permissions.

## Configuration

```bash
MARIMOHUB_COMPUTE_BACKEND=kubernetes
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=sandboxes.example.net     # kernels at https://<id>.sandboxes.example.net (separate domain from the app)
MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=marimo-kernels
MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS=traefik
MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET=marimo-kernels-wildcard-tls
# OpenShift alternative: replace `traefik` above with the cluster's IngressClass
# (usually `openshift-default`; verify with `oc get ingressclass`), remove or comment
# out the TLS_SECRET line, then uncomment these settings:
# MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=controller-default
# MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS='{"route.openshift.io/termination":"edge"}'
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

For proxy exposure, omit the hostname and all Ingress/TLS settings:

```bash
MARIMOHUB_COMPUTE_BACKEND=kubernetes
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=marimo-kernels
MARIMOHUB_SANDBOX_EXPOSURE=proxy
MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true
```

The internal URL defaults to the Kubernetes DNS suffix `svc.cluster.local`.
Set `MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE` only if the cluster uses a
different DNS domain.

### Changing from subdomain to proxy

::: danger Drain all sessions first
Proxy mode does not query or delete Ingresses.

1. Keep subdomain exposure and Ingress RBAC active.
2. Stop all editor, app, and temporary sessions.
3. Make sure that this command returns no resources:

```bash
kubectl -n marimo-kernels get pods,svc,ingress \
  -l app.kubernetes.io/managed-by=marimohub
```

4. Set `MARIMOHUB_SANDBOX_EXPOSURE=proxy`.
5. Restart all API and maintenance replicas.
6. Remove the Ingress RBAC rule.

If a session survives the change, its tokenless Ingress stays public and becomes
orphaned.
:::

See [Configuration → Compute → Kubernetes](../configuration.md#compute) for every
variable. Before you change the sharing mode, follow the drain procedure in
[Editor sessions](../editor-sessions.md#changing-the-sharing-mode). The same
procedure applies when you upgrade from a release without editor claims.

### OpenShift ingress

OpenShift creates a Route for each sandbox Ingress. Set
`MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=controller-default` to emit the empty
`spec.tls` entry that selects the cluster's default ingress certificate. Use
`MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS` for deployment-controlled
Route annotations. Do not set `MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET` with
this mode. Set `MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS` to the cluster's
IngressClass, usually `openshift-default`; verify it with `oc get ingressclass`.
For example:

```bash
MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS=openshift-default
MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=controller-default
MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS='{"route.openshift.io/termination":"edge"}'
```

The annotation value must be a JSON object whose keys and values are strings.
Keys must use Kubernetes annotation syntax, and their combined size cannot exceed 256 KiB.
Do not select `reencrypt` or `passthrough` unless the sandbox Service is configured
to serve TLS; the standard marimohub sandbox Service serves HTTP.

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
   pays the full pull. Run a DaemonSet on the kernel pool with one init
   container per image tag — see the
   [example on the CKS page](./cks.md#pre-pull-the-sandbox-image), swapping
   the `nodeSelector` for your pool — or an image-cache operator such as
   [kube-fledged](https://github.com/senthilrch/kube-fledged). Match the pull
   policy to the kernel pods': `IfNotPresent` for a digest/pinned image,
   `Always` for a tag you re-push.
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
(for example, `uv` resolving packages on the first run — see
[Sandbox image](../sandbox-image.md)). Super admins can reproduce a cold start
with the
[sandbox startup diagnostic](../operations.md#sandbox-startup-diagnostic).

## Topology

- **API Deployment** — 2+ replicas, runs in the cluster with a ServiceAccount
  bound to the kernel-namespace Role.
- **Maintenance** — a single-replica Deployment with `MARIMOHUB_RUN_MAINTENANCE=true`
  cleans up finished kernel Pods.
- **Kernel namespace** — `marimo-kernels`, where per-session Pods, Services, and
  subdomain-mode Ingresses live (isolated from marimohub via RBAC and, optionally,
  NetworkPolicy).

## Validate

1. Check API Deployment readiness and `/api/health`.
2. Create a notebook and start a kernel.
3. Make sure that the kernel Pod and Service appear. For subdomain exposure,
   make sure that the Ingress appears.
4. Open the kernel through the configured exposure URL.
5. Stop the session. Make sure that Kubernetes deletes its resources.

## Caveats (validate before production)

- Kernel Pods are **bare Pods** (no Deployment/restart): a node failure ends the
  session. That matches the ephemeral one-kernel-per-session model; a `Failed` Pod
  is treated as terminal.
- marimo runs **tokenless** behind marimohub's own auth (the provisioner passes
  `--no-token`); do not expose `*.<hostname>` without marimohub in front.
- In subdomain exposure, the Ingress/TLS scheme is cluster-specific. Confirm
  your ingress controller honours per-host rules and the wildcard certificate.
- A subdomain-mode Ingress route is created but not waited on, so the kernel
  URL can 404/502 briefly after a session starts. If the window is long, check
  your ingress controller's sync latency.

## Troubleshooting

See [Troubleshooting](../troubleshooting.md), especially kernel reachability and
file-IO errors.

## See also

- [Compute](../compute.md), [Storage](../storage.md), [Auth](../auth.md)
- `examples/kubernetes` — RBAC + Deployment manifests.
- [Configuration](../configuration.md) for every variable.
