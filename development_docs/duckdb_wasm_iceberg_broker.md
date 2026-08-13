# DuckDB-Wasm Iceberg HTTP broker mock

## Status

The repository contains a parent-side broker policy mock in
`packages/duckdb-wasm-runtime/src/icebergHttpBroker.ts`. It is deliberately not connected to the
DuckDB-Wasm worker. The runtime must continue to omit `iceberg-http` until the transport and worker
bridge described below exist and pass live conformance tests.

## Boundary

```text
API request
  -> resolve one integration version and its ephemeral credentials
  -> open broker capability in the server parent
  -> start disposable DuckDB-Wasm worker with only the capability ID
  -> worker asks the parent to perform HTTP requests
  -> broker authorizes and executes each request
  -> close capability and terminate worker
```

Credentials remain in the parent-side route records. The worker may supply safe protocol headers,
such as `Range` and `If-None-Match`, but cannot supply `Authorization`, cookies, proxy headers, or
arbitrary destinations. This first contract is read-only: catalog routes accept `GET`, and storage
routes accept `GET` or `HEAD`. OAuth exchanges happen in trusted parent code before the capability is
opened.

An execution capability contains:

- an expiry;
- catalog and storage URL scopes;
- methods allowed for each scope;
- parent-owned headers for each scope;
- request, redirect, and response-byte budgets.

For example, the parent might open this read-only capability after resolving one stored integration:

```ts
const capabilityId = broker.open({
	expiresAtMs: Date.now() + 30_000,
	routes: [
		{
			kind: 'catalog',
			url: 'https://catalog.example.com/iceberg',
			match: 'prefix',
			methods: ['GET'],
			headers: { authorization: `Bearer ${catalogToken}` },
		},
		{
			kind: 'storage',
			url: 'https://storage.example.com/warehouse',
			match: 'prefix',
			methods: ['GET', 'HEAD'],
			headers: { authorization: `Bearer ${storageToken}` },
		},
	],
	limits: {
		maxRequests: 256,
		maxRedirects: 8,
		maxResponseBytes: 64 * 1024 * 1024,
	},
});
```

This example is illustrative. Storage routes must come from validated integration configuration or
trusted parsing of catalog responses; they must not be copied from untrusted worker requests.

Redirects are not followed by the transport. The broker resolves each `Location`, authorizes the new
target, and applies credentials belonging to that target. A catalog credential therefore cannot ride
a redirect to object storage or an unapproved host. Requests are serialized within one capability so
concurrent reads cannot oversubscribe its cumulative response-byte budget.

## Missing implementation

The following work is required before advertising `iceberg-http`:

1. Implement a Node transport that resolves once, rejects forbidden addresses, pins the socket to the
   validated address set, does not follow redirects, supports byte ranges and binary bodies, and
   respects cancellation and response limits.
2. Bridge blocking DuckDB-Wasm HTTP callbacks to the asynchronous parent broker. Candidate designs
   are a per-execution loopback proxy or a shared-memory worker bridge. The capability ID must be
   bound to that worker and never accepted from an API client.
3. Derive initial routes from the resolved integration. Add storage routes only from configured
   locations or catalog responses parsed by trusted parent code. Do not let worker SQL add routes.
4. Serve pinned `iceberg` and `httpfs` Wasm extensions locally. Extension downloads must not share
   the data-egress capability.
5. Add live tests whose fixture records every catalog, redirect, metadata, manifest, and Parquet
   request. Tests must also cover DNS rebinding, private addresses, redirect credential separation,
   expired capabilities, cancellation, and concurrent budget exhaustion.
6. Only after those tests pass, enable external access for the brokered runtime and advertise the
   `iceberg-http` feature.

The broker mock is not itself a network sandbox. Its transport contract requires address validation
and pinning because an origin allowlist alone does not prevent DNS rebinding.
