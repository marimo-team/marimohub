---
description: Configure authentication and project authorization with OIDC, trusted proxies, Cloudflare Access, or local users.
---

# Auth

Auth decides who can sign in and what they can do. You must choose a backend. If
`MARIMOHUB_AUTH_BACKEND` is unset, marimohub refuses to start instead of falling
back to local auth.

Selector: `MARIMOHUB_AUTH_BACKEND`. Full variables:
[Configuration -> Auth](./configuration.md#auth).

Project roles decide who can edit a notebook. The
[editor sandbox-sharing policy](./editor-sessions.md) controls whether those
editors share one live sandbox or use exclusive ownership.

## Choose a backend

| Backend               | Selector            | Use for                                   |
| --------------------- | ------------------- | ----------------------------------------- |
| OIDC                  | `oidc`              | Production with Google, Okta, Auth0       |
| Trusted proxy headers | `proxy-header`      | oauth2-proxy, Google IAP, Tailscale Serve |
| Cloudflare Access     | `cloudflare-access` | Workers deployments behind Access         |
| Dev bypass            | `dev`               | Local development only                    |

## Configure it

### OIDC (production)

<!--@include: ./setup/auth/oidc.md-->

### Trusted proxy headers

<!--@include: ./setup/auth/proxy-header.md-->

### Cloudflare Access

Cloudflare Access is used by the Workers entrypoint. It reads unprefixed runtime
variables (`AUTH_MODE`, `ACCESS_TEAM`, `ACCESS_AUD`) from the Worker
environment. See [Deploying on Cloudflare](./deploying/cloudflare.md).

### Dev bypass

<!--@include: ./setup/auth/dev.md-->

## Verify it

After deployment:

1. Start the server without an authentication configuration error.
2. Sign in through the configured provider.
3. Create a project.
4. Add a second user with a lower role.
5. Verify that the second user has only the permitted access.

## Production cautions

- Do not use `dev` auth for any deployment that serves real users.
- Set `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS` for OIDC and proxy-header. Use `*` only to allow all domains.
- In proxy-header mode, block proxy bypasses and remove client-supplied identity headers.
- Review `MARIMOHUB_DEFAULT_ROLE` before launch. The default is permissive for a
  trusted single-tenant deployment.
- Treat auth errors as fail-closed until configuration proves otherwise.

## Authorization roles

Roles apply per project and rank `app-user` < `viewer` < `editor` < `manager` < `admin`.
This rank selects role grants. Runtime permissions differ: app users can always use apps, while viewer access depends on viewer mode.
Project owners and [super admins](#super-admins-marimohub_super_admins) are `admin`.
Members can receive any role up to `manager`; existing admin memberships remain valid.

| Capability                                                | `app-user` | `viewer` | `editor` | `manager` | `admin` |
| --------------------------------------------------------- | :--------: | :------: | :------: | :-------: | :-----: |
| Discover app titles and project names                     |     x      |    x     |    x     |     x     |    x    |
| Start and use live apps                                   |     x      |    \*    |    x     |     x     |    x    |
| Read notebook source, versions, and saved outputs         |            |    x     |    x     |     x     |    x    |
| Create notebooks; edit content and restore versions       |            |          |    x     |     x     |    x    |
| Run persistent editors; stop or restart shared apps       |            |          |    x     |     x     |    x    |
| Delete notebooks; manage projects, members, and app links |            |          |          |     x     |    x    |

\* Viewer runtime access depends on [`MARIMOHUB_VIEWER_MODE`](#what-viewers-see-marimohub_viewer_mode).
App users can always use apps but cannot open editors, including ephemeral sandboxes.
See [App user permissions and rollout](./apps.md#stakeholders-the-app-user-role) for assignment and stakeholder navigation.

The server enforces permissions; insufficient write access returns `403 FORBIDDEN`.
[Security labels](./security.md#applying-labels) and credential scopes can further restrict access.

Project creation is open by default, except for users with only app-user access.
App-only users need super-admin status or the `project-creator` entitlement, even when creation is open.
`MARIMOHUB_PROJECT_CREATION=restricted` requires those grants for everyone.
An [OIDC group mapping](#groups-and-roles) or [login-policy module](#login-policy-module) can grant `project-creator`.
The creator becomes the project owner.

### Members: user ids and email invites

A member is identified by user id (canonical) or by email. Managers can add a
member either way: a known email — someone who has signed in before — is
resolved to their user id, while an unknown email is stored as a **pending
invite**. At request time the caller matches a membership by their user id or,
case-insensitively, by their login email, so an invite grants access the first
time that person signs in, with no extra step. One person can never hold both
an invite row and an id row — adding a member is rejected (409) when any of
their known identifiers is already on the roster, so removing a member always
revokes their access.

After an invitee signs in, the next membership write or maintenance sweep
replaces their email invite with a user-id row while preserving their role. A
legacy roster that contains both forms is collapsed to one user-id row with the
higher role. Email matching remains active until that claim occurs, so access is
continuous.

The login email grants access, so OIDC requires `email_verified: true` by
default. `trusted-issuer` permits an enterprise issuer to omit the claim,
including when a domain allowlist is active. If the claim is present, its value
must be boolean `true`.

Invite emails are PII of people who never signed in: the members list and
project detail show them only to project managers (and to the invitee themself).
The add-member picker searches the user directory
(`GET /api/v1/users/search` — email, name, or id substring; everyone who has
signed in at least once). Search requires a viewer-or-higher default role,
super-admin status, or membership in at least one active project (including ownership).

**Rollout note:** code older than this feature cannot parse a `project.json`
containing an email invite row. Finish rolling out a release with this feature
before creating email invites, and treat a rollback across it as requiring
those invites to be removed first.

### What viewers see: `MARIMOHUB_VIEWER_MODE`

What a viewer gets depends on `MARIMOHUB_VIEWER_MODE`. The modes are ordered:
each tier includes everything the previous one grants.

- `static` (default): opening a notebook shows the last captured HTML snapshot.
  Viewers cannot start compute or use apps.
- `applications`: additionally, viewers can use
  [notebook apps](./apps.md) — start one, open it, and keep it alive while they
  have it open. The app is the same shared, per-notebook session editors use
  (viewers cannot stop or restart it). Note that the app kernel runs notebook
  code with the project's integration secrets and federated credentials, so enable this
  only for audiences you trust with what the app can reach. Opening a notebook
  (rather than its app) still shows the static snapshot.
- `ephemeral-sandbox`: additionally, opening a notebook provisions a real
  kernel in a temporary, private session. The viewer can run and edit code, but
  nothing is written back — no version, snapshot, or workspace changes. Edits
  are discarded when the session ends.

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
- `manager`: every logged-in user can manage every project. Use only in a fully
  trusted deployment.
- `viewer`: every logged-in user can read any project.
- `app-user`: every logged-in user can use apps without source access.
- `none`: non-members cannot see projects they do not own or belong to.

### Super admins: `MARIMOHUB_SUPER_ADMINS`

`MARIMOHUB_SUPER_ADMINS` is a comma-separated list of operators who are treated
as `admin` on **every** project, regardless of membership or
`MARIMOHUB_DEFAULT_ROLE`. A super admin can see and list all projects (even under
`MARIMOHUB_DEFAULT_ROLE=none`), read and write every notebook, secret, and
[integration](./integrations.md), control any session, and read the audit trail.
It is the one grant that overrides the per-project role model. Only super admins
can manage [organization-wide integrations](./integrations.md#organization-wide-integrations).
Project roles never grant this access.

The web application gives super admins access to the users, settings, audit-log,
and debug pages. They can suspend or reactivate any other user from the users
page. The audit page uses `GET /api/v1/events`, which returns at most 30 UTC days
per query. The debug page runs the
[sandbox startup diagnostic](./operations.md#sandbox-startup-diagnostic).
Project managers retain access to each project's daily audit log.

Existing non-owner Admin memberships remain valid and can be demoted or removed,
but the API does not allow new Admin assignments. A deployment introducing
Manager must stop all old replicas before the first Manager row is stored; older
versions cannot parse that role. Rolling back requires converting Manager rows
first.

An entry containing `@` matches the caller's login email, case-insensitively;
any other entry matches the user id (the IdP `sub`) exactly. The two namespaces
do not overlap — an email entry never elevates a caller whose _id_ happens to
equal that string, and vice versa. Email matching trusts the IdP-asserted login
email, the same trust model as email invites.

Two bounds still hold for a super admin: a project owner cannot be demoted or
removed, and a soft-deleted project stays unreachable (`404`) like it is for
everyone else. Session and app rate caps are not bypassed. A personal access
token minted by a super admin carries the same power, so scope those tokens
accordingly. Unset (the default) means no super admins.

## Deprovisioning and user suspension

Super admins can suspend a known user from **Admin -> Users**, or with
`PUT /api/v1/admin/users/{id}/suspension`; `DELETE` on the same path reactivates the
user. Suspension blocks both browser-session authentication and personal access
tokens. Requests authenticated with a browser session receive
`403 USER_SUSPENDED`; PAT authentication fails as an invalid credential.
Suspension and reactivation write `user.suspended` and `user.unsuspended` audit
events with the operator and target user ids.

Enforcement uses a bounded per-user cache in each server process. An active
result is fresh for 10 seconds, then served stale while it refreshes until a
hard limit of 30 seconds. Past that limit the request waits for storage; if the
status cannot be verified, the API fails closed with `503 SERVICE_UNAVAILABLE`.
A suspended result is cached for five minutes and remains denied while a stale
entry refreshes. This asymmetry bounds unauthorized access without making a
storage outage reactivate anyone. Pair suspension with session revocation at
the identity provider when access must end immediately.

Profile and suspension updates use ETag compare-and-swap. An authenticated
profile refresh therefore cannot overwrite a concurrent suspension change.

Suspension does not terminate an already-running notebook sandbox. Its normal
lifetime and idle policies still apply. This lifecycle flag is also the intended
target for future SCIM deprovisioning: a SCIM `active: false` update can suspend
the same identity without changing the authentication-time enforcement path.

## Troubleshooting

See [Troubleshooting -> Login fails](./troubleshooting.md#login-fails).
