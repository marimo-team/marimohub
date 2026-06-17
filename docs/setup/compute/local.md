<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Install `uv` and Python on the host running MarimoHub.
2. Set the env:

```bash
MARIMOHUB_COMPUTE_BACKEND=local
# MARIMOHUB_COMPUTE_LOCAL_HOST=localhost      # host the kernel URL points at
# MARIMOHUB_COMPUTE_LOCAL_BIND_HOST=127.0.0.1 # set 0.0.0.0 when running in Docker
# MARIMOHUB_COMPUTE_LOCAL_PORTS=2718-2723     # published port range (required in Docker)
```

::: tip Fastest way to try MarimoHub
Spawns `uv run marimo edit` as a subprocess on the host — nothing to provision.
Great for `pnpm dev` on your laptop.
:::

::: danger Development only
Kernels run as host subprocesses with no isolation, and it only works when the
server runs directly on the host. Never use it for shared or production
deployments — pick `docker`, `kubernetes`, `modal`, `coreweave`, or `e2b`.
:::
