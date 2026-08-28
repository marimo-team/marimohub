---
description: Open a notebook workspace in browser-based VS Code on its existing edit sandbox.
---

# VS Code surface

marimohub can run code-server or OpenVSCode Server beside marimo in the same
notebook edit sandbox. Both editors use the same workspace, credentials, Python
environment, and lifecycle. Stopping the session saves the workspace through
the normal version-capture path.

VS Code is disabled by default. Enable it with a sandbox image built from the
`vscode` target in `images/marimo-sandbox/Dockerfile`:

```bash
MARIMOHUB_SURFACES=marimo,vscode
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest-vscode
```

The notebook toolbar then shows **Open in VS Code** for editors who can attach
to the edit session. The server starts VS Code on demand and opens it in a new
tab. Set `MARIMOHUB_SURFACE_VSCODE_START=eager` to start it with each new edit
session. Set `MARIMOHUB_SURFACE_VSCODE_EMBED=iframe` to show marimo and VS Code
side by side instead.

## Availability

The compute adapter must expose more than one port from one sandbox. The current
implementation enables this for `local`, `e2b`, and `cloudflare`. Configuration
fails at startup on an adapter that cannot provide the second port. Docker,
Podman, Kubernetes, Modal, and CoreWeave require their create-time port manifests
to reserve the configured VS Code port before they can enable this feature.

If the selected image does not contain the configured server binary, the
surface is marked unavailable and the marimo session continues to run.

## Editing behavior

- marimo starts with file watching when VS Code is enabled. A saved VS Code edit
  reloads in marimo. Set `MARIMOHUB_SURFACE_VSCODE_MARIMO_WATCH=false` to opt out.
- VS Code autosaves after one second by default. Concurrent writes remain
  last-writer-wins; v1 does not merge editor buffers.
- Temporary edit sessions may use VS Code, but their changes are discarded with
  the sandbox.
- App sessions and viewer-owned ephemeral sessions cannot start VS Code. Its
  terminal has the same credential access as the notebook kernel and remains
  inside the editor trust boundary.
- VS Code user data stays under `/tmp/.marimohub`, outside the versioned
  workspace. Unsaved hot-exit buffers do not survive a sandbox restart.
- The extension gallery defaults to Open VSX. Set
  `MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY=none` for an air-gapped deployment,
  or provide the HTTP(S) service URL of a mirror.

## Exposure

In `proxy` mode, HTTP and WebSocket traffic uses a signed
`/surface-proxy/<token>/vscode/` prefix. The hub authenticates and authorizes
each new request or upgrade. In `subdomain` mode, the compute adapter returns the
second port's direct URL. The same origin-isolation requirements as the marimo
kernel apply.

See [Configuration](./configuration.md#compute) for all VS Code settings.
