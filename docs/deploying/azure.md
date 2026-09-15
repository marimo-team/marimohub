---
description: Choose Azure compute, storage, and auth, then add private packages, AI, and security controls.
---

# Deploying on Azure

Use this page to choose Azure services for marimohub. The linked setup guides contain the deployment commands and required permissions.

## Compute

The hub serves the API and web UI. The compute backend runs notebook kernels. These can run on different services.

| Hub host                       | Notebook compute                             | Setup                                               |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| Azure Kubernetes Service (AKS) | `kubernetes`: one Pod per notebook sandbox   | [Helm](./helm.md) and [Kubernetes](./kubernetes.md) |
| Azure Linux VM                 | `docker`: one container per notebook sandbox | [Single instance](./single-instance.md)             |
| AKS or a VM                    | External compute, such as `modal` or `e2b`   | [Compute backends](../compute.md)                   |

marimohub has no Azure Container Instances or Azure Container Apps notebook compute adapter. Hosting the hub on another container service requires separate validation of networking, WebSockets, and maintenance.

### Image

Run `ghcr.io/marimo-team/marimohub:<VERSION>`, or build `apps/server/Dockerfile` and push it to Azure Container Registry. The hub listens on port 3000.

Build a separate [sandbox image](../sandbox-image.md) for notebooks. For AKS, complete the Kubernetes RBAC, ingress, and TLS setup before starting kernels. Configure registry pull access for the hub and notebook images separately.

## Storage

| Storage                                                | Backend | Constraints                                                    |
| ------------------------------------------------------ | ------- | -------------------------------------------------------------- |
| Blob Storage container                                 | `azure` | Native ETag conditions support multiple hub processes          |
| Managed Disk on an Azure VM                            | `fs`    | One hub process with a persistent filesystem mount             |
| Azure Disk-backed persistent volume claim (PVC) on AKS | `fs`    | Custom volume mount and one hub process, including maintenance |

A PVC stores the hub's catalog and notebook objects through `fs`. It does not configure persistent volumes for notebook kernels. A shared filesystem does not make `fs` safe for multiple hub processes.

### Native Blob Storage

Create a private container, then configure the hub:

```bash
MARIMOHUB_STORAGE_BACKEND=azure
MARIMOHUB_STORAGE_AZURE_CONTAINER=<container-name>
MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL=https://<account-name>.blob.core.windows.net
```

Grant the hub identity `Storage Blob Data Contributor` on the container or account. The adapter uses `DefaultAzureCredential`, including managed identity and workload identity. The container must already exist.

A connection string is also supported. Configure either `MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL` or `MARIMOHUB_STORAGE_AZURE_CONNECTION_STRING`, never both. See [Azure storage setup](../storage.md#azure-blob-storage).

### AKS workload identity

Configure the AKS OIDC issuer, federated identity credential, and ServiceAccount association. With Helm, apply the identity to both API and maintenance Pods:

```yaml
serviceAccount:
  annotations:
    azure.workload.identity/client-id: '<managed-identity-client-id>'
podLabels:
  azure.workload.identity/use: 'true'
```

The Pod label activates Azure's workload identity webhook. It is required in addition to the ServiceAccount annotation. See [Microsoft's workload identity guide](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview).

These chart values configure hub Pods. Notebook Pods use a separate ServiceAccount, selected with `MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT`. The compute adapter has no arbitrary Pod-label configuration. Notebook workload identity therefore needs deployment customization that supplies Azure's required label.

## Auth

Use Microsoft Entra ID through the `oidc` backend:

```bash
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
MARIMOHUB_AUTH_OIDC_CLIENT_ID=<application-client-id>
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET='<client-secret>'
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET='<at least 32 random bytes>'
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

Create an app registration with a Web callback at the exact redirect URI. Store both secrets in your deployment's secret manager. Use a tenant-scoped issuer for a single-tenant deployment.

If your trusted issuer omits `email_verified`, configure `MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION=trusted-issuer`. Keep the email domain allowlist. See [Entra ID setup](../auth.md#microsoft-entra-id) and [OIDC claim requirements](../auth.md#oidc-production).

Browser login does not grant notebook access to Azure resources. Configure notebook cloud permissions separately from the hub's storage identity.

## Features

### Private Python packages with Azure Artifacts

Preinstall the credential helper in the sandbox image:

```bash
uv tool install keyring --with artifacts-keyring
```

Set the named index and authentication variables in the notebook runtime:

```bash
UV_INDEX='private-registry=https://pkgs.dev.azure.com/<organization>/<project>/_packaging/<feed>/pypi/simple/'
UV_KEYRING_PROVIDER=subprocess
UV_INDEX_PRIVATE_REGISTRY_USERNAME=VssSessionToken
```

Make `keyring` available on the notebook user's `PATH`, outside its per-notebook virtual environment. Configure the Azure Artifacts Credential Provider for noninteractive authentication and grant feed read access.

The helper does not inherit browser login or automatically gain access from the hub's Blob Storage identity. Test installation and credential renewal inside the notebook container. See [uv's Azure Artifacts guide](https://docs.astral.sh/uv/guides/integration/azure/).

Runtime variables can come from the image or an [Environment variables integration](../integrations.md#environment-variables).

### Managed AI

Use an [OpenAI-compatible upstream](../ai.md#openai-compatible-provider) for notebook assistants. For Azure OpenAI or Microsoft Foundry, check the endpoint path and authentication contract.

The hub sends `Authorization: Bearer <configured-key>`. It has no native Entra token refresh or Azure-specific `api-key` header configuration. Use a compatible endpoint, or a gateway that handles those requirements. See [Azure API authentication](https://learn.microsoft.com/en-us/azure/ai-services/reference/rest-api-resources).

Configure the gateway as `MARIMOHUB_AI_UPSTREAM_BASE_URL` and keep its key in `MARIMOHUB_AI_UPSTREAM_API_KEY`. Use the gateway's model or deployment identifier as `MARIMOHUB_AI_MODEL`.

### Data and secrets

- Add [Azure Blob Storage](../integrations.md#azure-blob-storage), [Microsoft SQL Server](../integrations.md#microsoft-sql-server), or [Databricks SQL](../integrations.md#databricks-sql) integrations for notebook data.
- Store deployment secrets in Key Vault and inject them through your deployment tooling.
- On AKS, a secret synchronization controller can populate [Kubernetes secret references](../integration-secrets.md#kubernetes-secrets).

The app has no built-in Key Vault resolver for integration fields. It also has no Azure [federation broker](../workload-identity-federation.md). Azure workload identity requires platform configuration.

## Security

- Give hub and notebook identities separate permissions. Scope Blob access to the deployment container.
- Keep Blob containers private. If you use private endpoints, configure DNS and network access from the hub.
- On AKS, restrict notebook traffic with NetworkPolicy and configure HTTPS for sandbox subdomains.
- Keep connection strings and deployment secrets outside notebook images and project environment variables.
- Review [kernel exposure](../security.md#kernel-exposure) before choosing same-origin proxy mode for untrusted users.

## Operations

With Blob Storage, run one maintenance replica with `MARIMOHUB_RUN_MAINTENANCE=true`. Set it to `false` on API replicas. With `fs`, run maintenance in the sole hub process.

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

For Blob authorization failures, check the container role assignment and the runtime identity. On AKS, check the workload identity label on both API and maintenance Pods. See [Troubleshooting](../troubleshooting.md).

## See also

[Storage](../storage.md) · [Compute](../compute.md) · [Auth](../auth.md) · [Configuration](../configuration.md)
