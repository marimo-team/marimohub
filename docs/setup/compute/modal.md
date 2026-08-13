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
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS=1800     # save and stop after 30 idle minutes
```

::: tip No infrastructure to run
Modal is fully serverless — nothing to provision or scale, and you pay only for
running kernels. The easiest path if you don't already run a cluster.
:::

The adapter uses the supported Modal JavaScript SDK to create and reconnect to
sandboxes. When `MARIMOHUB_COMPUTE_MODAL_ENVIRONMENT` is set, apps and sandboxes
are isolated in that Modal environment. It passes compute profiles through the
SDK's `cpu`, `memoryMiB`, and `gpu` options. The provider idle timeout is 1.5
times `MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS`. This interval gives the hub time
to save and stop the session first.

::: warning Cold starts & shared workspaces
A freshly-started kernel can take a few seconds to boot; a warm sandbox image
([Sandbox image](/sandbox-image)) helps. If multiple apps share one Modal
workspace, set `MARIMOHUB_COMPUTE_MODAL_APP_NAME` so marimohub only reaps its
own sandboxes.
:::
