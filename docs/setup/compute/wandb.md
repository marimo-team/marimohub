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
MARIMOHUB_COMPUTE_WANDB_PROJECT=my-project      # optional
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
```

::: tip Same backend as CoreWeave — no hostname config
W&B sandboxes are [CoreWeave Sandboxes](/compute#coreweave) behind the W&B
gateway — same adapter and API; only the credential differs. Kernel URLs are
resolved automatically (the managed runner assigns each kernel its own HTTPS
endpoint), so `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` is not needed. See the
[Configuration reference](/configuration#w-b-sandboxes) for all variables.
:::

Sandboxes created before HTTPS endpoints were enabled retain their HTTP URLs.
The adapter rejects those URLs. Save the notebook files, stop the old session,
and start a new session to create an HTTPS endpoint.

::: warning Gateway limitations
The gateway doesn't support profile/placement overrides, GPU requests, egress
overrides, or automatic CAIOS bucket credentials — for cloud-storage access use
hub-minted [Workload Identity Federation](/workload-identity-federation) instead.

The HTTPS endpoint uses a 900-second request timeout. Setting this timeout to
zero or omitting it restores the 15-second platform default.
See [CoreWeave endpoint timeouts](https://docs.coreweave.com/products/sandboxes/client/ref/networking/endpoints).
The gateway's timeout behavior for upgraded WebSockets remains unverified.
:::
