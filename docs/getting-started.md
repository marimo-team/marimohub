# Getting started

MarimoHub is self-hosted: you run it on your own infrastructure and connect the
providers you already use. Setting it up comes down to three choices, then a
deploy.

## 1. Choose your backends

MarimoHub has three pluggable parts. Pick one option for each — and you can
change any of them later without migrating your notebooks.

| Decision                           | Common options                                           | Guide                   |
| ---------------------------------- | -------------------------------------------------------- | ----------------------- |
| **Storage** — where notebooks live | CoreWeave CAIOS · AWS S3 · MinIO · Cloudflare R2         | [Storage](./storage.md) |
| **Compute** — where kernels run    | CoreWeave Sandboxes · Modal · Cloudflare Containers      | [Compute](./compute.md) |
| **Auth** — who can sign in         | OpenID Connect (Google, Okta, Auth0) · Cloudflare Access | [Auth](./auth.md)       |

Storage is the one you most need to get right: it holds all of your data, so it
must be durable and support atomic conditional writes (see [Storage](./storage.md)).

Optionally, turn on [Managed AI](./ai.md) to give every notebook a working AI
assistant without users supplying their own key.

## 2. Configure it

You select and configure backends with `MARIMOHUB_*` environment variables. Most
deployments set these and let the server wire everything up; teams that need
custom adapters can compose MarimoHub as a library instead.

Pick your backends below to generate ready-to-paste config. The **Configs** tab
emits a `.env` file, a Helm `values.yaml` fragment, or a Docker Compose service
(with sane defaults and examples to replace); the **Library** tab emits the
equivalent programmatic wiring for composing MarimoHub as a library. Each output
has **Copy** and **Download** buttons, and your selection is saved in the URL so
you can share it.

<DeploymentWizard />

For the full reference:

- [Deployment options](./deployment-options.md) — environment variables vs. the SDK.
- [Configuration](./configuration.md) — every variable, with defaults and examples.

## 3. Deploy

Ship the container image to your platform of choice:

- [CoreWeave (CKS)](./deploying/cks.md) · [GCP](./deploying/gcp.md) ·
  [AWS](./deploying/aws.md) · [Cloudflare](./deploying/cloudflare.md)

## Want to try it first?

You can run the whole stack on your laptop with no external services — see
[Testing locally](./testing-locally.md).
