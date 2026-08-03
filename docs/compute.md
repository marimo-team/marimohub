---
description: Select and configure the sandbox backend that runs marimohub notebook kernels.
---

# Compute

Compute is where each notebook's Python kernel runs. The web UI connects to an
on-demand sandbox created by the selected compute backend.

See [Editor sessions](./editor-sessions.md) to choose shared or exclusive access
to persistent editor sandboxes.

Selector: `MARIMOHUB_COMPUTE_BACKEND`. Full variables:
[Configuration -> Compute](./configuration.md#compute).

## Choose a backend

| Backend    | Selector     | Use for                                     |
| ---------- | ------------ | ------------------------------------------- |
| CoreWeave  | `coreweave`  | Production on CoreWeave Sandboxes           |
| W&B        | `wandb`      | CoreWeave Sandboxes via your W&B account    |
| Modal      | `modal`      | Production serverless sandboxes             |
| E2B        | `e2b`        | Managed code sandboxes                      |
| Kubernetes | `kubernetes` | Pods in your own cluster                    |
| Docker     | `docker`     | Single-host container per kernel            |
| Podman     | `podman`     | Rootless or remote container per kernel     |
| Local      | `local`      | Local development with `uv run marimo edit` |
| Cloudflare | `cloudflare` | Workers entrypoint with Containers binding  |
| None       | `none`       | Browse notebooks without runnable kernels   |

## Shared settings

Most production backends need a sandbox image and a public hostname for kernel
traffic:

```bash
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=sandboxes.example.net
```

`MARIMOHUB_COMPUTE_IMAGE` is the per-kernel container you bring. It also accepts
a comma-separated list of images — the first is the default, and the rest are
selectable per notebook (for `e2b`, `MARIMOHUB_COMPUTE_E2B_TEMPLATE` takes a
list of template ids the same way). See [Sandbox image](./sandbox-image.md) for
the contract, a pre-warmed example, and how multiple images behave.

The hub uses `MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS` for its backend-independent
session lifecycle. It saves the session before it asks the compute provider to
stop the sandbox. For Modal, the adapter sets the provider-side idle timeout to
1.5 times this value as a fallback if the scheduled lifecycle sweep cannot run.

`MARIMOHUB_SANDBOX_EXPOSURE` controls how kernels reach the browser:

- `subdomain` (default): kernels are served from an isolated kernel domain.
- `proxy`: kernel traffic is forwarded through the app origin.

See [Security -> Kernel exposure](./security.md#kernel-exposure) for the trust
model.

## Compute profiles

Operators can define named CPU and memory profiles in an ordered list:

```bash
MARIMOHUB_COMPUTE_PROFILES="small:cpu=1;mem=2Gi,large:cpu=8;mem=32Gi"
# Optional: let editors choose a profile per notebook.
MARIMOHUB_COMPUTE_PROFILE_OVERRIDE="editors"
```

- The first profile is the default and applies to every new sandbox. Reordering
  the list changes the default.
- Profile names are stable identifiers. Renaming is remove-and-add; CPU and
  memory values under an existing name can be changed freely.
- Changes apply on the next session start. Running kernels keep their current
  resources. The session details show both the running and selected profile
  until the restart.
- With `MARIMOHUB_COMPUTE_PROFILE_OVERRIDE=editors`, editors can choose a
  non-default profile per notebook. The choice falls back to the first profile
  if that profile is later removed; the stored name is retained in case the
  operator restores it. A viewer's own ephemeral edit kernel always uses the
  default, but the shared notebook app runs the notebook's chosen profile
  regardless of who starts it.
- A failed non-default personal edit session can be retried once on Default
  without changing the notebook's stored choice. Shared apps always use the
  notebook's selected profile.
- A filesystem snapshot restores with the resources it was captured on. The
  session details identify snapshot-backed compute until a fresh sandbox is
  started.
- Docker, Podman, Kubernetes, Modal, CoreWeave, and W&B apply profiles. E2B,
  Cloudflare, local, and none ignore them, hide the feature from the UI, and log
  a startup warning; their existing backend-specific sizing remains unchanged.

Docker and Podman enforce each container's limits but have no admission control.
Ensure the host can accommodate the expected concurrency; N concurrent
sandboxes at the largest profile can exceed the host's capacity.

## Configure it

### CoreWeave

<!--@include: ./setup/compute/coreweave.md-->

### W&B

<!--@include: ./setup/compute/wandb.md-->

### Modal

<!--@include: ./setup/compute/modal.md-->

### E2B

<!--@include: ./setup/compute/e2b.md-->

### Kubernetes

<!--@include: ./setup/compute/kubernetes.md-->

### Docker

<!--@include: ./setup/compute/docker.md-->

### Podman

<!--@include: ./setup/compute/podman.md-->

### Local (dev)

<!--@include: ./setup/compute/local.md-->

### None

<!--@include: ./setup/compute/none.md-->

## Validate it

After deploy:

1. Create or open a notebook.
2. Start a kernel session.
3. Confirm the notebook connects in the browser.
4. Stop the session.
5. Confirm the session disappears from active sessions after the configured
   timeout or cleanup pass.

## Production cautions

- Use an isolated sandbox hostname for `subdomain` mode.
- Set resource limits and idle timeouts before inviting real users.
- Use `none` only when users should browse notebooks without running kernels.
- Keep the sandbox image patched. It is part of the runtime security boundary.

## Troubleshooting

See [Troubleshooting -> Kernels won't start](./troubleshooting.md#kernels-wont-start)
and [Sandbox image](./sandbox-image.md).
