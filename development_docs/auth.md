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

The adapter discovers the provider at `<issuer>/.well-known/openid-configuration`,
runs Authorization Code + PKCE, verifies the ID token (JWKS signature + `iss` /
`aud` / `nonce` / expiry), and mints the `mh_session` cookie. Protocol mechanics
use [`oauth4webapi`](https://github.com/panva/oauth4webapi); cookie signing uses
[`jose`](https://github.com/panva/jose).

| Variable                            | Req | Description                                                  |
| ----------------------------------- | --- | ------------------------------------------------------------ |
| `MARIMOHUB_AUTH_OIDC_ISSUER`        | ✓   | e.g. `https://accounts.google.com`.                          |
| `MARIMOHUB_AUTH_OIDC_CLIENT_ID`     | ✓   | OAuth client ID.                                             |
| `MARIMOHUB_AUTH_OIDC_CLIENT_SECRET` | ✓   | OAuth client secret (sent via `client_secret_post`).         |
| `MARIMOHUB_AUTH_OIDC_REDIRECT_URI`  | ✓   | **Must be** `<your-origin>/api/auth/callback`.               |
| `MARIMOHUB_AUTH_SESSION_SECRET`     | ✓   | HS256 cookie-signing key; use ≥32 random bytes.              |
| `MARIMOHUB_AUTH_OIDC_AUDIENCE`      |     | Unused — `aud` must contain the client ID (enforced anyway). |

**Routes** (public, mounted before the authN guard): `GET /api/auth/login`
starts the flow; `/api/auth/callback` exchanges the code and sets `mh_session`;
`/api/auth/logout` clears it and redirects to the provider end-session endpoint.

**Redirect URI** is always `<origin>/api/auth/callback` and must match what you
register byte-for-byte. Providers require HTTPS (except `localhost`), as does
`oauth4webapi`.

**Cookies**: `mh_session` (HS256 JWT — `sub`=id, `email` claim; httpOnly,
Secure, SameSite=Lax; 8h default) and the short-lived `mh_oidc_txn` (PKCE
verifier + state + nonce during the round-trip). Rotating
`MARIMOHUB_AUTH_SESSION_SECRET` invalidates all sessions.

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
`cross-site`/`same-site` or the `Origin` host ≠ `Host`. Requests with neither
header (CLI, server-to-server, generated client) pass. If the SPA and API live
on **different origins**, allowlist the SPA origin (comma-separated); a
single-origin deployment needs nothing:

```bash
MARIMOHUB_ALLOWED_ORIGINS=https://app.example.com
```
