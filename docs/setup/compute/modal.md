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
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_IDLE_TIMEOUT=20m              # auto-stop idle kernels to control spend
```

::: tip No infrastructure to run
Modal is fully serverless — nothing to provision or scale, and you pay only for
running kernels. The easiest path if you don't already run a cluster.
:::

::: warning Cold starts & shared workspaces
A freshly-started kernel can take a few seconds to boot; a warm sandbox image
([Sandbox image](/sandbox-image)) helps. If multiple apps share one Modal
workspace, set `MARIMOHUB_COMPUTE_MODAL_APP_NAME` so MarimoHub only reaps its
own sandboxes.
:::
