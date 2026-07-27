---
description: Configure OIDC, Cloudflare Access, or local authentication and understand project authorization.
---

# Auth

Auth decides who can sign in and what they can do. You must choose a backend. If
`MARIMOHUB_AUTH_BACKEND` is unset, marimohub refuses to start instead of falling
back to local auth.

Selector: `MARIMOHUB_AUTH_BACKEND`. Full variables:
[Configuration -> Auth](./configuration.md#auth).

## Choose a backend

| Backend           | Selector            | Use for                             |
| ----------------- | ------------------- | ----------------------------------- |
| OIDC              | `oidc`              | Production with Google, Okta, Auth0 |
| Cloudflare Access | `cloudflare-access` | Workers deployments behind Access   |
| Dev bypass        | `dev`               | Local development only              |

## Configure it

### OIDC (production)

<!--@include: ./setup/auth/oidc.md-->

### Cloudflare Access

Cloudflare Access is used by the Workers entrypoint. It reads unprefixed runtime
variables (`AUTH_MODE`, `ACCESS_TEAM`, `ACCESS_AUD`) from the Worker
environment. See [Deploying on Cloudflare](./deploying/cloudflare.md).

### Dev bypass

<!--@include: ./setup/auth/dev.md-->

## Validate it

After deploy:

1. Start the server and check that auth configuration does not fail closed.
2. Sign in through the configured provider.
3. Create a project.
4. Add a second user with a lower role.
5. Confirm that user can do only what the role allows.

## Production cautions

- Do not use `dev` auth for any deployment that serves real users.
- Set `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS` for OIDC unless you intentionally
  accept any authenticated domain.
- Review `MARIMOHUB_DEFAULT_ROLE` before launch. The default is permissive for a
  trusted single-tenant deployment.
- Treat auth errors as fail-closed until configuration proves otherwise.

## Authorization roles

Authentication decides who you are. Authorization decides what you may do on a
project. Each project has an owner, who is implicitly `admin`, and a member list.
Roles are ordered `viewer` < `editor` < `admin`; each role includes the
capabilities below it.

| Role     | Description                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `viewer` | Read projects, notebooks, code, and version history. Cannot change state.                            |
| `editor` | Viewer access, plus create, update, and delete notebooks, restore versions, and run kernel sessions. |
| `admin`  | Editor access, plus update or delete the project and manage members.                                 |

| Capability                                                      | `viewer` | `editor` | `admin` |
| --------------------------------------------------------------- | :------: | :------: | :-----: |
| See projects and notebooks, read versions and code              |    x     |    x     |    x    |
| Create, update, and delete notebooks; save and restore versions |          |    x     |    x    |
| Start and stop kernel sessions                                  |          |    x     |    x    |
| Update or delete projects; manage members                       |          |          |    x    |

Enforcement is server-side. A write with an insufficient role returns
`403 FORBIDDEN`. Any authenticated user can create a project; the creator becomes
the project owner.

### Members: user ids and email invites

A member is identified by user id (canonical) or by email. Admins can add a
member either way: a known email — someone who has signed in before — is
resolved to their user id, while an unknown email is stored as a **pending
invite**. At request time the caller matches a membership by their user id or,
case-insensitively, by their login email, so an invite grants access the first
time that person signs in, with no extra step. One person can never hold both
an invite row and an id row — adding a member is rejected (409) when any of
their known identifiers is already on the roster, so removing a member always
revokes their access.

Because the login email is an authorization credential here, the OIDC adapter
refuses to mint a session when the provider declares the email unverified
(`email_verified: false`) — otherwise an attacker self-registering the
invitee's address at a lax IdP could inherit the invite.

Invite emails are PII of people who never signed in: the members list and
project detail show them only to project admins (and to the invitee themself).
The add-member picker searches the user directory
(`GET /api/v1/users/search` — email, name, or id substring; everyone who has
signed in at least once). Under `MARIMOHUB_DEFAULT_ROLE=none` the caller must
own or belong to at least one project to search; with a default role set, any
authenticated user may.

**Rollout note:** code older than this feature cannot parse a `project.json`
containing an email invite row. Finish rolling out a release with this feature
before creating email invites, and treat a rollback across it as requiring
those invites to be removed first.

### What viewers see: `MARIMOHUB_VIEWER_MODE`

What a viewer gets when opening a notebook depends on `MARIMOHUB_VIEWER_MODE`:

- `static` (default): the last captured HTML snapshot. No compute, no code
  execution.
- `ephemeral-sandbox`: a real kernel in a temporary, private session. The viewer
  can run and edit code, but nothing is written back — no version, snapshot, or
  workspace changes. Edits are discarded when the session ends.

Ephemeral sessions are per-user: each viewer gets their own sandbox, isolated
from every other user's, and only its owner can reach it. Refreshing or
re-opening the notebook reconnects to the same live session, so in-session state
survives a reload; the session ends on explicit Stop or after the idle timeout,
and the next visit starts fresh from the notebook's saved version.

### Default access for non-members

A logged-in user who is not the owner or a member falls back to
`MARIMOHUB_DEFAULT_ROLE`:

- `editor` (default): every logged-in user can edit notebooks and run sessions in
  any project, but cannot update or delete projects.
- `viewer`: every logged-in user can read any project.
- `none`: non-members cannot see projects they do not own or belong to.
- `admin`: every logged-in user is a project admin. Use only in a fully trusted
  deployment.

## Troubleshooting

See [Troubleshooting -> Login fails](./troubleshooting.md#login-fails).
