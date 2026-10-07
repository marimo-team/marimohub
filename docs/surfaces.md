---
description: Run VS Code or OpenCode beside marimo in an existing edit sandbox.
---

# Session surfaces

marimohub can run VS Code, OpenCode, or both in an edit sandbox. Each surface
shares marimo's workspace, Python environment, credentials, authorization, and
session lifetime. A surface does not create another sandbox.

Secondary surfaces are disabled by default. Select an image and enable the
matching surface:

```bash
# VS Code only
MARIMOHUB_SURFACES=marimo,vscode
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest-vscode

# OpenCode only
MARIMOHUB_SURFACES=marimo,opencode
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest-opencode

# Both
MARIMOHUB_SURFACES=marimo,vscode,opencode
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest-tools
```

The notebook header has an **Open** menu. While the editor session runs, the
menu has a start action for each enabled surface. It has a stop action when that
surface is running. The same menu also has **Run as app** and **View static
outputs**.

By default, a surface opens in the notebook's application tabs. Set its `EMBED`
variable to `iframe` to open it beside marimo in a split view. The most recently
opened split replaces the previous split, while the previous surface remains
available as a background tab. Use a surface tab's pop-out control to open its
iframe in a separate browser tab.

Set a surface's `START` variable to `eager` to start it with each authorized edit
session. The default is `on-demand`. A surface failure does not stop marimo or
another surface.

## Availability

Secondary surfaces require an adapter with `multiPort: true`. Supported built-in
adapters are `local`, `docker`, `podman`, `e2b`, `cloudflare`, `coreweave`, and
`kubernetes`. Compatible external `library` adapters can also support surfaces.
Configuration fails when the adapter does not advertise this capability.

Docker and Podman publish each enabled surface on a separate host port at
container creation. Port changes require new containers.

On kubernetes with subdomain exposure each port gets its own `{id}-{port}.{host}`
Ingress host, so the `*.{host}` wildcard DNS record and TLS certificate must cover
it.

Port 2718 belongs to marimo. Each secondary surface must use a unique port. If
an image lacks a required binary, only that surface becomes unavailable.

## Editing and state

- marimo runs with `--watch` whenever a secondary surface is enabled. A file
  saved from VS Code or OpenCode then reloads in marimo.
- VS Code opens the notebook entry path. OpenCode starts in the workspace without
  a notebook path.
- VS Code autosaves after one second. Concurrent writes use last-writer-wins.
- Surfaces start and stop independently. Session teardown stops all surfaces,
  captures eligible workspace changes, and destroys the sandbox.
- Surface configuration, caches, credentials, databases, and UI state stay
  under `/tmp/.marimohub/surfaces/<session-id>/<surface-id>`. They survive a
  stop and restart in the same sandbox. They are not versioned and do not
  survive session teardown.
- Temporary edit sessions can use surfaces. Their changes are discarded with
  the sandbox.

## API

Surfaces are per session. All routes live under
`/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}`,
where `surface` is `vscode` or `opencode`.

| Method   | Purpose                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `POST`   | Start the surface, or return it when running. Body: `{ "open": "<path>" }` |
| `GET`    | Read the surface state (`starting`, `ready`, `failed`, ...).               |
| `DELETE` | Stop the surface. Requires session control.                                |

`open` is a workspace-relative file path; only VS Code accepts it.

`POST` returns `202` with `Retry-After: 1` while the surface is `starting`, and
`200` once it is `ready`. Poll `GET` until the status leaves `starting`. A
`ready` surface includes its `url`; a `failed` or `unavailable` surface includes
`last_error`.

Session create (`POST .../sessions`) accepts a `surfaces` array of surface ids
to start with the session; only edit sessions may list surfaces. Every session
response carries `can.surfaces`, one boolean per surface id, so clients render
the start controls from the caller's evaluated grant instead of re-deriving
policy.

## OpenCode AI providers

When [managed AI](./ai.md) is enabled, marimohub adds a temporary `marimohub`
provider when OpenCode starts. This OpenAI-compatible provider uses the configured
model and a session token. The upstream API key stays on the server.

Project `opencode.json` files can override the provider or initial model. Users
can also add bring-your-own-key providers through `/connect`. These credentials
stay in the temporary surface directory.

The managed token expires after `MARIMOHUB_AI_TOKEN_TTL_SECONDS`, even while
OpenCode is open. Restart OpenCode to get a new token. A bring-your-own-key
provider uses its own credential.

## Kernel access

Secondary surfaces and their child agents inherit the sandbox environment,
including `MARIMOHUB_CONTEXT_FILE`. See
[Sandbox environment](./environment-and-access.md#sandbox-environment) for the
full list. Surfaces also get two kernel variables:

- `MARIMOHUB_KERNEL_URL`: the sandbox-local kernel URL. In `proxy` mode it keeps the
  full hub path prefix, for example `/marimohub/proxy/<token>/`.
- `MARIMOHUB_KERNEL_TOKEN_FILE`: the token file path, or an empty string with native authentication disabled.

The local compute adapter maps both values to the host process.
OpenCode images include a `marimo-pair` skill that passes these values to
the built-in `uv run --no-sync marimo pair` CLI through `--url` and `--token-file`.
Because the skill passes the URL explicitly, it does not depend on marimo's server
registry, so it works regardless of authentication or `XDG_STATE_HOME`.

## Security and exposure

Only users who can attach to an edit session can use its surfaces. App sessions
and viewer-owned ephemeral sessions cannot use them. VS Code terminals and
OpenCode agents can run shell commands and read the notebook credentials.

VS Code supports both exposure modes. In `proxy` mode, traffic uses a signed
`/surface-proxy/<token>/vscode/` path. The hub authorizes each HTTP request and
WebSocket upgrade.

OpenCode supports only `subdomain` mode because its client uses root-relative
paths. Configuration fails when OpenCode and
`MARIMOHUB_SANDBOX_EXPOSURE=proxy` are both enabled.

In `subdomain` mode, only authorized editors receive direct surface URLs.
Cloud adapters use high-entropy URLs as access capabilities. Keep sandbox
domains isolated and URLs private.

In `subdomain` mode, Docker and Podman return `http://<HOST>:<port>` URLs without
that protection. Browsers must reach these ports through a trusted, isolated
network. In `proxy` mode, only the hub needs access to the published ports.
Browsers connect to VS Code through the hub. See the
[Docker](./compute.md#docker) and [Podman](./compute.md#podman) setup guides.

See [Configuration](./configuration.md#compute) for all surface configuration and
[Security](./security.md#secondary-editor-surfaces) for the trust boundary.
