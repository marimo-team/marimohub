# Cloudflare Workers reference deployment

This reference example connects the shared `createApi` to R2 storage, Cloudflare
Containers, and Access authentication. The compute adapter requires the Workers
runtime and a Durable Object binding.

```sh
pnpm --filter @marimo-hub/web build          # build the SPA (served as assets)
cd examples/cloudflare-worker
npx wrangler deploy                          # or: npx wrangler dev
```

- `src/index.ts` — wires `R2BucketAdapter` + `CloudflareSandboxProvider` +
  `CloudflareAccessAuthenticator` into `ApiDeps`, re-exports the `Sandbox` DO, and
  runs maintenance through `scheduled()`. Notebook jobs are off by default.
  Set `MARIMOHUB_JOBS` to `on` under `vars` in `wrangler.jsonc` to enable them.
- `wrangler.jsonc` — R2 + Durable Object bindings, the `*/5` maintenance cron, and
  `assets.directory` → `../../packages/web/dist`.
- `sandbox.Dockerfile` — the marimo kernel sandbox image (`cloudflare/sandbox` base).

Set `MARIMOHUB_SANDBOX_AUTH` to `on` in `wrangler.jsonc` to enable native marimo
authentication for new editor and app sessions. The default is `off`. Existing
sessions keep their mode until stopped and restarted. See
[Native kernel authentication](../../docs/security.md#native-kernel-authentication)
for ingress requirements and cross-site cookie restrictions.

Notebook previews are unavailable in this reference deployment. It does not configure
a GitHub App source-control registry or schedule preview preparation. See
[Notebook previews](../../docs/notebook-previews.md) for deployment requirements.

## Dependency lifetime

The Worker lazily caches adapters, services, and the API by `env` identity within
each isolate. Fetch and scheduled handlers share storage, compute, and services.
A different `env` object gets fresh dependencies, including authentication and caches.

Each invocation keeps its own execution context through `AsyncLocalStorage`.
Background work uses that invocation's `waitUntil`. The sandbox hostname check runs
on every request, including cache hits. Failed initialization can retry on the next request.

## Optional: E2B for compute

The Worker can use [E2B](https://e2b.dev) microVMs instead of Cloudflare Containers.
Two optional modules provide this integration:

- `src/e2b.ts` — injects a statically-imported `e2b` SDK into `createE2bClient`
  (a Worker can't lazily `import()` it). Swap `compute:` in `index.ts` for
  `new E2bCompute(config, createWorkersE2bClient(config))`.
- `src/tieredCompute.ts` — optional `TieredComputeProvider` that uses E2B primary
  and falls back to Cloudflare Sandboxes when E2B is unreachable.

Build the kernel template from [`../e2b-template`](../e2b-template), set
`E2B_TEMPLATE` + the `E2B_API_KEY` secret, and see
[E2B compute](../../docs/setup/compute/e2b.md) for login-shell environment requirements.
