---
description: Install, update, validate, and operate marimohub with its OCI Helm chart.
---

# Deploying with Helm

The [`charts/marimohub`](https://github.com/marimo-team/marimohub/tree/main/charts/marimohub)
chart installs a single-tenant
marimohub on any Kubernetes cluster: one release is one isolated instance backed
by your own storage, compute, and identity provider.

The chart and image are released together to GHCR on every `v*` tag, so the chart
version, chart `appVersion`, and image tag all match — pinning a chart version
pins everything.

## Install

```bash
kubectl create namespace marimohub

# Secret MARIMOHUB_* values (the rest go in -f values.yaml as non-secret config).
kubectl -n marimohub create secret generic marimohub-secrets \
  --from-literal=MARIMOHUB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=... \
  --from-literal=MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID=... \
  --from-literal=MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY=... \
  --from-file=MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY=./github-app.pem

helm upgrade --install marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version <VERSION> -n marimohub -f values.yaml
```

Replace `<VERSION>` with a tag from
[GitHub Releases](https://github.com/marimo-team/marimohub/releases), without
the leading `v`. Start from
[`charts/marimohub/ci/example-values.yaml`](https://github.com/marimo-team/marimohub/blob/main/charts/marimohub/ci/example-values.yaml).
Reference the secret you created with `secrets.existingSecret: marimohub-secrets`.
Use `--from-file=KEY=PATH` for PEMs, certificates, and other multiline values;
Kubernetes preserves their newlines. The chart's development-only `secrets.data`
alternative also accepts YAML block scalars, but places the values in the Helm
release metadata.
The full `MARIMOHUB_*` surface is in [Configuration](../configuration.md).
Set `config.MARIMOHUB_EDITOR_SANDBOX_SHARING` to `shared` or `exclusive`. Before
you change it in an existing deployment, follow the required drain procedure in
[Editor sessions](../editor-sessions.md#changing-the-sharing-mode).

## Update

```bash
helm upgrade marimohub oci://ghcr.io/marimo-team/charts/marimohub \
  --version <VERSION> -n marimohub -f values.yaml
helm rollback marimohub -n marimohub            # revert
helm history marimohub -n marimohub             # what's running
```

For hands-off updates, point [Argo CD Image
Updater](https://argocd-image-updater.readthedocs.io/) or [Flux](https://fluxcd.io/)
at a semver range; the chart works with either.

## What the chart deploys

- **API Deployment** — `replicaCount` stateless replicas (`MARIMOHUB_RUN_MAINTENANCE=false`).
- **Maintenance Deployment** — single replica, `Recreate`, runs the session reaper.
- **ServiceAccount** — release-scoped by default, shared by the API and maintenance pods.
- **ConfigMap** from `config`, **Secret** from `secrets` (or your `existingSecret`),
  both consumed via `envFrom`.
- **Service** (ClusterIP) and an optional **Ingress** with TLS.

Pods run hardened by default (non-root, read-only rootfs, no caps). No
cluster-specific scheduling is baked in; set `nodeSelector` / `tolerations` /
`podLabels` per cluster. The chart covers the marimohub tier only — install your
ingress controller, cert-manager, and any kernel-namespace resources separately
(see [Kubernetes](./kubernetes.md) and [CKS](./cks.md)).

## ServiceAccount

The chart creates a ServiceAccount using its fullname by default. Use annotations
to connect it to a cloud workload identity:

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/marimohub
```

To use an existing account, set `serviceAccount.create: false` and
`serviceAccount.name`. The API and maintenance pods use the same account. The
chart does not create cluster-specific RBAC bindings; install those separately if
the server needs Kubernetes API access. The ServiceAccount configured for kernel
pods is a separate setting:
`config.MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT`.

## Validate

```bash
kubectl -n marimohub get pods
kubectl -n marimohub port-forward svc/marimohub 3000:80
```

Then open the app, sign in, create a notebook, start a kernel, and save it.

## Production cautions

- Pin chart versions. The chart version, app version, and image tag match.
- Keep `secrets.existingSecret` under your secret-management process.
- Run only one maintenance pod.
- Install cluster-specific ingress, TLS, and kernel namespace resources outside
  the chart.

## Troubleshooting

See [Troubleshooting](../troubleshooting.md) and
[`charts/marimohub/README.md`](https://github.com/marimo-team/marimohub/blob/main/charts/marimohub/README.md).

## See also

- [`charts/marimohub/README.md`](https://github.com/marimo-team/marimohub/blob/main/charts/marimohub/README.md)
  — full values reference.
- [Configuration](../configuration.md) for every variable.
