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
```

::: tip Best for CoreWeave deployments
This is the compute half of the [CKS deployment](/deploying/cks) — pair it
with CAIOS storage. If you're already on CoreWeave, it's the lowest-friction
option.
:::

::: warning Ingress is runner-specific
The public kernel URL scheme comes from the runner's default profile. If
kernels don't connect, set `MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE` —
see the [Configuration reference](/configuration#coreweave-sandbox).
:::

::: warning Removed with CoreWeave Sandbox v1
The former `…COREWEAVE_PROFILE`, `…_INGRESS_MODE`, `…_EGRESS_MODE`, and
`…_USER_HOME_PROFILE` variables are rejected at boot: v1 has no per-create
profile selection or network modes. A runner's **default** profile template
decides network, mounts, and placement — pin one with
`MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_IDS`, and give personal storage its own
runner via `…_USER_HOME_RUNNER_IDS`.
:::
