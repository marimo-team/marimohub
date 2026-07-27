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
`allow-same-origin` is required for the kernel to work, so a kernel on the **same
registrable domain** as the app could escape the iframe into the app's origin or
set cookies on the shared parent domain.

The browser connects **directly** to the kernel, so marimohub **refuses to
start** if `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` shares an origin or parent domain
with the app (taken from the OIDC redirect URI):

```bash
# app:      https://hub.example.com
# kernels:  https://sandboxes.example.net   ✅ separate registrable domain
MARIMOHUB_SANDBOX_EXPOSURE=subdomain   # default
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=sandboxes.example.net
```

::: danger Don't host kernels under the app domain
`sandboxes.hub.example.com` or `hub.example.com` for kernels is rejected at boot.
:::

The kernel URL is **not authenticated by the hub** — the per-session sandbox id
is the only capability. Don't expose the kernel hostname beyond the iframe.

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
# optional: build proxy URLs from this origin instead of the request host
MARIMOHUB_APP_BASE_URL=https://hub.example.com
```

The separate-domain guard doesn't apply here, and
`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` is unused. Proxy mode runs on the Node
server; the Cloudflare Workers deployment uses `subdomain`.

## Kernels run tokenless

The provisioner launches marimo with `--no-token`, so the kernel has no auth of
its own. In `proxy` mode the hub's auth + per-session check front it; in
`subdomain` mode only the high-entropy sandbox id on an isolated domain does.
Never expose the kernel hostname directly — keep marimohub (and your ingress, for
the `kubernetes`/`coreweave` backends) in front.

## Authentication fails closed

- `MARIMOHUB_AUTH_BACKEND` has **no default** — an unset backend refuses to
  start rather than silently falling back to the `dev` bypass.
- OIDC requires `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS` (verified email):
  marimohub will not silently admit every account the IdP can authenticate;
  set explicit domains, or `*` to consciously allow all.
- The session cookie is signed with `MARIMOHUB_AUTH_SESSION_SECRET` (HS256, ≥32
  bytes). Generate it with `openssl rand -base64 32` and treat it as a secret.

See [Auth](/auth) for provider setup.

## Authorization (roles)

Project reads require an effective `viewer` role, obtained through ownership,
membership, or `MARIMOHUB_DEFAULT_ROLE`. Non-members cannot see a project when
the default role is `none`. Writes require `editor` or `admin` against the target
project and are enforced server-side on every route. Project edit/delete always
requires `admin`, as does reading a project's audit log
(`GET /projects/{pid}/events`) — events record member management and deletion
activity. See
[Auth → Authorization](/auth#authorization-roles).

## Request safety

- **CSRF:** state-changing requests are same-origin by default; add trusted
  cross-origins with `MARIMOHUB_ALLOWED_ORIGINS`.
- **Cost / DoS:** `MARIMOHUB_MAX_SESSIONS_PER_USER` (default 10) caps concurrent
  kernels per user; `0` disables the cap.
- **Security headers** (anti-clickjacking, nosniff, HSTS, referrer policy) wrap
  the SPA/static responses.

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
