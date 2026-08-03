---
description: Try marimohub locally, choose backends, generate a configuration scaffold, and validate a deployment.
---

# Getting started

marimohub runs on your infrastructure. An operator usually does four things:
try it locally, choose production backends, generate configuration, then deploy.

## 1. Try the local stack

Run the hub with no external services before choosing providers:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The local stack uses memory storage, local subprocess compute, and dev auth. It
is useful for evaluation and development, but it is not durable and must not
serve real users. See [Testing locally](./testing-locally.md) for details.

## 2. Choose production backends

Every deployment picks one option for each port.

| Decision                           | Common options                                          | Guide                   |
| ---------------------------------- | ------------------------------------------------------- | ----------------------- |
| **Storage** - where notebooks live | CAIOS, AWS S3, GCS, Azure Blob Storage, MinIO, R2       | [Storage](./storage.md) |
| **Compute** - where kernels run    | CoreWeave Sandboxes, Modal, Kubernetes, Docker, Podman  | [Compute](./compute.md) |
| **Auth** - who can sign in         | OpenID Connect (Google, Okta, Auth0), Cloudflare Access | [Auth](./auth.md)       |

Storage is the decision to make first. It holds the durable state and must
support atomic conditional writes.

Optional capabilities:

- [Managed AI](./ai.md) gives notebook users an AI assistant without exposing the
  upstream provider key.
- [Environment & cloud access](./environment-and-access.md) configures data sources,
  environment variables, secret sources, and federated cloud access.
- [Syncing](./syncing.md) serves read-only notebooks whose source of truth is
  pushed in from another system.

## 3. Generate configuration

Most operators use environment variables and the prebuilt server. Teams with
custom adapters can compose the packages directly as a library. See
[Deployment options](./deployment-options.md) for the trade-off.

Use the configurator to generate a `.env`, Helm values, Docker Compose service,
or equivalent library wiring. The result is a scaffold: replace every
`_replace_me_` value, using its `# e.g.` comment as a guide, then review the
optional values before deploying.

<DeploymentWizard />

### Non-interactive configuration scaffold

Agents and terminal-only workflows can start from this equivalent S3 + Modal +
OIDC scaffold:

```bash
MARIMOHUB_STORAGE_BACKEND=s3
MARIMOHUB_STORAGE_S3_BUCKET=_replace_me_  # e.g. orgname-marimohub

MARIMOHUB_COMPUTE_BACKEND=modal
MARIMOHUB_COMPUTE_IMAGE=_replace_me_  # e.g. ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_MODAL_TOKEN_ID=_replace_me_
MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET=_replace_me_

MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=_replace_me_  # e.g. https://accounts.example.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=_replace_me_
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=_replace_me_
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=_replace_me_  # e.g. https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET=_replace_me_
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=_replace_me_  # e.g. example.com,example.org
```

Change the selector values and follow [Storage](./storage.md),
[Compute](./compute.md), and [Auth](./auth.md) for other backends. The generated
[Configuration](./configuration.md) reference is authoritative for variable
names, defaults, and requirements.

The full generated reference is [Configuration](./configuration.md).

## 4. Deploy and validate

Choose the guide closest to your platform:

- [Helm](./deploying/helm.md)
- [CoreWeave (CKS)](./deploying/cks.md)
- [Kubernetes](./deploying/kubernetes.md)
- [AWS](./deploying/aws.md)
- [GCP](./deploying/gcp.md)
- [Cloudflare](./deploying/cloudflare.md)

After deploy, check `/api/health`, sign in through your auth backend, create a test
project, start a kernel, and confirm a saved notebook survives a restart.

For production operation, read [Security](./security.md),
[Operations](./operations.md), and [Troubleshooting](./troubleshooting.md).
