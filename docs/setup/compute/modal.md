<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Create a [Modal](https://modal.com) account.
2. In the dashboard, open **Settings → API Tokens** and create a token (you get
   a token **id** and **secret**).
3. Build/publish a sandbox image (marimo + uv + python).
4. Set the env:

```bash
MARIMOHUB_COMPUTE_BACKEND=modal
MARIMOHUB_COMPUTE_MODAL_TOKEN_ID=…              # secret
MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET=…          # secret
MARIMOHUB_COMPUTE_MODAL_ENVIRONMENT=notebooks   # optional named environment
# MARIMOHUB_COMPUTE_MODAL_SECRETS=shared-credentials,huggingface
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS=1800     # save and stop after 30 idle minutes
# MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS=7200  # optional app override
```

For private [named Modal images](https://modal.com/docs/guide/named-images)
published with `image.publish()`, prefix the name with `modal://`:

```bash
MARIMOHUB_COMPUTE_IMAGE=modal://marimo-sandbox:v1
```

The tag defaults to `latest`. Unqualified names resolve in `MARIMOHUB_COMPUTE_MODAL_ENVIRONMENT`,
or the workspace default when unset. A name that contains `/`, such as
`modal://my-workspace/notebooks/marimo-sandbox:v1`, names its own namespace and ignores
that variable. The configured token must have access to the image.
Registry images and named Modal images can share a
[comma-separated image list](/sandbox-image#multiple-images).

::: tip No infrastructure to run
Modal is fully serverless — nothing to provision or scale, and you pay only for
running kernels. The easiest path if you don't already run a cluster.
:::

The adapter uses the supported Modal JavaScript SDK to create and reconnect to
sandboxes. When `MARIMOHUB_COMPUTE_MODAL_ENVIRONMENT` is set, apps and sandboxes
are isolated in that Modal environment. It passes compute profiles through the
SDK's `cpu`, `memoryMiB`, and `gpu` options. Modal sets its idle timeout to 1.5
times the effective timeout for each session mode. This fallback gives the hub
time to save an edit session and stop its sandbox first.

By default, CPU and memory requests allow Modal to burst above them. When you
[compose the adapter as a library](/deployment-options), set
`ModalConfig.limitResources` to `true` to cap both at their requests:

```ts
import { ModalCompute } from '@marimo-hub/compute-modal';

const compute = new ModalCompute({
	tokenId: '<token-id>',
	tokenSecret: '<token-secret>',
	image: 'ghcr.io/example/marimo-sandbox:latest',
	limitResources: true,
});
```

With this option, each new sandbox requires `resources.cpu` and `resources.memoryBytes`
in `compute.create(id, options)`. CPU uses physical cores, and the SDK truncates it
to millicores (0.001 cores). The adapter rounds memory up to whole MiB.
These converted values become both the requests and limits.
Each value must be between 1 and 4,294,967,295. Invalid values fail before app,
image, or secret resolution. Modal can reject values that exceed its scheduling limits.

This option is available only through library composition. It has no environment
variable. Existing sandboxes keep their limits and need no resource profile for
attachment or destruction. `connectExisting` never creates a replacement.
Resource limits do not cap total charges, which also depend on duration, GPUs,
and data transfer.

`MARIMOHUB_COMPUTE_MODAL_SECRETS` accepts comma-separated
[Modal secret names](https://modal.com/docs/guide/secrets), not secret values.
Every new editor, app, and job sandbox receives them as environment variables
across the deployment.
The secrets must exist in `MARIMOHUB_COMPUTE_MODAL_ENVIRONMENT`, or the workspace
default when unset. An empty or unset list adds none.

Any secret lookup failure prevents sandbox creation. The error names the
secret, the variable, and the Modal environment. The boot preflight also
resolves each secret, so it reports a misspelled name at startup. Existing
sandboxes retain their secrets.

::: warning Deployment-wide secrets
marimohub injects these secrets into every editor, app, and job sandbox in every
project. Any notebook author can read the values. For credentials that belong to
one project, use project integration secret references instead. Secret keys must avoid
[hub-reserved names](/environment-and-access#sandbox-environment). A `MARIMO_*` value
set here takes precedence over the same variable in a project integration.
:::

::: warning Cold starts & shared workspaces
A freshly-started kernel can take a few seconds to boot; a warm sandbox image
([Sandbox image](/sandbox-image)) helps. If multiple apps share one Modal
workspace, set `MARIMOHUB_COMPUTE_MODAL_APP_NAME` so marimohub only reaps its
own sandboxes.
:::
