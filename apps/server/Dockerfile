# syntax=docker/dockerfile:1

# --- build stage: install workspace, build the SPA and the server bundle ---
FROM node:24-slim AS build
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
RUN pnpm --filter @marimo-hub/web run build \
 && pnpm --filter @marimo-hub/server run build

# --- runtime: self-contained server bundle + prebuilt static SPA ---
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MARIMOHUB_STATIC_ROOT=./public
# Optionally bundle `uv` so the `local` compute backend can spawn marimo kernels
# inside this container (used by examples/docker-compose). Off by default to keep
# the production image lean. uv fetches Python + marimo on first kernel launch.
ARG INSTALL_UV=false
RUN if [ "$INSTALL_UV" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
      && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
      && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* ; \
    fi
# apps/server/dist is bundled (no node_modules needed at runtime).
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/packages/web/dist ./public
EXPOSE 3000
CMD ["node", "dist/index.mjs"]
