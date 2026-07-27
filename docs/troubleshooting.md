---
description: Diagnose startup, login, kernel, storage, and live-deployment failures.
---

# Troubleshooting

Common failures and what they mean. Most startup refusals are marimohub failing
**closed** on purpose — the message tells you exactly what to fix.

## The server refuses to start

### "MARIMOHUB_AUTH_BACKEND must be set"

Auth has no default. Set `MARIMOHUB_AUTH_BACKEND` to `oidc` (production) or `dev`
(local only). See [Auth](/auth).

### "MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS must be set" (OIDC)

The OIDC backend won't admit every account your IdP can authenticate. List the
allowed domains (`example.com,partner.com`) or set `*` to allow all. See
[Auth → OIDC](/auth#oidc-production).

### "SANDBOX_HOSTNAME shares an origin/parent domain with the app"

In `subdomain` exposure (the default) kernels run untrusted code and must be on
a **separate domain** from the app. Move `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`
off the app's registrable domain (e.g. `sandboxes.example.net`), or switch to
`proxy` exposure if you intend to serve kernels through the app. See
[Security → Kernel exposure](/security#kernel-exposure).

### `boot_failed` with `reason: preflight_fatal`

A preflight check returned a **fatal** result — a deterministic problem a restart
won't fix. The most common is a store that doesn't honor atomic conditional
writes (which marimohub needs to update notebooks safely): use a qualifying store
(AWS S3, R2, GCS, CoreWeave CAIOS, recent MinIO) — see
[Storage](/storage#requirement-atomic-conditional-writes). A malformed
`MARIMOHUB_WIF_SIGNING_KEY` is the other. The preceding `preflight_check` log line
names the failing check and the fix.

Note: a backend that is merely **unreachable** (a blip) is logged as
`level: error` but does **not** stop boot — the pod starts and you can inspect the
problem with `GET /api/health?deep=true` (below).

### "MARIMOHUB_STORAGE_BACKEND=memory is non-durable"

The in-memory store is dev/tests only. Set `MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true`
to acknowledge volatility, or choose `s3`/`gcs`. See [Storage](/storage#memory-dev-tests).

## Login fails

### `redirect_uri_mismatch`

The redirect URI registered with your provider doesn't exactly match
`MARIMOHUB_AUTH_OIDC_REDIRECT_URI`. It must be
`https://<your-host>/api/auth/callback`, registered verbatim (scheme, host, path).
See the provider steps in [Auth → OIDC](/auth#oidc-production).

### Logged in, but "access denied"

Your verified email's domain isn't in `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS`. Add
it, or set `*`.

## Kernels won't start

### "No compute backend configured"

`MARIMOHUB_COMPUTE_BACKEND=none` — notebooks are browsable but kernels can't
start. Pick a real backend. See [Compute](/compute).

### Kernel never becomes reachable (Kubernetes / CoreWeave)

The browser connects **directly** to the kernel host, so this is almost always
ingress/DNS/TLS:

- Wildcard DNS `*.{host}` must point at your ingress, with a matching wildcard
  TLS secret (`MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET`).
- For CoreWeave, the URL scheme is profile-specific — set
  `MARIMOHUB_COMPUTE_COREWEAVE_PROFILE` / `…_HOSTNAME_TEMPLATE`.

See [Deploying → Kubernetes](/deploying/kubernetes) and [CKS](/deploying/cks).

### Kernel starts but notebook fails with a file-IO error

The sandbox image runs as a non-root user that can't write `/workspace`. Point
`MARIMOHUB_COMPUTE_WORKDIR` at a writable directory (the marimo OSS image hits
this). See [Sandbox image](/sandbox-image).

### First kernel is slow (cold start)

Pre-install marimo and common libraries into the image's project environment so
the startup `uv sync --inexact` only adds notebook-specific dependencies. See
[Sandbox image → Why pre-install (not just cache)](/sandbox-image#why-pre-install-not-just-cache).

## Check a live deployment

`GET /api/health?deep=true` probes every downstream dependency and reports each
check (status + a remediation hint). It's authenticated, so send your session
cookie:

```bash
curl -s -b "$COOKIE" 'https://<your-host>/api/health?deep=true' | jq
# 200 = healthy, 503 = a dependency check failed
```

Each failing check carries a `remediation`. `GET /api/v1/version` shows the running
version and selected backends.

## API error codes

Every API error returns `{ "success": false, "error": { "code", "message" } }`.

| Code                               | HTTP      | Meaning / action                                                           |
| ---------------------------------- | --------- | -------------------------------------------------------------------------- |
| `UNAUTHORIZED`                     | 401       | Not logged in — sign in (or send the session cookie).                      |
| `FORBIDDEN`                        | 403       | Insufficient role, or a cross-origin write was rejected.                   |
| `NOT_FOUND`                        | 404       | The project/notebook/session doesn't exist.                                |
| `CONFLICT` / `PRECONDITION_FAILED` | 409 / 412 | Concurrent write lost the race — retry.                                    |
| `VALIDATION_ERROR`                 | 422       | Bad input; the message lists each `field: problem`.                        |
| `RESOURCE_EXHAUSTED`               | 429       | Per-user concurrent-session cap hit — free one or retry.                   |
| `PAYLOAD_TOO_LARGE`                | 413       | Request body exceeds the limit.                                            |
| `SERVICE_UNAVAILABLE`              | 503       | A compute/storage dependency is down — transient.                          |
| `INTERNAL_ERROR`                   | 500       | Unexpected; check `level: error` logs (the cause is logged, not returned). |

## Still stuck?

Check structured `level: error` logs (see
[Operations → Observability](/operations#observability)), and open an issue at the
[GitHub repo](https://github.com/marimo-team/marimohub).
