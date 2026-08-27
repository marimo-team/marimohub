# Ports & Adapters — Status

Every external dependency sits behind a port. This page shows the implementation
and verification status of each adapter.

## External adapter libraries

The Node server can load external storage and compute adapters at startup. Set
the port selector to `library`. Set its library variable to an npm package, an
ESM file path, or a `file://` URL:

```sh
MARIMOHUB_STORAGE_BACKEND=library
MARIMOHUB_STORAGE_LIBRARY=/etc/marimohub/storage.mjs
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=@myorg/marimohub-compute
```

A module must default-export a manifest. A CommonJS module can use
`module.exports` or `module.exports.default`.

```js
export default {
	apiVersion: 1,
	kind: 'storage', // or 'compute'
	async create(context) {
		return makeAdapter(context);
	},
};
```

`apiVersion` must equal `1`. A storage factory returns a `Bucket`. A compute
factory returns a `SandboxProvider`. Each factory receives the full
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
to `global` or `process`. During development, run the contract for your port:
`bucketContract` or `computeContract`.

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
| 🟡     | Kubernetes                      | `compute-kubernetes`       | Pod + Service + Ingress per sandbox; vendor-neutral   |
| ⬜     | Fly.io Machines                 | —                          | VM per sandbox, per-machine public hostname           |
| ⬜     | Daytona                         | —                          | Sandbox SDK (exec/files/preview URLs)                 |
| ⬜     | AWS Fargate / ECS RunTask       | —                          | RunTask + ECS Exec + ALB                              |
| ⬜     | Runpod / Lambda / Beam          | —                          | For GPU kernels                                       |

## Auth (`Authenticator`)

| Status | Provider                                         | Adapter                  | Notes                                                   |
| ------ | ------------------------------------------------ | ------------------------ | ------------------------------------------------------- |
| ✅     | OIDC (Google / Auth0 / Okta / Keycloak / WorkOS) | `auth-oidc`              | Verified end-to-end with Google OIDC                    |
| ✅     | Cloudflare Access                                | `auth-cloudflare-access` | Workers-only. Verifies `CF-Access-JWT-Assertion`        |
| ✅     | Dev bypass                                       | `auth-dev`               | Dev only (fixed local user)                             |
| ⬜     | Reverse-proxy header trust                       | —                        | oauth2-proxy / Pomerium (`X-Forwarded-Email`)           |
| ⬜     | Google IAP                                       | —                        | Verify signed `X-Goog-IAP-JWT-Assertion`                |
| ✅     | Personal access tokens                           | built into `core`        | `mhub_pat_…` bearer → user, for CLI/programmatic access |
| ⬜     | GitHub OAuth (native)                            | —                        | Partly covered by `auth-oidc` today                     |
| ⬜     | Tailscale identity                               | —                        | `Tailscale-User-Login` via tsnet/serve                  |
| ⬜     | Native SAML                                      | —                        | Usually better bridged via WorkOS/Auth0 → OIDC          |

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
