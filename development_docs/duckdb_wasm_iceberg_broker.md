# DuckDB-Wasm guarded HTTP broker

## Status

The Node DuckDB-Wasm runtime provides guarded, read-only access to Iceberg REST catalogs and S3 files.
When the composition root supplies a parent broker session factory, the runtime advertises
`guarded-http`. It also advertises `iceberg-http` as a compatibility alias.

Every Node filesystem callback blocks host-path enumeration and mutation. This restriction also
applies when `httpfs` requires DuckDB external access. The unbrokered runtime blocks all remote
protocols.

## Request path

```text
API request
  -> resolve one integration version and its credentials
  -> open a parent broker session
  -> send a credential-free DuckDB program to the worker
  -> worker submits a synchronous HTTP request through shared memory
  -> parent authorizes and signs the request
  -> guarded transport resolves, checks, and pins the target address
  -> parent returns the bounded binary response through shared memory
  -> close the broker session and terminate or recycle the worker
```

The worker receives dummy catalog credentials. Explicit S3 credentials and OAuth2 client secrets stay in the parent process.

Authenticated catalog, OAuth2, and S3 endpoints require HTTPS by default. The
`allow_insecure_transport` option permits HTTP for local development. Anonymous endpoints do not
require this option.

For OAuth2 client credentials, the parent requests a token for the first catalog request. It
uses HTTP Basic authentication and the `client_credentials` grant. The parent shares one refresh
operation across concurrent requests. It keeps the token only for the broker session. The worker
receives the dummy token from its `ATTACH` statement.

For an R2 Data Catalog, temporary SigV4 credentials enter the disposable worker. The broker limits
signed requests to the bucket from the trusted catalog URI.

Generic catalogs can also vend S3 credentials. An administrator configures the maximum endpoint,
bucket, and key prefixes. The catalog can create routes only inside these bounds.

For brokered Run SQL requests, the parent removes rendered integration files and environment
variables from the worker request.

## Supported configuration

The Iceberg REST integration supports three configurations.

The explicit S3 configuration for Iceberg REST requires:

- no authentication, bearer-token authentication, or OAuth2 client credentials
- a catalog URL without query parameters
- `access_delegation: none`
- explicit S3 storage
- an origin-only S3 endpoint
- path-style or virtual-hosted S3 addresses
- static S3 credentials or anonymous S3 access
- one or more `storage.broker_read_locations` entries
- system TLS without custom headers or extra properties
- the default PyIceberg runtime and REST client options

The R2 Data Catalog configuration requires:

- a recognized R2 Data Catalog URI
- bearer-token authentication
- catalog storage
- `access_delegation: vended_credentials`
- system TLS without custom headers or extra properties
- the default PyIceberg runtime and REST client options

The generic vended S3 configuration requires:

- an HTTPS catalog
- no authentication, bearer-token authentication, or OAuth2 client credentials
- `access_delegation: vended_credentials`
- `storage.scheme: catalog`
- an HTTPS, origin-only `storage.vended_s3.endpoint`
- one or more `storage.vended_s3.allowed_locations` entries
- system TLS without custom headers or extra properties
- the default PyIceberg runtime and REST client options

Each allowed location is a maximum storage bound. An empty prefix grants its complete bucket. A
non-empty prefix grants that prefix and its children.

The first release supports AWS S3 and fixed S3-compatible endpoints. It does not support GCS,
Azure storage, remote signing, server-side scan responses, or worker-selected endpoints.

The R2 route derives its storage endpoint and bucket from the catalog URI. R2 does not require these
explicit S3 fields:

- an endpoint
- client options or credentials
- broker read locations
- virtual-hosted bucket constraints

The catalog scopes temporary SigV4 credentials to the R2 permissions of the bearer token.

Catalog and path-style storage prefixes must not overlap. A bucket named `iceberg` must use
`https://catalog.cloudflarestorage.com/{account}/iceberg`. The account-scoped
`https://{account}.r2.cloudflarestorage.com/iceberg/iceberg` form is not SQL-ready.

Other Iceberg configurations use the fixed PyIceberg sandbox preview.

For explicit S3, each read location contains a bucket and prefix. The broker denies object URLs
outside these prefixes.

The S3 integration also supports guarded Run SQL. It requires an explicit origin-only endpoint,
static or anonymous authentication, and one or more `broker_read_locations` entries. The default
bucket helps notebook code, but it does not grant Run SQL access.

Direct S3 queries support exact Parquet and CSV object paths. S3 globs require list requests at the
bucket root, so the first release denies them. JSON queries remain unavailable until the runtime
packages the signed `json` extension. The broker permits only `GET` and `HEAD`, and the worker runs
the statement in a read-only transaction.

## Broker policy

A broker session contains these controls:

- an expiry time
- catalog and storage URL prefixes
- an allowlist of `GET` and `HEAD` methods
- parent-owned authorization or signing functions
- request, redirect, cumulative-byte, and single-response limits
- cumulative limits of 512 dynamic routes and 512 KiB of normalized dynamic-route URLs
- at most four concurrent requests
- response-byte reservations that adjust to actual response sizes

The worker can submit safe protocol headers such as `Range` and `If-None-Match`.
The broker drops worker-supplied authorization, cookie, host, proxy, forwarding, and Iceberg
access-delegation headers. It also drops dummy DuckDB signatures on parent-authenticated routes.
For R2 and generic vended S3, the parent adds this header only to the catalog route:
`X-Iceberg-Access-Delegation: vended-credentials`.

