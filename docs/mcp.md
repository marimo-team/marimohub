---
description: Connect Claude, Cursor, and other MCP clients to marimohub notebooks.
---

# MCP server

Marimohub exposes notebooks that a user can access through the Model Context
Protocol (MCP). OAuth 2.1 opens a browser consent page. There, the user selects
actions, projects, and token lifetime. The client receives a scoped
[personal access token](./api-tokens.md).

## Enable MCP

MCP is off by default and runs only on the Node server. Set these variables:

```dotenv
MARIMOHUB_MCP=on
MARIMOHUB_APP_BASE_URL=https://hub.example.com
```

`MARIMOHUB_APP_BASE_URL` must include the public origin and any path prefix.
The MCP server URL adds `/mcp` to this value:

```text
https://hub.example.com/mcp
```

OAuth discovery uses the base URL to publish stable, absolute URLs. The API
tokens dialog shows the MCP URL.

## Connect a client

For Claude Code, run:

```bash
claude mcp add --transport http marimohub https://hub.example.com/mcp
```

For Claude.ai, add a custom connector and enter the MCP server URL. For Cursor,
add a remote HTTP MCP server. The client discovers the authorization server,
registers itself, and opens the marimohub consent page.

Before approval, verify the client name and redirect URL. The default grant
permits notebook editing and execution. You can restrict its actions, projects,
and lifetime. Revoke the token from the API tokens dialog. Marimohub issues no
refresh token, so expiry or revocation requires new authorization.

## Tools

### `list_catalog`

Lists accessible projects and notebooks. Filters by project, notebook status,
tag, or text. Includes active sessions by default.

### `launch_notebook`

Starts or reuses an edit or app session. The first launch can take about two
minutes. Later calls reuse an eligible session.

### `execute_code`

Runs code in the scratchpad of a live edit session. Open the notebook URL in a
browser before you call this tool. The kernel remains available while a tab is
connected and during marimo's short grace period. If no tab is connected, the
tool returns the URL to open.

The scratchpad shares the notebook's live variables. For durable cell changes,
first inspect marimo code mode:

```python
import marimo._code_mode as cm
help(cm)
```

## OAuth and security

Dynamic registration creates public clients that use authorization code with
PKCE S256. Redirect URIs require HTTPS, loopback HTTP, or a private-use
application scheme. Each code expires after ten minutes and permits one claim.
The OAuth resource must exactly match the configured MCP URL.

Within the configured app base path, MCP reserves these paths:

- `/mcp`
- `/authorize`
- `/token`
- `/register`
- `/revoke`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

Action scopes restrict Hub API calls, but not kernel code or injected
credentials. Select the smallest useful grant and a short token lifetime.

OAuth rate limits apply to the deployment, not to each client IP.
