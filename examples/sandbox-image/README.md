# Example sandbox image (bring your own container)

The container a marimohub deployment runs **one of per notebook kernel** — point
`MARIMOHUB_COMPUTE_IMAGE` at it and the `docker` / `kubernetes` / `modal` /
`coreweave` backends launch it per session. It's separate from the server image
(`apps/server/Dockerfile`). See [Sandbox image](../../docs/sandbox-image.md) for
the full contract.

This example ships `uv` + git + a writable `/workspace` and **pre-installs** marimo
and popular libraries (polars, narwhals, numpy, pandas, pyarrow, altair, duckdb)
into the project environment, so the base-case kernel starts instantly — no
per-launch install.

## Build & push

marimo is **pinned** via the `MARIMO_VERSION` build arg (default in the
Dockerfile). Tag the image with the Python + marimo version so it's traceable and
never upgrades unexpectedly:

```sh
docker build --build-arg MARIMO_VERSION=0.23.10 \
  -t ghcr.io/<you>/marimo-sandbox:py3.13-marimo0.23.10 examples/sandbox-image
docker push ghcr.io/<you>/marimo-sandbox:py3.13-marimo0.23.10
```

Then point the deployment at that exact tag:

```sh
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/<you>/marimo-sandbox:py3.13-marimo0.23.10
```

To **upgrade marimo**, bump `MARIMO_VERSION`, rebuild, and retag — it's a
deliberate, manual step, never automatic.

## How it works

The provisioner runs, in `/workspace/notebooks`:

```sh
uv sync --inexact --no-compile-bytecode   # add the notebook's deps, keep the pre-installed base
uv run --no-sync marimo edit notebook.py …
```

marimo + the base libraries are already installed in `/opt/venv`
(`UV_PROJECT_ENVIRONMENT`), so a notebook that only uses them starts with no
install. The notebook's `pyproject.toml` lists only its own extra libraries.

## Customize

- **Pinned libraries** — edit `warm/pyproject.toml` (marimo is added separately via
  `MARIMO_VERSION`).
- **System packages** — add `apt-get install` lines.
- **Python version** — change the base image tag (and the `py3.13` in your image tag).

## Test it

```sh
examples/sandbox-image/acceptance-test.sh   # builds, then runs every contract check
```

## Private registries

- **Kubernetes** — set `MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET` to a pull secret.
- **Docker** — the server's Docker daemon must be `docker login`'d to the registry.
- **Modal / CoreWeave** — configure registry credentials in the platform; pass the image ref.
