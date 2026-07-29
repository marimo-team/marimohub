<!-- Setup snippet — included by docs/auth.md and rendered in the deployment wizard. -->

App-native OpenID Connect — the production backend. marimohub discovers the
provider's endpoints automatically from the issuer's
`/.well-known/openid-configuration`, so you only supply an issuer, client
credentials, and a redirect URI.

```bash
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.example.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=…
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET=…            # signs the session cookie (HS256, ≥32 bytes)
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com  # REQUIRED allowlist (verified email); `*` allows all
# MARIMOHUB_AUTH_OIDC_AUDIENCE=…           # optional: expected ID-token audience (the client id is enforced anyway)
# MARIMOHUB_AUTH_OIDC_PROMPT=consent       # optional: override the default (select_account) OAuth prompt
```

The **redirect URI** is always `https://<your-host>/api/auth/callback`. Register
it with your provider exactly as you set it here, or login fails with a
`redirect_uri_mismatch` error. `ALLOWED_EMAIL_DOMAINS` is **required** —
marimohub fails closed rather than admitting every account the IdP
authenticates; list your domains or set `*` to allow all.

Generate a session secret with `openssl rand -base64 32`.

### Google

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   open **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorized redirect URIs**, add `https://hub.example.com/api/auth/callback`
   (and `http://localhost:3000/api/auth/callback` for local testing).
4. Copy the **Client ID** and **Client secret**.

```bash
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.google.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=…apps.googleusercontent.com
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com   # a single domain is also sent to Google as the `hd` hint
```

marimohub defaults the OAuth `prompt` to `select_account`, so a returning user
always gets the Google account chooser instead of being silently logged in with
their last account. Override it via `MARIMOHUB_AUTH_OIDC_PROMPT` (e.g. `consent`
to also re-show the consent screen).

See [Google's OpenID Connect docs](https://developers.google.com/identity/openid-connect/openid-connect).

### Microsoft Entra ID

1. In the [Entra admin center](https://entra.microsoft.com) (or Azure Portal),
   go to **App registrations → New registration**.
2. Set a **Web** redirect URI of `https://hub.example.com/api/auth/callback`.
3. From **Overview**, copy the **Application (client) ID** and **Directory
   (tenant) ID**; under **Certificates & secrets**, create a **client secret**.

```bash
# tenant-scoped issuer (use `organizations` or `common` for multi-tenant)
MARIMOHUB_AUTH_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
MARIMOHUB_AUTH_OIDC_CLIENT_ID=<application-client-id>
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
```

See [Microsoft's OIDC docs](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc).

### Okta

1. In the Okta Admin Console, open **Applications → Create App Integration**.
2. Choose **OIDC - OpenID Connect** and **Web Application**.
3. Add `https://hub.example.com/api/auth/callback` as a **Sign-in redirect URI**.
4. Copy the **Client ID** and **Client secret** from the app's **General** tab.

```bash
MARIMOHUB_AUTH_OIDC_ISSUER=https://<your-org>.okta.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=…
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
```

If you use an Okta authorization server, the issuer is
`https://<your-org>.okta.com/oauth2/<server-id>`. See
[Okta's OIDC docs](https://developer.okta.com/docs/concepts/oauth-openid/).

### Auth0

1. In the [Auth0 Dashboard](https://manage.auth0.com), open **Applications →
   Create Application** and pick **Regular Web Application**.
2. Under **Settings → Allowed Callback URLs**, add
   `https://hub.example.com/api/auth/callback`.
3. Copy the **Domain**, **Client ID**, and **Client Secret** from **Settings**.

```bash
# note the trailing slash on the issuer
MARIMOHUB_AUTH_OIDC_ISSUER=https://<tenant>.auth0.com/
MARIMOHUB_AUTH_OIDC_CLIENT_ID=…
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
```

See [Auth0's OIDC docs](https://auth0.com/docs/authenticate/protocols/openid-connect-protocol).
