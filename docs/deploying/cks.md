---
description: Deploy marimohub on CoreWeave Kubernetes Service with Sandboxes, CAIOS, DNS, TLS, and OIDC.
---

# Deploying on CoreWeave (CKS)

marimohub on CoreWeave: a CKS cluster runs the hub, CoreWeave Sandboxes run
notebook kernels, CAIOS (CoreWeave's S3-compatible object store) holds all
state, and your OIDC provider signs users in. When you're done:

- The hub is at `https://app.<ORG-ID>-marimohub.coreweave.app`
- Kernels are at `https://<sandboxId>.sandbox.<ORG-ID>-marimohub.coreweave.app`
- DNS and TLS for both are automatic (CoreWeave manages `*.coreweave.app`)

Two parts: **[Required](#required-a-working-deployment)** is the bare minimum —
eight steps, one name for everything so they reference each other (every name
is yours to change). **[Optional features](#optional-features)** adds
capabilities one at a time; skip any you don't need.

## Required: a working deployment

### 1. Prerequisites

_Gets you: the accounts, permissions, and tools every step below assumes._

- **A CoreWeave organization** and its **org ID** — the alphanumeric id (like
  `ab12cd`) shown next to the organization name in the
  [Cloud Console](https://console.coreweave.com). Written `<ORG-ID>` below; it
  is part of every public hostname.
- **IAM**: the `SANDBOX_ADMIN` action on your user (Console → **Access
  Policies**), to manage sandbox runners and templates.
- **A CoreWeave API access token** (Console → **Tokens**). It authenticates
  `cwic` and is the hub's sandbox API key. Create it from the account that will
  own the deployment: kernels run under this token's identity, which matters if
  you later grant them [bucket credentials](#automatic-caios-credentials-in-sandboxes).
- **Local tools**: `kubectl`, `helm` (v3.8+), and
  [`cwic`](https://docs.coreweave.com/products/sandboxes/get-started)
  (`cwic auth login`, paste the token).
- **An OIDC identity provider** (Google, Okta, Entra, …) with a registered
  client — issuer URL, client ID, client secret. See [Auth](../auth.md).

No GPU capacity is needed; kernels run on CPU nodes.

### 2. Cluster and node pools

_Gets you: a CKS cluster with one pool for the hub and one for kernels, so
bursty untrusted kernels never compete with the hub and each pool scales on its
own signal._

Console → **Compute → [Clusters](https://console.coreweave.com/clusters) →
Create Cluster**: name it **`marimohub`** (lowercase and short — it is in every
public hostname), newest Kubernetes version, a public Kubernetes API endpoint
(so `kubectl` works from your machine), the default VPC, CKS Managed Auth. When
it is `Healthy`, download the kubeconfig from the cluster page.

Then, from the cluster's **Node Pools** tab, create:

| Pool                  | Runs                            | Sizing                                    |
| --------------------- | ------------------------------- | ----------------------------------------- |
| `marimohub-prod`      | The hub (API + maintenance)     | CPU instance, autoscale 1–2               |
| `marimohub-sandboxes` | Notebook kernels (sandbox pods) | CPU instance, autoscale to concurrent use |

The names become values of the `compute.coreweave.com/node-pool` node label
(used in steps 4 and 7). Nodes take up to ~30 minutes to join —
`kubectl get nodes`.

Details: [Create a CKS cluster](https://docs.coreweave.com/products/cks/clusters/create),
[Node Pools](https://docs.coreweave.com/products/cks/nodes/nodes-and-node-pools).

### 3. Enable the sandbox runner

_Gets you: the CoreWeave-managed component on your cluster that turns the hub's
create requests into kernel pods._

On the cluster page, click **Enable sandbox runner** and wait for `Ready`. The
runner is named after the cluster:

```bash
cwic sandbox runner get marimohub   # INSTALL READY, CONN CONNECTED
```

Kernel pods land in the runner's sandbox namespace, `org-ns-<ORG-ID>` by
default (`kubectl get ns | grep org-ns` after the first kernel). Every kernel's
outbound network comes from the runner's **policy**, and the default is right
for notebooks: public internet allowed (`pip`/`uv`, data APIs); the cluster,
pod, and node-metadata networks blocked. Nothing to change here.

::: details Changing the runner policy safely (when you ever need to)

The policy is one document that `edit` replaces wholesale. Download the live
one, keep that file untouched as your revert target, and edit a copy:

```bash
cwic sandbox runner policy edit marimohub --print-template > runner-policy.yaml
cp runner-policy.yaml custom-runner-policy.yaml
# edit custom-runner-policy.yaml, then:
cwic sandbox runner policy validate -f custom-runner-policy.yaml
cwic sandbox runner policy edit marimohub -f custom-runner-policy.yaml
```

Changes apply to kernels created afterwards; running ones keep their policy.
Revert with `cwic sandbox runner policy edit marimohub -f runner-policy.yaml`.
The one edit this guide ever suggests is the [LOTA carve-out](#automatic-caios-credentials-in-sandboxes).

:::

Details: [Get started with sandboxes](https://docs.coreweave.com/products/sandboxes/get-started),
[Policy reference](https://docs.coreweave.com/products/sandboxes/reference/profile).

### 4. Sandbox template

_Gets you: the shape of every kernel — which port is the kernel and who may
reach it, which node pool, DNS, and `/dev/shm`. The runner has no other place
for these._

Save as `marimohub-template.yaml`:

```yaml
display_name: marimohub # unique within the org
spec:
  containers:
    - name: main # image and command come from the hub at create time
  services:
    - name: kernel
      port: 2718 # marimo's kernel port
      protocol: SERVICE_PROTOCOL_TCP
      visibility: VISIBILITY_CUSTOM
  network:
    ingress:
      - any: true # without this, nothing can reach the kernel port
attachments:
  spec:
    nodeSelector:
      compute.coreweave.com/node-pool: marimohub-sandboxes
    dnsPolicy: None # in-cluster DNS is unreachable under the network policy
    dnsConfig:
      nameservers: [1.1.1.1, 8.8.8.8] # any public resolvers
    enableServiceLinks: false # no cluster Service env vars leaked into kernels
    volumes:
      - name: dshm # Kubernetes defaults /dev/shm to 64Mi
        emptyDir: { medium: Memory, sizeLimit: 8Gi }
    containers:
      - name: main
        volumeMounts:
          - { name: dshm, mountPath: /dev/shm }
```

```bash
cwic sandbox template create -f marimohub-template.yaml   # prints the template id
cwic sandbox template get                                 # lists ids later
```

Keep the id for step 7. To change the template later:
`cwic sandbox template edit <id> -f marimohub-template.yaml` (applies to new
kernels only; `edit` replaces each top-level key you include).

::: details Why the file is shaped this way

- **`VISIBILITY_CUSTOM` + `network.ingress: any`** — CUSTOM means "reachable
  from the sources declared in `network.ingress`"; that rule is what puts an
  inbound allow on the kernel port's NetworkPolicy so the ingress controller
  can reach it. `PUBLIC` visibility needs runner HTTPS endpoint routes, which a
  plain CKS runner doesn't have — the runner rejects it.
- **`attachments`, not `spec`** — the hub overlays the template's container
  (image, keep-alive command, environment) on every create, which replaces
  `spec.containers`. Pod settings and mounts under `attachments` survive that
  overlay. Attachments are admin-only and make the template CKS-only, which is
  what you want.
- **Enum names are spelled in full** (`SERVICE_PROTOCOL_TCP`,
  `VISIBILITY_CUSTOM`); the CLI rejects short forms like `tcp` or `custom`.

:::

### 5. Ingress and TLS

_Gets you: a public entry point with automatic DNS and certificates for the hub
and for every kernel._

CoreWeave's charts install Traefik (public LoadBalancer, IngressClass
`traefik`) and cert-manager with a `letsencrypt-prod` issuer; for
`*.coreweave.app` hosts, DNS records and certificates are automatic.

```bash
helm repo add coreweave https://charts.core-services.ingress.coreweave.com
helm repo update coreweave

helm upgrade --install traefik coreweave/traefik -n traefik --create-namespace

helm upgrade --install cert-manager coreweave/cert-manager -n cert-manager --create-namespace
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=120s
helm upgrade --install cert-manager coreweave/cert-manager -n cert-manager \
  --reuse-values --set cert-issuers.enabled=true
kubectl get clusterissuer   # letsencrypt-prod: Ready
```

The hub creates one Ingress per kernel (in the sandbox namespace, deleted with
the sandbox). Those carry no certificate, so give Traefik a wildcard as its
default — save as `sandbox-tls.yaml` and `kubectl apply -f` it:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: sandbox-wildcard-tls
  namespace: traefik
spec:
  secretName: sandbox-wildcard-tls
  issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
  dnsNames: ['*.sandbox.<ORG-ID>-marimohub.coreweave.app'] # = MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (step 7)
---
apiVersion: traefik.io/v1alpha1
kind: TLSStore
metadata:
  name: default # Traefik's singleton fallback store — the name is fixed
  namespace: traefik
spec:
  defaultCertificate:
    secretName: sandbox-wildcard-tls
```

`kubectl -n traefik get certificate sandbox-wildcard-tls` is Ready in about two
minutes.

::: details Why a default certificate instead of one per kernel

A Kubernetes Ingress can only reference a certificate Secret in its own
namespace, and kernel Ingresses are short-lived objects in the sandbox
namespace. Traefik's `TLSStore` named `default` is a cluster-wide fallback: any
Ingress on port 443 without its own certificate gets the wildcard via SNI. The
app host keeps its own certificate because a specific SNI match beats the
default. One caveat: a later `helm upgrade` of Traefik can reset the TLSStore —
re-apply `sandbox-tls.yaml` if kernel TLS breaks.

:::

Details: [Traefik](https://docs.coreweave.com/products/cks/clusters/coreweave-charts/traefik),
[cert-manager](https://docs.coreweave.com/products/cks/clusters/coreweave-charts/cert-manager).

### 6. CAIOS bucket

_Gets you: the one bucket all hub state lives in — notebooks, projects, the
catalog._

Console → **Storage → Object Storage**: create a bucket (e.g. `marimohub-prod`)
and an access key pair. The S3 endpoint is `https://cwobject.com`; no region
setting is needed. This key pair is for the hub only; notebooks get
[short-lived credentials](#automatic-caios-credentials-in-sandboxes) instead.

Details: [Create buckets](https://docs.coreweave.com/products/storage/object-storage/buckets/create-bucket),
[Access keys](https://docs.coreweave.com/products/storage/object-storage/auth-access/manage-access-keys/create-keys).

### 7. Install marimohub

_Gets you: the hub — API, maintenance worker, Service, and app Ingress — wired
to everything above._

```bash
kubectl create namespace marimohub
kubectl -n marimohub create secret generic marimohub-secrets \
  --from-literal=MARIMOHUB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=... \
  --from-literal=MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID=... \
  --from-literal=MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=... \
  --from-literal=MARIMOHUB_COMPUTE_COREWEAVE_API_KEY=...   # the token from step 1
```

`values.yaml` — substitute `<ORG-ID>`, the template id from step 4, your OIDC
details, and your own email:

```yaml
nodeSelector:
  compute.coreweave.com/node-pool: marimohub-prod

# Grants the hub a Role in this namespace with create, delete, and
# deletecollection on ingresses (teardown deletes by label selector, which
# Kubernetes authorizes as deletecollection). Must equal
# MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE below.
sandboxIngress:
  namespace: org-ns-<ORG-ID>

ingress:
  className: traefik
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  host: app.<ORG-ID>-marimohub.coreweave.app
  tls:
    enabled: true
    secretName: app-tls

config:
  MARIMOHUB_STORAGE_BACKEND: s3
  MARIMOHUB_STORAGE_S3_BUCKET: marimohub-prod
  MARIMOHUB_STORAGE_S3_ENDPOINT: https://cwobject.com

  MARIMOHUB_COMPUTE_BACKEND: coreweave
  MARIMOHUB_COMPUTE_IMAGE: ghcr.io/marimo-team/marimo:latest-sql
  MARIMOHUB_COMPUTE_WORKDIR: /home/appuser/workspace
  MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_ID: marimohub # step 3
  MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID: <TEMPLATE-ID> # step 4
  MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: sandbox.<ORG-ID>-marimohub.coreweave.app
  MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE: https://{sandboxId}.{host}
  MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE: org-ns-<ORG-ID>

  MARIMOHUB_AUTH_BACKEND: oidc
  MARIMOHUB_AUTH_OIDC_ISSUER: https://accounts.google.com
  MARIMOHUB_AUTH_OIDC_CLIENT_ID: ...
  MARIMOHUB_AUTH_OIDC_REDIRECT_URI: https://app.<ORG-ID>-marimohub.coreweave.app/api/auth/callback
  MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: example.com # who may sign in; `*` for anyone
  MARIMOHUB_SUPER_ADMINS: you@example.com # first admin (admin pages, user management)

  PORT: '3000' # the port the chart's Service and probes expect

secrets:
  existingSecret: marimohub-secrets
```

```bash
helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version <VERSION> -n marimohub -f values.yaml   # versions: github.com/marimo-team/marimohub/releases
kubectl -n marimohub get pods,certificate            # app-tls issues in a minute or two
```

::: details What the compute variables do

- **`RUNNER_ID`** pins kernels to your runner. Without it, creates go to
  CoreWeave's serverless pool, not your cluster.
- **`TEMPLATE_ID`** makes every kernel use the step-4 template.
- **`SANDBOX_HOSTNAME` + `HOSTNAME_TEMPLATE`** produce each kernel's URL
  (`https://<sandboxId>.sandbox.…`). **`INGRESS_NAMESPACE`** makes the hub
  publish an Ingress for that host next to the runner's Service, using the
  Role from `sandboxIngress.namespace`. Kernels are on a separate hostname from
  the app by design — origin isolation from untrusted code.
- **`COMPUTE_IMAGE`** is the kernel image; the default works out of the box.
  **`COMPUTE_WORKDIR`** is where notebooks are checked out inside it — it must
  be writable by the image's user and must not be that user's home directory
  (the default image runs as `appuser`, hence `/home/appuser/workspace`). See
  [Sandbox image](../sandbox-image.md) to build your own.

All values: [chart README](https://github.com/marimo-team/marimohub/blob/main/charts/marimohub/README.md);
all variables: [Configuration](../configuration.md).

:::

### 8. Validate

1. `curl https://app.<ORG-ID>-marimohub.coreweave.app/api/health`
2. Sign in, create a project and a notebook, start a kernel.
3. In `org-ns-<ORG-ID>`: a pod on the `marimohub-sandboxes` pool with
   `dnsPolicy: None` and a `dshm` volume, the runner's Service, and a
   `kernel-<sandboxId>` Ingress. The notebook connects at
   `https://<sandboxId>.sandbox.<ORG-ID>-marimohub.coreweave.app`.
4. Save the notebook, `kubectl -n marimohub rollout restart deploy/marimohub`,
   confirm it is still there.

If a new `*.coreweave.app` host doesn't resolve right away, your resolver
negative-cached it — `dig @8.8.8.8 <host>`. Anything else:
[Troubleshooting](#troubleshooting).

That's a complete deployment. Everything below is optional.

## Optional features

### Automatic CAIOS credentials in sandboxes

_Gets you: auto-refreshing, per-kernel credentials for chosen buckets — no keys
in notebooks. Needed when notebooks read or write CAIOS._

Three parties have to agree, and each is configured in a different place:

1. **CoreWeave IAM** — an OIDC config trusting the sandbox gateway issuer
   `https://oidc.cwsandbox.com`, and an org access policy granting that
   identity `cwobject:CreateAccessKeyOIDC` plus the bucket actions.
2. **The sandbox gateway** — a `wif-config` naming the buckets and maximum
   permission kernels may request.
3. **The hub and template** — which buckets each kernel asks for.

Steps 1–2 are in [Workload Identity Federation](../workload-identity-federation.md).
For step 3, set:

```bash
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS=my-data,my-models
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION=read   # or read-write
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_ENDPOINT=https://cwobject.com
```

and declare the same buckets and permission in the template (the per-create
overlay cannot carry them; they must also be within the `wif-config`):

```yaml
spec:
  object_storage_access:
    buckets: [my-data, my-models]
    permission: OBJECT_STORAGE_PERMISSION_READ # or _READ_WRITE
```

Kernels then get `AWS_*` environment variables that boto3, DuckDB, Polars, and
the AWS CLI pick up without configuration.

::: details The access-policy principal (the usual cause of a 403)

The policy statement that grants `cwobject:CreateAccessKeyOIDC` must name the
sandbox token's subject exactly: `role/https://oidc.cwsandbox.com:<sub>`, where
`sub` is `user:<id of the API token's owner>` (step 1). Bucket statements can
use the prefix `role/https://oidc.cwsandbox.com*`. A 403 from
`api.coreweave.com` while minting credentials means this principal doesn't
match — compare it with the `sub` claim of the token at
`$AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` inside a kernel.

:::

::: details Optional: CAIOS through LOTA (`cwlota.com`)

CoreWeave injects `AWS_ENDPOINT_URL_S3=http://cwlota.com` into these kernels —
its in-cluster object-storage accelerator at `10.2.3.4`. The default runner
policy's `except 10.0.0.0/8` blocks that address, which is why the
`OBJECT_STORAGE_ENDPOINT` override above points at the public endpoint (a
hub-set endpoint wins over the injected one).

To use LOTA instead, follow
[Changing the runner policy safely](#_3-enable-the-sandbox-runner) and add a
`/32` to **both** egress lists in `custom-runner-policy.yaml`:

```yaml
constraints:
  network:
    allowed_egress:
      - cidr: { cidr: 0.0.0.0/0, except: [...] } # keep the default entry
      - cidr: { cidr: 10.2.3.4/32 }
    default_egress:
      - cidr: { cidr: 0.0.0.0/0, except: [...] }
      - cidr: { cidr: 10.2.3.4/32 }
```

Apply it, drop the `OBJECT_STORAGE_ENDPOINT` override, and verify from a new
notebook: `socket.create_connection(("10.2.3.4", 80), timeout=5)`. If it still
times out, LOTA is not routable from your cluster — keep the public endpoint.

:::

### User homes (per-user persistent directories)

_Gets you: a private directory for each editor on a shared RWX volume,
surviving across sessions. Needed when editors keep files outside the notebook._

Three pieces: a PVC in the sandbox namespace, a **second** template (the step-4
template plus the volume — so apps and viewer kernels never mount someone's
home), and two hub settings.

::: details 1. The PVC

Any `ReadWriteMany` storage class works; on CoreWeave, `shared-vast`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: user-homes
  namespace: org-ns-<ORG-ID>
spec:
  accessModes: [ReadWriteMany]
  storageClassName: shared-vast
  resources:
    requests:
      storage: 100Gi
```

:::

2. Save as `user-home-template.yaml` and create it:

```yaml
display_name: marimohub-user-home
spec:
  # ... same as marimohub-template.yaml ...
attachments:
  spec:
    # ... same as marimohub-template.yaml, plus:
    volumes:
      - name: user-homes
        persistentVolumeClaim:
          claimName: user-homes
      - name: user-home-links
        emptyDir: {} # makes /mnt writable (created 0777)
    containers:
      - name: main
        volumeMounts:
          - name: user-homes
            mountPath: /var/run/marimohub/user-home
            subPathExpr: $(MARIMOHUB_USER_HOME_KEY) # per-user subdirectory
          - name: user-home-links
            mountPath: /mnt
```

```bash
cwic sandbox template create -f user-home-template.yaml   # prints the template id
```

3. Configure the hub — both together (it refuses one without the other), and
   the two template ids must differ:

```bash
MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive                        # one kernel per editor
MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_TEMPLATE_ID=<USER-HOME-TEMPLATE-ID>
```

Editors then find their directory at `/mnt/<lowercase-email>`.

::: details How the mount works

The hub sets `MARIMOHUB_USER_HOME_KEY` on the container (so `subPathExpr`
selects the user's subdirectory) and symlinks `/mnt/<lowercase-email>` to the
fixed mount path, because Kubernetes does not expand variables in `mountPath`.
The subdirectory must be writable by the image's user (UID 1000 in the default
image); NFSv3 drivers such as VAST create missing `subPathExpr` directories as
`0777`. A user whose email changes gets a new directory. `exclusive` sharing
means each editor gets their own kernel for a notebook instead of joining a
shared one — required so a home is never mounted into someone else's kernel.

:::

### GPU sandboxes

_Gets you: kernels on GPU nodes. Needed for training or large inference._

Add a GPU node pool, then a template with `spec.instance_type` (e.g.
`gd-8xh100ib-i128`) and a matching `nodeSelector` in `attachments`, and point
`MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID` at it. Every kernel then gets a GPU;
per-notebook selection is not available.

### Custom domain

_Gets you: the hub and kernels on your own domain instead of `*.coreweave.app`._

Set `ingress.host` to your domain and point its DNS at the Traefik LoadBalancer
(`kubectl -n traefik get svc`). Add a certificate solver for it (the automatic
DNS-01 solver only covers `*.coreweave.app`), a wildcard on
`*.sandbox.<your-domain>` in the TLSStore, and a matching
`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`.

### Secret management

_Gets you: config and secrets from External Secrets, Vault, Doppler, … instead
of a hand-made Secret._

The chart only needs `secrets.existingSecret`. All config can live in that
Secret with `config: {}`; a change is then a sync plus
`kubectl rollout restart`.

### Faster kernel cold-starts

_Gets you: the sandbox filesystem (venv, caches) restored on the next session._

`MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT=true` — trade-offs in
[Configuration](../configuration.md#coreweave-sandbox).

### Pre-pull the sandbox image

_Gets you: kernel starts that don't wait on a registry pull (≈20 s for a 650 MB
image on a cold node). Needed once the sandbox pool autoscales or you roll
image tags often._

::: details DaemonSet

One init container per tag in `MARIMOHUB_COMPUTE_IMAGE` (and
`MARIMOHUB_DATA_PREVIEW_IMAGE`), then an idle holder:

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
    rollingUpdate: { maxUnavailable: 100% }
  template:
    metadata:
      labels: { app: sandbox-image-prepuller }
    spec:
      nodeSelector:
        compute.coreweave.com/node-pool: marimohub-sandboxes
      tolerations: [{ operator: Exists }]
      initContainers:
        - name: pull
          image: ghcr.io/marimo-team/marimo:latest-sql
          imagePullPolicy: Always # re-fetch when the tag is re-pushed
          command: ['/bin/true']
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          resources:
            requests: { cpu: 1m, memory: 8Mi }
```

Re-apply (with a changed pod annotation) whenever the image changes, before
rolling the hub.

:::

## Production cautions

- Pin the chart version; upgrade deliberately.
- Keep the maintenance Deployment at exactly one replica (the chart enforces it).
- Keep every secret only in the Kubernetes Secret or your secret manager.
- Keep kernels on their own hostname — never serve them from the app origin.
- The runner is managed by CoreWeave and updates on its own schedule;
  `cwic sandbox runner get marimohub` shows its version and health.

## Troubleshooting

Where to look first: the hub's API logs carry one `session_provision` event per
kernel start (`provision_error_code` and the CoreWeave `reason` on failure) —
`kubectl -n marimohub logs deploy/marimohub | grep session_provision`; the
sandbox namespace shows what the runner made —
`kubectl -n org-ns-<ORG-ID> get pods,svc,ingress,networkpolicy` and
`kubectl -n org-ns-<ORG-ID> describe pod <pod>` for events.

::: details Kernel won't start or isn't reachable

- **`CWSANDBOX_SERVICE_VISIBILITY_NOT_SUPPORTED` on create** — the kernel
  service was declared `public`; set `MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE`
  so the hub declares it `custom` and publishes the Ingress itself.
- **Create hangs or "no eligible runner"** — `MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_ID`
  doesn't name your runner; the sandbox was placed elsewhere.
- **Kernel starts but the URL times out** — the template lacks
  `network.ingress: [{ any: true }]`, or the hub has no Role in the sandbox
  namespace (`sandboxIngress.namespace` must equal the namespace variable).
- **502 with valid TLS** — the kernel must listen on `0.0.0.0`; the provisioner
  passes `--host 0.0.0.0`, check anything that overrides the command.
- **Traefik's self-signed certificate** — `sandbox-wildcard-tls` is not Ready,
  or the TLSStore was reset by a Traefik upgrade (step 5).
- **Pod missing the node pool / `dshm` / DNS settings** — they belong in the
  template's `attachments`, or the create isn't using the template
  (`MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID`).
- **File-write error while provisioning** — set `MARIMOHUB_COMPUTE_WORKDIR` to
  a path writable by the image's user.

:::

::: details Storage and user homes

- **CAIOS calls time out from notebooks** — LOTA is not reachable; set
  `MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_ENDPOINT=https://cwobject.com`
  (or allow `10.2.3.4/32` in the runner policy).
- **403 from `api.coreweave.com` when minting credentials** — the access-policy
  principal doesn't match the token subject (see the CAIOS section).
- **`CreateContainerConfigError: missing value for MARIMOHUB_USER_HOME_KEY`** —
  a user-home kernel was created without the hub's container overlay; make sure
  `MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive` is set with the template id.

:::

More in [Troubleshooting](../troubleshooting.md).

## See also

- [Helm](./helm.md) — chart operations (upgrade, rollback, GitOps).
- [Storage](../storage.md), [Compute](../compute.md), [Auth](../auth.md).
- [Configuration](../configuration.md) — every `MARIMOHUB_*` variable.
- [Security](../security.md) — the origin-isolation model for kernels.
