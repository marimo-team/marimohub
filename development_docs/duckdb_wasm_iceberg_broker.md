# DuckDB-Wasm Iceberg HTTP broker

## Status

The Node DuckDB-Wasm runtime supports guarded, read-only Iceberg REST access.
The runtime advertises `iceberg-http` only when the composition root supplies a parent broker session factory.

The runtime rejects host path enumeration and mutation through every Node filesystem callback, including when `httpfs` requires DuckDB external access to remain enabled. The unbrokered runtime also rejects all remote protocols.

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

The worker receives dummy DuckDB credentials. Real catalog and S3 credentials stay in the parent process.

For brokered Run SQL requests, the parent also removes rendered integration files and environment variables from the worker request.

## Supported configuration

The Iceberg REST integration must use this configuration:

- no authentication or bearer-token authentication
- a catalog URL without query parameters
- `access_delegation: none`
- explicit S3 storage
- an origin-only S3 endpoint
- path-style or virtual-hosted S3 addresses
- static S3 credentials or anonymous S3 access
- one or more `storage.broker_read_locations` entries
- system TLS without custom headers or extra properties
- the default PyIceberg runtime and REST client options

Other Iceberg configurations use the fixed PyIceberg sandbox preview.

Each read location contains an S3 bucket and prefix. The broker denies every object URL outside these prefixes.

## Broker policy

A broker session contains these controls:

- an expiry time
- catalog and storage URL prefixes
- an allowlist of `GET` and `HEAD` methods
- parent-owned authorization or signing functions
- request, redirect, cumulative-byte, and single-response limits
- at most four concurrent requests, with response-byte reservations reconciled to actual bodies

The worker can submit safe protocol headers such as `Range` and `If-None-Match`.
The broker rejects worker authorization, cookie, host, proxy, forwarding, and Iceberg access-delegation headers.

The Node transport does not follow redirects. The broker authorizes each redirect target and applies the credentials for that route.
As a result, a catalog credential cannot move to an object-store route.

The transport resolves each hostname once. It rejects forbidden addresses and pins the socket to the checked address set.
It disables connection pooling so every request uses its newly validated address set.
DNS, connection, headers, and body reads share one deadline bounded by the execution deadline.
`MARIMOHUB_INTEGRATIONS_PROBE=private` permits private and loopback targets for private deployments.

## Worker bridge

DuckDB-Wasm uses synchronous `XMLHttpRequest` calls. The worker waits on a `SharedArrayBuffer` while the parent completes each request.

The bridge has fixed header and body buffers. A single response cannot exceed 16 MiB.
The broker also applies a 64 MiB cumulative response limit and a 512-request limit to each session.
Each remote request must echo the nonce bound to its current execution. A stale or mismatched nonce closes the session and terminates the worker.

The parent closes the broker session after success, failure, cancellation, or runtime shutdown. Session closure aborts active transport requests.
Preview workers that process brokered data are dedicated to that execution and disposed afterward; a previously used pooled worker is never promoted into a brokered execution.

The broker emits low-cardinality metrics for authorization outcomes, redirects, exhausted budgets, response bytes, and request and transport latency. The runtime also records bridge failures and worker termination reasons. Metric tags contain only fixed outcome, reason, method, route, status-class, and budget values; they never contain URLs, capability IDs, or credentials.

## Extensions

The runtime packages signed DuckDB 1.4.3 Wasm extensions for `iceberg`, `httpfs`, `parquet`, and `avro`.
The worker loads these files from the local package and checks their SHA-256 digests.
It advertises `iceberg-http` only after all four extensions load successfully during initialization.
A checked-in manifest couples their origin and hashes to the pinned DuckDB-Wasm and embedded DuckDB versions; a drift test verifies the package pin, engine badge, and packaged bytes.

Automatic extension installation, automatic extension loading, and community extensions remain disabled.
The extension-download origin accepts only the four pinned file names.

## Tests

Unit tests cover route authorization, credential separation, redirects, expiry, cancellation, bounded parallelism, byte limits, S3 signing, private-address policy, and per-request DNS pinning.

The live test seeds a populated Iceberg snapshot in the local Iceberg REST and MinIO services. It executes the production preview and Run SQL planners, then verifies that catalog metadata, manifest-list, manifest, and Iceberg data-file requests all cross the worker bridge. It also reads a standalone signed Parquet object. The catalog-conformance workflow runs this test and its adversarial broker unit suites in CI.

Run the live test with these commands:

```bash
pnpm dev:services
MARIMOHUB_TEST_ICEBERG_BROKER_URI=http://127.0.0.1:18181 \
MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT=http://127.0.0.1:19000 \
pnpm --filter @marimo-hub/config test -- --run src/duckdbHttpBroker.live.test.ts
```
