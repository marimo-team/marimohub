# Example E2B kernel template (bring your own template)

The per-session sandbox the **E2B compute backend** (`@marimo-hub/compute-e2b`)
boots one of per notebook kernel — the E2B analogue of
[`examples/sandbox-image`](../sandbox-image) (which serves the `docker` /
`kubernetes` / `modal` / `coreweave` backends). E2B's base template has no marimo,
so you must build one; set its name/id as `MARIMOHUB_COMPUTE_E2B_TEMPLATE`. See
[E2B compute](../../docs/setup/compute/e2b.md).

Unlike a container backend, E2B builds this into an **E2B template** (its own
firecracker-microVM format, with `envd` injected) rather than a Docker image you
push. This uses the E2B **v2 build system** — the template is defined in code
(`template.mjs`) and built by a script (`build.prod.mjs`), not the deprecated
`e2b.toml` + `e2b.Dockerfile` (v1).

## Layout

```
examples/e2b-template/
  template.mjs        # SDK template definition (base image, uv, marimo, warm libs)
  build.prod.mjs      # builds + deploys the template to E2B (Template.build)
  files/marimo.sh     # /etc/profile.d script — runtime env the kernel launch needs
  warm/pyproject.toml # libraries pre-installed into /opt/venv
  package.json        # pins the `e2b` SDK
```

## Build & deploy

```sh
pnpm install                                   # once, from the repo root
cd examples/e2b-template
E2B_API_KEY=<your key> pnpm build:template     # builds template "marimo-sandbox"
```

`build.prod.mjs` prints the template **id**; either the name (`marimo-sandbox`, or
override with `E2B_TEMPLATE_NAME=…`) or the id works as the template reference.

## The one non-obvious gotcha

E2B runs every command in a **login shell** that re-sources `/etc/profile`, so a
template's build-time `ENV` / `.setEnvs()` does **not** reach the kernel launch. The
env the launch needs — above all `UV_PROJECT_ENVIRONMENT=/opt/venv`, so
`uv run --no-sync marimo` resolves the pre-installed venv — must live in an
`/etc/profile.d/*.sh` script (`files/marimo.sh`), not just the build env.

## How it works

marimo + the base libraries are pre-installed into `/opt/venv`
(`UV_PROJECT_ENVIRONMENT`), so the provisioner's launch in `/workspace`
starts instantly for a notebook that only uses them:

```sh
uv sync --inexact --no-compile-bytecode   # add the notebook's deps, keep the base
uv run --no-sync marimo edit notebook.py …
```

## Customize

- **Pinned libraries** — edit `warm/pyproject.toml` (marimo is added separately via
  `MARIMO_VERSION` in `template.mjs`).
- **Sizing** — `cpuCount` / `memoryMB` are passed to `Template.build` in
  `build.prod.mjs`; E2B bills per sandbox-second.
- **System packages** — add to the `.aptInstall([...])` call.
