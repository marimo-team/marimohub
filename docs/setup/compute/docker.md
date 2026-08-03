<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Make sure the server has the `docker` CLI on its `PATH` with access to the
   daemon (the local socket, or a remote `DOCKER_HOST`).
2. Pull/publish a sandbox image (marimo + uv + python).
3. Set the env:

```bash
MARIMOHUB_COMPUTE_BACKEND=docker
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_DOCKER_HOST=localhost         # hostname used in the kernel URL
MARIMOHUB_COMPUTE_DOCKER_BIND_HOST=127.0.0.1    # keep tokenless kernel ports on loopback
# MARIMOHUB_COMPUTE_DOCKER_NETWORK=marimo         # optional network to attach kernels to
```

At boot the server shells out `docker info` as a preflight: a missing CLI
(`spawn docker ENOENT`) or an unreachable daemon is reported as a **non-fatal**
`preflight_check` log line with the fix, before anyone opens a notebook.

For browsers on another machine, keep the loopback binding and use
[`MARIMOHUB_SANDBOX_EXPOSURE=proxy`](/security#proxy-forwarded-through-the-app)
so kernel traffic goes through the hub's authentication and per-session
authorization.

::: danger Direct kernel exposure
Kernels run without their own authentication token. If you deliberately publish
them directly on a trusted, isolated network, set
`MARIMOHUB_COMPUTE_DOCKER_BIND_HOST=0.0.0.0` **and** set
`MARIMOHUB_COMPUTE_DOCKER_HOST` to the server hostname browsers can reach.
Never expose those ports to the public internet.
:::

::: tip Simplest self-hosted option
A container per kernel on one box — no cloud account, no cluster. Good for a
single VM or on-prem host: see
[Deploying on a single instance](/deploying/single-instance) for the full
recipe, or
[`examples/docker-compose`](https://github.com/marimo-team/marimohub/tree/main/examples/docker-compose)
for a ready-to-run local stack.
:::

::: warning Single host only
There's no cross-host scheduling, so capacity is capped by one machine. For a
cluster, use `kubernetes`.
:::
