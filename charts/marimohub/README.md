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
  --from-literal=MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=... \
  --from-file=MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY=./github-app.pem

helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version 1.4.2 -n marimohub -f my-values.yaml
```

Start from `ci/example-values.yaml`. The full `MARIMOHUB_*` surface is in
[`apps/server/.env.example`](../../apps/server/.env.example).

Use `--from-file=KEY=PATH` for PEMs, certificates, and other multiline values;
Kubernetes preserves their newlines. Set `secrets.existingSecret` to
`marimohub-secrets` in `my-values.yaml`. For development, `secrets.data` also accepts
YAML block scalars:

```yaml
secrets:
  data:
    MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
```

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
| `serviceAccount.create` / `.name` | `true` / `""` | Create a release-scoped account, or name an existing account |
| `serviceAccount.annotations` | `{}` | Workload identity annotations, such as EKS IRSA or GKE Workload Identity |
| `serviceAccount.automountServiceAccountToken` | `true` | Mount the Kubernetes API token in API and maintenance pods |
| `compute.profiles` | `""` | Ordered sandbox CPU/memory profiles; first is the default |
| `compute.profileOverride` | `none` | Set to `editors` to allow per-notebook profile selection |
| `maintenance.enabled` | `true` | Singleton session reaper |
| `config` | see `values.yaml` | Non-secret `MARIMOHUB_*` → ConfigMap |
| `secrets.existingSecret` | `""` | Secret you create with the secret vars (recommended) |
| `secrets.data` | `{}` | Or let the chart create the Secret (dev) |
| `ingress.enabled` / `.className` / `.host` | `true` / `""` / `hub.example.com` | |
| `ingress.tls.*` | enabled, `marimohub-tls` | |
| `metrics.enabled` / `.port` | `false` / `9464` | Prometheus scrape mode; port exposed on the Service, never the ingress |
| `metrics.serviceMonitor.*` | disabled, `30s`, `{}` labels | Prometheus Operator ServiceMonitor |
| `resources` | 100m/256Mi → 500m/512Mi | API container |
| `nodeSelector` / `tolerations` / `affinity` | empty | Set per cluster |

Pods run hardened by default: non-root (uid 1000), read-only root filesystem, all
capabilities dropped, `RuntimeDefault` seccomp. No cluster-specific scheduling is
baked in, so the chart is portable across any Kubernetes.

The chart sets `MARIMOHUB_RUN_MAINTENANCE` per deployment (`false` on API pods,
`true` on the maintenance pod), overriding any value in `config`. The maintenance
pod is pinned to one replica with the `Recreate` strategy — don't scale it.

### ServiceAccount

By default, the chart creates a ServiceAccount using the chart fullname and uses
it for both the API and maintenance pods. Add cloud workload identity annotations
to the generated account:

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/marimohub
```

To use an account managed outside the chart:

```yaml
serviceAccount:
  create: false
  name: marimohub
```

Set `automountServiceAccountToken: false` when marimohub does not need a projected
Kubernetes token. Keep it enabled for Kubernetes compute and workload identity
providers that use that token. This account belongs to the marimohub control plane;
`config.MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT` separately selects the
ServiceAccount assigned to notebook kernel pods.

The chart does not grant the control-plane account any RBAC permissions. Bind it
to cluster-specific Roles separately, as shown in
[`examples/kubernetes/rbac.yaml`](../../examples/kubernetes/rbac.yaml) for the
native Kubernetes compute backend.
