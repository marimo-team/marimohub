import { defaultRegistry } from '../services/integrations/kinds';

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
	const schemas: Record<string, unknown> = {};

	for (const d of descriptors) {
		const { $schema: _, ...schema } = d.json_schema;
		schemas[d.kind] = schema;
		const ref = { $ref: `#/components/schemas/${d.kind}` };
		specPaths[`/kinds/${d.kind}/config`] = {
			summary: d.title,
			description: d.description,
			'x-kind-schema-version': d.schema_version,
			'x-category': d.category,
			'x-brand-color': d.brand.color,
			...(d.brand.icon !== undefined && { 'x-brand-icon': d.brand.icon }),
			'x-secret-paths': registry.secretPathsOf(d.kind).map((p) => p.join('.')),
			'x-supports-test': d.supports_test,
			'x-requirements': d.requirements,
			get: {
				operationId: `read_${d.kind}_config`,
				summary: `Stored ${d.kind} config`,
				responses: {
					'200': {
						description: 'A stored config every reader and migration must accept.',
						content: { 'application/json': { schema: ref } },
					},
				},
			},
			put: {
				operationId: `write_${d.kind}_config`,
				summary: `Input ${d.kind} config`,
				requestBody: {
					required: true,
					content: { 'application/json': { schema: ref } },
				},
				responses: { '204': { description: 'Accepted.' } },
			},
		};
	}

	return {
		openapi: '3.1.0',
		info: {
			title: 'marimohub integration kinds',
			version: '1.0.0',
			description: [
				'Machine-checkable description of every integration kind registered in',
				'`defaultRegistry()` (`packages/core/src/services/integrations/kinds/`),',
				'generated from each kind’s zod config schema (input io, so defaulted',
				'fields stay optional). This is not an HTTP API: each path stands for a',
				'kind, and its component schema is the config contract stored in',
				'`versions/{n}.json` records and rendered into sandboxes.',
			].join('\n'),
		},
		paths: specPaths,
		components: { schemas },
	};
}
