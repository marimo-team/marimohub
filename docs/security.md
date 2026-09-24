---
description: Understand kernel isolation, authentication, authorization, request safety, and storage integrity.
---

# Security model

marimohub runs **untrusted code** (notebook kernels) on behalf of authenticated
users. This page collects the guarantees it makes and the things you, the
operator, must get right.

## Kernel exposure

`MARIMOHUB_SANDBOX_EXPOSURE` chooses how kernels reach the browser, independent
of the compute backend. The modes trade origin isolation against authentication.

### `subdomain` (default): isolated kernel domain

Kernels run arbitrary Python in an `<iframe sandbox="allow-scripts allow-same-origin …">`.
Browsers connect **directly** to kernels. Sibling hostnames such as `hub.example.com` and `sandboxes.example.com` are supported.
The server rejects identical or parent/child app and sandbox hostnames.
It uses `MARIMOHUB_APP_BASE_URL`, with the OIDC redirect URI as a fallback when the app URL is unset or blank.
Surrounding whitespace is ignored. A nonblank invalid value blocks startup instead of using the fallback.
Both URLs must have the same origin when both are present.
A configured kernel host without a valid app origin prevents startup for every authentication backend.
The Cloudflare Worker example also compares against the request hostname.

Sibling subdomains share cookie scope. Separate registrable domains provide stronger isolation from cookies set by notebooks.

```bash
# app:      https://hub.example.com
# kernels:  https://sandboxes.example.com
MARIMOHUB_APP_BASE_URL=https://hub.example.com
MARIMOHUB_SANDBOX_EXPOSURE=subdomain   # default
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=sandboxes.example.com
```

