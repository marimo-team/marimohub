# Integration architecture and kind development

This guide is for maintainers adding or changing integration kinds. For
deployment configuration, project administration, and notebook usage, see the
[integrations guide](../docs/integrations.md). The object layout and
concurrency protocol are specified in
[`bucket_spec.md`](./bucket_spec.md) §4.12.

## Architecture

Integrations follow the repository's ports-and-adapters boundary:

- `packages/core/src/ports/integrations.ts` defines the provider and render
  contracts used by the API and session pipeline.
- `packages/core/src/services/integrations/sdk.ts` defines a kind: its Zod
  config schema, UI hints, renderer, optional connectivity probe, and migration.
- `packages/core/src/services/integrations/registry.ts` turns registered
  definitions into JSON Schema descriptors for the API and web form.
- `packages/core/src/services/integrations/ProjectIntegrationsStore.ts` contains
  shared storage, versioning, name-claim, secret, migration, and rendering
  logic. `ProjectIntegrationsStore` uses this logic under
  `projects/{pid}/integrations/`. `OrgIntegrationsStore` uses it under
  `_system/integrations/`.
- `packages/core/src/services/integrations/bundle.ts` merges rendered files and
  environment variables into the session payload. Structured YAML fragments
  sharing a path are recursively merged, with conflicting leaves rejected.
- `packages/api/src/routes/integrations.ts` exposes management routes, while
  `packages/api/src/routes/sessions.ts` resolves enabled integrations during
  provisioning.

Concrete deployment wiring stays in `packages/config` and entrypoints. Core and
API code must not import vendor adapters.

The kind's Zod schema is the source for write validation, secret-field
discovery, generated JSON Schema, and the schema-driven web form. At session
launch, the store loads each enabled integration's current version and migrates
it to the current kind schema. It decrypts managed fields and resolves external
references before it calls the renderer. The session then records that version
as its audit pin. Rendered files
and environment variables are bundled outside the notebook workspace so
credentials cannot be captured in a notebook version.

Before rendering, `ProjectIntegrationsStore` combines the project and
organization tiers. It includes each enabled organization integration unless
the project has an integration with the same name. The project entry takes
precedence even when it is disabled. This rule supports overrides and opt-outs,
and it prevents duplicate names in the bundle.

The renderer receives the session's project ID for integrations from either
tier. Organization configuration and secret-encryption contexts remain under
`_system/`. The `/api/v1/org/integrations` routes call `assertSuperAdmin`, which
uses `MARIMOHUB_SUPER_ADMINS`.

## Adding a kind

Add one definition under
`packages/core/src/services/integrations/kinds/`, export it, and register it in
`packages/core/src/services/integrations/kinds/index.ts`:

```ts
export const postgres = defineIntegration({
	kind: 'postgres',
	title: 'PostgreSQL',
	description: 'Direct Postgres connection for SQL cells and SQLAlchemy.',
	category: 'database',
	schemaVersion: 1,
	configSchema: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65535).default(5432),
		password: zSecret(),
	}),
	requirements: ['sqlalchemy>=2'],
	uiHints: { host: { group: 'Connection', order: 1 } },
	render({ config, instanceName }) {
		const segment = envSegment(instanceName);
		const hostEnv = `MARIMOHUB_PG_${segment}_HOST`;
		return {
			env: { [hostEnv]: config.host },
			files: [
				{
					path: `postgres/${instanceName}.json`,
					content: JSON.stringify({ host_env: hostEnv }),
				},
			],
		};
	},
});
```

The `kind` discriminator is permanent; changing it is a data migration. Keep
`render` pure and synchronous: all session-specific values arrive in its input,
and identical input must produce byte-identical output.

`requirements` is informational. It is shown in the UI and written to the
integration manifest, but the hub does not install or preflight those packages.

## Supported schema dialect

`kinds.test.ts` requires every registered kind to stay within the form
renderer's supported JSON Schema dialect:

- strings, numbers, integers, booleans, and enums;
- nested objects and discriminated unions;
- `z.record(z.string(), z.string())` for key/value fields;
- arrays of objects; and
- `zSecret()` for secret-bearing strings.

Scalar arrays and other unsupported constructs fail the schema-dialect test so
they cannot reach users as uneditable forms. `uiHints` can control presentation
such as grouping, order, widgets, and advanced sections, but must not change
validation or storage semantics.

