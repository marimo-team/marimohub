# Auth

Auth decides who can sign in. You **must choose a backend** — there is no
default. (If it's left unset, MarimoHub refuses to start rather than fall back to
the insecure local login.)

Selector: `MARIMOHUB_AUTH_BACKEND`. Full variables: [Configuration → Auth](./configuration.md#auth).

## Backends

| Backend           | Selector            | Use for                                |
| ----------------- | ------------------- | -------------------------------------- |
| OIDC              | `oidc`              | Production (Google, Okta, Auth0, …)    |
| Cloudflare Access | `cloudflare-access` | Workers deployments behind CF Access   |
| Dev bypass        | `dev`               | Local development only — never in prod |

## OIDC (production)

<!--@include: ./setup/auth/oidc.md-->

## Cloudflare Access

Used by the Workers entrypoint. Reads unprefixed runtime vars (`AUTH_MODE`,
`ACCESS_TEAM`, `ACCESS_AUD`) — see [Cloudflare deploy](./deploying/cloudflare.md).

## Dev bypass

<!--@include: ./setup/auth/dev.md-->

## Authorization (roles)

Authentication decides _who_ you are; authorization decides _what_ you may do on
a given project. Each project has an `owner` (implicitly `admin`) and a list of
members, each holding one **role**. Roles are ordered `viewer` < `editor` <
`admin`, and each subsumes the ones below it.

| Role     | Description                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `viewer` | **Read-only.** List and open the project and its notebooks; read notebook code and version history. Cannot change anything.      |
| `editor` | Everything a viewer can, **plus edit**: create/update/delete notebooks, save & restore versions, and start/stop kernel sessions. |
| `admin`  | Everything an editor can, **plus manage the project**: update/delete the project and add/remove members & change their roles.    |

The capability matrix, by role:

| Capability                                                          | `viewer` | `editor` | `admin` |
| ------------------------------------------------------------------- | :------: | :------: | :-----: |
| See & read projects/notebooks; read versions & notebook code        |    ✓     |    ✓     |    ✓    |
| Create/update/delete notebooks; save/restore versions; run sessions |          |    ✓     |    ✓    |
| Update/delete projects; manage members                              |          |          |    ✓    |

Enforcement is server-side (per-route, never in the client). An insufficient
role on a **write** returns `403 FORBIDDEN`. Creating a _new_ project is always
open to any authenticated user — the creator becomes its `owner` (`admin`).

### Default access for non-members (`MARIMOHUB_DEFAULT_ROLE`)

A logged-in user who is neither the owner nor an explicit member of a project
falls back to the deployment-wide `MARIMOHUB_DEFAULT_ROLE`:

- **`editor`** (the default) — every logged-in user can edit notebooks and run
  sessions in any project, but still cannot edit/delete projects (that stays
  `admin`-only).
- **`viewer`** — every logged-in user can view any project, read-only.
- **`none`** — non-members get **no access at all**: they cannot even see a
  project they don't own or belong to (`GET` returns `404`, and it is omitted
  from the project list). They can still create their own projects and are made
  `owner`/`admin` of those.

`admin` is also accepted (every logged-in user is a project admin) but is
unusual — use it only for a fully trusted single-tenant deployment.
