<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Install the `podman` CLI on the server and configure it for the user running
   marimohub. Local rootless Podman and remote connections are both supported;
   confirm access with `podman info`.
2. Pull or publish a sandbox image containing marimo, uv, and Python.
3. Set the environment:

```bash
MARIMOHUB_COMPUTE_BACKEND=podman
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_PODMAN_HOST=localhost         # hostname used in the kernel URL
MARIMOHUB_COMPUTE_PODMAN_BIND_HOST=127.0.0.1    # keep tokenless kernel ports on loopback
# MARIMOHUB_COMPUTE_PODMAN_NETWORK=marimohub      # optional network to attach kernels to
```

For browsers on another machine, keep the loopback binding and use
[`MARIMOHUB_SANDBOX_EXPOSURE=proxy`](/security#proxy-forwarded-through-the-app)
so kernel traffic goes through the hub's authentication and per-session
authorization.

::: danger Direct kernel exposure
Kernels run without their own authentication token. If you deliberately publish
them directly on a trusted, isolated network, set
`MARIMOHUB_COMPUTE_PODMAN_BIND_HOST=0.0.0.0` **and** set
`MARIMOHUB_COMPUTE_PODMAN_HOST` to the server hostname browsers can reach.
Never expose those ports to the public internet.
:::

The published marimohub server image does not bundle Podman. If the server runs
inside a container, provide a Podman remote client and mount/configure the
appropriate Podman service socket yourself.

::: warning Single host only
Podman creates one container per kernel but does not add cross-host scheduling.
Use `kubernetes` when kernels need cluster scheduling.
:::
