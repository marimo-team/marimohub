ARG MARIMOHUB_IMAGE=ghcr.io/marimo-team/marimohub:latest

FROM ${MARIMOHUB_IMAGE}

COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /usr/local/bin/

ENV UV_PROJECT_ENVIRONMENT="/opt/venv" \
    PATH="/opt/venv/bin:$PATH" \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/uv-cache \
    UV_PYTHON_INSTALL_DIR=/opt/python

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/uv-cache \
    --mount=type=bind,source=warm/pyproject.toml,target=pyproject.toml \
    uv sync --no-install-project --compile-bytecode
