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
| **Storage** - where notebooks live | CoreWeave CAIOS, AWS S3, MinIO, Cloudflare R2           | [Storage](./storage.md) |
| **Compute** - where kernels run    | CoreWeave Sandboxes, Modal, Kubernetes, Docker          | [Compute](./compute.md) |
| **Auth** - who can sign in         | OpenID Connect (Google, Okta, Auth0), Cloudflare Access | [Auth](./auth.md)       |

Storage is the decision to make first. It holds the durable state and must
support atomic conditional writes.

Optional capabilities:

- [Managed AI](./ai.md) gives notebook users an AI assistant without exposing the
  upstream provider key.
- [Project secrets](./secrets.md) inject selected third-party credentials into
  notebook sandboxes.
- [Syncing](./syncing.md) serves read-only notebooks whose source of truth is
  pushed in from another system.

## 3. Generate configuration

Most operators use environment variables and the prebuilt server. Teams with
custom adapters can compose the packages directly as a library. See
[Deployment options](./deployment-options.md) for the trade-off.

Use the configurator to generate a `.env`, Helm values, Docker Compose service,
or equivalent library wiring.

<DeploymentWizard />

The full generated reference is [Configuration](./configuration.md).

## 4. Deploy and validate

Choose the guide closest to your platform:

- [Helm](./deploying/helm.md)
- [CoreWeave (CKS)](./deploying/cks.md)
- [Kubernetes](./deploying/kubernetes.md)
- [AWS](./deploying/aws.md)
- [GCP](./deploying/gcp.md)
- [Cloudflare](./deploying/cloudflare.md)

After deploy, check `/healthz`, sign in through your auth backend, create a test
project, start a kernel, and confirm a saved notebook survives a restart.

For production operation, read [Security](./security.md),
[Operations](./operations.md), and [Troubleshooting](./troubleshooting.md).
