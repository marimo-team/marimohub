---
description: Deploy marimohub on CoreWeave Kubernetes Service with Sandboxes, CAIOS, DNS, TLS, and OIDC.
---

# Deploying on CoreWeave (CKS)

This is the complete 0→100 guide for running marimohub on CoreWeave: a CKS
cluster running the hub, CoreWeave Sandboxes running notebook kernels, CAIOS
(CoreWeave's S3-compatible object store) holding all state, and OIDC for sign-in.

When you're done you'll have:

- The hub at `https://app.<ORG-ID>-<CLUSTER-NAME>.coreweave.app`
- Kernels at `https://<sandboxId>.sandbox.<ORG-ID>-<CLUSTER-NAME>.coreweave.app`
- Automatic TLS and DNS for both (CoreWeave manages `*.coreweave.app`)

The guide is opinionated — it picks one way to do each step and names things
concretely so the pieces reference each other cleanly. Every name is yours to
change (each step says what else to update if you do), and every step links to
the official CoreWeave docs for alternatives and depth.

## 1. Requirements

Before you start:

- **A CoreWeave account and organization.** You'll need your **org ID** (visible
  in the [Cloud Console](https://console.coreweave.com); an alphanumeric ID like
  `ab12cd`) — it appears in every public hostname below, written as `<ORG-ID>`.
- **IAM permissions**: the `SANDBOX_ADMIN` action (grantable on the Console's
  Access Policies page) to manage sandbox runners and policies.
- **A CoreWeave API access token** from the Console's Tokens page. Copy the
  Token Secret when it's shown — it's used both by the `cwic` CLI and as the
  hub's sandbox API key.
- **Local tools**: `kubectl`, `helm` (v3.8+ for OCI charts), and
  [`cwic`](https://docs.coreweave.com/products/sandboxes/get-started), the
  CoreWeave CLI. Authenticate it once with `cwic auth login` (paste the token).
- **An OIDC identity provider** (Google, Okta, Entra, …) where you can register
  a client. You'll need the issuer URL, client ID, and client secret — see
  [Auth](../auth.md).

No GPU capacity is required — the default setup runs CPU sandboxes. GPUs are an
[optional add-on](#gpu-sandboxes).

## 2. Create a CKS cluster

In the Console, open **Compute → [Clusters](https://console.coreweave.com/clusters)**
and click **Create Cluster**:

1. **Setup** — name the cluster **`marimohub`**. Lowercase letters, numbers, and
   hyphens only. Keep it short: the cluster name is baked into every public
   hostname (`<ORG-ID>-<CLUSTER-NAME>.coreweave.app`), so a long name makes long
   URLs. (CoreWeave's docs suggest zone-first names like `use04a-prod` — also
   fine, just longer.) Pick the newest available Kubernetes version and leave internet API
   access enabled (you'll manage the cluster with `kubectl` from your machine).
2. **Network** — pick a zone with available capacity and let CoreWeave create a
   default VPC unless you have one already.
3. **Auth** — skip the optional webhook/OIDC settings; CKS Managed Auth is fine.
4. **Deploy** — review and **Submit**.

The cluster shows `Creating`, then `Healthy` once the control plane is up. Get
`kubectl` access from the cluster page (CKS Managed Auth generates a kubeconfig
for you) and confirm with `kubectl get nodes` (no nodes until step 3).

Details and Terraform equivalents: [Create a CKS cluster](https://docs.coreweave.com/products/cks/clusters/create)
and [Managed Authentication](https://docs.coreweave.com/products/cks/auth-access/managed-auth/kubeconfig).

## 3. Create two node pools

A new cluster has no compute until you add Node Pools. Create two, from the
cluster's **Node Pools** tab (**Create Node Pool**):

| Pool                  | Runs                                    | Sizing                                                          |
| --------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `marimohub-prod`      | The hub (API + maintenance deployments) | CPU instance, autoscale 1–2                                     |
| `marimohub-sandboxes` | Notebook kernels (sandbox pods)         | CPU instance, autoscale to your expected concurrent-kernel load |

Two pools keep bursty, untrusted kernel workloads from competing with (or being
scheduled next to) the hub itself, and let each pool scale on its own signal.
Only the hub and kernels get pinned to a pool; cluster services like Traefik and
cert-manager (step 6) are unpinned and schedule onto whatever capacity exists.

The pool names become values of the `compute.coreweave.com/node-pool` node
label. Later steps pin the hub to `marimohub-prod` (Helm values, step 8) and
kernels to `marimohub-sandboxes` (runner policy, step 5) — if you pick other
names, update those two places.

Node provisioning can take up to ~30 minutes. `kubectl get nodes` shows them as
they join.

Details, autoscaler behavior, and manifest-based management:
[Node Pools](https://docs.coreweave.com/products/cks/nodes/nodes-and-node-pools).

## 4. Enable the sandbox runner

The **runner** is the CoreWeave-managed workload on your cluster that receives
sandbox placement decisions and creates kernel pods. Enable it from the Console:

1. Open your cluster on the **Clusters** page.
2. In the **Sandbox runner** card, click **Enable sandbox runner**.
3. Wait for the runner status to go from `Pending` to `Ready`.

The managed runner is named after the cluster (`marimohub` here). Verify from
your machine:

```bash
cwic sandbox runner get marimohub
```

The `INSTALL` and `CONN` columns should read `READY` and `CONNECTED`. The
runner comes with a default sandbox policy — you'll review it next.

Details: [Get started with CoreWeave sandboxes](https://docs.coreweave.com/products/sandboxes/get-started).

## 5. Sandbox templates (optional)

Every sandbox runs under the runner's **default policy** — namespace,
network, and pod shape — and the shipped default is good, so a fresh
deployment can leave this step for later. Verify two things in it (and edit
the default with `cwic sandbox runner policy edit marimohub` if you prefer
changing it over templating):

- **Ingress.** The browser connects to kernels **directly** (not proxied
  through the hub), so each sandbox must be published at a predictable
  per-sandbox hostname. Note the ingress `template` suffix —
  `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` (step 8) must match it, and the
  wildcard DNS + TLS (steps 6 and 9) must cover it. To serve kernels through
  the cluster's own Traefik on your domain, set:

  ```yaml
  ingress:
    controllerName: traefik
    template: '{{.SandboxID}}.sandbox.<ORG-ID>-marimohub.coreweave.app'
  ```

- **Egress.** Kernels need outbound internet (`pip`/`uv` installs, data APIs)
  but should not reach the internal network. Verify the default allows the
  public internet while the RFC1918/link-local ranges (node metadata
  endpoint, pod/service network) stay unreachable; pin any internal host
  kernels may still reach with its own /32.

Beyond the default policy, customization is per-create via org-scoped
**sandbox templates**:

```bash
RUNNER_ID=marimohub
# shows the runner's templates
cwic sandbox runner edit $RUNNER_ID --print-template
```

### Optional: a marimohub template

Create a template for custom specs — GPU placement, denied egress, or pod
tweaks like node-pool pinning and a larger `/dev/shm`:

```yaml
spec:
  pod:
    spec:
      # Pin kernels to the sandbox pool from step 3.
      nodeSelector:
        compute.coreweave.com/node-pool: marimohub-sandboxes
      enableServiceLinks: false
      # Notebook code does not need access to the Kubernetes API.
      automountServiceAccountToken: false
      # Kubernetes defaults /dev/shm to 64Mi; data tools (DuckDB, PyTorch
      # dataloaders, Arrow) want much more.
      volumes:
        - name: dshm
          emptyDir:
            medium: Memory
            sizeLimit: 8Gi
      containers:
        # An entry with an empty name patches the sandbox's main container.
        - name: ''
          resources: {}
          volumeMounts:
            - name: dshm
              mountPath: /dev/shm
```

Save it as `marimohub-template.yaml`, create the template (note the id the
CLI prints), and attach it to the runner:

```bash
cwic sandbox template create -f marimohub-template.yaml
cwic sandbox runner edit $RUNNER_ID   # add the template id to the runner
```

Set `MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID=<template-id>` (step 8) and every
sandbox is created from it; omit the variable to use the default policy.

Policy and template schema, egress allowlists, and examples:
[Configure a sandbox profile](https://docs.coreweave.com/products/sandboxes/profiles/configure),
[Profiles overview](https://docs.coreweave.com/products/sandboxes/profiles/profiles),
[Profile examples](https://docs.coreweave.com/products/sandboxes/profiles/profile-examples).

### User-home template (optional per-user VAST directories)

Personal storage uses a second template that only adds the per-user mount —
no egress or network customization needed. Keep the normal template (or
default policy) without this volume: notebook apps are shared across users
and must not inherit the starter's directory. The PVC must exist in the
sandbox namespace, and each selected directory must be writable by the
sandbox image's user (`appuser`, UID 1000 in the default image). The
shared-vast `csi.vastdata.com` driver with NFSv3 allows kubelet to create a
missing `subPathExpr` directory automatically as `root:root` mode `0777`, so
that setup needs no directory pre-provisioner. Verify the behavior with your
CSI configuration. If your setup creates `root:root` mode `0755`, use a
supported `fsGroup` or a root init container to grant UID 1000 access. The
template's additional Pod fields:

```yaml
spec:
  namespace:
    strategy: static
    staticNamespace: marimohub-sandboxes
  pod:
    spec:
      # ... include the marimohub template's pod settings here (node-pool
      # pinning, automountServiceAccountToken, /dev/shm) — templates do not
      # inherit from each other.
      volumes:
        - name: user-homes
          persistentVolumeClaim:
            claimName: vast-user-homes
        - name: user-home-links
          emptyDir: {}
      initContainers:
        - name: prepare-user-home-links
          image: busybox:1.37
          command: ['sh', '-c', 'chmod 1777 /links']
          volumeMounts:
            - name: user-home-links
              mountPath: /links
      containers:
        - name: ''
          volumeMounts:
            - name: user-homes
              mountPath: /var/run/marimohub/user-home
              subPathExpr: $(MARIMOHUB_USER_HOME_KEY)
            - name: user-home-links
              mountPath: /mnt
```

Create and attach it the same way:

```bash
cwic sandbox template create -f user-home-template.yaml
cwic sandbox runner edit $RUNNER_ID
```

marimohub creates editor sandboxes with personal storage from this template:

```yaml
MARIMOHUB_EDITOR_SANDBOX_SHARING: exclusive
MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_TEMPLATE_ID: <USER-HOME-TEMPLATE-ID>
```

Kubernetes does not expand environment variables in `mountPath`, so marimohub
creates `/mnt/<lowercase-email>` as a symlink to the isolated VAST mount. The
`emptyDir` makes `/mnt` writable without running the sandbox as root. marimohub
refuses to enable user homes unless editor sharing is `exclusive`, and refuses
to start when the normal and user-home template ids are the same. Because the
`emptyDir` is mounted at `/mnt`, it shadows anything the sandbox image placed
there. A user whose email changes receives a different directory; migrate or
alias that data before changing the identity-provider email.

## 6. Install the ingress stack (Traefik + cert-manager)

Both the hub and every sandbox are served through **Traefik**, with certificates
from **cert-manager** — installed once per cluster from CoreWeave's vetted
charts:

```bash
helm repo add coreweave https://charts.core-services.ingress.coreweave.com
helm repo update coreweave

# Traefik: public LoadBalancer + IngressClass `traefik`.
helm upgrade --install traefik coreweave/traefik -n traefik --create-namespace

# cert-manager: controller + CRDs first, then the bundled ClusterIssuers
# (two steps — the issuers need the CRDs established first).
helm upgrade --install cert-manager coreweave/cert-manager -n cert-manager --create-namespace
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=120s
helm upgrade --install cert-manager coreweave/cert-manager -n cert-manager \
  --reuse-values --set cert-issuers.enabled=true

kubectl get clusterissuer   # expect letsencrypt-prod: Ready
```

Everything downstream is automatic for `*.coreweave.app` hosts: when an Ingress
deploys, CoreWeave creates the DNS A record pointing at the Traefik
LoadBalancer, and the `letsencrypt-prod` ClusterIssuer issues certificates via
CoreWeave's DNS-01 webhook solver — no HTTP-01 challenges, no manual DNS.

Details: [Traefik](https://docs.coreweave.com/products/cks/clusters/coreweave-charts/traefik)
and [cert-manager](https://docs.coreweave.com/products/cks/clusters/coreweave-charts/cert-manager)
on CoreWeave Charts.

## 7. Create a CAIOS bucket

All hub state — notebooks, projects, the catalog — lives in one object-storage
bucket. In the Console, open **Storage → Object Storage**:

1. Create a bucket, e.g. **`marimohub-prod`**. Any name works and it only
   appears in config, but a suffixed name leaves room for siblings later — a
   `marimohub-backup` replication target, a `marimohub-staging` instance.
2. Create an access key pair and save both halves.

The S3 endpoint for CAIOS is `https://cwobject.com`.

Details: [Create buckets](https://docs.coreweave.com/products/storage/object-storage/buckets/create-bucket)
and [Create access keys](https://docs.coreweave.com/products/storage/object-storage/auth-access/manage-access-keys/create-keys).

::: tip Long-lived keys are only needed by the hub
This key pair is used by the hub server only. Notebooks that need bucket access
should use short-lived credentials instead — see
[Optional: automatic bucket credentials in sandboxes](#automatic-caios-credentials-in-sandboxes).
The hub can also use short-lived credentials from an annotated ServiceAccount.
See [Pod Identity](#caios-credentials-from-a-serviceaccount).
:::

## 8. Install marimohub with Helm

The [`marimohub` chart](./helm.md) deploys the stateless API (2 replicas), the
single-replica maintenance deployment, a Service, and the app Ingress. Chart,
app, and image versions are released together — pinning one pins all.

First the namespace and the Secret holding every sensitive value:

```bash
kubectl create namespace marimohub

kubectl -n marimohub create secret generic marimohub-secrets \
  --from-literal=MARIMOHUB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=... \
  --from-literal=MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID=... \
  --from-literal=MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=... \
  --from-literal=MARIMOHUB_COMPUTE_COREWEAVE_API_KEY=...   # the API token from step 1
```

Then `values.yaml` (substitute `<ORG-ID>`, and your names if they differ):

```yaml
replicaCount: 2

# Run the hub on its node pool (step 3).
nodeSelector:
  compute.coreweave.com/node-pool: marimohub-prod

# CoreWeave taints on reserved/interruptable capacity; harmless if your pool
# has none.
tolerations:
  - key: qos.coreweave.cloud/interruptable
    operator: Exists
    effect: NoExecute
  - key: node.coreweave.cloud/reserved
    operator: Exists
    effect: NoExecute
  - key: node.coreweave.cloud/evict
    operator: Exists
    effect: NoExecute

# Admits hub pods through the per-sandbox NetworkPolicies the runner creates,
# so the hub's WebSocket proxy can reach kernels. Must be your org ID.
podLabels:
  sandbox.coreweave.com/sandbox-organization-id: '<ORG-ID>'

# Spread the two replicas across distinct nodes; with DoNotSchedule this also
# nudges the marimohub-prod autoscaler to add the second node.
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule
    minDomains: 2

ingress:
  className: traefik
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  host: app.<ORG-ID>-marimohub.coreweave.app
  tls:
    enabled: true
    secretName: app-tls

config:
  # Storage — CAIOS (step 7)
  MARIMOHUB_STORAGE_BACKEND: s3
  MARIMOHUB_STORAGE_S3_BUCKET: marimohub-prod
  MARIMOHUB_STORAGE_S3_ENDPOINT: https://cwobject.com

  # Compute — CoreWeave Sandboxes (steps 4–5)
  MARIMOHUB_COMPUTE_BACKEND: coreweave
  MARIMOHUB_COMPUTE_IMAGE: ghcr.io/marimo-team/marimo:latest-sql
  MARIMOHUB_COMPUTE_WORKDIR: /home/appuser/workspace
  MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: sandbox.<ORG-ID>-marimohub.coreweave.app
  # No {port}: Traefik routes the hostname to the kernel port.
  MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE: https://{sandboxId}.{host}

  # Auth — your OIDC provider (see docs/auth.md)
  MARIMOHUB_AUTH_BACKEND: oidc
  MARIMOHUB_AUTH_OIDC_ISSUER: https://accounts.google.com
  MARIMOHUB_AUTH_OIDC_CLIENT_ID: ...
  MARIMOHUB_AUTH_OIDC_REDIRECT_URI: https://app.<ORG-ID>-marimohub.coreweave.app/api/auth/callback
  MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: example.com

  PORT: '3000'

secrets:
  existingSecret: marimohub-secrets
```

Two values worth calling out:

- `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` must match the hostname suffix in the
  runner policy's ingress `template` (step 5). Kernels are on a **separate hostname
  from the app by design** — origin isolation between untrusted kernel code and
  the hub UI.
- `MARIMOHUB_COMPUTE_IMAGE` is the kernel image. `ghcr.io/marimo-team/marimo:latest-sql`
  works out of the box (it runs as a non-root user whose writable home is
  `/home/appuser`, so this config uses `/home/appuser/workspace`). To build your
  own, see [Sandbox image](../sandbox-image.md).

Install:

```bash
helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version <VERSION> -n marimohub -f values.yaml
```

Watch `kubectl -n marimohub get pods` and
`kubectl -n marimohub get certificate` (the `app-tls` cert issues in a minute
or two). The full values surface is in the
[chart README](https://github.com/marimo-team/marimohub/blob/main/charts/marimohub/README.md);
every `MARIMOHUB_*` var is in
[Configuration](../configuration.md).

## 9. Wildcard TLS for sandbox kernels

The app Ingress carries its own certificate, but the per-sandbox Ingresses are
created by the CoreWeave runner from the policy's `ingress` block — which has
no TLS fields — so they can't reference a certificate themselves. The fix is a
**Traefik default certificate**: one wildcard cert that Traefik serves as the
SNI fallback for every certless Ingress, in any namespace.

Apply this once (substitute `<ORG-ID>`; both resources must be in the `traefik`
namespace, and the TLSStore **must** be named `default` — it's Traefik's global
singleton fallback store, so it affects any other certless Ingress on the
cluster too):

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: sandbox-wildcard-tls
  namespace: traefik
spec:
  secretName: sandbox-wildcard-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - '*.sandbox.<ORG-ID>-marimohub.coreweave.app'
---
apiVersion: traefik.io/v1alpha1
kind: TLSStore
metadata:
  name: default
  namespace: traefik
spec:
  defaultCertificate:
    secretName: sandbox-wildcard-tls
```

```bash
kubectl apply -f sandbox-tls.yaml
kubectl -n traefik get certificate sandbox-wildcard-tls   # Ready in ~2 min
```

The app host is unaffected — a specific SNI match (`app-tls`) always beats the
default. Note that a later `helm upgrade` of the Traefik chart can overwrite the
TLSStore; re-apply if kernel TLS breaks after a Traefik upgrade.

## 10. Validate

1. `curl https://app.<ORG-ID>-marimohub.coreweave.app/api/health`
2. Sign in through your OIDC provider.
3. Create a project and a notebook.
4. Start a kernel — a sandbox pod appears in the org namespace, and the
   notebook connects at `https://<sandboxId>.sandbox.…coreweave.app`.
5. Save the notebook, then `kubectl -n marimohub rollout restart deploy/marimohub`
   and confirm the notebook is still there.

If a fresh `*.coreweave.app` hostname doesn't resolve immediately, your local
resolver may have negative-cached it before CoreWeave's record propagated —
`dig @8.8.8.8 <host>` to check.

## Optional configuration

Everything above is a complete deployment. These are add-ons.

### Automatic CAIOS credentials in sandboxes

Give every kernel automatic, auto-refreshing credentials for selected CAIOS
buckets — no keys in notebooks. After a one-time org setup (OIDC config for
issuer `https://oidc.cwsandbox.com` + the org `wif-config`), set:

```bash
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS=my-data,my-models
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION=read   # or read-write
```

Full setup and the alternative hub-minted federation flow:
[Workload Identity Federation](../workload-identity-federation.md).

### CAIOS credentials from a ServiceAccount

CoreWeave's **Pod Identity Webhook** can supply short-lived CAIOS credentials.
It uses your cluster's OIDC issuer and an annotated ServiceAccount.

Add the ServiceAccount to `spec.pod.spec.serviceAccountName` in the runner
policy. The webhook can also supply credentials to the hub pods.

Do not set the CoreWeave bucket list for this method. Set the endpoint and
region:

```bash
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_ENDPOINT=https://cwobject.com
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_REGION=us-east-04a
```

For setup steps, access policies, and trade-offs, see
[Pod Identity](../workload-identity-federation.md#example-coreweave-object-storage-pod-identity).

### GPU sandboxes

Create a sandbox template whose pod placement requests GPU instance types
(`spec.pod.placement.instanceTypes`, e.g. `gd-8xh100ib-i128`) backed by a GPU
node pool, and select it via `MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID`. See
[Profile examples](https://docs.coreweave.com/products/sandboxes/profiles/profile-examples).

### Custom domain

Set `ingress.host` in `values.yaml` to your domain and point its DNS at the
Traefik LoadBalancer (`kubectl -n traefik get svc`). You'll also need a
certificate solver for that domain (the automatic DNS-01 solver only covers
`*.coreweave.app`) and, for kernels, a wildcard on your own
`*.sandbox.<your-domain>` plus matching `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`
and the runner policy's ingress `template`.

### Secret management

Instead of a hand-made Secret, sync `marimohub-secrets` from a manager
(External Secrets Operator, Vault, Doppler, …). The chart only needs
`secrets.existingSecret` to name it. You can also put **all** config (not just
secrets) in that one Secret and leave `config: {}` — then a config change is a
sync + `kubectl rollout restart`.

### Faster kernel cold-starts

`MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT=true` snapshots the sandbox
filesystem (venv, caches) on teardown and restores it next session. See
[Configuration](../configuration.md#coreweave-sandbox) for the trade-offs.

### Pre-pull the sandbox image

Sandbox pods run on your sandbox node pool and pull `MARIMOHUB_COMPUTE_IMAGE`
through the node's image cache. A node that does not have the tag yet pays a
full registry pull on the session's critical path (≈20 s for a 650 MB image
from ghcr.io), and a registry hiccup fails the start outright. This hits every
new node in the pool and every tag you roll. Both `coreweave_ensure` and
[`sandbox_startup_diagnostic`](../operations.md#sandbox-startup-diagnostic) flag
this condition. A `boot_ms` value of more than 10 s includes a `slow_boot_hint`.

Keep every tag warm with a DaemonSet on the pool — one init container per
image, then an idle holder:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sandbox-image-prepuller
spec:
  selector:
    matchLabels: { app: sandbox-image-prepuller }
  updateStrategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 100% } # warm every node at once
  template:
    metadata:
      labels: { app: sandbox-image-prepuller }
    spec:
      nodeSelector:
        compute.coreweave.com/node-pool: sandboxes # your sandbox pool
      tolerations: [{ operator: Exists }]
      imagePullSecrets: [{ name: ghcr-credentials }] # optional for a public image
      initContainers:
        # One per tag in MARIMOHUB_COMPUTE_IMAGE (and MARIMOHUB_DATA_PREVIEW_IMAGE).
        - name: pull-py313
          image: ghcr.io/marimo-team/marimo-sandbox:py3.13-marimo0.23.16
          imagePullPolicy: Always
          command: ['/bin/true']
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          resources:
            requests: { cpu: 1m, memory: 8Mi }
```

Use `imagePullPolicy: Always` on the pull containers: sandbox pods pull with
`Always`, so when you re-push a tag the prepuller must fetch the new digest
rather than hold the old one. An unchanged tag costs one manifest check.
Re-apply (with a changed pod annotation so the pods roll) whenever you change
`MARIMOHUB_COMPUTE_IMAGE`, before rolling the hub.

## Production cautions

- Pin the chart version; upgrade deliberately (`helm upgrade --version …`).
- Keep the API Deployment stateless and the maintenance Deployment at exactly
  one replica (the chart enforces both).
- Keep CAIOS keys, the CoreWeave API token, OIDC client secret, and session
  secret only in the Kubernetes Secret (or your secret manager).
- Keep kernels on their own hostname — never serve them from the app origin.
- The runner is managed by CoreWeave and updates independently of your Helm
  releases; `cwic sandbox runner get marimohub` shows its version and health.

## Troubleshooting

- **Kernel URL returns 502 with valid TLS** — the kernel process must bind
  `0.0.0.0`, not `127.0.0.1` (Traefik connects to the pod IP). The provisioner
  already passes `--host 0.0.0.0`; check anything that overrides the kernel
  command.
- **Kernels never become reachable** — verify `…_SANDBOX_HOSTNAME` matches
  the runner policy's ingress `template` suffix exactly (step 5).
- **Kernel TLS shows the Traefik default self-signed cert** — the
  `sandbox-wildcard-tls` Certificate isn't Ready, or the TLSStore was
  overwritten by a Traefik chart upgrade (step 9).
- **Provisioning fails with a file-write error** — the image's workdir isn't
  writable; set `MARIMOHUB_COMPUTE_WORKDIR` to a writable path in your image.

More in [Troubleshooting](../troubleshooting.md), especially login failures and
kernel reachability.

## See also

- [Helm](./helm.md) — chart operations (upgrade, rollback, GitOps).
- [Storage](../storage.md), [Compute](../compute.md), [Auth](../auth.md).
- [Configuration](../configuration.md) — every `MARIMOHUB_*` variable.
- [Security](../security.md) — the origin-isolation model for kernels.
