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

The login email comes from UserInfo when it supplies `email`, otherwise from
the ID token. UserInfo must match the validated ID token's `sub`.

By default, the email source must supply `email_verified`. Every present claim
in either source must be boolean `true` or the exact string `"true"` (Cognito
compatibility). `MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION=trusted-issuer` permits
missing claims only, including with a domain allowlist.

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
MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS=hub-project-creators
MARIMOHUB_AUTH_OIDC_DEFAULT_APP_USER_GROUPS=hub-app-users
MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS=hub-viewers
MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS=hub-editors
MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS=hub-project-managers
```

Nested claims use JSON Pointer syntax, such as `/realm_access/roles`.
Array elements use zero-based indices, such as `/identities/0/groups`.
`ALLOWED_GROUPS` controls login. The other lists map groups to internal
entitlements. The session stores mapped entitlements and, when membership groups
are configured, only the selected group IDs. It never copies the full claim by default.

If `ALLOWED_GROUPS` is set, it must contain at least one group ID. An empty list
fails at startup. Unset it to disable the login group restriction.

`PROJECT_CREATION_GROUPS` controls who can create projects:

- If unset, [project creation policy](/auth#authorization-roles) applies, including the app-only exception.
- If the value is empty, only super admins can create projects.
- If the value contains group IDs, super admins and matching users can create projects.

If no super admin is configured, an empty value prevents every user from creating projects.
Setting the variable implies `MARIMOHUB_PROJECT_CREATION=restricted`, which also
works without group mapping; combining it with `MARIMOHUB_PROJECT_CREATION=open`
is rejected at startup.

An empty value does not require `GROUPS_CLAIM`. A non-empty value requires the claim and creates a group-derived session entitlement.

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
Group-derived roles and project-creation access apply to browser sessions and
enabled [external access tokens](#external-access-tokens). They do not transfer
to personal access tokens.

After you enable project-creation groups, matching users must sign in again. Existing sessions do not contain the new entitlement.

For a strict rollout, first deploy the new version without the variable. Then set the variable after all replicas run the new version.

The user ID is the OIDC `sub` within the configured issuer. The same `sub` from
another issuer can identify a different person. Therefore, an issuer URL change
is an identity migration. Reconcile stored owners and members before the change.

Generate a session secret with `openssl rand -base64 32`.

### Group membership

To retain selected group IDs in the current credential, configure exact IDs, prefixes, or both:

```bash
MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM=/groups
MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUPS=hub-team-data,hub-team-ml
MARIMOHUB_AUTH_OIDC_MEMBERSHIP_GROUP_PREFIXES=/marimohub/
```

Both lists use case-sensitive comparisons. Exact IDs match whole values.
Prefixes match the start of a value, without a path boundary rule.
A group matches if either list selects it. The configuration accepts at most
200 exact IDs and 20 prefixes. Empty lists are invalid.

IDs and prefixes contain 1–128 Unicode characters, without control characters,
commas, or whitespace at either end. Internal spaces, `@`, and leading `/` are
valid. The host removes selected claim values that fail this rule and records
only their count. Invalid provider claims still fail the existing admission checks.

The host removes duplicate IDs and sorts the retained set by code unit.
The set must contain at most 32 groups and 1,280 UTF-8 bytes of JSON.
If either limit is exceeded, login fails with `auth_failed`. The host never
truncates the set. Narrow the selection lists to correct an overflow.
A missing claim produces an empty set.

The session cookie is signed, not encrypted. `GET /api/v1/me` returns the selected
groups to the user. Do not select groups with sensitive names.
The host does not store groups in the identity directory or log their values.
`oidc_session_issued` records the entitlement count, group count, and discarded-value count.
`oidc_membership_groups_exceeded` records the retained count on overflow.

Selected groups share the credential expiry, with a maximum lifetime of one hour.
External access tokens use the same selection rules and their token expiry.
Personal access tokens, service accounts, background work, and non-OIDC backends
have no group source. `/me` returns `groups: []` for those credentials.
Groups have no access effect until the project bindings and access rules from
plans 068 and 069 exist. They never supply security labels or subject compartments.

For Microsoft Entra, select **Groups assigned to the application** to limit the
provider claim. [Microsoft documents the group limits and application assignment](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims).
Group overage omits the claim, which produces no retained groups.
The host does not resolve overage references through Microsoft Graph.

### Login-policy module

When a group mapping cannot express your access rule — for example, an approved
department AND a minimum level AND a set of required attribute values — load a
trusted login-policy module instead:

```bash
MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library
MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY=/etc/marimohub/oidc-login-policy.mjs
# MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS=5        # 1–30; a timeout denies login
# MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS=3600 # 300–3600
```

The built-in adapter still completes all OIDC protocol work: discovery, PKCE,
state and nonce, ID-token verification, UserInfo subject binding, email
verification, and the email-domain allowlist. The module runs after that
validation and before session signing. It receives the validated ID-token and
UserInfo claims as separate read-only objects and returns one bounded result: an
allow or deny decision, plus the built-in entitlements (`super-admin`,
`project-creator`, `default-role:app-user`, `default-role:viewer`,
`default-role:editor`, `default-role:manager`).
`project-creator` permits creation on restricted deployments and for app-only users.
`MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=none` (or unset) disables the module.

Login-policy configuration is mutually exclusive with the group variables
above. A module can reproduce any group rule in code. The module applies to
browser sessions only; personal access tokens never receive login-policy
entitlements or groups.

The module is trusted code and runs in-process with server privileges. Bundle
it (with its dependencies) into one `.mjs` file, pin its version, and mount the
same artifact on every replica. A module that fails to load stops the server at
startup. During login, a policy denial shows the user a generic access-policy
message; a policy error, timeout, or malformed result fails closed with the
generic sign-in error and a bounded operator log event. The host keeps raw claims
out of storage and logs. Only selected, bounded groups from an allow result enter
the signed cookie. The module sees every claim and runs with server privileges.
Review policy code to prevent logs or stored records that expose claim values.

An allow result can include `groups: ['team-data', 'team-ml']`. The host applies
the same ID, count, and byte limits as the membership configuration.
It removes duplicate IDs and sorts them. An omitted field produces `groups: []`.
The membership variables are mutually exclusive with a login-policy module.
The module selects its own groups without an additional host selection filter.

Invalid results fail login with one of these bounded problem codes:
`groups_not_an_array`, `invalid_group`, `too_many_groups`, or `groups_on_deny`.
The policy analyzer shows selected groups and supports expected-group assertions.
Its login stage evaluates modules only, not environment-based group mappings.

The optional field keeps login-policy API version `1`. It requires a host release
that includes Plan 067 (the bounded IdP group contract).
Older hosts reject allow results with `groups` as `unknown_result_field`.
Deploy the supporting host version on every replica before a module returns groups.

Policy sessions last at most one hour, like group sessions, which bounds the
delay after an attribute or policy change. A module change requires a server
restart and takes effect on the next login.

This feature maps identity to login eligibility and coarse roles. It is not
resource-level access control: it cannot see projects or notebooks, and an
entitlement never bypasses project-role checks. See
[Security](/security) for the boundary.

See
[`examples/external-adapter/oidc-login-policy.mjs`](https://github.com/marimo-team/marimohub/blob/main/examples/external-adapter/oidc-login-policy.mjs)
for a complete example.

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

### External access tokens

The Hub can accept JWT access tokens from the browser-login OIDC issuer.
This optional feature supports the API and the Node MCP server. Browser login
and existing Hub tokens continue to work.

After you configure OIDC browser login, add these variables:

```dotenv
MARIMOHUB_AUTH_OIDC_ACCESS_TOKENS=on
MARIMOHUB_AUTH_OIDC_ACCESS_TOKEN_AUDIENCE=https://hub.example.com/mcp
# Optional. Otherwise, the Hub discovers JWKS from the configured OIDC issuer.
# MARIMOHUB_AUTH_OIDC_ACCESS_TOKEN_JWKS_URL=https://accounts.example.com/jwks
```

If MCP is enabled, set the audience to the exact public MCP URL.
For example, a base URL of `https://hub.example.com/hub` requires
`https://hub.example.com/hub/mcp`. The API accepts this same audience.
For API-only deployments, choose a Hub resource audience that differs from the browser client ID.

