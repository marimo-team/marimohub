# Authentication

marimohub resolves **who** a request comes from behind one port —
`Authenticator` (`packages/core/src/ports/auth.ts`) — with the concrete adapter
chosen at the composition root ([`packages/config`](../packages/config) for
Node, [`examples/cloudflare-worker`](../examples/cloudflare-worker) for Workers).
See [`architecture.md`](./architecture.md) for the ports-and-adapters picture.

Every `/api/v1/*` request passes through, in order:

1. **CSRF guard** — rejects state-changing requests a browser flags as
   cross-origin; non-browser callers pass. See [CSRF](#csrf--allowed-origins).
2. **AuthN guard** — `authenticate(request)` returns an `AuthUser` (`{ id,
email }`) or `null` → `401`.
3. **Auto-init** — creates the catalog + default project on first request.

`GET /api/v1/me` returns the current user and an optional provider `logoutUrl`.

## Backends

`MARIMOHUB_AUTH_BACKEND` selects the adapter and **must be set explicitly**
(unset throws on boot).

| Backend             | Identity source                                         | Wired in            |
| ------------------- | ------------------------------------------------------- | ------------------- |
| `oidc`              | App-native OpenID Connect (Auth Code + PKCE)            | `packages/config`   |
| `cloudflare-access` | `CF-Access-JWT-Assertion` header from Cloudflare Access | `cloudflare-worker` |
| `dev`               | A fixed local user — **no real identity**               | both                |

`oidc` is the recommended choice for self-hosting: it runs the OAuth2 redirect
dance itself (no reverse proxy) and issues a signed, httpOnly session cookie, so
the API tier stays stateless — no session store, preserving the "no database"
property.

## OIDC (`MARIMOHUB_AUTH_BACKEND=oidc`)

The adapter discovers the provider at `<issuer>/.well-known/openid-configuration`.
It runs Authorization Code + PKCE and verifies the ID token signature, `iss`,
`aud`, `nonce`, and expiry. UserInfo must have the same `sub` as the ID token.
The adapter then mints the `mh_session` cookie. Protocol code uses
[`oauth4webapi`](https://github.com/panva/oauth4webapi). Cookie signing uses
[`jose`](https://github.com/panva/jose).

| Variable                                 | Req | Description                                                    |
| ---------------------------------------- | --- | -------------------------------------------------------------- |
| `MARIMOHUB_AUTH_OIDC_ISSUER`             | ✓   | For example, `https://accounts.google.com`.                    |
| `MARIMOHUB_AUTH_OIDC_CLIENT_ID`          | ✓   | OAuth client ID.                                               |
| `MARIMOHUB_AUTH_OIDC_CLIENT_SECRET`      | ✓   | OAuth client secret (sent via `client_secret_post`).           |
| `MARIMOHUB_AUTH_OIDC_REDIRECT_URI`       | ✓   | **Must be** `<your-origin>/api/auth/callback`.                 |
| `MARIMOHUB_AUTH_SESSION_SECRET`          | ✓   | HS256 cookie-signing key with ≥32 random bytes.                |
| `MARIMOHUB_AUTH_OIDC_AUDIENCE`           |     | Deprecated and ignored; `aud` must contain the client ID.      |
| `MARIMOHUB_AUTH_OIDC_SCOPES`             |     | Defaults to `openid email profile`. Keep `openid` and `email`. |
| `MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION` |     | `required` (default) or explicit `trusted-issuer`.             |
| `MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM`       |     | JSON Pointer for opt-in group policy and entitlement mapping.  |

**Routes** are public and mount before the authentication guard.
`GET /api/auth/login` starts the flow. `/api/auth/callback` exchanges the code
and sets `mh_session`. `/api/auth/logout` clears the cookie and redirects to the
provider logout endpoint.

**Redirect URI** is always `<origin>/api/auth/callback` and must match what you
register byte-for-byte. The issuer, redirect URI, and discovered authorization
and logout endpoints must use HTTPS and cannot contain credentials.

`trusted-issuer` permits an omitted `email_verified` claim, including when a
domain allowlist is active. Any present value other than boolean `true` is
rejected.

**Cookies**: `mh_session` is an issuer-, audience-, and type-bound HS256 JWT.
It is HttpOnly, Secure, and SameSite=Lax. Its default lifetime is 8 hours, or
at most 1 hour with group policy. The short-lived `mh_oidc_txn` stores the PKCE
verifier, state, and nonce. Rotating `MARIMOHUB_AUTH_SESSION_SECRET` invalidates
all sessions.

The session JWT cannot exceed 3,800 bytes. If necessary, the signer omits
`picture_url` first and `name` second. It never omits required identity or
authorization claims. Login fails if those claims exceed the limit.

Each deployment supports one issuer. Stored user IDs use that issuer's `sub`.
An issuer change is an identity migration. Reconcile stored owners and members
before the change.

The session stores mapped entitlements, not raw groups. Group-derived roles do
not transfer to personal access tokens. Group-authorized kernels use the session
JWT expiry as a fixed authorization deadline. Active editors cannot extend it.
Session reuse keeps the earliest credential deadline presented by any caller.
At expiry, the lifecycle destroys the kernel and the proxy closes WebSockets.
This teardown skips the final capture so that the kernel stops promptly.
Periodic snapshots limit potential data loss.

> The session cookie is `Secure` (HTTPS only). For local `http://localhost`
> work, use the [`dev`](#dev-marimohub_auth_backenddev) backend, not `oidc`.

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
