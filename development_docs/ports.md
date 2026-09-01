# Ports & Adapters — Status

Every external dependency sits behind a port. This page shows the implementation
and verification status of each adapter.

## External adapter libraries

The Node server can load external storage, compute, login-policy, and
subject-context adapters at startup. Set the applicable backend to `library`.
Set its library variable to an npm package, ESM file path, or `file://` URL:

```sh
MARIMOHUB_STORAGE_BACKEND=library
MARIMOHUB_STORAGE_LIBRARY=/etc/marimohub/storage.mjs
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=@myorg/marimohub-compute
MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND=library      # requires MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY=/etc/marimohub/oidc-login-policy.mjs
MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND=library       # requires MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER
MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY=/etc/marimohub/subject-context.mjs
```

A module must default-export a manifest. A CommonJS module can use
`module.exports` or `module.exports.default`.

```js
export default {
	apiVersion: 1,
	kind: 'storage', // 'storage', 'compute', 'oidc-login-policy', or 'subject-security-context'
	async create(context) {
		return makeAdapter(context);
	},
};
```

`apiVersion` must equal `1`. A storage factory returns a `Bucket`. A compute
factory returns a `SandboxProvider`. An `oidc-login-policy` factory returns
`evaluate(input)`. Its contract lives in `@marimo-hub/auth-oidc/loginPolicy.ts`,
not in `core`. It maps validated OIDC claims to a bounded login decision and
entitlements. It does not authorize runtime resources. A
`subject-security-context` factory returns `resolve(principal, signal)` and
implements `SubjectSecurityContextProvider`. Each factory receives the full
`MARIMOHUB_*` environment. A compute factory also receives
`sessionMaxLifetimeSeconds` and `sessionIdleTimeoutMs` in `context.compute`.

At startup, the loader validates the five required `Bucket` methods and its CAS
safety contract. For compute, it validates `create` and `proxy`, plus optional
methods when present. It validates the first `SandboxInstance` after the provider
creates it. Structural validation does not replace the contracts in
`@marimo-hub/core/testing`.

A storage adapter must implement atomic `onlyIfEtagMatches` and
`onlyIfNotExists` writes. If a conditional write fails, throw
`context.errors.preconditionFailed(message)`. This function returns the server's
`PreconditionFailedError`, so the adapter does not need `@marimo-hub/core` at
runtime.

The storage adapter must implement `verifyConditionalWrites()` and set `casScope`
to `global` or `process`. The probe must use a unique temporary key and verify
that exactly one of several writes using the same ETag succeeds. During
development, run the contract for your port: `bucketContract` or
`computeContract`.

The server loads each module once. It does not sandbox, unload, or hot-reload
modules. Only the Node server supports these modules. Load only trusted code. It
runs with server privileges.

For deployment, bundle the adapter and its SDK dependencies into one `.mjs` file.
Then mount the file in the server image. Node ESM does not use `NODE_PATH`. See
[`examples/external-adapter`](../examples/external-adapter/README.md).

**Legend**

| Icon | Status      | Meaning                                                 |
| ---- | ----------- | ------------------------------------------------------- |
| ✅   | Verified    | Exercised against the live provider                     |
| 🟡   | Implemented | Code complete, not yet verified against a live provider |
| 🚧   | In progress | Actively being built                                    |
| ⬜   | Not started | Candidate, not yet built                                |

## Storage (`Bucket`)

| Status | Provider                            | Adapter         | Notes                                                  |
| ------ | ----------------------------------- | --------------- | ------------------------------------------------------ |
| ✅     | CoreWeave AI Object Storage (CAIOS) | `storage-s3`    | S3-compatible                                          |
| ✅     | AWS S3                              | `storage-s3`    |                                                        |
| ✅     | Cloudflare R2 (binding)             | `storage-r2`    | Workers-only. Wired in the Worker entrypoint           |
| 🟡     | MinIO / Tigris / Ceph / R2-via-S3   | `storage-s3`    | Same adapter, config only (endpoint/region)            |
| 🟡     | Memory                              | `core/testing`  | Dev/tests only (the contract-test double)              |
| 🟡     | Google Cloud Storage                | `storage-gcs`   | Native JSON API, generation-based CAS                  |
| 🟡     | Azure Blob Storage                  | `storage-azure` | Native SDK, ETag-based CAS                             |
| 🟡     | Filesystem / local disk             | `storage-fs`    | Single-process adapter for local deployments and tests |

## Compute (`SandboxProvider`)

