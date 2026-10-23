# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# --- build stage: install workspace, build the SPA and the server bundle ---
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
# CI=true keeps pnpm non-interactive (no TTY prompts) during the image build.
ENV CI=true
# git: required by the root `prepare` script (vp config).
# ca-certificates: vite-plus needs system CA certs to initialize its HTTP client.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# web + server builds are vite.config tasks, so build them via `vp run`.
RUN pnpm exec vp run --filter @marimo-hub/web --filter @marimo-hub/server build

# --- runtime: self-contained server bundle + prebuilt static SPA ---
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MARIMOHUB_STATIC_ROOT=./public
# The runtime image has no Git checkout, so the build (CI, or the deploy Makefile's
# --build-arg) supplies build identity; an unset or empty version reports as `dev`.
ARG MARIMOHUB_VERSION=dev
ARG MARIMOHUB_IMAGE
ENV MARIMOHUB_VERSION=$MARIMOHUB_VERSION \
    MARIMOHUB_IMAGE=$MARIMOHUB_IMAGE
# Local compute needs uv and Python 3.11+ for the setup step's tomllib parser.
# Off by default to keep the production image lean; enabled by examples/docker-compose.
ARG INSTALL_UV=false
RUN if [ "$INSTALL_UV" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
      && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
      && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* ; \
    fi
# apps/server/dist is bundled (no node_modules needed at runtime).
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/packages/web/dist ./public
EXPOSE 3000
CMD ["node", "dist/index.mjs"]
