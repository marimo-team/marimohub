# Cloudflare Workers reference deployment

A copy-pasteable reference (not a maintained app) showing the same `createApi`
composed with the Cloudflare adapters — R2 storage, Containers compute, Access
auth. This is also the only runtime where the Cloudflare compute adapter works
(it needs the Workers runtime + Durable Object binding).

```sh
pnpm --filter @marimo-hub/web build          # build the SPA (served as assets)
cd examples/cloudflare-worker
npx wrangler deploy                          # or: npx wrangler dev
```

- `src/index.ts` — wires `R2BucketAdapter` + `CloudflareSandboxProvider` +
  `CloudflareAccessAuthenticator` into `ApiDeps`, re-exports the `Sandbox` DO, and
  reimplements the cron via `scheduled()`.
- `wrangler.jsonc` — R2 + Durable Object bindings, the `*/5` maintenance cron, and
  `assets.directory` → `../../packages/web/dist`.
- `sandbox.Dockerfile` — the marimo kernel sandbox image (`cloudflare/sandbox` base).

## Optional: E2B for compute

Compute is a pluggable port — you can run kernels on [E2B](https://e2b.dev)
microVMs instead of Cloudflare Containers (E2B and Cloudflare are independent
backends; this example just shows how to wire them in one Worker). Two opt-in files
demonstrate it:

- `src/e2b.ts` — injects a statically-imported `e2b` SDK into `createE2bClient`
  (a Worker can't lazily `import()` it). Swap `compute:` in `index.ts` for
  `new E2bCompute(config, createWorkersE2bClient(config))`.
- `src/tieredCompute.ts` — optional `TieredComputeProvider` that uses E2B primary
  and falls back to Cloudflare Sandboxes when E2B is unreachable.

Build the kernel template from [`../e2b-template`](../e2b-template), set
`E2B_TEMPLATE` + the `E2B_API_KEY` secret, and see
[E2B compute](../../docs/setup/compute/e2b.md) for the details (esp. the
login-shell env gotcha).
