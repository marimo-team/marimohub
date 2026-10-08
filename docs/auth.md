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

### Members: users, email invites, and IdP groups

Each member row identifies one user id, email, or IdP group. Managers and admins can add members.
The highest matching membership role overrides default access, even when the default is higher.
Owners and super admins retain `admin` access.

Removing a row removes that grant. Other memberships, default access, ownership, or super-admin status can still grant access.
Duplicate requests for an existing member return `409`.

#### Users and email invites

User ids match exactly. The server resolves known emails to user ids and stores unknown emails as **pending invites**.
An invite matches the login email without regard to case and grants access on the first sign-in.
The login email grants access, so [OIDC](#oidc-production) requires email verification by default.

After sign-in, the next membership write or maintenance sweep replaces the email row with a user-id row and preserves its role.
If a legacy roster contains both forms, the server keeps one user-id row with the higher role.
The email row grants access until this replacement occurs.

The add-member picker searches signed-in users by email, name, or id through `GET /api/v1/users/search`.
Search requires a default role of viewer or higher, super-admin status, or membership in an active project (including ownership).
User and group rows are visible to all project readers. Pending invite emails are visible only to managers, admins, and the invitee.

#### IdP groups

A group membership grants its role to callers whose authenticated groups contain the exact group id.
Groups can receive `app-user`, `viewer`, `editor`, or `manager`. They cannot receive `admin`.
A group named like a user id or email remains a separate member.

Group ids are case-sensitive. The server does not trim whitespace or normalize Unicode.
See [group selection and ID limits](#group-membership) for valid IDs and OIDC configuration.
Group creation requires OIDC membership selection or a [login-policy module](#login-policy-module) that can carry groups.
The API reports this capability as `groups_carried` in `/api/v1/capabilities`.

To add a group in **Project Access**:

1. Select **IdP group**.
2. Enter the exact group id.
3. Choose a role.
4. Select **Add group**.

The picker suggests your own authenticated groups. It cannot search the IdP directory or confirm that a group exists.
You can add a group you do not belong to.
Group ids are visible to project readers and subscribed alert destinations. Do not use secrets as group ids.

Group grants require browser SSO sessions or enabled external OIDC access tokens.
PATs do not inherit SSO groups and need another applicable project grant within their credential scope.
IdP changes take effect when the credential's groups refresh. See [session freshness](#group-membership).

The API uses these routes:

| Action      | Request                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| Add         | `POST /api/v1/projects/{pid}/members` with `{ "group": "/teams/data", "role": "editor" }`    |
| Change role | `PUT /api/v1/projects/{pid}/group-members?group=%2Fteams%2Fdata` with `{ "role": "viewer" }` |
| Remove      | `DELETE /api/v1/projects/{pid}/group-members?group=%2Fteams%2Fdata`                          |

Encode the group as a query parameter, including literal `+`, `/`, and `&` characters.
The `/members/{uid}` route addresses users and email invites only.
Existing group rows remain editable and removable if group creation is disabled.

### Rolling out group membership

1. Upgrade all replicas and stop all old replicas before adding group rows.
2. Before rollback, remove all group rows with a compatible server.

Older versions reject project records with group rows and return `503`.
The bucket schema version remains 1. Project reads and listings use the authoritative project record, even if catalog projections are stale.

Email invites have the same rollout requirement. Before creating invites, upgrade all replicas.
Before rollback to an unsupported release, remove pending invites.

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

`MARIMOHUB_DEFAULT_ROLE` sets access for signed-in non-members (`editor` by default).
Managers and admins can override it in **Project Access → Default access for signed-in users**.

| Setting                                 | API value                                 | Access for non-members                                       |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Inherit deployment and sign-in defaults | `inherit`                                 | Higher of the deployment and OIDC group defaults.            |
| Members only                            | `none`                                    | No default access, including OIDC default-role entitlements. |
| App user, Viewer, Editor, or Manager    | `app-user`, `viewer`, `editor`, `manager` | Selected role for this project.                              |

Existing projects inherit. Explicit memberships override defaults. Owners and super
admins retain admin access. These rules apply to project listings, direct requests,
and apps. They never grant anonymous access.

`PATCH /api/v1/projects/{pid}` accepts `default_role` with the values above.
Omitting the field preserves its current value. Project details include the override when present.

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
