import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { buildBucketSpec } from './bucketSpec';
import { buildIntegrationsSpec } from './integrationsSpec';

/**
 * Generator and drift guard for the committed specs under `internal/schemas/`
 * (same pattern as the API's openapi.spec.test.ts): UPDATE_SCHEMAS rewrites
 * the files, otherwise the build fails when they no longer match the zod
 * schemas they are rendered from.
 *
 * Regenerate with:  pnpm schemas:generate
 */
const SPECS = [
	{ file: 'bucket.yml', doc: buildBucketSpec() },
	{ file: 'integrations.yml', doc: buildIntegrationsSpec() },
];

const specPath = (file: string) =>
	fileURLToPath(new URL(`../../../../internal/schemas/${file}`, import.meta.url));

if (process.env.UPDATE_SCHEMAS) {
	for (const { file, doc } of SPECS) {
		mkdirSync(dirname(specPath(file)), { recursive: true });
		// The docs reuse `$ref` objects, which would otherwise serialize as YAML
		// aliases (`*a1`) — valid, but mishandled by some OpenAPI tooling.
		writeFileSync(specPath(file), stringify(doc, { aliasDuplicateObjects: false }));
	}
}

describe.each(SPECS)('internal/schemas/$file', ({ file, doc }) => {
	it('is in sync with the zod schemas (run `pnpm schemas:generate` to update)', () => {
		const committed = parse(readFileSync(specPath(file), 'utf8'));
		expect(committed).toEqual(doc);
	});

	// zod emits `#/$defs/…` refs for cyclic schemas; inside an OpenAPI component
	// such a ref resolves against the document root and dangles. None of our
	// schemas are cyclic today — if one becomes so, hoist its defs instead.
	it('is self-contained (no document-root $defs refs)', () => {
		expect(JSON.stringify(doc)).not.toContain('#/$defs');
	});
});

describe('bucket schema contracts', () => {
	const doc = buildBucketSpec() as {
		components: { schemas: Record<string, Record<string, unknown>> };
	};

	it('keeps the token schema concrete and publishes grant uniqueness', () => {
		const token = doc.components.schemas.Token as {
			type: string;
			properties: {
				credential_version: { const: number };
				grant: {
					properties: Record<string, { anyOf: Record<string, unknown>[] }>;
				};
				oauth: {
					properties: {
						resource: { format: string };
						scopes: { minItems: number };
					};
				};
			};
			dependentRequired: Record<string, string[]>;
		};
		expect(token.type).toBe('object');
		expect(token.properties.credential_version.const).toBe(2);
		expect(token.dependentRequired).toEqual({
			credential_version: ['grant'],
			grant: ['credential_version'],
			oauth: ['credential_version', 'grant'],
		});
		expect(token.properties.oauth.properties.resource.format).toBe('uri');
		expect(token.properties.oauth.properties.scopes.minItems).toBe(1);

		for (const boundary of ['actions', 'projects']) {
			const array = token.properties.grant.properties[boundary].anyOf.find(
				(branch) => branch.type === 'array',
			);
			expect(array?.uniqueItems).toBe(true);
		}
	});
});

describe('bucket job contracts', () => {
	const doc = buildBucketSpec() as {
		paths: Record<string, Record<string, unknown>>;
		components: {
			schemas: Record<
				string,
				{
					properties: Record<
						string,
						{
							maxProperties?: number;
							properties?: Record<string, { uniqueItems?: boolean }>;
						}
					>;
				}
			>;
		};
	};

	it('publishes job parameter and notification limits', () => {
		for (const schema of [doc.components.schemas.JobDefinition, doc.components.schemas.JobRun]) {
			expect(schema.properties.parameters.maxProperties).toBe(32);
		}
		expect(
			doc.components.schemas.JobDefinition.properties.notifications.properties?.on.uniqueItems,
		).toBe(true);
	});

	it('documents load-bearing job indexes without exposing an unused session artifact', () => {
		expect(
			doc.paths['/projects/{pid}/notebooks/{nid}/job-index/{created_at}_{job_id}.json'],
		).toMatchObject({
			'x-mutability': 'immutable',
			'x-owner': 'JobsService',
		});
		expect(
			doc.paths['/projects/{pid}/notebooks/{nid}/jobs/{job_id}/run-index/{reverse_ulid}.json'],
		).toMatchObject({ 'x-mutability': 'immutable', 'x-owner': 'JobRunService' });
		expect(
			doc.paths['/projects/{pid}/notebooks/{nid}/jobs/{job_id}/runs/{run_id}/session.json'],
		).toBeUndefined();
	});
});