| Status | Provider                        | Adapter                    | Notes                                                 |
| ------ | ------------------------------- | -------------------------- | ----------------------------------------------------- |
| ✅     | CoreWeave Sandboxes (cwsandbox) | `compute-coreweave`        | Vendored gRPC SDK                                     |
| ✅     | Cloudflare Containers           | `compute-cloudflare`       | Durable Object-backed; Workers-only                   |
| ✅     | E2B                             | `compute-e2b`              | `e2b` SDK is an optional, bring-your-own dependency   |
| ✅     | Local subprocess                | `compute-local`            | Dev only (`uv run marimo edit` on the host)           |
| 🟡     | Modal                           | `compute-modal`            |                                                       |
| 🟡     | Docker                          | `compute-container/docker` | Local end-to-end test passed; not run in a deployment |
| 🟡     | Podman                          | `compute-container/podman` | Hermetic CLI tests; not yet live-verified             |
| 🟡     | Kubernetes                      | `compute-kubernetes`       | Pod + Service; optional Ingress; vendor-neutral       |
| ⬜     | Fly.io Machines                 | —                          | VM per sandbox, per-machine public hostname           |
| ⬜     | Daytona                         | —                          | Sandbox SDK (exec/files/preview URLs)                 |
| ⬜     | AWS Fargate / ECS RunTask       | —                          | RunTask + ECS Exec + ALB                              |
| ⬜     | Runpod / Lambda / Beam          | —                          | For GPU kernels                                       |

## Auth (`Authenticator`)

| Status | Provider                                         | Adapter                  | Notes                                                   |
| ------ | ------------------------------------------------ | ------------------------ | ------------------------------------------------------- |
| ✅     | OIDC (Google / Auth0 / Okta / Keycloak / WorkOS) | `auth-oidc`              | Verified end-to-end with Google OIDC                    |
| ✅     | Cloudflare Access                                | `auth-cloudflare-access` | Workers-only. Verifies `CF-Access-JWT-Assertion`        |
| 🟡     | Trusted proxy headers / Google IAP               | `auth-proxy-header`      | oauth2-proxy, IAP, Tailscale, or another trusted proxy  |
| ✅     | Dev bypass                                       | `auth-dev`               | Dev only (fixed local user)                             |
| ✅     | Personal access tokens                           | built into `core`        | `mhub_pat_…` bearer → user, for CLI/programmatic access |
| ⬜     | GitHub OAuth (native)                            | —                        | Partly covered by `auth-oidc` today                     |
| ⬜     | Native SAML                                      | —                        | Usually better bridged via WorkOS/Auth0 → OIDC          |
| ✅     | OIDC login policy (external module)              | `auth-oidc`              | `oidc-login-policy` library: login-time claim mapping   |

Every adapter returns an `AuthenticatedPrincipal`: the user plus a required
`credential` with bounded provenance (`sso` | `personal-access-token` |
`service-account` | `development`, optional id and expiry). Consumers key
credential-scoped behavior (e.g. the API's PAT-only route guard) off this
field, never off request-header inference.

## Subject security context (`SubjectSecurityContextProvider`)

`packages/core/src/ports/subjectContext.ts` defines the strict runtime context:
`schemaVersion`, `classification`, `compartments`, `policyVersion`, and
`expiresAt`. Values use bounded tokens and contain at most 64 compartments.

The provider resolves one context for each principal. `null` means that the
principal has no context. Unlabeled resources are unaffected. Labeled resources
fail closed. Raw JWT claims, UserInfo data, and login-policy results are not
valid sources.

The hub validates every result with `validateSubjectSecurityContext()`. It
rejects expired contexts, malformed values, and unknown fields. Deployments can
load a trusted provider through the `subject-security-context` library
interface.

| Status | Provider          | Adapter           | Notes                    |
| ------ | ----------------- | ----------------- | ------------------------ |
| ✅     | External library  | Configured module | Loaded at server startup |
| ⬜     | Built-in IdP sync | —                 | Not implemented          |

## Object browsing (`ObjectBrowser`)

| Status | Provider             | Adapter                  | Notes                                      |
| ------ | -------------------- | ------------------------ | ------------------------------------------ |
| ✅     | Amazon S3 / MinIO    | `object-browser-s3`      | S3-compatible object browsing              |
| 🟡     | Google Cloud Storage | `object-browser-gcs`     | Native GCS API                             |
| 🟡     | Azure Blob Storage   | `object-browser-azure`   | Containers map to provider-neutral roots   |
| 🟡     | Shared helpers       | `object-browser-commons` | Guarded transport, formats, and validation |

## Notifications (`Notifier`)

| Status | Delivery channel | Adapter          | Notes                       |
| ------ | ---------------- | ---------------- | --------------------------- |
| 🟡     | SMTP             | `notify-smtp`    | Personal and broadcast mail |
| 🟡     | Slack            | `notify-slack`   | Broadcast incoming webhook  |
| 🟡     | Signed webhook   | `notify-webhook` | JSON with HMAC-SHA256       |

## Data preview and query runtimes

`DataPreviewService` selects server-authored preview programs. The
`duckdb-wasm-runtime` package implements the isolated Node runtime for
DuckDB-Wasm previews. `DataQueryService` uses a separate disposable-executor
contract for user SQL. The Node composition root creates a fresh worker for
each query when full data-browser mode is enabled.
