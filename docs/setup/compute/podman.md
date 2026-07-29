<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Install the `podman` CLI on the server and configure it for the user running
   marimohub. Local rootless Podman and remote connections are both supported;
   confirm access with `podman info`.
2. Pull or publish a sandbox image containing marimo, uv, and Python.
3. Set the environment:

```bash
MARIMOHUB_COMPUTE_BACKEND=podman
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_PODMAN_HOST=localhost         # hostname in the returned kernel URL
MARIMOHUB_COMPUTE_PODMAN_BIND_HOST=127.0.0.1    # set 0.0.0.0 to expose externally
# MARIMOHUB_COMPUTE_PODMAN_NETWORK=marimohub      # optional network to attach kernels to
```

The published marimohub server image does not bundle Podman. If the server runs
inside a container, provide a Podman remote client and mount/configure the
appropriate Podman service socket yourself.

::: warning Single host only
Podman creates one container per kernel but does not add cross-host scheduling.
Keep the bind host on loopback unless browsers must reach kernel ports directly;
use `kubernetes` when kernels need cluster scheduling.
:::
