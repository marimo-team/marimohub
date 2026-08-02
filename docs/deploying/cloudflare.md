---
description: Deploy marimohub on Cloudflare Workers with R2, Containers, and Access.
---

# Deploying on Cloudflare

Run marimohub **fully serverless** — no always-on server, no database:

- [R2](https://developers.cloudflare.com/r2/) for storage,
- [Containers](https://developers.cloudflare.com/containers/) (a `Sandbox` Durable
  Object) for compute,
- [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
  for auth.

All three are platform **bindings**, not env credentials, so the Cloudflare deploy
is an [SDK/library composition](../deployment-options.md) rather than the env-driven
container. You deploy a copy of `examples/cloudflare-worker` — a small, complete
worker that wires the Cloudflare adapters into the same `createApi` everything else
uses.

## Prerequisites

- A Cloudflare account with **Workers**, **R2**, and **Containers** enabled
  (Containers requires a paid Workers plan).
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) via `pnpm`
  (the example already depends on it) and Docker running locally (wrangler builds
  the sandbox image).
- This repo checked out, with `pnpm install` run once.

## 1. Copy the worker

The worker lives at
[`examples/cloudflare-worker`](https://github.com/marimo-team/marimohub/tree/main/examples/cloudflare-worker).
Copy it somewhere you control (or deploy it in place) and open `wrangler.jsonc` —
that file is where you point everything at your account.

These bindings come pre-wired; you generally only rename them:

- **R2 bucket** → `NOTEBOOKS_BUCKET` (storage **and** the credential-less sandbox mount).
- **Container + Durable Object** → `SANDBOX` (the `Sandbox` class, image from
  `sandbox.Dockerfile`). The entrypoint also exports `ContainerProxy`, required for
  the binding mount below.
- **Assets** → the web UI build (`packages/web/dist`).
- **Cron** → `*/5 * * * *` runs session maintenance (there's no always-on replica).

## 2. Create the R2 bucket

```bash
pnpm exec wrangler r2 bucket create <bucket>
```

Set the same name in `wrangler.jsonc` (`r2_buckets[].bucket_name` and
`R2_BUCKET_NAME`).

## 3. Set up auth (Cloudflare Access)

Protect the **app host only** with a
[self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
and an Allow policy (e.g. your email domain). Access adds a signed JWT that the
worker verifies — see [Auth](../auth.md).

From the Access application, copy:

- the **team name** (`<team>.cloudflareaccess.com`) → `ACCESS_TEAM`
- the **Application Audience (AUD) tag** → `ACCESS_AUD`

## 4. Configure `wrangler.jsonc`

Set the runtime `vars` (non-secret, committed):

```jsonc
"vars": {
  "AUTH_MODE": "access",        // "dev" is a LOCAL-ONLY bypass; prod MUST be "access"
  "ACCESS_TEAM": "your-team",   // <team>.cloudflareaccess.com
  "ACCESS_AUD": "<aud>",        // Access application Audience tag
  "MARIMOHUB_EDITOR_SANDBOX_SHARING": "shared", // or "exclusive"
  "SANDBOX_HOSTNAME": "",       // empty => quick tunnels (see Kernel exposure)
  "R2_S3_ENDPOINT": ""          // empty => R2 binding mount (see Notebook storage)
}
```

The worker **refuses to start** if `AUTH_MODE` is unset or unknown — there is no
insecure default.

See [Editor sessions](../editor-sessions.md) for the sharing and takeover model.

## 5. Deploy

```bash
pnpm --filter @marimo-hub/web build          # build the web UI assets
cd examples/cloudflare-worker                # or your copy
pnpm exec wrangler deploy                    # provisions R2 + Container + DO + cron
```

The first `wrangler deploy` provisions everything. See
[Troubleshooting](#troubleshooting) for the known first-deploy hiccups.

## 6. Serve on a custom domain

Add a `routes` entry with `custom_domain: true` for your app host (its zone must
be active in the account):
[custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
Cloudflare provisions the DNS record and an edge TLS cert; a deep subdomain
(`a.b.example.com`) gets its **own** cert — allow a few minutes before HTTPS works.

## 7. (Optional) Managed AI

Give every notebook a working AI assistant with no user key — see
[Managed AI](../ai.md) for the model. On Workers, set the upstream as vars/secrets:

```bash
# non-secret: add to wrangler.jsonc "vars"
#   AI_UPSTREAM_BASE_URL = "https://api.openai.com/v1"
#   AI_MODEL             = "gpt-4o-mini"

# secrets (never committed):
pnpm exec wrangler secret put AI_UPSTREAM_API_KEY    # the real upstream key
pnpm exec wrangler secret put AI_SESSION_SECRET      # signs per-session tokens
```

Managed AI turns on only when all four are present. The real upstream key stays on
the worker and is never injected into a sandbox.

## Notebook storage (R2 mount)

The sandbox mounts the notebook bucket as a filesystem. Two modes
([SDK docs](https://developers.cloudflare.com/sandbox/guides/mount-buckets/)):

- **R2 binding mount (default, `R2_S3_ENDPOINT` empty)** — mounts the
  `NOTEBOOKS_BUCKET` binding with **no credentials in the container** (the Durable
  Object re-signs S3 egress). **No secrets to set.** Requires the `r2_buckets`
  binding and the entrypoint to `export { ContainerProxy }` (both already wired).
- **External S3 endpoint** — set `R2_S3_ENDPOINT` (+ `R2_BUCKET_NAME`) and the
  `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
  [secrets](https://developers.cloudflare.com/workers/configuration/secrets/) to
  mount any S3-compatible bucket (R2, AWS S3, GCS, …):

  ```bash
  pnpm exec wrangler secret put R2_ACCESS_KEY_ID
  pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
  ```

## Kernel exposure

Kernels run untrusted code, so they must be **cross-origin** from the app. Two ways
([Security → Kernel exposure](../security#kernel-exposure)):

- **Quick tunnels (default, `SANDBOX_HOSTNAME` empty)** — each kernel gets a random,
  unguessable
  [`*.trycloudflare.com`](https://developers.cloudflare.com/sandbox/api/tunnels/)
  URL. Zero config, no second domain.
- **Subdomain** — set `SANDBOX_HOSTNAME` to a **separate** isolated domain and add
  its route. The worker fails closed if it shares an origin/parent with the app host.

## Swapping the compute backend

Compute is a pluggable [port](../compute.md), independent of storage and auth — you
can run kernels on another backend without touching R2 or Access. This example ships
an **opt-in [E2B](https://e2b.dev) wiring** (`src/e2b.ts` + `src/tieredCompute.ts`):
managed microVM sandboxes with direct per-port kernel URLs and no container image to
build. E2B and Cloudflare are separate backends — see [E2B compute](../compute.md#e2b)
for the backend itself (SDK, template, the login-shell env gotcha) and
[`examples/e2b-template`](https://github.com/marimo-team/marimohub/tree/main/examples/e2b-template)
for a copy-pasteable marimo template. `src/tieredCompute.ts` additionally shows E2B
primary with a Cloudflare-Sandbox fallback.

The one Worker-specific catch: the `e2b` SDK must be **statically bundled** (a Worker
can't lazily `import()` it), so `src/e2b.ts` injects a static import into
`createE2bClient`.

## Validate

1. Check the deployed Worker route.
2. Sign in through Cloudflare Access.
3. Create and save a notebook.
4. Start a kernel and confirm it opens through the configured tunnel or sandbox
   hostname.
5. Confirm the R2 bucket contains hub objects after saving.

## Production cautions

- Protect only the app host with Cloudflare Access. Kernel hosts must stay
  isolated from the app origin.
- Store upstream AI keys and S3 keys as Worker secrets, never committed vars.
- Keep the sandbox image lean enough for Cloudflare Containers.
- Re-run `wrangler deploy` after changing bindings or Durable Object migrations.

## Troubleshooting

- **`docker login` fails on macOS** (`error storing credentials … -25299`): a
  stale keychain entry. Run `docker logout registry.cloudflare.com`, then redeploy.
- **`wrangler deploy` fails building the sandbox image** (`TLS handshake timeout`
  pulling `cloudflare/sandbox`): a transient Docker Hub blip, not your config —
  just re-run once connectivity is back.
- **First deploy 500s** on `POST /containers/applications` ("can't fetch the
  application"): the app is usually created anyway — just re-run `wrangler deploy`
  and it reconciles.
- **TLS handshake fails right after first deploy**: the custom-domain edge cert is
  still issuing. Wait a few minutes; check **SSL/TLS → Edge Certificates**.
- **Kernel container won't start** (`permanent error`): usually an oversized image —
  keep `sandbox.Dockerfile` lean (per-notebook deps install at runtime via uv).
- **Credential-less R2 mount fails immediately**: the entrypoint must
  `export { ContainerProxy }` and the `r2_buckets` binding name must match what the
  worker mounts; on older wrangler, also add the `enable_ctx_exports` compat flag.
- **(E2B) sandboxes silently never start** and everything runs on the fallback: the
  `E2B_API_KEY` secret is wrong. If you piped it in (`… | wrangler secret put`),
  **strip the trailing newline** (`printf '%s' "$key" | …`) — a newline-suffixed key
  fails auth (401), which the tiered provider swallows as a fallback.

## See also

[Auth](../auth.md) · [Storage](../storage.md) · [Compute](../compute.md) ·
[Managed AI](../ai.md) · [Configuration](../configuration.md)