describe('integration schema contracts', () => {
	const doc = buildIntegrationsSpec() as {
		paths: Record<string, Record<string, unknown>>;
		components: { schemas: Record<string, Record<string, unknown>> };
	};

	it('separates strict authoring schemas from materialized stored schemas', () => {
		const glue = doc.components.schemas.iceberg_glue;
		const stored = doc.components.schemas.iceberg_glue_stored;
		expect(glue.additionalProperties).toBe(false);
		expect(stored.additionalProperties).toBe(false);
		expect((glue.required as string[] | undefined) ?? []).not.toContain('skip_archive');
		expect(stored.required as string[]).toContain('skip_archive');
		expect(
			(
				doc.paths['/kinds/iceberg_glue/config'].get as {
					responses: { '200': { content: { 'application/json': { schema: { $ref: string } } } } };
				}
			).responses['200'].content['application/json'].schema.$ref,
		).toBe('#/components/schemas/iceberg_glue_stored');
	});

	it('models sealed secrets once and references them from stored configs', () => {
		const serialized = JSON.stringify(doc.components.schemas);
		expect(doc.components.schemas.ManagedStoredSecret).toBeDefined();
		expect(doc.components.schemas.ReferenceStoredSecret).toBeDefined();
		expect(serialized).toContain('#/components/schemas/ManagedStoredSecret');
		expect(serialized).toContain('#/components/schemas/ReferenceStoredSecret');
	});

	it('resolves every local component reference', () => {
		const serialized = JSON.stringify(doc);
		const refs = [...serialized.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map(
			([, name]) => name,
		);
		for (const name of refs) expect(doc.components.schemas[name]).toBeDefined();
	});

	it('hoists shared Iceberg schema branches into named components', () => {
		for (const kind of [
			'iceberg_bigquery',
			'iceberg_dynamodb',
			'iceberg_glue',
			'iceberg_hive',
			'iceberg_sql',
		]) {
			const properties = doc.components.schemas[kind].properties as Record<
				string,
				{ $ref?: string }
			>;
			expect(properties.storage.$ref).toBe('#/components/schemas/IcebergStorage');
			expect(properties.runtime.$ref).toBe('#/components/schemas/IcebergRuntime');
			expect(properties.extra_properties.$ref).toBe('#/components/schemas/IcebergExtraProperties');
		}
		const restProperties = doc.components.schemas.iceberg_rest.properties as Record<
			string,
			{ $ref?: string }
		>;
		expect(restProperties.storage.$ref).toBe('#/components/schemas/IcebergRestStorage');
		expect(restProperties.runtime.$ref).toBe('#/components/schemas/IcebergRuntime');
		expect(restProperties.extra_properties.$ref).toBe(
			'#/components/schemas/IcebergExtraProperties',
		);
	});

	it('publishes environment conflicts and migration descriptions', () => {
		const gcs = doc.paths['/kinds/gcs/config'];
		expect(gcs['x-env']).toEqual(['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT']);
		expect(gcs['x-env-conflicts-with']).toEqual(['bigquery']);
		expect(doc.paths['/kinds/postgres/config']['x-migrations']).toEqual([
			{
				from: 1,
				to: 2,
				description: 'Replace the boolean ssl flag with an explicit libpq sslmode object.',
			},
		]);
	});

	it('declares every cross-kind environment conflict in both directions', () => {
		const claims = Object.entries(doc.paths).map(([path, item]) => ({
			kind: path.split('/')[2],
			env: (item['x-env'] as string[] | undefined) ?? [],
			conflicts: (item['x-env-conflicts-with'] as string[] | undefined) ?? [],
		}));
		for (const left of claims) {
			for (const right of claims) {
				if (left.kind === right.kind || !left.env.some((name) => right.env.includes(name)))
					continue;
				expect(left.conflicts, `${left.kind} → ${right.kind}`).toContain(right.kind);
			}
		}
	});
});
