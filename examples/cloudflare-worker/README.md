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