## Render contract

Renderers emit relative POSIX file paths, mergeable YAML fragments, and
environment variables. The bundler
rejects:

- absolute paths, backslashes, empty segments, `.` or `..`;
- the reserved `manifest.json` path;
- malformed or process-sensitive environment variable names; and
- conflicting file paths or environment values across integrations.

Use `yamlFiles` only when multiple instances must contribute to one
tool-owned configuration document. Leaves must be scalar/array/object data and
must either be unique or byte-equivalent after JSON serialization; the bundler
fails on divergent values rather than choosing an owner.

Kinds live in `core`, so they cannot import vendor SDKs. Render text files and
environment variables instead. The bundle is placed under
`/tmp/marimohub-integrations`, outside the notebook workspace.

## Connectivity probes

`testConnection` must access the network only through the injected
`IntegrationProbe`. Never use ambient `fetch`. The probe is the deployment's
SSRF boundary: the Node adapter validates and pins resolved addresses, blocks
redirects, caps response size and time, and rate-limits requests.

HTTP-native kinds use `fetch`. Protocols without an HTTP endpoint may use
`connect` for DNS, TCP, and optional TLS reachability only; it does not validate
application-protocol authentication.

When no probe is wired, every kind reports `supports_test: false`. This is the
case for the Cloudflare Worker example because Workers do not expose the DNS
hooks needed to pin validated addresses.

Probe results and errors must never include credentials or resolved plaintext
secret values.

## Data browsing

A kind can implement `BrowseCapability` when it has an HTTP metadata API. The
capability lists namespaces, tables, and schemas. It also creates a notebook
snippet. `MARIMOHUB_DATA_BROWSER` controls access to this capability.

Object stores implement the provider-neutral `ObjectBrowser` port separately from table
`BrowseCapability`. The S3 adapter lives in `packages/object-browser-s3`; only `packages/config`
imports it. Core owns source/context/result contracts, and API/web dispatch on the advertised
`tables` or `objects` surface instead of importing provider code.

Kinds can implement `previewRows` for bounded reads through the guarded HTTP
path. Otherwise, `IntegrationDefinition.preview` emits DuckDB SQL and/or Python
programs. `DataPreviewService` selects `DuckDBWasmDataPreview` first when its
required runtime features are healthy, then `SandboxDataPreview`. Neither
executor switches on integration kind.

The DuckDB SDK lives in `packages/duckdb-wasm-runtime`. Core owns only the runtime-neutral orchestration seam.
The Node implementation locks its configuration and runs each result query in a read-only transaction.

The unbrokered runtime disables external access. Its Node file callbacks reject all remote protocols.
The configured runtime advertises `iceberg-http` and uses a parent-owned HTTP broker.
The worker submits synchronous requests through fixed shared-memory buffers.
The parent authorizes each target, injects credentials, checks DNS results, and pins the socket.

The Iceberg integration supports a narrow configuration with explicit S3 read prefixes.
Unsupported authentication, storage, TLS, delegation, and runtime options use the sandbox executor.
See [the DuckDB-Wasm Iceberg HTTP broker](./duckdb_wasm_iceberg_broker.md) for the full boundary and test procedure.

The sandbox adapter renders only the selected integration. It uses the image
from `MARIMOHUB_DATA_PREVIEW_IMAGE` after a PyIceberg and PyArrow preflight. It
also injects applicable WIF credentials.

Per-user and process-wide limits control admission across both executors.
Deadlines bound startup and execution. A `finally` block destroys each sandbox;
DuckDB failures poison and close the affected engine slot before later traffic.

Run SQL has a separate, fail-closed `DataQueryService` contract and does not
reuse trusted preview programs. The Node composition root wires a fresh
DuckDB-Wasm worker per request only when `MARIMOHUB_DATA_BROWSER=full`. The
route remains in OpenAPI while the runtime is disabled and returns `404`.
Read-only execution, one-statement validation, row, byte, memory, concurrency,
and deadline limits apply; inline execution is forbidden.

All network access must use the injected browse probe. This probe has a separate
request budget and a larger response limit than the connection-test probe.

Browse errors must not include secrets. `defineIntegration` replaces transport
errors with a generic failure. It also replaces a `DomainError` that contains a
schema-marked secret value.

