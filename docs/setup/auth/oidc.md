<!-- Setup snippet — included by docs/auth.md and rendered in the deployment wizard. -->

App-native OpenID Connect is the production backend. marimohub discovers the
provider endpoints from `/.well-known/openid-configuration`. You supply the
issuer, client credentials, and redirect URI.

```bash
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.example.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=…
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET=…            # signs the session cookie (HS256, ≥32 bytes)
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com  # REQUIRED allowlist (verified email); `*` allows all
# MARIMOHUB_AUTH_OIDC_AUDIENCE=…           # deprecated and ignored; aud must contain the client ID
# MARIMOHUB_AUTH_OIDC_PROMPT=consent       # optional: override the default (select_account) OAuth prompt
# MARIMOHUB_AUTH_OIDC_SCOPES="openid email profile groups" # add only provider-required scopes
```

The **redirect URI** is always `https://<your-host>/api/auth/callback`. Register
this exact value with your provider. A different value causes a
`redirect_uri_mismatch` error. `ALLOWED_EMAIL_DOMAINS` is **required**. Set one
or more domains, or set `*` to allow all.

If the provider publishes UserInfo, marimohub uses it for profile claims.
UserInfo must have the same `sub` as the validated ID token. Email verification
is required by default. If a trusted issuer omits `email_verified`, use
`MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION=trusted-issuer`. Any present value other
than boolean `true` is invalid. This policy also applies when a domain allowlist
is active.

The signed session JWT has a 3,800-byte limit. If necessary, marimohub omits the
profile picture first and the display name second. Required identity and
authorization claims are never omitted. Login fails if they exceed the limit.

The issuer, callback, discovered authorization, and discovered logout endpoints
must use HTTPS and cannot contain embedded credentials.

### Groups and roles

Group authorization is optional and uses exact provider group IDs. Set a JSON
Pointer to the provider array. Then set at least one group policy:

```bash
MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM=/groups
MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS=hub-users
MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS=hub-platform-admins
MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS=hub-viewers
MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS=hub-editors
MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS=hub-project-managers
```

Nested claims use JSON Pointer syntax, such as `/realm_access/roles`.
`ALLOWED_GROUPS` controls login. The other lists map groups to internal
entitlements. The session cookie stores mapped entitlements, not raw groups.

Group sessions last at most one hour by default. This limit bounds the delay
after an IdP removes a user from a group. Kernels inherit the session JWT expiry
as a fixed authorization deadline. Active editors cannot extend it. Session
reuse keeps the earliest caller credential deadline. At expiry, the lifecycle
destroys the kernel and the proxy closes WebSockets. This teardown skips the
final capture so that the kernel stops promptly. Periodic snapshots limit
potential data loss.

Missing, malformed, or oversized group data cannot satisfy the login policy.
marimohub accepts at most 200 group IDs. It does not resolve group-overage
references from the provider. Configure the IdP to emit only the groups that
marimohub needs.
Group-derived roles apply only to the browser session. They do not transfer to
personal access tokens.

The user ID is the OIDC `sub` within the configured issuer. The same `sub` from
another issuer can identify a different person. Therefore, an issuer URL change
is an identity migration. Reconcile stored owners and members before the change.

Generate a session secret with `openssl rand -base64 32`.

### Google

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   open **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorized redirect URIs**, add `https://hub.example.com/api/auth/callback`.
4. Copy the **Client ID** and **Client secret**.

```bash
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.google.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=…apps.googleusercontent.com
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=…
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com   # a single domain is also sent to Google as the `hd` hint
```

The default OAuth `prompt` is `select_account`, which displays the Google
account chooser. Set `MARIMOHUB_AUTH_OIDC_PROMPT=consent` to display the consent
screen again.

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