The issuer and JWKS endpoint must use HTTPS without embedded credentials.
Startup fails for incomplete configuration, non-OIDC backends, or custom OIDC login-policy modules.
The audience and JWKS variables require `MARIMOHUB_AUTH_OIDC_ACCESS_TOKENS=on`.

#### Issuer requirements

Configure the issuer to issue JWT access tokens for the Hub resource with these claims:

| Claim            | Requirement                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `iss`            | Exact configured OIDC issuer                                              |
| `aud`            | Configured access-token audience. Must not include the browser client ID. |
| `sub`            | Same subject as browser login                                             |
| `email`          | User email that satisfies the domain allowlist                            |
| `email_verified` | `true` or `"true"`. Omission requires `trusted-issuer`.                   |
| `client_id`      | Nonempty ID of the OAuth client that requested the token                  |
| `iat`, `exp`     | Integer issuance and expiry times, in Unix seconds                        |
| `scope`          | Space-separated OAuth scopes, including a Hub grant scope                 |

The total token lifetime (`exp - iat`) cannot exceed 3,600 seconds.
If group authorization uses a shorter session lifetime, that limit applies instead.
The Hub rejects future `iat` or `nbf` values and expired tokens.

The token must use an asymmetric signature and a key from the trusted JWKS.
Supported algorithms are RS256/384/512, PS256/384/512, ES256/384/512, and EdDSA.
The Hub accepts an absent `typ`, `JWT`, `at+jwt`, or `application/at+jwt` header.
It rejects opaque tokens, browser ID tokens, and tokens with a `cnf` binding.
The Hub does not support DPoP or mutual-TLS token bindings on this path.

