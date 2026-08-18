# Quickstart: S3 (MinIO) + Node control plane

The config-driven path from `development_docs/architecture.md` §5 — the whole stack on a laptop.

```sh
docker compose -f examples/docker-compose/docker-compose.yml up --build
open http://localhost:3000        # SPA + API
open http://localhost:9001        # MinIO console (minioadmin / minioadmin)
```

- **Storage** → MinIO via the S3 adapter (`forcePathStyle: true`). The server runs
  `verifyConditionalWrites()` at boot to confirm MinIO honors `If-Match`.
- **Auth** → `dev` bypass (every request is a fixed local user). Switch to OIDC by
  setting `MARIMOHUB_AUTH_BACKEND=oidc` + the `MARIMOHUB_AUTH_OIDC_*` vars.
- **Compute** → `local`. marimo kernels run as subprocesses **inside the server
  container**. The image is built with `uv` bundled in (`INSTALL_UV=true`), and
  `uv` fetches Python + marimo on the first kernel launch (cached in the
  `uv-cache` volume). Each kernel binds `0.0.0.0` on a port in the published
  `2718-2723` range and is served to the browser at `http://localhost:<port>`.
  Sandboxes use `/sandboxes` instead of `/tmp`, so marimo saves Hub-managed
  notebooks in place instead of opening **Save As**.

  To use Modal instead, set `MARIMOHUB_COMPUTE_BACKEND=modal` with
  `MARIMOHUB_COMPUTE_MODAL_TOKEN_*` and an image (drop the `local` vars and the
  port range). For no compute at all (browse/CRUD only), set it to `none`.

> **Kernel concurrency** is bounded by the published port range
> (`MARIMOHUB_COMPUTE_LOCAL_PORTS` ↔ the `ports:` mapping) — six concurrent
> kernels by default. Widen both to allow more.

The same `local` backend also works **on the host** (no container) — that's what
`pnpm dev` uses; it serves kernels on ephemeral ports and only needs `uv` +
Python on your PATH.
