<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Create an [E2B](https://e2b.dev) account and grab an **API key**.
2. Build an E2B **template** with marimo + uv + python (or reuse one), and note
   its template id — [`examples/e2b-template`](https://github.com/marimo-team/marimohub/tree/main/examples/e2b-template)
   is a copy-pasteable one (E2B build system v2).
3. Install the SDK into your server image — it's an optional, bring-your-own
   dependency: `pnpm add e2b`.
4. Set the env:

```bash
MARIMOHUB_COMPUTE_BACKEND=e2b
MARIMOHUB_COMPUTE_E2B_API_KEY=…                 # secret
MARIMOHUB_COMPUTE_E2B_TEMPLATE=marimo           # E2B template id (falls back to MARIMOHUB_COMPUTE_IMAGE)
# MARIMOHUB_COMPUTE_E2B_MAX_LIFETIME_SECONDS=3600   # hard cap so stray sandboxes auto-kill
```

::: tip Managed sandboxes, direct kernel URLs
Each session gets a sandbox with a public per-port URL
(`https://<port>-<id>.e2b.app`), so the browser talks to the kernel directly —
no ingress to configure.
:::

::: warning Template ≠ container image
`MARIMOHUB_COMPUTE_E2B_TEMPLATE` is an E2B **template id**, not a Docker image.
And because the `e2b` SDK is bring-your-own, you must bake it into the server
image or the backend won't load.
:::

::: warning Set the kernel's env for a **login shell**
E2B runs each command in a login shell that re-sources `/etc/profile`, so a
template's build-time `ENV`/`setEnvs` does **not** reach the kernel launch. Put the
runtime env the launch needs — above all `UV_PROJECT_ENVIRONMENT` (so
`uv run --no-sync marimo` resolves your pre-installed venv) — in an
`/etc/profile.d/*.sh` script instead. The
[`examples/e2b-template`](https://github.com/marimo-team/marimohub/tree/main/examples/e2b-template)
template does exactly this.
:::

::: tip Bundled / edge runtimes (e.g. Cloudflare Workers)
The `e2b` SDK bundles and runs in the Workers runtime, but a Worker can't lazily
`import()` it. Inject a statically-imported SDK into `createE2bClient`'s `loadSdk`
argument instead of relying on the default dynamic import —
[`examples/cloudflare-worker/src/e2b.ts`](https://github.com/marimo-team/marimohub/tree/main/examples/cloudflare-worker/src/e2b.ts)
is a one-liner that does this.
:::