`browse.available(config)` checks whether the hub supports one stored instance.
For example, it can reject unsupported authentication methods or TLS material.
This function receives secret placeholders, so it must not inspect secret
values.

The kind descriptor uses `supports_browse` to report kind-level support. The
`GET …/browse` route reports support for one instance. All browse routes require
the editor role or a higher role.

The API resolves a browse ID in the project tier before the organization tier.
A project integration shadows an organization integration with the same name.
Browse operations do not write to the bucket.

S3 content routes are the raw-response exception to the JSON envelope on success. They authorize
and resolve the integration before opening a stream, accept at most one byte range, set no-store and
nosniff headers, sanitize `Content-Disposition`, and release the provider client on completion,
failure, deadline, or client cancellation. Pre-stream failures still use the standard envelope.

Metadata lists use a short state-token cache. Short-lived federated credentials are cached in memory
until their refresh window; details, search, previews, tags, versions, streams, provider clients, and
failures are not cached. Explicit preview/download reads append audit events; navigation does not.
Live S3 transport behavior is covered by
`objectBrowseContract` against pinned MinIO in the Object browser conformance workflow.

Servers differ in pagination and namespace addressing, so the `iceberg_rest`
client filters listings to direct children, stops on a non-advancing page
token, and honors a `namespace-separator` declared by `/v1/config`.

Every browsable kind must run the shared live suite: `browseContract`
(`@marimo-hub/core/testing/browse-contract`) pins the cross-kind guarantees —
roots without descendants, exact direct children under a parent, tables in
their namespace, schema round-trip — while the kind supplies config, probe,
and seeding. See `icebergRest.browse.live.test.ts` for the shape; suites gate
on a `MARIMOHUB_TEST_*` env var and skip otherwise. CI runs them on every PR:
the `Catalog conformance` workflow (mirroring storage-conformance) starts the
pinned servers — currently `apache/iceberg-rest-fixture` — and sets the env
vars. A new kind adds its server container and env var there.

## Secrets

Mark secret-bearing string fields with `zSecret()`. The framework derives their
paths from JSON Schema and transforms values through three shapes:

| Context   | Shape                                           |
| --------- | ----------------------------------------------- |
| Authoring | Plaintext string or the keep marker             |
| Stored    | `{ $secret: { kind: 'managed', envelope: … } }` |
| API read  | `{ $secret: { set: true } }`                    |

Encryption context combines the integration head path with the wildcard field
path. A secret in an array therefore remains decryptable after item reordering,
but an envelope copied to another integration or field does not.

Every array item that contains `zSecret()` must have a required, unique, and
stable `name` field. Keep-marker resolution uses this field to match an edited
item to its stored value. Without it, matching falls back to the array position.
Deleting or reordering items can then attach stored ciphertext to the wrong
item.

The `custom_env.secret_bundles` schema follows this rule. Its deletion and
reorder tests make sure that each retained ciphertext stays with its named
bundle. Add the same coverage for every new secret-bearing array.

Do not move a `zSecret()` field in a normal schema migration. Its envelope is
bound to the old path and must be decrypted and resealed under the new one.
Until a dedicated resealing migration exists, treat a secret-field rename as
unsupported.

## Schema evolution

Bump `schemaVersion` for incompatible config-shape changes and provide a
stepwise `migrate(stored, fromVersion)` implementation. Migrations receive the
stored shape, including secret envelopes, and must preserve those envelopes
unchanged.

Reads fail closed when:

- the stored schema version is newer than the running deployment;
- a migration step is missing;
- the migrated config no longer matches the current schema; or
- a secret envelope appears outside a registered secret path.

The store applies migrations before redaction, keep-marker resolution, testing,
and session rendering so every consumer sees the current shape.

## Tests

Add kind-specific coverage to
`packages/core/src/services/integrations/kinds/kinds.test.ts`. The shared tests
enforce:

- deterministic rendering;
- the supported schema dialect;
- collision-free static outputs;
- no ambient network access from probes; and
- registry descriptors that can be serialized for the web form.

Also test URL encoding, authentication headers, sensitive-field handling,
connectivity responses, and any kind-specific validation. Run the repository
done criteria before finishing:

```sh
pnpm check
pnpm test
pnpm build
```
