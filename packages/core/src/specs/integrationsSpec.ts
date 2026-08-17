import { defaultRegistry } from '../services/integrations/kinds';
import { INTEGRATION_STORED_SECRET_SCHEMAS } from '../services/integrations/registry';

/**
 * OpenAPI 3.1 description of every registered integration kind's config
 * schema, one literal path per kind: a removed kind diffs as a removed
 * endpoint (breaking), a new kind as additive. PUT models the input config the
 * API accepts; GET models what stored configs must still satisfy.
 * `x-secret-paths` tracks where secret envelopes live — they are
 * cryptographically bound to their field path, so moving one needs a
 * decrypt-and-reseal migration.
 */
export function buildIntegrationsSpec(): Record<string, unknown> {
	const registry = defaultRegistry();
	const descriptors = [...registry.describeAll()].sort((a, b) => a.kind.localeCompare(b.kind));

	const specPaths: Record<string, unknown> = {};
	const schemas: Record<string, unknown> = structuredClone(INTEGRATION_STORED_SECRET_SCHEMAS);

	for (const d of descriptors) {
		const { $schema: _, ...schema } = d.json_schema;
		const { $schema: _stored, ...storedSchema } = registry.storedJsonSchema(d.kind);
		schemas[d.kind] = schema;
		schemas[`${d.kind}_stored`] = storedSchema;
		const inputRef = { $ref: `#/components/schemas/${d.kind}` };
		const storedRef = { $ref: `#/components/schemas/${d.kind}_stored` };
		const def = registry.get(d.kind);
		const envConflicts = def.environmentVariables
			? registry
					.list()
					.filter(
						(other) =>
							other.kind !== def.kind &&
							other.environmentVariables?.some((name) => def.environmentVariables?.includes(name)),
					)
					.map(({ kind }) => kind)
					.sort()
			: [];
		specPaths[`/kinds/${d.kind}/config`] = {
			summary: d.title,
			description: d.description,
			'x-kind-schema-version': d.schema_version,
			...(def.migrations && { 'x-migrations': def.migrations }),
			'x-category': d.category,
			'x-brand-color': d.brand.color,
			...(d.brand.icon !== undefined && { 'x-brand-icon': d.brand.icon }),
			'x-secret-paths': registry.secretPathsOf(d.kind).map((p) => p.join('.')),
			'x-supports-test': d.supports_test,
			'x-requirements': d.requirements,
			...(def.environmentVariables && { 'x-env': def.environmentVariables }),
			...(envConflicts.length > 0 && { 'x-env-conflicts-with': envConflicts }),
			get: {
				operationId: `read_${d.kind}_config`,
				summary: `Stored ${d.kind} config`,
				responses: {
					'200': {
						description: 'A stored config every reader and migration must accept.',
						content: { 'application/json': { schema: storedRef } },
					},
				},
			},
			put: {
				operationId: `write_${d.kind}_config`,
				summary: `Input ${d.kind} config`,
				requestBody: {
					required: true,
					content: { 'application/json': { schema: inputRef } },
				},
				responses: { '204': { description: 'Accepted.' } },
			},
		};
	}

	const icebergKinds = [
		'iceberg_bigquery',
		'iceberg_dynamodb',
		'iceberg_glue',
		'iceberg_hive',
		'iceberg_rest',
		'iceberg_sql',
	];
	const sharedStorageKinds = icebergKinds.filter((kind) => kind !== 'iceberg_rest');
	hoistSharedProperty(schemas, sharedStorageKinds, 'storage', 'IcebergStorage');
	hoistSharedProperty(schemas, ['iceberg_rest'], 'storage', 'IcebergRestStorage');
	hoistSharedProperty(schemas, icebergKinds, 'runtime', 'IcebergRuntime');
	hoistSharedProperty(schemas, icebergKinds, 'extra_properties', 'IcebergExtraProperties');
	hoistSharedProperty(
		schemas,
		sharedStorageKinds.map((kind) => `${kind}_stored`),
		'storage',
		'IcebergStorageStored',
	);
	hoistSharedProperty(schemas, ['iceberg_rest_stored'], 'storage', 'IcebergRestStorageStored');
	hoistSharedProperty(
		schemas,
		icebergKinds.map((kind) => `${kind}_stored`),
		'runtime',
		'IcebergRuntimeStored',
	);
	hoistSharedProperty(
		schemas,
		icebergKinds.map((kind) => `${kind}_stored`),
		'extra_properties',
		'IcebergExtraPropertiesStored',
	);

	return {
		openapi: '3.1.0',
		info: {
			title: 'marimohub integration kinds',
			version: '1.0.0',
			description: [
				'Machine-checkable description of every integration kind registered in',
				'`defaultRegistry()` (`packages/core/src/services/integrations/kinds/`),',
				'generated from each kind’s zod config schema. Each kind has an authoring',
				'schema (defaulted fields optional, plaintext secrets write-only) and a',
				'stored schema (defaults materialized, secrets sealed). This is not an HTTP',
				'API: each path represents the config contract persisted in',
				'`versions/{n}.json` records and rendered into sandboxes.',
			].join('\n'),
		},
		paths: specPaths,
		components: { schemas },
	};
}

function hoistSharedProperty(
	schemas: Record<string, unknown>,
	owners: string[],
	property: string,
	component: string,
): void {
	let shared: unknown;
	for (const owner of owners) {
		const schema = schemas[owner] as { properties?: Record<string, unknown> } | undefined;
		const value = schema?.properties?.[property];
		if (value === undefined) throw new Error(`${owner} has no ${property} schema`);
		if (shared === undefined) shared = value;
		else if (JSON.stringify(value) !== JSON.stringify(shared)) {
			throw new Error(`${owner}.${property} drifted from the shared Iceberg schema`);
		}
	}
	schemas[component] = shared;
	for (const owner of owners) {
		const schema = schemas[owner] as { properties: Record<string, unknown> };
		schema.properties[property] = { $ref: `#/components/schemas/${component}` };
	}
}
