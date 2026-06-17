# Deploying on CoreWeave (CKS)

CoreWeave Kubernetes Service runs MarimoHub with CAIOS storage (CoreWeave's
S3-compatible object store) + CoreWeave Sandbox compute + OIDC auth, all on
Kubernetes. This is a general recipe; adapt names and hostnames to your cluster.

## Image

Built from `apps/server/Dockerfile`. It is stateless — all state lives in storage
and compute — so you can run multiple replicas. Serves the API and web UI on
`:3000`.

## Config via a Kubernetes Secret

Keep every `MARIMOHUB_*` var (secret and non-secret) plus `PORT` in a single
Kubernetes Secret (e.g. `marimohub-config`) and have the Deployment consume it via
`envFrom: secretRef`. A secrets manager such as Doppler can sync into that Secret;
otherwise manage it directly. To change a value, update the Secret and restart.

Minimum vars:

```bash
MARIMOHUB_STORAGE_BACKEND=s3          # CAIOS speaks S3
MARIMOHUB_STORAGE_S3_BUCKET=…
MARIMOHUB_STORAGE_S3_ENDPOINT=https://cwobject.com  # CAIOS
MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID=…  MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=…
MARIMOHUB_COMPUTE_BACKEND=coreweave
MARIMOHUB_COMPUTE_COREWEAVE_API_KEY=…  MARIMOHUB_COMPUTE_IMAGE=…
MARIMOHUB_AUTH_BACKEND=oidc           # + OIDC vars (see Auth)
```

## Topology

- **API Deployment** — 2+ replicas, `envFrom` the config Secret.
- **Maintenance** — a separate single-replica Deployment with
  `MARIMOHUB_RUN_MAINTENANCE=true`. Run it on **exactly one** replica.
- **Service** — ClusterIP `:80 → :3000`.
- **Ingress + TLS** — Traefik ingress with a cert-manager certificate; CoreWeave
  auto-creates the `*.coreweave.app` DNS record pointing at the LB.

## See also

- [Storage](../storage.md), [Compute](../compute.md), [Auth](../auth.md)
- [Configuration](../configuration.md) for every variable.
