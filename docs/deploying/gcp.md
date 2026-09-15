---
description: Choose GCP compute, storage, and auth, then add private packages, AI, and security controls.
---

# Deploying on GCP

Use this page to choose Google Cloud services for marimohub. The linked setup guides contain the deployment commands and required permissions.

## Compute

The hub serves the API and web UI. The compute backend runs notebook kernels. These can run on different services.

| Hub host                | Notebook compute                             | Setup                                                                 |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| GKE                     | `kubernetes`: one Pod per notebook sandbox   | [Helm](./helm.md) and [Kubernetes](./kubernetes.md)                   |
| Compute Engine Linux VM | `docker`: one container per notebook sandbox | [Single instance](./single-instance.md)                               |
| Cloud Run               | External compute, such as `modal` or `e2b`   | [Compute backends](../compute.md) and the Cloud Run constraints below |

### Image

Run `ghcr.io/marimo-team/marimohub:<VERSION>`, or build `apps/server/Dockerfile` and push it to Artifact Registry. The hub listens on port 3000.

Build a separate [sandbox image](../sandbox-image.md) for notebooks. For GKE, configure Kubernetes RBAC before starting kernels. For subdomain exposure, also configure sandbox ingress and TLS. With `MARIMOHUB_SANDBOX_EXPOSURE=proxy`, kernels need no ingress or TLS configuration. See the [Kubernetes configuration](./kubernetes.md#configuration) for both modes.

### Cloud Run constraints

Cloud Run can host the hub, but marimohub has no Cloud Run notebook compute adapter. This hosting combination requires deployment-specific validation.

Cloud Run limits the lifetime of each WebSocket request. Configure the request timeout and test reconnects. See [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets).

Keep one maintenance process active on GKE or a VM. Alternatively, configure a dedicated Cloud Run service with instance-based billing. Set its minimum and maximum instance counts to one. See [Cloud Run CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings).

Set `MARIMOHUB_RUN_MAINTENANCE=true` on the dedicated maintenance service. Keep it `false` on the API service. Instance counts and CPU allocation do not enable the maintenance loop.

marimohub has no built-in Cloud Scheduler endpoint for maintenance. A scheduled HTTP request does not replace the maintenance loop or job scheduler.

## Storage

| Storage                                                     | Backend | Constraints                                                    |
| ----------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| Cloud Storage bucket                                        | `gcs`   | Native generation preconditions support multiple hub processes |
| Persistent Disk on a Compute Engine VM                      | `fs`    | One hub process with a persistent filesystem mount             |
| Persistent Disk-backed persistent volume claim (PVC) on GKE | `fs`    | Custom volume mount and one hub process, including maintenance |

A PVC stores the hub's catalog and notebook objects through `fs`. It does not configure persistent volumes for notebook kernels. A shared filesystem does not make `fs` safe for multiple hub processes.

### Storage — native GCS

```bash
MARIMOHUB_STORAGE_BACKEND=gcs
MARIMOHUB_STORAGE_GCS_BUCKET=<bucket-name>
MARIMOHUB_STORAGE_GCS_SA_KEY='<service-account-key-json>'
```

Grant the service account `roles/storage.objectAdmin` on the bucket. Store the JSON key as a deployment secret. The adapter uses the key to obtain and refresh access tokens.

The built-in environment configuration requires a service-account key or an explicit `MARIMOHUB_STORAGE_GCS_ACCESS_TOKEN`. It does not discover Application Default Credentials or GKE Workload Identity automatically. An explicit access token does not refresh.

For storage without a key, use [library composition](../deployment-options.md) with the GCS adapter's `getToken` provider. Your provider must obtain fresh credentials from the runtime identity. Assigning a GKE identity alone does not change the built-in storage configuration.

Use the native GCS backend for atomic conditional writes. See [GCS setup](../storage.md#google-cloud-storage) and [filesystem setup](../storage.md#filesystem-setup).

## Auth

Use Google's OIDC provider for browser login:

```bash
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.google.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=<client-id>.apps.googleusercontent.com
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET='<client-secret>'
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET='<at least 32 random bytes>'
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

Register the callback on a Web application OAuth client. Store both secrets in your deployment's secret manager. See [Google login setup](../auth.md#google).

Browser login, hub storage credentials, and notebook cloud access are separate configurations. A user's Google login does not grant their notebook access to Google Cloud resources.

## Features

### Private Python packages with Artifact Registry

Preinstall the credential helper in the sandbox image:

```bash
uv tool install keyring --with keyrings.google-artifactregistry-auth
```

Set the named index and authentication variables in the notebook runtime:

```bash
UV_INDEX='private-registry=https://<region>-python.pkg.dev/<project>/<repository>/simple/'
UV_KEYRING_PROVIDER=subprocess
UV_INDEX_PRIVATE_REGISTRY_USERNAME=oauth2accesstoken
```

Make `keyring` available on the notebook user's `PATH`, outside its per-notebook virtual environment. Configure the helper's Google credentials and grant read access to the repository. Test installation from the notebook environment after token expiry. See [uv's Artifact Registry guide](https://docs.astral.sh/uv/guides/integration/google/).

Runtime variables can come from the image or an [Environment variables integration](../integrations.md#environment-variables). The hub's GCS storage key does not configure the notebook's package helper.

### Managed AI

Use an [OpenAI-compatible upstream](../ai.md#openai-compatible-provider) for notebook assistants. For Vertex AI with Google identity, use a gateway that handles Google authentication and token refresh.

The hub's generic AI backend sends a configured bearer API key. It has no native Google credential provider or token refresh. Configure the hub to use your gateway:

```bash
MARIMOHUB_AI_BACKEND=openai-compatible
MARIMOHUB_AI_UPSTREAM_BASE_URL=https://<gateway-host>/v1
MARIMOHUB_AI_UPSTREAM_API_KEY='<gateway-api-key>'
MARIMOHUB_AI_MODEL=<gateway-model-id>
```

Keep the gateway key in your deployment's secret manager. Managed AI also requires `MARIMOHUB_AUTH_SESSION_SECRET`, configured in the auth example.

### Data and notebook identity

- Add [BigQuery](../integrations.md#bigquery) or [Cloud Storage](../integrations.md#google-cloud-storage) integrations for notebook data.
- On GKE, select a notebook ServiceAccount with `MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT`.
- Configure [GKE Workload Identity Federation](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/workload-identity) for SDKs inside those notebook Pods.

GKE's native identity feature is separate from marimohub's [federation broker](../workload-identity-federation.md). The hub does not currently provide a GCP broker.

## Security

- Give hub and notebook identities separate permissions. Restrict notebook access to the data each workload needs.
- Keep the deployment bucket private. Scope the storage service account to that bucket.
- On GKE, restrict notebook traffic with NetworkPolicy and configure HTTPS for sandbox subdomains.
- Keep the hub's storage key outside notebook images and project environment variables.
- Store deployment secrets in Secret Manager and inject them through your deployment tooling.

Secret Manager injection is deployment configuration. The app has no built-in Google Secret Manager resolver for integration fields. On GKE, a secret synchronization controller can populate [Kubernetes secret references](../integration-secrets.md#kubernetes-secrets).

## Operations

With GCS, run one maintenance replica with `MARIMOHUB_RUN_MAINTENANCE=true`. Set it to `false` on API replicas. With `fs`, set `MARIMOHUB_RUN_MAINTENANCE=true` in the sole hub process. Do not start a separate maintenance process against the same filesystem.

Use [Operations](../operations.md) for backups, logs, metrics, and session limits. If notebook jobs are enabled, keep maintenance active for scheduling and cleanup.

## Validate

1. Check `/api/health` and the authenticated deep health report.
2. Sign in through the configured provider.
3. Create a notebook and start its kernel.
4. Install a private package from the notebook environment.
5. Save the notebook and restart the hub.
6. Check that the notebook persists and the kernel reconnects.
7. If managed AI is enabled, send a request from the notebook assistant.

## Troubleshooting

For GCS authorization failures, check the configured storage credentials first. A GKE identity does not replace `MARIMOHUB_STORAGE_GCS_SA_KEY` in the built-in configuration. See [Troubleshooting](../troubleshooting.md).

## See also

[Storage](../storage.md) · [Compute](../compute.md) · [Auth](../auth.md) · [Configuration](../configuration.md)
