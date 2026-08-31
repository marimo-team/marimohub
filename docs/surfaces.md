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

The toolbar has a **Surfaces** menu, even when only one surface is enabled. The
menu has a start action for each surface. It has a stop action when that surface
is running.

By default, a surface opens in the notebook's application tabs. Set its `EMBED`
variable to `iframe` to open it beside marimo in a split view. The most recently
opened split replaces the previous split, while the previous surface remains
available as a background tab. Use a surface tab's pop-out control to open its
iframe in a separate browser tab.

Set a surface's `START` variable to `eager` to start it with each authorized edit
session. The default is `on-demand`. A surface failure does not stop marimo or
another surface.

## Availability

The compute adapter must expose multiple ports from one sandbox. The `local`,
`e2b`, and `cloudflare` adapters support this feature. Configuration fails for
other adapters. Docker, Podman, Kubernetes, Modal, CoreWeave, and W&B need
create-time port reservation support.

Port 2718 belongs to marimo. Each secondary surface must use a unique port. If
an image lacks a required binary, only that surface becomes unavailable.

## Editing and state

- marimo watches files when either surface requests this behavior. A saved file
  then reloads in marimo.
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

In `subdomain` mode, each surface has a direct, high-entropy URL. The URL is an
access capability, so the hub returns it only to authorized editors. Keep the
sandbox domain isolated. Do not publish these URLs.

See [Configuration](./configuration.md#compute) for all surface configuration and
[Security](./security.md#secondary-editor-surfaces) for the trust boundary.
