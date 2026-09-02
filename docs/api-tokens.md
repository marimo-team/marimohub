---
description: Create, use, protect, audit, and revoke personal access tokens for automation.
---

# API tokens

Personal access tokens (PATs) let CI jobs, scripts, and the CLI call the
`/api/v1/*` HTTP API without a browser session. A token acts as the user who
created it. It cannot add authority that the user does not have.

For an interactive CLI, run `mohub login`. For a remote CLI, run
`mohub login --device-code`. Both commands create a 30-day token by default. You
can select a different lifetime in the approval page. Use manual tokens for
non-interactive automation.

## Create a token

In the app, open the user menu (top right) → **API tokens** → **Create a
token**. Name it after what will hold it, such as `ci-deploy`. You must select
an action preset and a project mode. You can also set an expiry in days.

The presets expand to a fixed action list when you create the token:

| Preset         | Access                                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| Read           | Read projects and integrations                                                     |
| Run notebooks  | Read access, use integrations, and start, attach, stop, surface, or proxy sessions |
| Edit notebooks | Run access, write notebooks, and publish change requests                           |
| Full           | Every PAT-accessible action, including actions added in later releases             |

Use **Advanced** to select individual canonical actions. An explicit action
list does not include actions that the Hub adds in later releases.

Project access can include all projects or 1 to 100 selected projects. The all
projects option also includes projects that the user can access in the future.
A selected-project token cannot use deployment-level actions, even if its
action list contains them.

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

The Hub checks three boundaries for each request:

```text
allowed = current user authority ∧ resource security ∧ token grant
```

The current role, membership, security labels, and project lifecycle still
apply. Removing a user from a project removes the token's access to that
project. Adding a project to the token grant does not add membership.

Know the blast radius before you create one:

- **Choose the smallest useful grant.** A full token can do everything its user
  can do on PAT-enabled routes. A selected-project token masks other projects
  as not found. A missing action returns a forbidden response.
- **Expiry is optional.** Omitting `expires_in_days` mints a token that never
  expires. For anything long-lived, prefer a bounded lifetime and rotate it, so
  a leak has a time limit even if it goes unnoticed.
- **Tokens cannot manage tokens.** `POST`/`GET`/`DELETE /api/v1/me/tokens`
  require session (SSO) auth, so a leaked token cannot mint replacements or
  revoke its neighbors — but note this only limits _token_ escalation, not the
  account-level access above.

> **A scoped token can start a powerful notebook sandbox.** Action scopes limit
> Hub API calls. They do not restrict code inside an authorized kernel. They
> also do not remove credentials that the Hub injects into that kernel.

## Token format

```
mhub_pat_<id>_<secret>
```

The fixed `mhub_pat_` prefix identifies leaked tokens to secret scanners.
Register it in the scanning tools you use. The `id` is the public token ID. The
160-bit `secret` exists only in the create response and as a server-side hash.

The scoped endpoint is `POST /api/v1/me/tokens/scoped`. Its request must include
a `grant`. The legacy `POST /api/v1/me/tokens` endpoint remains available. It
rejects a `grant` field and creates an unrestricted legacy token.

Token list and create responses include `grant` for scoped tokens. An absent
grant means unrestricted legacy access. The token table labels these records
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

Scoped tokens use version 2 credential records and authorization states. Old
replicas reject these records. They do not treat them as unrestricted tokens.

During a mixed-version rollout, a scoped token can fail on an old replica. It
must never gain broader access. Finish the rollout on all replicas before you
depend on scoped tokens.
