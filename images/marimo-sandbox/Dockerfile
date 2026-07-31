# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91

ARG MARIMO_VERSION=0.23.11
ENV MARIMO_VERSION=${MARIMO_VERSION}

COPY --from=ghcr.io/astral-sh/uv:0.10.9@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82 /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates locales \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_CACHE_DIR=/opt/uv-cache \
    MARIMO_SKIP_UPDATE_CHECK=1 \
    _MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD=[html]

RUN useradd -m appuser \
 && mkdir -p /workspace \
 && chown -R appuser:appuser /workspace

# Retaining uv's cache makes overlapping per-notebook dependency installs cache hits.
RUN cd /tmp \
 && uv init --bare --no-readme base \
 && cd base \
 && uv add --compile-bytecode \
      "marimo[recommended]==${MARIMO_VERSION}" \
      polars \
      narwhals \
      numpy \
      pandas \
      pyarrow \
      duckdb \
      altair \
      matplotlib \
      plotly \
      anywidget \
      moutils \
      connectorx \
      pyiceberg \
      sqlalchemy \
      fsspec \
      s3fs \
      gcsfs \
      python-dotenv \
      pydantic \
      scikit-learn \
      scipy \
      requests \
      httpx \
      openpyxl \
      sqlglot \
 && rm -rf /tmp/base \
 && chown -R appuser:appuser /opt/venv /opt/uv-cache

# uv compiles installed packages, but not the interpreter's standard library.
RUN python3 -m compileall -j 0 -q /usr/local/lib/python3.13 || true

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

USER appuser
WORKDIR /workspace

CMD ["uv", "run", "--no-sync", "marimo", "edit", "notebook.py", "--convert", "--headless", "--no-token", "--host", "0.0.0.0", "--port", "2718"]
