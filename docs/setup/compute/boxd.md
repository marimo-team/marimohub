<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

1. Create a [boxd](https://boxd.sh/?ref=marimohub) account and an **API key**
   (`boxd auth keys create marimohub --org <org>`).
2. Build a boxd **snapshot** with marimo + uv + python, and note its name.
   [`examples/boxd-template`](https://github.com/marimo-team/marimohub/tree/main/examples/boxd-template)
   builds one with `BOXD_API_KEY=… pnpm build:snapshot`.
3. Install the SDK into your server image. It's an optional, bring-your-own
   dependency: `pnpm add @boxd-sh/sdk`.
4. Set the env:

```bash
MARIMOHUB_COMPUTE_BACKEND=boxd
MARIMOHUB_COMPUTE_BOXD_API_KEY=…                 # secret
MARIMOHUB_COMPUTE_BOXD_SNAPSHOT=marimo-sandbox   # boxd snapshot (falls back to MARIMOHUB_COMPUTE_IMAGE)
# MARIMOHUB_COMPUTE_BOXD_REGION=fra               # must match the snapshot's region
# MARIMOHUB_COMPUTE_BOXD_MAX_LIFETIME_SECONDS=3600   # hard cap so stray machines are deleted
```

::: tip One isolated machine per session, direct kernel URLs
Each session gets its own isolated machine. It never joins your org's private
network and holds no boxd credentials. The kernel is served at the machine's
public HTTPS URL, and other session surfaces at a named route in front of it
(`p<port>.` plus the machine's host name), so there is no ingress to configure.
A named route answers once its certificate is issued, which can take up to a
minute the first time a machine uses one.
:::

::: warning Snapshot ≠ container image
`MARIMOHUB_COMPUTE_BOXD_SNAPSHOT` is a boxd **snapshot name**, not a Docker image.
And because `@boxd-sh/sdk` is bring-your-own, you must bake it into the server
image or the backend won't load.
:::

::: tip Kernel env lives in `/etc/profile.d`
The backend runs each command in a login shell, so the runtime env the launch
needs (above all `UV_PROJECT_ENVIRONMENT`, so `uv run --no-sync marimo` resolves
the pre-installed venv) belongs in an `/etc/profile.d/*.sh` script. The
[`examples/boxd-template`](https://github.com/marimo-team/marimohub/tree/main/examples/boxd-template)
snapshot does exactly this.
:::
