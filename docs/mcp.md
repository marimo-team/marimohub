---
description: Connect Claude, Cursor, and other MCP clients to marimohub notebooks.
---

# MCP server

Marimohub exposes notebooks that a user can access through the Model Context
Protocol (MCP). By default, the Hub issues a scoped
[personal access token](./api-tokens.md) after browser consent. Deployments can
instead enable [external authorization](#external-authorization) through their OIDC issuer.

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

OAuth discovery uses the base URL to publish stable, absolute URLs. The MCP dialog in the user menu shows the MCP URL and client setup instructions.

## Connect a client

For Claude Code, run:

```bash
claude mcp add --transport http marimohub https://hub.example.com/mcp
```

For Claude.ai, add a custom connector and enter the MCP server URL. For Cursor,
add a remote HTTP MCP server. The client discovers the authorization server.

By default, the client registers with the Hub and opens the marimohub consent page.
With external authorization, the client uses the issuer described in the next section.

For the default Hub authorization flow, use the following consent checklist.
Check the client name and redirect URL before approval.
The default grant permits notebook editing and execution. Use the smallest practical set of
actions and projects. The token lifetime defaults to 7 days and cannot exceed
90 days. Revoke a token from the API tokens dialog. Marimohub does not issue
refresh tokens. Expiry or revocation requires a new authorization.

## External authorization

With [external OIDC access tokens](./auth.md#external-access-tokens)
enabled, MCP discovery advertises the configured OIDC issuer. Clients use that
issuer for authorization and consent. The issuer must support the discovery,
client registration, and PKCE flow that each MCP client requires.

Configure the issuer to accept the exact public MCP URL as an OAuth resource,
including any deployment path prefix.

Clients must request `mcp:tools` and at least one
[Hub grant scope](./auth.md#scope-grants), such as `marimohub:read` or
`marimohub:edit`. The issuer controls which clients can request these scopes
and what the user approves.

External authorization does not use the Hub consent page or its project selector.
Token scopes limit actions across all projects that the user can already access.
They cannot increase user permissions or permit session-only administration.

Existing Hub-issued MCP tokens continue to work. Hub OAuth endpoints remain
available, but protected-resource metadata advertises only the external issuer.
External tokens expire within one hour, or sooner under the configured group-session limit.
The Hub cannot revoke or refresh them.

A gateway needs an access token for the Hub with the required audience and scopes.
A shared issuer alone does not guarantee one authorization step.
Test discovery, client registration, resource requests, and scope requests with your gateway before deployment.

## Tools

### `list_catalog`

Lists accessible projects and notebooks. Filters by project, notebook status,
tag, or text. Includes active sessions by default.

### `create_notebook`

Creates a local notebook from Python source. Set `launch` to `true` to start an
edit session and return its session details.

### `start_session`

Starts or reuses an edit or app session. The first start can take about two
minutes. Later calls reuse an eligible session.

### `stop_session`

Stops a session and destroys its sandbox. The stop process attempts to save
changes from persistent edit sessions.

### `execute_code`

Runs code in the scratchpad of a live edit session. Open the notebook URL in a
browser before you call this tool. The kernel remains available while a tab is
connected and during marimo's short grace period. If no tab is connected, the
tool returns the URL to open. Pass the project and session ID returned by
`start_session`. The tool automatically uses the first connected kernel.

The scratchpad shares the notebook's live variables. For durable cell changes,
first inspect marimo code mode:

```python
import marimo._code_mode as cm
help(cm)
```

## OAuth and security

The following OAuth rules apply to Hub-issued credentials. External credentials
use the issuer requirements in [external authorization](#external-authorization).

Dynamic registration creates public clients that use authorization code and
PKCE S256. Redirect URIs must use HTTPS, loopback HTTP, or a private-use
application scheme. Marimohub supports `cursor:` and reverse-domain,
single-slash application schemes. Authorization codes expire after ten minutes
and can be used once. Authorization requests, token exchanges, and issued tokens
must target the configured MCP URL. Each token also stores the registered client
ID. Other marimohub PATs cannot access `/mcp`.

The `mcp:tools` OAuth scope permits MCP access. The consent grant restricts Hub
actions and projects for each tool call.

Within the configured app base path, MCP reserves these paths:

- `/mcp`
- `/authorize`
- `/oauth/consent`
- `/token`
- `/register`
- `/revoke`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

The grant does not restrict kernel code or injected credentials. Use a short
token lifetime.

Hub dynamic registration remains available in both authorization modes.
Registration is anonymous. Marimohub checks client metadata, enforces
deployment-wide rate limits, and expires registrations after 90 days. Each
successful registration emits an `oauth_client_registered` event without
client-supplied names or URIs. Deployments that require client vetting must add
trusted registration controls before enabling MCP.
