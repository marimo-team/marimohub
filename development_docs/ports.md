# Ports & Adapters — Status

Every external dependency sits behind a port (`Bucket`, `SandboxProvider`,
`Authenticator`). This is the implementation + verification status of each
adapter.

**Legend**

| Icon | Status      | Meaning                                                 |
| ---- | ----------- | ------------------------------------------------------- |
| ✅   | Verified    | Exercised against the live provider                     |
| 🟡   | Implemented | Code complete, not yet verified against a live provider |
| 🚧   | In progress | Actively being built                                    |
| ⬜   | Not started | Candidate, not yet built                                |

## Storage (`Bucket`)

| Status | Provider                            | Adapter        | Notes                                                |
| ------ | ----------------------------------- | -------------- | ---------------------------------------------------- |
| ✅     | CoreWeave AI Object Storage (CAIOS) | `storage-s3`   | S3-compatible; the production storage backend        |
| ✅     | AWS S3                              | `storage-s3`   |                                                      |
| 🟡     | MinIO / Tigris / Ceph / R2-via-S3   | `storage-s3`   | Same adapter, config only (endpoint/region)          |
| 🟡     | Cloudflare R2 (binding)             | `storage-r2`   | Workers-only; wired by hand in the worker entrypoint |
| 🟡     | Memory                              | `core/testing` | Dev/tests only (the contract-test double)            |
| 🚧     | Google Cloud Storage                | `storage-gcs`  | Native JSON API, generation-based CAS                |
| ⬜     | Azure Blob Storage                  | —              | ETag `If-Match` → clean CAS                          |
| ⬜     | Filesystem / local disk             | —              | CAS via atomic-rename + lockfile                     |

## Compute (`SandboxProvider`)

| Status | Provider                        | Adapter              | Notes                                                 |
| ------ | ------------------------------- | -------------------- | ----------------------------------------------------- |
| ✅     | CoreWeave Sandboxes (cwsandbox) | `compute-coreweave`  | Vendored gRPC SDK; the production compute backend     |
| 🟡     | Modal                           | `compute-modal`      |                                                       |
| 🟡     | Cloudflare Containers           | `compute-cloudflare` | Durable Object-backed; Workers-only                   |
| 🟡     | Docker                          | `compute-docker`     | Local end-to-end test passed; not run in a deployment |
| 🟡     | E2B                             | `compute-e2b`        | `e2b` SDK is an optional, bring-your-own dependency   |
| 🟡     | Local subprocess                | `compute-local`      | Dev only (`uv run marimo edit` on the host)           |
| 🚧     | Kubernetes                      | `compute-kubernetes` | Pod + Service + Ingress per sandbox; vendor-neutral   |
| ⬜     | Fly.io Machines                 | —                    | VM per sandbox, per-machine public hostname           |
| ⬜     | Daytona                         | —                    | Sandbox SDK (exec/files/preview URLs)                 |
| ⬜     | AWS Fargate / ECS RunTask       | —                    | RunTask + ECS Exec + ALB                              |
| ⬜     | Runpod / Lambda / Beam          | —                    | For GPU kernels                                       |

## Auth (`Authenticator`)

| Status | Provider                                         | Adapter                  | Notes                                            |
| ------ | ------------------------------------------------ | ------------------------ | ------------------------------------------------ |
| 🟡     | OIDC (Google / Auth0 / Okta / Keycloak / WorkOS) | `auth-oidc`              | Google OIDC is live in the deployment            |
| 🟡     | Cloudflare Access                                | `auth-cloudflare-access` | Verifies `CF-Access-JWT-Assertion`; Workers-only |
| 🟡     | Dev bypass                                       | `auth-dev`               | Dev only (fixed local user)                      |
| ⬜     | Reverse-proxy header trust                       | —                        | oauth2-proxy / Pomerium (`X-Forwarded-Email`)    |
| ⬜     | Google IAP                                       | —                        | Verify signed `X-Goog-IAP-JWT-Assertion`         |
| ⬜     | Static API tokens / PAT                          | —                        | Bearer-token → user, for CLI/programmatic access |
| ⬜     | GitHub OAuth (native)                            | —                        | Partly covered by `auth-oidc` today              |
| ⬜     | Tailscale identity                               | —                        | `Tailscale-User-Login` via tsnet/serve           |
| ⬜     | Native SAML                                      | —                        | Usually better bridged via WorkOS/Auth0 → OIDC   |
