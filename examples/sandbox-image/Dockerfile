# syntax=docker/dockerfile:1
#
# Example marimohub sandbox image (MARIMOHUB_COMPUTE_IMAGE) — the per-kernel
# container, not the server image (apps/server/Dockerfile). The provisioner reuses
# the pre-installed env (UV_PROJECT_ENVIRONMENT) via `uv sync --inexact` (add the
# notebook's deps, keep the base) then `uv run --no-sync marimo edit notebook.py`.
# Contract: uv + a POSIX shell + coreutils + git + a writable workdir + marimo and
# popular libs pre-installed so startup is instant. See docs/sandbox-image.md.

FROM python:3.13-slim

# marimo version baked into the image. Pinned (not `latest`) so rebuilds don't
# silently upgrade marimo; bump it to upgrade.
ARG MARIMO_VERSION=0.23.10
ENV MARIMO_VERSION=${MARIMO_VERSION}

# uv (+uvx) on PATH — the launch is `uv sync` / `uv run`.
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /usr/local/bin/

# git: notebook git checkouts. ca-certificates: TLS to PyPI.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# UV_PROJECT_ENVIRONMENT is the pre-installed env the launch reuses. Do NOT set
# UV_COMPILE_BYTECODE here — bytecode is a build-time CLI flag below; the
# provisioner passes `--no-compile-bytecode` on the startup sync, which uv rejects
# if this env is also set. UV_LINK_MODE is left unset (default: hardlink); the
# `uv cache clean` below still yields a self-contained environment.
ENV UV_PROJECT_ENVIRONMENT=/opt/marimohub/venv

# marimo kernel config baked into the image. SKIP_UPDATE_CHECK: no PyPI version
# ping on startup. AUTO_DOWNLOAD=[html]: continuously snapshot the notebook to
# __marimo__/notebook.html, which the host reads back on teardown.
ENV MARIMO_SKIP_UPDATE_CHECK=1 \
    _MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD=[html]

# Non-root user + a writable /workspace.
RUN useradd -m appuser \
 && mkdir -p /workspace \
 && chown -R appuser:appuser /workspace

# Pre-install marimo (pinned) + the popular libraries in warm/pyproject.toml into
# the project environment with bytecode compiled (fast imports), so the base-case
# kernel needs no install. Cache is dropped to keep the image lean (the env is
# self-contained); appuser owns its parent so uv can replace the environment for
# another Python version.
COPY warm/pyproject.toml /tmp/base/pyproject.toml
RUN cd /tmp/base \
 && uv add --compile-bytecode "marimo[recommended]==${MARIMO_VERSION}" \
 && uv cache clean \
 && rm -rf /tmp/base \
 && chown -R appuser:appuser /opt/marimohub

# Pre-compile the stdlib to bytecode: the slim base ships it uncompiled, so the
# kernel otherwise pays lazy .pyc compilation on first import (uv's
# --compile-bytecode covers installed packages, not the interpreter's stdlib).
RUN python3 -m compileall -j 0 -q /usr/local/lib/python3.13 || true

# Activate the project environment so marimo runs straight from it even for a
# notebook with no pyproject.toml (where `uv run --no-sync` would otherwise
# ignore the env).
ENV VIRTUAL_ENV=/opt/marimohub/venv \
    PATH=/opt/marimohub/venv/bin:$PATH

USER appuser
WORKDIR /workspace

# Not used in production (the provisioner supplies the launch command); lets a bare
# `docker run` start a kernel for a sanity check, straight from the pre-installed
# env. `--convert` opens a plain Python file too.
CMD ["uv", "run", "--no-sync", "marimo", "edit", "notebook.py", "--convert", "--headless", "--no-token", "--host", "0.0.0.0", "--port", "2718"]
