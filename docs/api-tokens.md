---
description: Create, use, protect, audit, and revoke personal access tokens for automation.
---

# API tokens

Personal access tokens (PATs) let CI jobs, scripts, and the CLI call the
`/api/v1/*` HTTP API without a browser session. A token acts as the user who
created it: it inherits their project memberships and roles unchanged, and it
works on every deployment — there is nothing to configure.

For an interactive CLI, run `mohub login`. The browser approval flow creates a
token with a 30-day lifetime by default and lets you choose a different lifetime
before approving. Manual token creation is intended for automation and other
clients that cannot use the browser flow.

## Create a token

In the app, open the user menu (top right) → **API tokens** → **Create a
token**. Name it after what will hold it (for example `ci-deploy`) and
optionally set an expiry in days.

The dialog shows the plaintext token **exactly once** — the server stores only
its SHA-256 hash, so it can never be shown again. Copy it immediately. Each
user can hold up to 20 tokens.

There is no way to mint a token without a signed-in session — see the
restrictions below.

## Use it

Send the token as a bearer credential:

```bash
curl https://hub.example.com/api/v1/me \
  -H "Authorization: Bearer mhub_pat_…"
```

The request authenticates as the issuing user; the response to `/api/v1/me`
returns their identity. Token-authenticated requests are exempt from the
cookie-oriented cross-origin (CSRF) guard — a bearer header is never attached
ambiently by a browser, so there is nothing to forge.

Know the blast radius before you create one:

- **A token is full account power.** There are no scopes in v1 — a token can do
  everything its user can on every route except token management: create and
  delete notebooks, manage integrations, and start sessions.
  A leaked token is therefore equivalent to a compromised account. Treat it like
  a password. Scoped (read-only, per-project) tokens are a planned follow-up.
- **Expiry is optional.** Omitting `expires_in_days` mints a token that never
  expires. For anything long-lived, prefer a bounded lifetime and rotate it, so
  a leak has a time limit even if it goes unnoticed.
- **Tokens cannot manage tokens.** `POST`/`GET`/`DELETE /api/v1/me/tokens`
  require session (SSO) auth, so a leaked token cannot mint replacements or
  revoke its neighbors — but note this only limits _token_ escalation, not the
  account-level access above.

## Token format

```
mhub_pat_<id>_<secret>
```

The fixed `mhub_pat_` prefix identifies leaked tokens to secret scanners —
register it in the scanning tools you use. The `id` is the token's public
identifier (shown in the token list); the 160-bit `secret` exists only in the
create response and as a hash on the server.

## Revoke a token

Delete it from the **API tokens** dialog.

Revocation (and expiry) takes effect immediately on the replica that served the
request and within about 30 seconds everywhere else — verified tokens are
positively cached per process for that long to keep per-request verification
off the storage hot path.

## Audit

Token lifecycle is recorded in the audit event stream as `token.create` and
`token.revoke`, stamped with the acting user. These are account-level events;
they do not appear in any single project's audit log.
