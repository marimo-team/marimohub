# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Held at 3.13: pyiceberg (in the acceptance image) has no cp314 wheel yet, so
# 3.14 forces a source build that needs a compiler absent from -slim.
FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS base

ARG MARIMO_VERSION=0.24.0
ENV MARIMO_VERSION=${MARIMO_VERSION}

COPY --from=ghcr.io/astral-sh/uv:0.12.1@sha256:cf4eedcaa81655197f625739489effcbe71b61ceb1506f332c3facae5deceded /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates locales \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    UV_PROJECT_ENVIRONMENT=/opt/marimohub/venv \
    UV_CACHE_DIR=/opt/marimohub/uv-cache \
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
 && chown -R appuser:appuser /opt/marimohub

# uv compiles installed packages, but not the interpreter's standard library.
RUN python3 -m compileall -j 0 -q /usr/local/lib/python3.13 || true

ENV VIRTUAL_ENV=/opt/marimohub/venv \
    PATH=/opt/marimohub/venv/bin:$PATH

# The hub's compute adapters exec commands via a login shell (`sh -lc`), and
# /etc/profile resets PATH — dropping the venv set by ENV above. profile.d runs
# after that reset, so login shells keep python3/pyarrow/pyiceberg resolvable
# (the data-preview preflight depends on it).
RUN echo 'export PATH=$VIRTUAL_ENV/bin:$PATH' > /etc/profile.d/venv-path.sh

USER appuser
WORKDIR /workspace

CMD ["uv", "run", "--no-sync", "marimo", "edit", "notebook.py", "--convert", "--headless", "--no-token", "--host", "0.0.0.0", "--port", "2718"]

FROM base AS vscode

USER root
ARG CODE_SERVER_VERSION=4.133.0
ARG CODE_SERVER_AMD64_SHA256=a4e0f8f8c76e7de8e7424289f74e507af4c97bfe104c3e8ee272b8cc7b46c6f1
ARG CODE_SERVER_ARM64_SHA256=d999d8b0256e5537f3b62e6c09f624220026e19107a04a876c0cef62d1c71147
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64; checksum="${CODE_SERVER_AMD64_SHA256}" ;; \
      arm64) arch=arm64; checksum="${CODE_SERVER_ARM64_SHA256}" ;; \
      *) exit 1 ;; \
    esac \
 && archive=/tmp/code-server.tar.gz \
 && curl -fsSL -o "${archive}" "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${arch}.tar.gz" \
 && printf '%s  %s\n' "${checksum}" "${archive}" | sha256sum -c - \
 && tar -xzf "${archive}" -C /opt \
 && rm "${archive}" \
 && ln -s "/opt/code-server-${CODE_SERVER_VERSION}-linux-${arch}/bin/code-server" /usr/local/bin/code-server \
 && mkdir -p /opt/marimohub/vscode-extensions \
 && chown -R appuser:appuser /opt/marimohub/vscode-extensions

USER appuser
RUN code-server --extensions-dir /opt/marimohub/vscode-extensions --install-extension marimo-team.vscode-marimo@0.17.2 \
 && code-server --extensions-dir /opt/marimohub/vscode-extensions --install-extension detachhead.basedpyright@1.39.10 \
 && code-server --extensions-dir /opt/marimohub/vscode-extensions --install-extension charliermarsh.ruff@2026.74.0 \
 && code-server --extensions-dir /opt/marimohub/vscode-extensions --install-extension tamasfe.even-better-toml@0.21.2

FROM base AS opencode

USER root
ARG OPENCODE_VERSION=1.18.17
ARG OPENCODE_AMD64_SHA256=3f14a4c61c7f6b0d3b6d933d1d212e64e19683eba6fa453ad98e46303afe144a
ARG OPENCODE_ARM64_SHA256=7531c1a110546aaf04b465d98a3bf54018e1740f769077c2526fec6add5fc230
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; checksum="${OPENCODE_AMD64_SHA256}" ;; \
      arm64) arch=arm64; checksum="${OPENCODE_ARM64_SHA256}" ;; \
      *) exit 1 ;; \
    esac \
 && archive=/tmp/opencode.tar.gz \
 && curl -fsSL -o "${archive}" "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${arch}.tar.gz" \
 && printf '%s  %s\n' "${checksum}" "${archive}" | sha256sum -c - \
 && tar -xzf "${archive}" -C /usr/local/bin opencode \
 && rm "${archive}" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/*

USER appuser

FROM vscode AS tools

USER root
COPY --from=opencode /usr/local/bin/opencode /usr/local/bin/opencode
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/*

USER appuser

FROM base AS release
