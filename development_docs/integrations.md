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

`testConnection` may access the network only through the injected
`IntegrationProbe`. Never use ambient `fetch`. The probe is the deployment's
SSRF boundary: the Node adapter validates and pins resolved addresses, blocks
redirects, caps response size and time, and rate-limits requests.

When no probe is wired, every kind reports `supports_test: false`. This is the
case for the Cloudflare Worker example because Workers do not expose the DNS
hooks needed to pin validated addresses.

Probe results and errors must never include credentials or resolved plaintext
secret values.

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

The current `custom_env.secret_bundles` schema is a known exception. Until it
has stable row identity, clients must replace every retained inline bundle
value after a delete or reorder. Add deletion and reorder coverage for every
new secret-bearing array.

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
