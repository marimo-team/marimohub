---
description: Create, use, protect, audit, and revoke personal access tokens for automation.
---

# API tokens

Personal access tokens (PATs) let CI jobs, scripts, and the CLI call the
`/api/v1/*` HTTP API without a browser session. A token acts as the user who
created it. It cannot add authority that the user does not have.

MCP clients receive the same kind of scoped PAT through the browser consent
flow. See [MCP server](./mcp.md).

For an interactive CLI, run `mohub login`. For a remote CLI, run
`mohub login --device-code`. Both commands create a 30-day token by default. You
can select a different lifetime in the approval page. Use manual tokens for
non-interactive automation.

## Create a token

In the app, open the user menu (top right) → **API tokens** → **Create a
token**. Name it after its consumer, such as `ci-deploy`. Select an action
preset and a project mode. You can also set an expiry in days.

Read, Run notebooks, and Edit notebooks expand to fixed action lists when you
create the token. Full stores the `"*"` action wildcard instead.

| Preset         | Access                                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| Read           | Read projects and integrations                                                     |
| Run notebooks  | Read access, use integrations, and start, attach, stop, surface, or proxy sessions |
| Edit notebooks | Run access, write notebooks, and publish change requests                           |
| Full           | Every PAT-accessible action, including actions added in later releases             |

Use **Advanced** to select individual actions. An explicit list excludes
actions that the Hub adds in later releases.

Project access can include all projects or 1 to 100 selected projects. The all
projects option also includes projects that the user can access in the future.
A selected-project token cannot use deployment-level actions, even if its
action list contains them.

The dialog shows the plaintext token **exactly once**. Copy it immediately.
The server stores only its SHA-256 hash. Each user can hold up to 20 tokens.
Token creation requires a signed-in browser session.

## Use it

Send the token as a bearer credential:

```bash
curl https://hub.example.com/api/v1/me \
  -H "Authorization: Bearer mhub_pat_…"
```

The request authenticates as the issuing user. The response to `/api/v1/me`
returns that user's identity. The browser does not attach bearer headers
automatically, so PAT requests do not use the cookie-oriented CSRF guard.

The Hub evaluates three boundaries for each request:

```text
allowed = current user authority ∧ resource security ∧ token grant
```

The current role, membership, security labels, and project lifecycle still
apply. Removing a user from a project removes the token's access to that
project. Adding a project to the token grant does not add membership.

Know the blast radius before you create one:

- **Choose the smallest useful grant.** A full token has the user's authority
  on all PAT-enabled routes. Other projects appear not found to a
  selected-project token. An omitted action returns a forbidden response.
- **Expiry is optional.** Omitting `expires_in_days` mints a token that never
  expires. For anything long-lived, prefer a bounded lifetime and rotate it, so
  a leak has a time limit even if it goes unnoticed.
- **Tokens cannot manage tokens.** `POST`/`GET`/`DELETE /api/v1/me/tokens`
  require session authentication. A leaked token cannot create or revoke other
  tokens, but it keeps all access in its own grant.

> **A scoped token can start a powerful notebook sandbox.** Action scopes limit
> Hub API calls. They do not restrict code inside an authorized kernel. They
> also do not remove credentials that the Hub injects into that kernel.

## Token format

```
mhub_pat_<id>_<secret>
```

The fixed `mhub_pat_` prefix identifies leaked tokens to secret scanners.
Register it in the scanning tools you use. The `id` is the public token ID. The
server returns the 160-bit `secret` only in the create response. It does not
store the secret.

The server stores a SHA-256 digest, not the plaintext token. A legacy token
hashes the secret. A scoped token hashes the domain-separated input
`mhub_pat:v2:<id>:<secret>`. The token ID in this input binds the digest to the
version 2 record.

Use `POST /api/v1/me/tokens/scoped` with a required `grant`. The legacy
`POST /api/v1/me/tokens` route rejects `grant` and creates an unrestricted
legacy token. API responses omit `grant` for legacy tokens. The app labels them
as **Full access · all projects · legacy**.

## Revoke a token

Delete it from the **API tokens** dialog.

Revocation (and expiry) takes effect immediately on the replica that served the
request and within about 30 seconds everywhere else — verified tokens are
positively cached per process for that long to keep per-request verification
off the storage hot path.

## Audit

Token lifecycle is recorded in the audit event stream as `token.create` and
`token.revoke`, stamped with the acting user. These are account-level events.
They do not appear in any single project's audit log.

The `token.create` event includes the immutable grant for a scoped token. It
never includes the token secret.

## Rolling upgrades

Scoped tokens use version 2 records. Old replicas reject these records instead
of treating them as unrestricted. A scoped token can fail during a mixed-version
rollout, so update all replicas before you depend on it.
