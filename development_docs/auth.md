# Authentication

marimohub resolves **who** a request comes from behind one port —
`Authenticator` (`packages/core/src/ports/auth.ts`) — with the concrete adapter
chosen at the composition root ([`packages/config`](../packages/config) for
Node, [`examples/cloudflare-worker`](../examples/cloudflare-worker) for Workers).
See [`architecture.md`](./architecture.md) for the ports-and-adapters picture.

Every `/api/v1/*` request passes through, in order:

1. **CSRF guard** — rejects state-changing requests a browser flags as
   cross-origin; non-browser callers pass. See [CSRF](#csrf--allowed-origins).
2. **AuthN guard** — `authenticate(request)` returns an `AuthenticatedPrincipal`
   (user identity plus credential provenance) or `null` → `401`.
3. **Auto-init** — creates the catalog + default project on first request.

`GET /api/v1/me` returns the current user and an optional provider `logoutUrl`.

## Backends

`MARIMOHUB_AUTH_BACKEND` selects the adapter and **must be set explicitly**
(unset throws on boot).

| Backend             | Identity source                                            | Wired in            |
| ------------------- | ---------------------------------------------------------- | ------------------- |
| `oidc`              | App-native OpenID Connect (Auth Code + PKCE)               | `packages/config`   |
| `proxy-header`      | Trusted proxy identity headers or a verified IAP assertion | `packages/config`   |
| `cloudflare-access` | `CF-Access-JWT-Assertion` header from Cloudflare Access    | `cloudflare-worker` |
| `dev`               | A fixed local user — **no real identity**                  | both                |

`oidc` is the recommended choice for self-hosting: it runs the OAuth2 redirect
dance itself (no reverse proxy) and issues a signed, httpOnly session cookie, so
the API tier stays stateless — no session store, preserving the "no database"
property.

Every adapter returns an `AuthenticatedPrincipal` — the user plus a required
`credential` naming the provenance: `sso`, `personal-access-token`,
`external-access-token`, `service-account`, or `development`. Bounded credentials
include their expiry. PAT credentials include a token ID and can carry an immutable
`TokenGrant`. An absent PAT grant means legacy unrestricted behavior.
External access tokens always carry an explicit `TokenGrant`, expiry, and OAuth
client ID, resource, and scopes. Each grant limits actions and projects.

Consumers read `credential.kind` from the authenticator result, never from request
headers. Session-only guards reject personal tokens, external tokens, and service accounts,
including token-management and administration routes.

`composeAuthenticators` uses `parseBearerAuthorization` to distinguish absent,
malformed, and valid bearer credentials. Combined Authorization headers containing
a bearer scheme fail before verification. PAT and service-account prefixes select
their own verifier, even when that verifier is disabled. Other bearer values use
the configured external authenticator or fail. No bearer request falls back to SSO.

The optional third argument names the bearer authenticators:

```ts
composeAuthenticators(tokens, sso, { external, serviceAccounts });
```

## Service accounts

`MARIMOHUB_SERVICE_ACCOUNTS` declares accounts and hashed credentials in the Node
composition root. `ServiceAccountCredentials` verifies the complete token hash and
expiry without bucket I/O. It supports overlapping credentials for rotation.
`IdentityService` remains the only writer for the directory and suspension records.
The reserved `service-account:` namespace separates machines from human identities.

`SERVICE_ACCOUNT_ACTIONS` defines the supported machine authority and the configuration
schema uses that same vocabulary. Currently only `org-integration.manage` is supported.
`AuthorizationService` uses this explicit authority for machines. Human roles, ownership,
entitlements, and default roles cannot expand it. Missing or wildcard grants fail closed.
Org-integration routes use their specific action, so a narrow human PAT can also manage
integrations when its owner has super-admin standing.

See [Service accounts](../docs/service-accounts.md) for configuration, expiry, and rotation.

## Personal access token grants

For personal and external access tokens, `AuthorizationService` evaluates each
request against three boundaries:

```text
allowed = current user authority ∧ resource security ∧ credential grant
```

The grant shape is strict:

```ts
{
	actions: '*' | AuthorizationAction[];
	projects: '*' | ProjectId[];
}
```

`'*'` actions include future PAT-accessible actions. An explicit array denies
new actions by default. `'*'` projects include future projects that the user
can access. A selected list contains 1 to 100 unique project IDs. For PATs, the
Hub expands presets at token creation. Later preset changes do not alter existing
PAT grants.

A selected-project grant denies deployment-level actions. It also filters
project lists before pagination. Super-admin standing and deployment default
roles do not bypass this boundary. Direct access outside the list returns 404.
An omitted action returns 403 only after lifecycle, visibility, and labels pass.

The analyzer uses `credential-resource` for a masked project denial and
`credential-action` for an action denial. Its `credential` trace stage supports
both live and synthetic grants.

Scoped PATs use credential version 2. Old replicas reject v2 token records
and CLI states. During a rolling upgrade, an old replica can reject a valid
scoped token but cannot accept it without its grant.

PAT expiry and revocation block later authentication. They do not stop a
session that is already running. A token that can start a sandbox can run
arbitrary notebook code. API action scopes do not confine that code or remove
credentials that the Hub injects into the kernel.

## OIDC (`MARIMOHUB_AUTH_BACKEND=oidc`)

The adapter discovers the provider at `<issuer>/.well-known/openid-configuration`.
It runs Authorization Code + PKCE and verifies the ID token signature, `iss`,
`aud`, `nonce`, and expiry. UserInfo must have the same `sub` as the ID token.
The adapter then mints the `mh_session` cookie. Protocol code uses
[`oauth4webapi`](https://github.com/panva/oauth4webapi). Cookie signing uses
[`jose`](https://github.com/panva/jose).

| Variable                                      | Req | Description                                                               |
| --------------------------------------------- | --- | ------------------------------------------------------------------------- |
| `MARIMOHUB_AUTH_OIDC_ISSUER`                  | ✓   | For example, `https://accounts.google.com`.                               |
| `MARIMOHUB_AUTH_OIDC_CLIENT_ID`               | ✓   | OAuth client ID.                                                          |
| `MARIMOHUB_AUTH_OIDC_CLIENT_SECRET`           | ✓   | OAuth client secret (sent via `client_secret_post`).                      |
| `MARIMOHUB_AUTH_OIDC_REDIRECT_URI`            | ✓   | **Must be** `<your-origin>/api/auth/callback`.                            |
| `MARIMOHUB_AUTH_SESSION_SECRET`               | ✓   | HS256 cookie-signing key with ≥32 random bytes.                           |
| `MARIMOHUB_AUTH_OIDC_AUDIENCE`                |     | Deprecated and ignored; `aud` must contain the client ID.                 |
| `MARIMOHUB_AUTH_OIDC_SCOPES`                  |     | Defaults to `openid email profile`. Keep `openid` and `email`.            |
| `MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION`      |     | `required` (default) or explicit `trusted-issuer`.                        |
| `MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM`            |     | JSON Pointer for opt-in group policy and entitlement mapping.             |
| `MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS` |     | Exact groups permitted to create projects. Empty means super admins only. |
| `MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND`    |     | `library` loads a trusted external login-policy module.                   |

**Routes** are public and mount before the authentication guard.
`GET /api/auth/login` starts the flow. `/api/auth/callback` exchanges the code
and sets `mh_session`. `/api/auth/logout` clears the cookie and redirects to the
provider logout endpoint.

**Redirect URI** is always `<origin>/api/auth/callback` and must match what you
register byte-for-byte. The issuer, redirect URI, and discovered authorization
and logout endpoints must use HTTPS and cannot contain credentials.

`trusted-issuer` permits an omitted `email_verified` claim, including when a
domain allowlist is active. If the claim is present, its value must be boolean
`true`.

**Cookies**: `mh_session` is an issuer-, audience-, and type-bound HS256 JWT.
It is HttpOnly, Secure, and SameSite=Lax. Its default lifetime is 8 hours, or
at most 1 hour with a group policy or login-policy module. The short-lived `mh_oidc_txn` stores the PKCE
verifier, state, and nonce. Rotating `MARIMOHUB_AUTH_SESSION_SECRET` invalidates
all sessions.

The session JWT cannot exceed 3,800 bytes. If necessary, the signer omits
`picture_url` first and `name` second. It never omits required identity or
authorization claims. Login fails if those claims exceed the limit.

Each deployment supports one issuer. Stored user IDs use that issuer's `sub`.
An issuer change is an identity migration. Reconcile stored owners and members
before the change.

The session stores mapped entitlements, not raw groups. Group-derived roles and
project-creation access do not transfer to personal access tokens.
Group-authorized kernels use the session JWT expiry as a fixed authorization deadline. Active editors cannot extend it.
Session reuse keeps the earliest credential deadline presented by any caller.
At expiry, the lifecycle destroys the kernel and the proxy closes WebSockets.
This teardown skips the final capture so that the kernel stops promptly.
Periodic snapshots limit potential data loss.

> The session cookie is `Secure` (HTTPS only). For local `http://localhost`
> work, use the [`dev`](#dev-marimohub_auth_backenddev) backend, not `oidc`.

### External access tokens

`MARIMOHUB_AUTH_OIDC_ACCESS_TOKENS=on` enables a separate JWT access-token
authenticator in `auth-oidc`, wired through `config`. It trusts the browser-login
issuer and uses `sub` as the same Hub user ID. It reads identity and group claims
from the verified access token, without UserInfo requests or stored entitlement
reuse. Shared helpers enforce browser and token email admission and group policy.
Custom login-policy modules cannot be combined with external access tokens.

The adapter maps `marimohub:read`, `marimohub:run`, `marimohub:edit`, and
`marimohub:full` scopes to the corresponding grant presets. It expands and unions
recognized scopes on each authentication. `full` sets `actions: '*'`.
Unrelated scopes are ignored, but at least one recognized grant scope is required.
External grants always use `projects: '*'`: all projects the user can already
access. Grants cannot elevate user permissions or bypass resource security,
suspension, or session-only guards.

API and MCP use the same configured audience. MCP also requires the canonical
public `/mcp` resource and `mcp:tools` scope. Hub OAuth issuance, verification, and
revocation remain limited to Hub-owned credentials. The Hub does not persist
external tokens or mint replacement credentials. Issuer-side revocation generally
takes effect at token expiry.

See [External access tokens](../docs/auth.md#external-access-tokens) for
configuration, required claims, and lifetime limits.

### Login-policy module (`MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library`)

For compound identity rules that exact group matching cannot express, the OIDC
backend can load one trusted login-policy module
(`MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY`; see
[Ports → External adapter libraries](./ports.md#external-adapter-libraries)).
The versioned contract lives in `@marimo-hub/auth-oidc` (`loginPolicy.ts`), and
deliberately **not** in `core`: OIDC claims stay an adapter concern. The
composition root (`packages/config`) loads the module once during
`createFromEnvAsync()` and rejects any combination with the group variables, so
exactly one identity-mapping mechanism is ever in force.

The adapter calls the module after every protocol/email validation above and
before session signing, with the host-owned identity (`sub` + verified email),
deep-frozen clones of the ID-token and UserInfo claims as **separate** objects,
and an abort signal. The host accepts only a bounded result — `allow` with
recognized entitlements, or `deny` with an optional `^[a-z][a-z0-9_]{0,63}$`
reason — and fails closed on everything else. A denial redirects with
`policy_denied`; a timeout (timer race, since a module can ignore the signal),
exception, or malformed result redirects with the generic `auth_failed`. A
synchronous block cannot be preempted in-process, so a decision returned after
the deadline is also discarded as a timeout. The
stable operator events are `oidc_login_policy_denied`,
`oidc_login_policy_timeout`, `oidc_login_policy_failed`, and
`oidc_login_policy_result_invalid`; they carry a duration and a bounded
reason/problem code, never claim values or module exception messages.

An allowed login always signs an `entitlements` claim (possibly empty), so the
session carries the short authorization lifetime; policy sessions are capped at
one hour like group sessions. Entitlements apply to browser sessions only —
never to personal access tokens.

**Boundary — this is not resource fine-grained access control (FGAC).** The
login policy controls login and deployment roles. It does not authorize
projects or notebooks. A version-1 result that contains runtime subject state,
such as `subjectSecurityContext`, is rejected. Resource security uses these
separate components:

- `SubjectSecurityContextProvider` resolves clearance and compartments for each
  principal at request time. It never reads them from raw login claims or stores
  them in the session cookie. Set
  `MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND=library` to load a trusted provider.
  Each decision batch resolves one strict, time-bounded context.
- `AuthorizationService` requires both `roleAllowed` and
  `constraintsSatisfied`. Project labels and notebook overrides can only reduce
  access. `LocalResourceConstraintPolicy` applies
  `MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER` and the required compartments.
- A labeled resource fails closed for a missing or expired context, missing
  policy, unknown classification, policy error, or timeout. The API returns 404
  for these denials. Super admins do not bypass labels.
- Sessions use the earlier entitlement or subject-context expiry for
  `authorization_expires_at`. The lifecycle sweep and proxy enforce this
  deadline.
- Catalog entries store a three-state label projection: labeled, `null` for
  known unlabeled, or absent for indeterminate. Lists resolve indeterminate
  entries from `project.json` before pagination. Label mutations mark the
  projection indeterminate before they update the authoritative record. A later
  projection update repairs the state.
- Label changes require super-admin standing through `security-labels.raise` or
  `security-labels.lower`. Project owners and managers do not get this authority.
  Each change records the old and new labels in the audit log.

Known limits:

- Git-sync tokens have no user principal. Do not enable git sync for labeled
  notebooks.
- Deployment-wide sandbox storage credentials can cross label boundaries below
  the API. Use scoped credentials (WIF) or non-persistent workspaces.

### Policy analyzer

Super admins use **Admin → Policy** to examine policy decisions.
The endpoints require a super-admin session and reject personal and external access tokens.
The analyzer calls the production policy functions and returns a deterministic trace without generated reasoning.

A version-1 suite contains 1 to 25 cases.
Each case evaluates the configured OIDC login policy, the authorization engine, or both.
Authorization covers entitlements, roles, action rules, session rules, and resource constraints.
The analyzer compares each decision with the expected decision.
A login denial skips authorization that depends on login entitlements.
A case is valid when every stage finishes and every assertion matches.
An expected denial is valid.
Timeouts, module errors, malformed results, invalid contexts, and inaccessible stored resources invalidate a case.

The analyzer grants no additional resource access.
It loads only readable stored resources, and resource security labels still apply.
Use hypothetical resources for inaccessible or counterfactual cases.
Live subject context is available only for the signed-in admin.

Suites remain in the browser unless the admin downloads them.
The server does not store suites, and the page imports or exports the exact version-1 JSON format.

CAUTION: Treat exported suites as sensitive data. They can contain sample claims and subject context.

Each evaluation request records one `policy.analysis.run` event.
The event contains bounded request and assertion metadata.
It excludes claims, entitlements, labels, subject context, policy reasons, and module errors.

Classification names come from `MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER`.
Examples use the notional names `LEVEL_1`, `LEVEL_2`, and `LEVEL_3`.

### Example: Google

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
create an **OAuth client ID** (type: Web application), and add your callback to
**Authorized redirect URIs** (e.g. `https://hub.example.com/api/auth/callback`).
Then:

```bash
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.google.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=GOCSPX-your-secret
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET=$(openssl rand -base64 32)
```

Visit `/api/auth/login` to start. Any OIDC provider works — only the issuer and
credentials change:

| Provider           | `MARIMOHUB_AUTH_OIDC_ISSUER`                         |
| ------------------ | ---------------------------------------------------- |
| Google             | `https://accounts.google.com`                        |
| Auth0              | `https://<tenant>.us.auth0.com`                      |
| Okta               | `https://<org>.okta.com`                             |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Keycloak           | `https://<host>/realms/<realm>`                      |

## Cloudflare Access (`cloudflare-access`)

A hosted OIDC gateway in front of the app: the adapter verifies the
`CF-Access-JWT-Assertion` header against the team JWKS and trusts its
`sub`/`email` (no app-side login — Access owns the UI). Wired in
`examples/cloudflare-worker` with `AUTH_MODE=access`, `ACCESS_TEAM` (e.g.
`myteam` → `myteam.cloudflareaccess.com`), and `ACCESS_AUD` (the application's
Audience tag). `logoutUrl()` → `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`.

## Trusted proxy headers (`MARIMOHUB_AUTH_BACKEND=proxy-header`)

This backend has no login routes. The proxy owns the login flow.

Header mode defaults to `X-Forwarded-Email,X-Forwarded-User`. One configured header supplies both identity values.

CAUTION: Block direct access to marimohub in header mode. The proxy must remove
client-supplied identity headers.

Any nonempty `MARIMOHUB_AUTH_PROXY_JWT_*` variable enables JWT mode. This mode requires the audience.
The IAP defaults require ES256 and verify the issuer, audience, lifetime, subject, and email.

Both modes require `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS`. Set `*` to allow all domains.

## Dev (`MARIMOHUB_AUTH_BACKEND=dev`)

Authenticates **every** request as one fixed user — a local shortcut, **never
for real users** (logs a warning on startup). Used by `pnpm dev`. Optional:
`MARIMOHUB_AUTH_DEV_USER_ID` (default `user`), `MARIMOHUB_AUTH_DEV_EMAIL`
(default `user@localhost`).

## CSRF & allowed origins

On top of the `SameSite=Lax` cookie and no permissive CORS, `createApi` rejects
state-changing requests when the browser's `Sec-Fetch-Site` is
`cross-site`/`same-site` or the full `Origin` differs from the request origin.
The comparison includes the scheme, host, and port. Requests with neither
header (CLI, server-to-server, generated client) pass. If the SPA and API live
on **different origins**, allowlist the SPA origin (comma-separated); a
single-origin deployment needs nothing:

```bash
MARIMOHUB_ALLOWED_ORIGINS=https://app.example.com
```
