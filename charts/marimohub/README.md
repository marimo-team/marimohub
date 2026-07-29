# marimohub Helm chart

Single-tenant: one release is one isolated marimohub backed by your own object
storage, compute, and identity provider.

The chart and image are released together to GHCR on every `v*` tag, so the chart
version, chart `appVersion`, and image tag all match. Pinning a chart version
pins everything.

## Install

```bash
kubectl create namespace marimohub

# Create the secret with your MARIMOHUB_* secret values.
kubectl -n marimohub create secret generic marimohub-secrets \
  --from-literal=MARIMOHUB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=... \
  --from-literal=MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID=... \
  --from-literal=MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=...

helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version 1.4.2 -n marimohub -f my-values.yaml
```

Start from `ci/example-values.yaml`. The full `MARIMOHUB_*` surface is in
[`apps/server/.env.example`](../../apps/server/.env.example).

## Update

```bash
helm upgrade marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version 1.5.0 -n marimohub -f my-values.yaml   # upgrade
helm rollback marimohub -n marimohub               # revert
helm history marimohub -n marimohub                # what's running
```

For hands-off updates, point [Argo CD Image
Updater](https://argocd-image-updater.readthedocs.io/) or
[Flux](https://fluxcd.io/) at a semver range — the chart supports either model.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` | `ghcr.io/marimo-team/marimohub` | |
| `image.tag` | `""` → chart `appVersion` | Override to decouple image from chart version |
| `replicaCount` | `2` | Stateless API replicas |
| `compute.profiles` | `""` | Ordered sandbox CPU/memory profiles; first is the default |
| `maintenance.enabled` | `true` | Singleton session reaper |
| `config` | see `values.yaml` | Non-secret `MARIMOHUB_*` → ConfigMap |
| `secrets.existingSecret` | `""` | Secret you create with the secret vars (recommended) |
| `secrets.data` | `{}` | Or let the chart create the Secret (dev) |
| `ingress.enabled` / `.className` / `.host` | `true` / `""` / `hub.example.com` | |
| `ingress.tls.*` | enabled, `marimohub-tls` | |
| `resources` | 100m/256Mi → 500m/512Mi | API container |
| `nodeSelector` / `tolerations` / `affinity` | empty | Set per cluster |

Pods run hardened by default: non-root (uid 1000), read-only root filesystem, all
capabilities dropped, `RuntimeDefault` seccomp. No cluster-specific scheduling is
baked in, so the chart is portable across any Kubernetes.

The chart sets `MARIMOHUB_RUN_MAINTENANCE` per deployment (`false` on API pods,
`true` on the maintenance pod), overriding any value in `config`. The maintenance
pod is pinned to one replica with the `Recreate` strategy — don't scale it.
