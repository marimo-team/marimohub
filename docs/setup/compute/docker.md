<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Make sure the server has the `docker` CLI on its `PATH` with access to the
   daemon (the local socket, or a remote `DOCKER_HOST`).
2. Pull/publish a sandbox image (marimo + uv + python).
3. Set the env:

```bash
MARIMOHUB_COMPUTE_BACKEND=docker
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_DOCKER_HOST=localhost         # hostname in the returned kernel URL
MARIMOHUB_COMPUTE_DOCKER_BIND_HOST=127.0.0.1    # set 0.0.0.0 to expose externally
# MARIMOHUB_COMPUTE_DOCKER_NETWORK=marimo         # optional network to attach kernels to
```

::: tip Simplest self-hosted option
A container per kernel on one box — no cloud account, no cluster. Good for a
single VM or on-prem host. See
[`examples/docker-compose`](https://github.com/marimo-team/marimohub/tree/main/examples/docker-compose)
for a ready-to-run server + storage stack.
:::

::: warning Single host only
There's no cross-host scheduling, so capacity is capped by one machine. Set
`BIND_HOST=0.0.0.0` only if browsers must reach kernels from another host. For a
cluster, use `kubernetes`.
:::
