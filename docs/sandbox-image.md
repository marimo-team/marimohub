---
description: Build a compatible, pre-installed container image for marimohub notebook kernels.
---

# Sandbox image (bring your own container)

A compute **backend** decides _where_ a kernel runs (`docker`, `podman`,
`kubernetes`, `modal`, `coreweave`). The **sandbox image** decides _what_ runs
inside it — the Python version, system libraries, and pre-installed packages
your notebooks get.

You bring your own image. Set it once per deployment:

```bash
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
```

Every container-based backend reads this same variable. (`local` runs `uv` on the
host and needs no image; `e2b` uses an E2B template instead — see
[Compute](./compute.md).)

## Multiple images

To offer more than one image — say a lean default plus a GPU or heavy-ML
variant — set `MARIMOHUB_COMPUTE_IMAGE` to a comma-separated list:

```bash
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest,ghcr.io/orgname/marimo-gpu:latest
```

- **The first image is the default.** Every notebook uses it unless it chooses
  otherwise.
- **Notebooks pick per-notebook.** The create-notebook dialog and the notebook
  menu's **Change base image** action offer "Default" plus each listed image.
  Only a non-default choice is stored (in the notebook's metadata); "Default"
  always follows the first image, even if you later reorder the list.
- **Changes apply on the next session start.** A running kernel keeps the image
  it booted from; stop and restart the session to switch.
- **Removing an image from the list is safe.** A notebook still pointing at it
  falls back to the default at session start (with a server-side warning), and
  its stored choice can be updated to any currently-listed image.
- The full list is served to clients via `GET /api/v1/capabilities`
  (`sandbox_images`); `GET /api/v1/version` reports only the default.

For the `e2b` backend the same applies to `MARIMOHUB_COMPUTE_E2B_TEMPLATE`,
which takes a comma-separated list of template ids.

> With CoreWeave filesystem snapshots enabled, a notebook restoring from a
> snapshot boots the snapshot's image — a base-image change takes effect once no
> restore pointer exists (e.g. after the snapshot is dropped).

## The contract

marimohub copies the notebook into the image and launches the kernel itself,
reusing the image's pre-installed environment. With cwd `/workspace`:

```sh
uv sync --inexact --no-install-package marimo --no-compile-bytecode --no-build   # add the notebook's deps (skipped when it declares none)
uv run --no-sync marimo edit notebook.py --headless --no-token --host 0.0.0.0 --port 2718
```

During the sync, `--no-install-package marimo` keeps the image's pinned marimo
version even if the notebook declares another version. `--no-build` permits only
wheels, so a source build cannot run arbitrary code or delay startup.

If a git-synced notebook's entry file contains
[PEP 723](https://peps.python.org/pep-0723/) inline metadata, marimohub runs three
more setup commands. These commands run after the project sync and install the
inline dependencies into the base environment:

```sh
[ -d "${UV_PROJECT_ENVIRONMENT:-.venv}" ] || uv venv "${UV_PROJECT_ENVIRONMENT:-.venv}"
uv export --script notebook.py --format requirements-txt --no-hashes --prune marimo -o "${UV_PROJECT_ENVIRONMENT:-.venv}/marimohub-script-requirements.txt"
uv pip install --python "${UV_PROJECT_ENVIRONMENT:-.venv}" --no-build -r "${UV_PROJECT_ENVIRONMENT:-.venv}/marimohub-script-requirements.txt"
```

A setup failure stops the session with `PYTHON_ENV_SETUP_FAILED` before the kernel
starts. The export keeps the image's bytecode-compiled `marimo` version and removes
packages used only by marimo. Direct notebook dependencies remain in the export.

So your image must provide:

1. **`uv` on `PATH`** — the launch command is `uv sync` + `uv run …`.
2. **marimo + your common libraries pre-installed** into the project environment
   (`UV_PROJECT_ENVIRONMENT`, also activated as `VIRTUAL_ENV`), at a **pinned**
   marimo version. This is what makes the base case start instantly — no per-launch
   install.
3. **A POSIX shell (`sh`) + coreutils** — `base64`, `mkdir`, `rm`, `cat`, `true`.
   marimohub transfers notebook files and probes reachability with these.
4. **`git`** — only if notebooks use git checkouts, but cheap to include.
5. **A writable working directory** (`/workspace`) and a writable parent for
   `UV_PROJECT_ENVIRONMENT`. uv can replace the whole environment to change
   Python versions. If the user cannot write to `/workspace`, set
   `MARIMOHUB_COMPUTE_WORKDIR` to a writable directory.
6. **PyPI egress at runtime** for notebooks that use libraries beyond the
   pre-installed base.

No marimo entrypoint or `CMD` is required — marimohub supplies the launch command.

> **Don't set `UV_COMPILE_BYTECODE` in your image.** Compile bytecode at build with
> the `--compile-bytecode` flag (fast imports for the pre-installed base). The
> startup sync passes `--no-compile-bytecode` to skip the ~5s of compiling freshly
> added deps on the launch path — and uv errors if both the env var and the flag
> are set.

## Why pre-install (not just cache)

`uv sync` builds a notebook's environment at startup. Even with a warm download
cache, materializing marimo + its recommended extras (~70 packages) into a fresh
venv takes a few seconds — paid on every kernel. Instead, **pre-install** marimo
and your common libraries into the image's project environment. Then
`uv sync --inexact` only needs to add a notebook's _extra_ deps (and keeps the
base), so the common case is a near-instant no-op.

Pin marimo to a specific version so it's consistent and never silently upgrades;
bump it deliberately. Encode the Python + marimo version in the image tag (e.g.
`py3.13-marimo0.23.10`) so each image is traceable.

## Build your own

The [`examples/sandbox-image/`](https://github.com/marimo-team/marimohub/tree/main/examples/sandbox-image)
directory is a ready-to-fork starting point. marimo is pinned via the
`MARIMO_VERSION` build arg and installed alongside the libraries in
`warm/pyproject.toml` into `/opt/marimohub/venv`:

```dockerfile
FROM python:3.13-slim
ARG MARIMO_VERSION=0.23.10
ENV MARIMO_VERSION=${MARIMO_VERSION}
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV UV_PROJECT_ENVIRONMENT=/opt/marimohub/venv UV_LINK_MODE=copy
# Skip marimo's PyPI version ping, and continuously snapshot the notebook to
# __marimo__/notebook.html so the host captures it on teardown.
ENV MARIMO_SKIP_UPDATE_CHECK=1 _MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD=[html]
RUN useradd -m appuser && mkdir -p /workspace && chown -R appuser:appuser /workspace
COPY warm/pyproject.toml /tmp/base/pyproject.toml
RUN cd /tmp/base && uv add --compile-bytecode "marimo[recommended]==${MARIMO_VERSION}" \
 && uv cache clean && rm -rf /tmp/base && chown -R appuser:appuser /opt/marimohub
ENV VIRTUAL_ENV=/opt/marimohub/venv PATH=/opt/marimohub/venv/bin:$PATH
USER appuser
WORKDIR /workspace
```

Build with a version-stamped tag, push, and point `MARIMOHUB_COMPUTE_IMAGE` at it:

```sh
docker build --build-arg MARIMO_VERSION=0.23.10 \
  -t ghcr.io/orgname/marimo-sandbox:py3.13-marimo0.23.10 examples/sandbox-image
docker push ghcr.io/orgname/marimo-sandbox:py3.13-marimo0.23.10
```

To upgrade marimo, bump `MARIMO_VERSION` and rebuild. To change the pre-installed
libraries, edit `warm/pyproject.toml`; add system libraries with extra
`apt-get install` lines.

## Private registries

| Backend    | How to authenticate the pull                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Kubernetes | Create an image pull secret; set `MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET` to its name. |
| Docker     | `docker login` on the server's Docker daemon — its credentials pull the image.                 |
| Podman     | `podman login` for the server user or configured remote connection.                            |
| Modal      | Configure registry credentials in Modal; pass the image reference.                             |
| CoreWeave  | Configure registry credentials in CoreWeave; pass the image reference.                         |

## Custom PyPI index (private packages)

The launch command is plain `uv`, so pointing notebooks at a private or mirrored
package index is plain
[uv configuration](https://docs.astral.sh/uv/configuration/environment/): add
`ENV` lines to your sandbox image and every sandbox in the deployment uses the
index.

```dockerfile
# Replace PyPI entirely with an internal mirror or proxy (Artifactory, Nexus,
# devpi, …) — every `uv sync` at session start resolves against it.
ENV UV_DEFAULT_INDEX=https://pypi.example.com/simple

# OR keep PyPI and add a private index searched first for your internal
# packages. The `name=URL` form registers it as a NAMED index...
ENV UV_INDEX=internal=https://pypi.example.com/simple

# ...so credentials can be supplied per index, without putting them in the URL.
# The infix is the index name, uppercased. Never bake real values into the
# image (anyone who can pull it can read them) — inject them at runtime
# instead, through the Environment variables integration (see below).
ENV UV_INDEX_INTERNAL_USERNAME=notebooks
# UV_INDEX_INTERNAL_PASSWORD is injected at runtime, not baked in.
```

For credentials, add the `UV_*` names to the
[Environment variables integration](./environment-and-access.md). Store the
password as an [external reference](./integration-secrets.md). The hub resolves
it before `uv sync` starts. A restricted viewer sandbox does not receive it.

`uv sync` runs once at session start — an index change applies to new sessions,
not already-running kernels.
