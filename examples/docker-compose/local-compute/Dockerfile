ARG MARIMOHUB_IMAGE=ghcr.io/marimo-team/marimohub:latest

FROM ${MARIMOHUB_IMAGE}

COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_CACHE_DIR=/uv-cache \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/uv-cache/python