For generic vended S3, the parent inspects successful JSON responses from these routes:

- `GET .../namespaces/{namespace}/tables/{table}`
- `GET .../namespaces/{namespace}/tables/{table}/credentials`

The parent does not inspect `/v1/config`. It parses credential prefixes, but it does not parse or
store credential values. The response must use an `s3://` prefix inside an administrator bound.

The parent installs path-style and eligible virtual-hosted routes before it returns the response.
Only these worker headers can enter a dynamic storage route:

- `authorization`
- `x-amz-content-sha256`
- `x-amz-date`
- `x-amz-security-token`

Catalog routes, other origins, sibling buckets, and sibling prefixes cannot receive these headers.

The Node transport does not follow redirects. The broker authorizes each redirect target and then
applies the credentials for that route. Thus, catalog credentials cannot move to an object-store
route.

The transport resolves each hostname once. It rejects forbidden addresses and pins the socket to
the checked address set. The transport disables connection pooling, so each request uses a newly
checked address set. DNS lookup, connection, headers, and body reads share the execution deadline.
`MARIMOHUB_INTEGRATIONS_PROBE=private` permits private and loopback targets for private deployments.
This policy also applies to OAuth2 token endpoints. Token responses have a 64 KiB limit. Failures
do not include the response body, client ID, client secret, scope, or token.

## Worker bridge

DuckDB-Wasm uses synchronous `XMLHttpRequest` calls. The worker waits on a `SharedArrayBuffer` while
the parent completes each request.

The bridge has fixed header and body buffers. A single response cannot exceed 16 MiB.
Each broker session has a 64 MiB cumulative response limit and a 512-request limit. Each remote
request must echo the nonce for its current execution. A stale or incorrect nonce closes the session
and terminates the worker.

The parent closes the broker session after success, failure, cancellation, or runtime shutdown.
Session closure aborts active transport requests. A preview worker that processes brokered data runs
only that execution and then stops. A pooled worker cannot become a brokered worker after use.

The broker emits low-cardinality metrics for authorization outcomes, redirects, exhausted budgets,
response bytes, and latency. Dynamic route outcomes are `installed`, `duplicate`, `malformed`,
`outside_bound`, `unsupported_scheme`, and `route_conflict`.

The runtime also records bridge failures and worker termination reasons.
Metric tags contain only fixed outcome, reason, method, route, status-class, and budget values. They
never contain URLs, capability IDs, or credentials.

## Extensions

The runtime packages signed DuckDB 1.4.3 Wasm extensions for `iceberg`, `httpfs`, `parquet`, and
`avro`. The worker loads these files from the local package and checks their SHA-256 digests. It
advertises guarded HTTP only after all four extensions load during initialization. A checked-in
manifest binds their origin and hashes to the pinned DuckDB-Wasm and embedded DuckDB versions. A
drift test checks the package pin, engine badge, and packaged bytes.

Automatic extension installation, automatic extension loading, and community extensions remain disabled.
The extension-download origin accepts only the four pinned file names.

## Tests

Unit tests cover authorization, OAuth2 refresh, credential separation, redirects, expiry,
cancellation, concurrency, byte limits, S3 signing, anonymous S3 access, private-address policy,
and DNS pinning. An integration test runs the
packaged DuckDB-Wasm Iceberg extension through the worker bridge. One test checks the R2 delegation
header. A second test uses a synthetic `LoadTable` response and fixed Iceberg object fixtures.

The second test checks the access-key identifier and session-token header on manifest and Parquet
requests. It does not check or log the secret key.

The live test seeds an Iceberg snapshot in the local Iceberg REST and MinIO services. It runs the
production preview and Run SQL plans. The test checks that catalog metadata, manifest-list, manifest,
and data-file requests cross the worker bridge. It also reads a signed Parquet object. The catalog
conformance workflow runs this test and the adversarial broker unit tests in CI.

Run the live test with these commands:

```bash
pnpm dev:services
MARIMOHUB_TEST_ICEBERG_BROKER_URI=http://127.0.0.1:18181 \
MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT=http://127.0.0.1:19000 \
MARIMOHUB_TEST_ICEBERG_BROKER_S3_ACCESS_KEY=minioadmin \
MARIMOHUB_TEST_ICEBERG_BROKER_S3_SECRET_KEY=minioadmin \
pnpm --filter @marimo-hub/config test -- --run src/duckdbHttpBroker.live.test.ts
```

The same file has an optional live test for a Polaris, Lakekeeper, or compatible catalog that vends
MinIO credentials. Configure an HTTPS catalog and storage endpoint. The bucket and prefix are the
administrator-owned maximum bound. The token, warehouse, namespace, and table variables are
optional. The namespace and table default to `demo.events`.

```bash
MARIMOHUB_TEST_ICEBERG_VENDED_URI=https://catalog.example.com/iceberg \
MARIMOHUB_TEST_ICEBERG_VENDED_S3_ENDPOINT=https://minio.example.com \
MARIMOHUB_TEST_ICEBERG_VENDED_BUCKET=warehouse \
MARIMOHUB_TEST_ICEBERG_VENDED_PREFIX=production/demo/events \
MARIMOHUB_TEST_ICEBERG_VENDED_TOKEN=catalog-token \
MARIMOHUB_TEST_ICEBERG_VENDED_WAREHOUSE=production \
pnpm --filter @marimo-hub/config test -- --run src/duckdbHttpBroker.live.test.ts
```

This test reads a real table and checks that the query capability contains only storage bounds. It
does not add a static S3 credential to the capability.
