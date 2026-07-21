<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Get a **W&B API key** from your [wandb.ai user settings](https://wandb.ai/settings)
   (optionally note the entity/team and project to attribute sandboxes to).
2. Build or pick a sandbox image (marimo + uv + python), as for
   [CoreWeave](/compute#coreweave).
3. Set the env and start marimohub:

```bash
MARIMOHUB_COMPUTE_BACKEND=wandb
MARIMOHUB_COMPUTE_WANDB_API_KEY=…               # secret
MARIMOHUB_COMPUTE_WANDB_ENTITY=my-team          # optional
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
```

::: tip Same backend as CoreWeave — no hostname config
W&B sandboxes are [CoreWeave Sandboxes](/compute#coreweave) behind the W&B
gateway — same adapter and API; only the credential differs. Kernel URLs are
resolved automatically (the managed runner assigns each sandbox its own public
IP), so `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` is not needed. See the
[Configuration reference](/configuration#w-b-sandboxes) for all variables.
:::

::: warning Gateway limitations
Kernels are served over **plain HTTP** at a per-sandbox public IP — an
HTTPS-served hub will hit mixed-content blocking in the browser, so this
backend currently suits local/HTTP deployments. The gateway also doesn't
support profile/placement overrides, GPU requests, egress overrides, or
automatic CAIOS bucket credentials — for cloud-storage access use hub-minted
[Workload Identity Federation](/workload-identity-federation) instead.
:::
