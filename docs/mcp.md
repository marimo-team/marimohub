---
description: Connect Claude, Cursor, and other MCP clients to marimohub notebooks.
---

# MCP server

Marimohub can expose the notebooks a user can access through the Model Context
Protocol (MCP). The built-in OAuth 2.1 flow opens a browser consent page. The
user selects an action grant, project scope, and token lifetime before the
client receives a scoped [personal access token](./api-tokens.md).

## Enable MCP

MCP is off by default. Set both variables on the Node server:

```dotenv
MARIMOHUB_MCP=on
MARIMOHUB_APP_BASE_URL=https://hub.example.com
```

`MARIMOHUB_APP_BASE_URL` is required because OAuth discovery must advertise
stable, absolute URLs. The MCP server URL is the app base URL plus `/mcp`:

```text
https://hub.example.com/mcp
```

The API tokens dialog shows this URL when MCP is enabled. The Cloudflare Worker
example does not wire MCP yet.

## Connect a client

For Claude Code:

```bash
claude mcp add --transport http marimohub https://hub.example.com/mcp
```

In Claude.ai, add a custom connector and enter the MCP server URL. In Cursor,
add it as a remote HTTP MCP server. The client discovers the authorization
server, registers itself, and opens the marimohub consent page.

Confirm the client name and redirect destination before approval. The default
grant permits editing and running notebooks, but you can reduce its actions or
limit it to selected projects. The resulting token appears in the API tokens
dialog and can be revoked there. Marimohub does not issue refresh tokens; a
client must repeat authorization after expiry or revocation.

## Tools

### `list_catalog`

Lists visible projects and notebooks. Filters include project, notebook status,
tag, and text search. Active sessions are included by default.

### `launch_notebook`

Creates or reuses an edit or app session. The first launch can take about two
minutes. Repeating the call attaches to the same eligible session.

### `execute_code`

Runs code in the live scratchpad of a running edit session. A marimo kernel
session exists only while a browser tab is connected, plus marimo's short
session grace period. Open the notebook URL in a browser before calling this
tool. If no tab is connected, the tool returns the URL to open.

The scratchpad shares the notebook's live variables. To make durable cell
changes, first inspect marimo code mode:

```python
import marimo._code_mode as cm
help(cm)
```

## OAuth and security

Dynamic registrations are public clients and use authorization code with PKCE
S256. Redirects must use HTTPS, loopback HTTP, or a private-use application
scheme. Authorization codes expire after ten minutes and can be claimed once.
The requested OAuth resource must exactly match the configured MCP URL.

The following root paths are reserved while MCP is enabled:

- `/mcp`
- `/authorize`
- `/token`
- `/register`
- `/revoke`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

Action scopes limit Hub API calls. They do not sandbox code inside a kernel or
remove credentials that the Hub injects into an authorized session. Choose the
smallest useful grant and a short token lifetime.

Refresh-token rotation, longer kernel session TTLs, Cloudflare Worker wiring,
and proxy-aware per-IP OAuth rate limits are follow-up work.