If group policies are configured, include those groups in the access token.
The Hub applies the same email and group admission policies as browser login.
It does not fetch UserInfo or reuse stored group claims for external authentication.
Missing group claims grant no group entitlements and cannot satisfy a group allowlist.

The Hub maps `sub` directly to the existing user ID. The issuer must supply
the same subject across browser login and external clients. The Hub does not
link accounts by email or translate pairwise subjects. This feature supports
user identities, not machine identities or client-credentials grants.

#### Scope grants

| OAuth scope      | Permitted actions                                |
| ---------------- | ------------------------------------------------ |
| `marimohub:read` | Read projects and integrations                   |
| `marimohub:run`  | Read, use integrations, and run sessions         |
| `marimohub:edit` | Run, edit notebooks, and publish change requests |
| `marimohub:full` | All actions available to a bearer credential     |

Clients must request at least one grant scope. Multiple grant scopes combine
their actions. The Hub ignores unrelated scopes and rejects tokens without a
recognized grant scope. MCP also requires `mcp:tools`.

These scopes belong in the access token. `MARIMOHUB_AUTH_OIDC_SCOPES` controls
browser login and does not request scopes for external clients.

Grants apply to all projects that the user can already access. They cannot
increase the user's project permissions. External tokens cannot manage Hub
tokens or access session-only administration, even for a super admin.
Per-token project selection is not supported.

To call the API, send the access token as a bearer credential:

```bash
curl https://hub.example.com/api/v1/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

#### Expiry and revocation

The Hub checks token signatures locally with cached signing keys. It retrieves
keys only from the configured or discovered JWKS endpoint. Failed token or key
checks deny authentication, even with a valid browser cookie in the same request.

The Hub does not store, revoke, or refresh external tokens. It does not query
the issuer for revocation status. Issuer-side revocation generally takes effect
at token expiry. Hub user suspension blocks API and MCP access, with a cache
delay of up to 30 seconds across server instances.

For client discovery and gateway behavior, see [MCP external authorization](/mcp#external-authorization).