The hub does not authenticate direct kernel traffic. Protect the kernel endpoint
at the ingress. [Native kernel authentication](#native-kernel-authentication)
is optional and off by default. Treat kernel URLs as sensitive.

The session API exposes `sandbox_url` only to authorized editors, ephemeral
session owners, app users, and shared-app viewers allowed by the [viewer mode](/apps#who-can-do-what).

### `proxy`: forwarded through the app

Kernel traffic is forwarded **through the app** at
`https://hub.example.com/proxy/<token>/…`, so each request goes through
marimohub's auth and a per-session role check; `<token>` is an HMAC of the
session id signed with `MARIMOHUB_AUTH_SESSION_SECRET`. No separate kernel domain
is needed.

The cost: the kernel is **same-origin** with the app, so a malicious notebook can
script the control plane (XSS). Proxy mode is for **trusted environments only**
and **refuses to start** without an explicit acknowledgement:

```bash
MARIMOHUB_SANDBOX_EXPOSURE=proxy
MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true   # required — acknowledges same-origin/XSS
# optional public URL for browser links
MARIMOHUB_APP_BASE_URL=https://hub.example.com
```

The separate-domain guard doesn't apply here, and
`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` is unused. Proxy mode runs on the Node
server; the Cloudflare Workers deployment uses `subdomain`.

Kubernetes proxy mode uses each kernel's internal Service URL. It does not query,
create, or delete Ingresses. Before you change from subdomain exposure, complete
the required [session drain](/deploying/kubernetes#changing-from-subdomain-to-proxy).
A session Ingress from an earlier release otherwise stays public and becomes
orphaned.

Note the interaction with [notebook apps](/apps): the same-origin risk you
acknowledge is that notebook-authored JS can script the control plane as
whoever opens the kernel. App-user assignments and either
`MARIMOHUB_VIEWER_MODE=applications` or `MARIMOHUB_VIEWER_MODE=ephemeral-sandbox`
extend this risk to people who use apps that other authors wrote.
If you combine proxy mode with app access, trust every notebook author in the deployment.

HTTP and WebSocket proxies remove hub credentials before they forward requests to kernels or secondary editor surfaces.
The filter includes cookies, Authorization, Cloudflare Access headers, the IAP assertion, and configured `MARIMOHUB_AUTH_PROXY_HEADER` names.
Library deployments must supply custom identity headers through `sandbox.credentialHeaders`.

## Native kernel authentication

`MARIMOHUB_SANDBOX_AUTH` controls native marimo authentication for new editor and
app sessions:

| Value           | Behavior                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `off` (default) | Starts marimo with `--no-token` for cross-site iframe compatibility. Protect direct kernel access at the ingress. |
| `on`            | Creates an independent 256-bit token per session and starts marimo with `--token --token-password-file`.          |

Hub login and proxy authorization do not change. Existing sessions retain their
authentication mode. Stop and start them to apply a changed setting. Scheduled
jobs do not use native authentication.

With `on`, the provisioner stores the token in a reserved file outside the
workspace. The launch command contains the file path, not the token. Quiet mode
suppresses token-bearing startup URLs, and log capture redacts `access_token`.

In `subdomain` mode, marimo exchanges the URL's token for a session cookie. In
`proxy` mode, the hub supplies the token after authorization for HTTP requests
and WebSocket upgrades. It does not forward the token to secondary editor surfaces.
Native authentication does not replace TLS, origin isolation, or hub authorization.

Browser restrictions can block the session cookie inside a cross-site iframe.
After 15 seconds, the UI offers Retry and Open in new window. Retry reloads only
the frame. A separate window makes the kernel a first-party page. The prompt is
dismissible and can also appear for healthy frames because browsers hide
cross-origin load failures.

This setting does not change cookie attributes or enable partitioned cookies.

## Secondary editor surfaces

VS Code and OpenCode run in the edit sandbox. Their terminals and agents can run
shell commands and read the notebook credentials. Only users who can attach to
the edit session can use these surfaces. App sessions and viewer-owned ephemeral
sessions cannot use them.

VS Code proxy exposure authorizes each HTTP request and WebSocket upgrade.
OpenCode supports only subdomain exposure because its client requires root
paths. Each subdomain URL is an access capability. Do not publish these URLs.

OpenCode stores `/connect` credentials and state in its temporary surface
directory. Managed AI stores an expiring session token there, not the upstream
API key. Project configuration and bring-your-own-key providers can override it.

## Authentication fails closed

- `MARIMOHUB_AUTH_BACKEND` has **no default** — an unset backend refuses to
  start rather than silently falling back to the `dev` bypass.
- OIDC requires `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS`. Set explicit domains or
  `*` to allow all. This prevents accidental access for every IdP account.
- OIDC requires boolean `email_verified=true` by default. `trusted-issuer`
  permits omission only. Other present values are invalid. UserInfo must have
  the same `sub` as the ID token.
- Group policy accepts at most 200 group IDs and stores only mapped entitlements.
  Group sessions and kernels expire with the entitlement credential. Active
  connections cannot extend this deadline.
- An external OIDC login-policy module is **trusted in-process code** with
  server privileges — load only pinned, reviewed modules, identical on every
  replica. The host fails closed on module load errors, timeouts, exceptions,
  and out-of-contract results, and accepts only an allow/deny decision plus the
  built-in entitlements (`project-creator` permits project creation under
  `MARIMOHUB_PROJECT_CREATION=restricted` and for app-only users). The host keeps raw provider claims out of cookies,
  storage, logs, and client errors — but the module sees every claim and could
  log or persist them itself, so require and review that policy code does
  neither. Policy sessions expire within one hour. The module
  maps identity to login eligibility and coarse roles only — it is not
  resource-level access control, and an entitlement never bypasses the
  project-role checks below.
- The OIDC issuer, callback, authorization endpoint, and logout endpoint must
  use HTTPS and cannot contain credentials. Stored user IDs are issuer-local
  `sub` values, so an issuer change requires an identity migration.
- The session cookie is signed with `MARIMOHUB_AUTH_SESSION_SECRET` (HS256, ≥32
  bytes). Generate it with `openssl rand -base64 32` and treat it as a secret.

Cloudflare Access requires a valid team name and a nonblank application audience.
Tokens must use RS256 and match both the audience and team issuer.

See [Auth](/auth) for provider setup.

## Authorization (roles)

Every resource decision — project guards, session gates, kernel proxies, and
list filtering — flows through one authorization service over a bounded action
vocabulary, so an allow or deny cannot differ between surfaces. Routes outside
the standard API guard carry their own scoped capability instead: the sandbox
proxies re-run the full session authorization per request (including the
WebSocket path, which force-closes at the authorization deadline), the managed
AI proxy and git sync accept only their own short-lived minted tokens, and the
CLI token exchange is bound by PKCE and rate budgets.

Deployments can add **security labels** to projects and notebooks. A label has a
classification and required compartments. Notebook labels add restrictions to
the project label.

Access requires both the project role and a matching subject context. A trusted
provider resolves this context at request time, never from raw login claims.
A request with a missing, expired, or invalid context fails closed. The API
returns 404. Super admins do not bypass labels.

Lists filter labels before pagination. Sessions and kernel proxies are bounded
by the earlier of the entitlement expiry and the subject-context expiry
(`authorization_expires_at`); the credential's own lifetime is not consulted.
Each subject-context resolution and constraint evaluation has a fixed 5-second
deadline; a timeout denies like any other failure and emits an operator event.
Label changes require super-admin standing and record the old and new labels in
the audit log.

Known limits:

- Git-sync tokens have no user principal. Do not enable git sync for labeled
  notebooks.
- Deployment-wide sandbox storage credentials can cross project boundaries.
  Use scoped credentials (WIF) or non-persistent workspaces.

Project creation is open by default, except for users with only app-user access.
App-only users need super-admin status or the `project-creator` entitlement.
`MARIMOHUB_PROJECT_CREATION=restricted` or `MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS`
requires these grants for everyone.
Project reads require an effective `viewer` role, obtained through ownership,
membership, or `MARIMOHUB_DEFAULT_ROLE`. Non-members cannot see a project when
the default role is `none`. Notebook writes require `editor` or higher against
the target project and are enforced server-side on every route. Project
edit/delete always requires `manager` or higher, as does reading a project's audit log
(`GET /projects/{pid}/events`) — events record member management and deletion
activity. See
[Auth → Authorization](/auth#authorization-roles).

Kernel access follows the same gates. App users and editors or higher roles can use
[notebook apps](/apps). Viewers also get app access under
`MARIMOHUB_VIEWER_MODE=applications` or `ephemeral-sandbox`.
Apps run notebook code with the project's integration secrets and federated credentials.
The app-user role hides source, but cannot hide data that an app displays or offers for download.
See [Notebook apps → Who can do what](/apps#who-can-do-what).

Persistent editor access also depends on the
[editor sandbox-sharing policy](/editor-sessions).
Use `exclusive` when a sandbox contains user-specific files or settings. Use
`shared` only when every project editor is trusted with the sandbox's process,
files, environment, secrets, and credentials.

### Applying labels

Before enabling resource constraints or applying labels, upgrade every API,
proxy, and maintenance replica to a version that enforces resource security.
Use the same policy configuration on every replica. Older replicas preserve
label fields but do not enforce them.

Super admins set and clear labels through four endpoints, from a browser
session only (personal access tokens are refused):

- `PUT` / `DELETE /api/v1/projects/{pid}/security-labels`
- `PUT` / `DELETE /api/v1/projects/{pid}/notebooks/{nid}/security-labels`

Prerequisites: the caller holds super-admin standing (`MARIMOHUB_SUPER_ADMINS`
or the `super-admin` entitlement), and the deployment sets
`MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER`. Without an evaluator a `PUT` is rejected
as a validation error, because labels nobody can satisfy would lock the resource
for everyone.

Every mutation needs super-admin standing and, on an already-labeled resource,
a subject context that satisfies its current labels: an admin outside a
compartment cannot relax a label to gain visibility. Adding labels, or raising
them to a compartment superset with the same classification, is a **raise**;
anything else — clearing labels, changing the classification, dropping a
compartment — is a **lower**, a separately audited action. A notebook override
is evaluated in addition to the project labels, so it can only add
restrictions. The responses carry an `ETag`; send it back as `If-Match` to
reject a concurrent change with `412`.

Notebook duplication preserves the source notebook's security labels in the initial metadata and catalog entry.
The copy requires the same resource clearance as the original.

## Identity lookup

`GET /api/v1/users` resolves known IDs to display profiles, including email and profile picture.
Authenticated users can resolve display identities without project membership, preserving author, member, and session-owner displays on internal deployments.
Directory search still requires directory authority or project involvement.
Credential grants apply to both endpoints: restricted PATs and service accounts cannot resolve arbitrary identities, and selected-project tokens cannot access the deployment directory.
Authenticated callers can always resolve their own profile.

## Sandbox artifact reads

Artifact capture accepts regular files only and rejects symlinks in every path component.
Each read has a 25 MiB limit and a 10-second command deadline.
The transport stops on overflow or timeout. Earlier file sizes do not replace the transport limit.
Workspace capture also enforces its total byte limit against the captured bytes.
A refused workspace read preserves the last stored copy.

External compute adapters need `SandboxInstance.readFileBounded` to support artifact and workspace capture.
The method must enforce byte limits during transport and cancel the transport on overflow or timeout.
An adapter without this method can still run sessions. Capture logs a warning once per sandbox instance and skips artifact reads, workspace uploads, and workspace cleanup.
Existing stored content is preserved, but new sandbox changes are not captured until the adapter supports bounded reads.
Capture never falls back to an unbounded read.

## Request safety

- **CSRF:** state-changing requests are same-origin by default; add trusted
  cross-origins with `MARIMOHUB_ALLOWED_ORIGINS`.
- **Cost / DoS:** `MARIMOHUB_MAX_SESSIONS_PER_USER` (default 10) caps concurrent
  kernels per user; `0` disables the cap.
- **Security headers** (anti-clickjacking, nosniff, HSTS, referrer policy) wrap
  the SPA/static responses.
- **SPA Content Security Policy:** the Node server sends a report-only policy.
  Connections are limited to the app origin. Proxy-mode frames also use only the app origin.
  Direct sandbox exposure permits HTTP(S) frames because providers assign their origins at runtime.
  This frame allowance is intentional and does not protect against iframe exfiltration.
  The policy also permits local scripts, Google Fonts, image sources, and workers.
  Browsers report violations in the developer console. The policy does not block resources yet.
  Before enforcement, review violations from the deployment's integrations and narrow the permitted origins.
  Kernel proxy and HTML snapshot policies remain separate.

## Storage integrity

The catalog pointer is updated with an atomic compare-and-swap (conditional
write). marimohub verifies the store honors conditional writes **at boot** and
refuses to run on one that doesn't, so concurrent edits can't corrupt state.
See [Storage](/storage#requirement-atomic-conditional-writes).

## Secrets handling

Keep secret `MARIMOHUB_*` values (storage keys, OIDC client secret, session
secret, compute tokens) out of source. Use a Kubernetes Secret / your secrets
manager and inject via `envFrom` — see [Operations](/operations#secrets) and
[Deploying with Helm](/deploying/helm). The published image and Helm chart run
**non-root with a read-only root filesystem and all capabilities dropped** by
default.

Kubernetes, Docker, Podman, and CoreWeave send session environment values through
stdin to private files outside the workspace. Exec arguments contain no
injected values. Files use mode `0600` in directories with mode `0700` and remain
until sandbox destruction. Notebook code can read its own credentials.

Environment preparation adds one remote command per new set of values, including
process overrides. Commands reuse the file while values stay unchanged.
Workspace file transfers are unchanged.

Cloudflare endpoint bucket mounts use the SDK credential proxy to keep mount
credentials outside the container filesystem.

## Shared deployment credentials

[AWS](integration-secrets.md#aws-project-policies) and
[GitHub](syncing.md#github-project-policies) project policies are optional. Unset
or blank policies keep existing access with a startup warning. The hub enforces
configured rules before it uses shared credentials.

Ambient object browsing excludes the configured hub bucket or Azure container,
even with server ambient access enabled. The exclusion matches names within each
provider, across endpoints and accounts. Explicit integration credentials remain
available.

Use a separate data bucket for ambient browsing. Restrict hub storage credentials
to hub storage.
