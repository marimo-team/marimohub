<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Get a **CoreWeave Sandbox API key** from your CoreWeave account.
2. Build or pick a sandbox image (marimo + uv + python) and publish it where
   CoreWeave can pull it.
3. Set the env and start marimohub:

```bash
MARIMOHUB_COMPUTE_BACKEND=coreweave
MARIMOHUB_COMPUTE_COREWEAVE_API_KEY=…           # secret
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=hub.example.com
MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_ID=marimohub    # your sandbox runner's id
```

::: tip Best for CoreWeave deployments
This is the compute half of the [CKS deployment](/deploying/cks) — pair it
with CAIOS storage. If you're already on CoreWeave, it's the lowest-friction
option.
:::

::: warning Ingress is runner-specific
The public kernel URL scheme comes from the runner's default policy. If
kernels don't connect, set `MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE` —
see the [Configuration reference](/configuration#coreweave-sandbox).
:::

::: info Per-sandbox customization uses templates
Profiles and network modes are not per-create settings. Sandboxes run under
the runner's default policy unless `MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID`
selects an org-scoped sandbox template; personal storage uses its own
template via `…_USER_HOME_TEMPLATE_ID`.
:::
