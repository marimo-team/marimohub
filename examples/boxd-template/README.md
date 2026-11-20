# Example boxd kernel snapshot (bring your own snapshot)

The machine the **boxd compute backend** (`@marimo-hub/compute-boxd`) boots one
of per notebook kernel: the boxd analogue of
[`examples/sandbox-image`](../sandbox-image) (which serves the `docker` /
`kubernetes` / `modal` / `coreweave` backends) and
[`examples/e2b-template`](../e2b-template). A fresh boxd machine is Ubuntu with
Python and uv but no marimo, so you build a snapshot once and set its name as
`MARIMOHUB_COMPUTE_BOXD_SNAPSHOT`. See [boxd compute](../../docs/setup/compute/boxd.md).

## Layout

```
examples/boxd-template/
  build.mjs           # boots a builder machine, installs uv + marimo + warm libs, saves the snapshot
  files/marimo.sh     # /etc/profile.d script with the runtime env the kernel launch needs
  warm/pyproject.toml # libraries pre-installed into /opt/venv
  package.json        # pins @boxd-sh/sdk
```

## Build

```sh
pnpm install                                   # once, from the repo root
cd examples/boxd-template
BOXD_API_KEY=<your key> pnpm build:snapshot    # builds snapshot "marimo-sandbox"
```

Optional variables:

- `BOXD_SNAPSHOT_NAME`: the snapshot name (default `marimo-sandbox`).
- `BOXD_ORG`, `BOXD_REGION`: where the builder and the snapshot live. Use the
  same org and region as the hub (`MARIMOHUB_COMPUTE_BOXD_ORG`,
  `MARIMOHUB_COMPUTE_BOXD_REGION`); machines boot from snapshots in their own region.
- `BOXD_BUILDER_NAME`, `BOXD_LABELS` (`key=value,...`): name and labels of the
  builder machine.
- `BOXD_KEEP_BUILDER=1`: keep the builder machine instead of deleting it.

Re-running the script saves a new version under the same name. New sessions
use the latest version.

## How it works

marimo and the base libraries are pre-installed into `/opt/venv`
(`UV_PROJECT_ENVIRONMENT`), owned by the machine's exec user, so the
provisioner's launch in `/workspace` starts at once for a notebook that only
uses them:

```sh
uv sync --inexact --no-install-package marimo --no-compile-bytecode   # add the notebook's deps, keep the base
uv run --no-sync marimo edit notebook.py …
```

The backend runs every command in a login shell, so `files/marimo.sh` in
`/etc/profile.d` is where the kernel's runtime env lives.

## Customize

- **Pinned libraries**: edit `warm/pyproject.toml` (marimo is added separately
  via `MARIMO_VERSION` in `build.mjs`).
- **System packages**: add `sudo apt-get install -y …` to the install step in
  `build.mjs`.
- **Source builds**: allowed by default. To disable them, add
  `export UV_NO_BUILD="${UV_NO_BUILD:-true}"` to `files/marimo.sh` and rebuild
  the snapshot. See [overrides](../../docs/sandbox-image.md#configure-source-builds).
