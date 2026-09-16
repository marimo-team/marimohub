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
With [external authorization](#external-authorization), the client uses the configured issuer.

For the default Hub authorization flow, use the following consent checklist.
Check the client name and redirect URL before approval.
The default grant permits notebook editing and execution. Use the smallest practical set of
actions and projects. The token lifetime defaults to 7 days and cannot exceed
90 days. Revoke a token from the API tokens dialog. Marimohub does not issue
refresh tokens. Expiry or revocation requires a new authorization.

## Work with notebooks

Use `list_catalog` to find accessible projects, notebooks, and active sessions.
Project and notebook selectors accept IDs or exact names, case-insensitively.
Use IDs when names are duplicated and for subsequent calls.

| Tool              | Purpose                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `list_catalog`    | Discover notebooks. Filter by project, status, tag, or text.                      |
| `get_notebook`    | Read notebook metadata and stored source.                                         |
| `create_notebook` | Create a local notebook. Optional `launch` starts an edit session.                |
| `update_notebook` | Replace supplied metadata fields or the complete local source.                    |
| `delete_notebook` | Soft-delete a notebook, retire live apps, and cancel job runs.                    |
| `start_session`   | Start or reuse an edit or app session.                                            |
| `execute_code`    | Run Python in an edit session's live scratchpad.                                  |
| `stop_session`    | Stop a session and destroy its sandbox, with a save attempt for persistent edits. |

### Edit stored source

Notebook reads, updates, and deletions work without a session. `get_notebook`
returns stored source, which can differ from unsaved edits in a live session.

1. Read the notebook with `get_notebook`.
2. Pass the changed fields to `update_notebook`, using `expected_updated_at` from the read.

Omitted fields remain unchanged. Supplied fields replace their previous values.
A code update creates a version. Remote source changes go through sync.
`delete_notebook` also accepts `expected_updated_at`.

If the precondition fails, read the latest notebook before retrying.
A persistent edit session blocks stored code replacement until its sandbox is cleaned up.
Edit in the live session, or stop it and call `get_notebook` to include its saved changes before retrying.
Metadata updates, app sessions, and temporary sessions do not have this restriction.

### Source format

The `code` parameter for `create_notebook` and `update_notebook` contains a
complete marimo Python notebook. For example:

```python
import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    mo.md("Hello from MCP")
    return


if __name__ == "__main__":
    app.run()
```

The Hub stores source verbatim, without syntax validation or script conversion.
Local notebook dependencies come from the workspace `pyproject.toml`.
PEP 723 headers remain in the source but do not install dependencies for local notebooks.

### Work in a live session

1. Call `start_session` with `mode: "edit"`.
2. Read `execution.ready`. If it is false, follow `execution.next_step`.
3. Call `execute_code` with the returned project and session IDs.
4. When finished, call `stop_session` for sessions you no longer need.

The first start can take about two minutes. Session `status` describes the
sandbox lifecycle. `execution` reports whether a kernel is available for code
execution. When its status is `awaiting_client`, open `notebook_url` in a browser.
The browser connection creates the kernel. Readiness can change between calls.

`execute_code` takes Python statements and shares the notebook's live variables.
Scratchpad execution does not save notebook cells. For persistent cell edits,
inspect marimo's code-mode API with `import marimo._code_mode as cm; help(cm)`.
App sessions serve the notebook and do not support scratchpad execution.

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

The initial authorization challenge requests `mcp:tools marimohub:read`.
Discovery lists all supported scopes, but clients that honor the challenge start with read access.
For execution or editing, authorize the client with the corresponding grant scope.
The Hub does not automatically request broader scopes after a tool is denied.

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
