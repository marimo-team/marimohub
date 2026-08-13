import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { generateOpenApiDocument } from './createApi';

/**
 * The committed, human-readable OpenAPI 3.1 spec. It is the single source of
 * truth for `@marimo-hub/client`'s type codegen, and this test fails the build if
 * it drifts from the live route definitions.
 *
 * Regenerate it with:  pnpm --filter @marimo-hub/api openapi:generate
 */
const SPEC_PATH = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

const doc = generateOpenApiDocument();

interface SchemaNode {
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	oneOf?: SchemaNode[];
	enum?: unknown[];
	description?: string;
}

function property(schema: SchemaNode, name: string): SchemaNode {
	const value = schema.properties?.[name];
	if (!value) throw new Error(`OpenAPI property ${name} is missing`);
	return value;
}

function arrayItems(schema: SchemaNode): SchemaNode {
	if (!schema.items) throw new Error('OpenAPI array items schema is missing');
	return schema.items;
}

// The `openapi:generate` script sets UPDATE_OPENAPI to rewrite the committed
// spec from `generateOpenApiDocument()` rather than asserting against it.
if (process.env.UPDATE_OPENAPI) {
	writeFileSync(SPEC_PATH, stringify(doc));
}

describe('OpenAPI spec', () => {
	it('openapi.yaml is in sync with the live API (run `pnpm --filter @marimo-hub/api openapi:generate` to update)', () => {
		const committed = parse(readFileSync(SPEC_PATH, 'utf8'));
		expect(committed).toEqual(doc);
	});

	it('constrains integration identifiers, timestamps, and version numbers', () => {
		const schemas = (
			doc as {
				components: {
					schemas: Record<string, { properties: Record<string, Record<string, unknown>> }>;
				};
			}
		).components.schemas;
		const entry = schemas.IntegrationEntry.properties;
		const version = schemas.IntegrationVersion.properties;

		expect(entry.id.pattern).toBe('^intg-[0-9a-z]{16}$');
		expect(entry.created_at.format).toBe('date-time');
		expect(entry.updated_at.format).toBe('date-time');
		expect(entry.current_version).toMatchObject({ type: 'integer', exclusiveMinimum: 0 });
		expect(version.version).toMatchObject({ type: 'integer', exclusiveMinimum: 0 });
		expect(version.kind_schema_version).toMatchObject({
			type: 'integer',
			exclusiveMinimum: 0,
		});
		expect(version.created_at.format).toBe('date-time');
	});

	it('publishes integration scope and a discriminated test request', () => {
		const typed = doc as {
			tags: { name: string }[];
			components: {
				schemas: Record<
					string,
					{
						properties: Record<string, Record<string, unknown>>;
						required: string[];
						oneOf: Record<string, unknown>[];
					}
				>;
			};
		};
		expect(typed.tags).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'Integrations' })]),
		);
		const entry = typed.components.schemas.IntegrationEntry;
		expect(entry.properties.name.pattern).toBe('^[a-z][a-z0-9-]{0,31}$');
		expect(entry.properties.scope.enum).toEqual(['project', 'org']);
		expect(entry.required).toEqual(expect.arrayContaining(['id', 'scope']));
		const request = typed.components.schemas.IntegrationTestRequest;
		expect(request.oneOf[0]).toMatchObject({
			required: ['source', 'kind', 'config'],
			additionalProperties: false,
		});
		expect(request.oneOf[1]).toMatchObject({
			required: ['source', 'id'],
			additionalProperties: false,
		});
	});

	it('publishes typed response vocabularies with an unknown fallback', () => {
		const schemas = (doc as { components: { schemas: Record<string, SchemaNode> } }).components
			.schemas;
		const capability = schemas.IntegrationBrowseCapability;
		const objects = property(property(capability, 'surfaces'), 'objects');
		const alerts = property(schemas.Capabilities, 'project_alerts');
		const previewFormats = (schemas.IntegrationObjectPreview.oneOf ?? [])
			.map((branch) => branch.properties?.format)
			.filter((format): format is SchemaNode => format !== undefined);
		const destinationKinds = (schemas.ProjectAlertDestination.oneOf ?? []).map((branch) =>
			arrayItems(property(branch, 'kinds')),
		);
		const alertKinds = [
			'member.invited',
			'member.added',
			'member.role_changed',
			'member.removed',
			'session.takeover',
			'notebook.deleted',
			'project.deleted',
			'app.start_failed',
			'app.unavailable',
			'sync.failed',
			'unknown',
		];
		const typedEnums: [SchemaNode, string[]][] = [
			[
				arrayItems(property(schemas.IntegrationKind, 'browse_surfaces')),
				['tables', 'objects', 'unknown'],
			],
			[property(objects, 'provider'), ['s3', 'gcs', 'azure_blob', 'unknown']],
			[property(objects, 'root_kind'), ['bucket', 'container', 'unknown']],
			[property(objects, 'uri_scheme'), ['s3', 'gs', 'az', 'unknown']],
			[property(objects, 'search'), ['none', 'bounded-key-name', 'unknown']],
			[arrayItems(property(alerts, 'destination_types')), ['slack', 'webhook', 'unknown']],
			[arrayItems(property(alerts, 'selectable_kinds')), alertKinds],
			[previewFormats[0], ['table', 'csv', 'tsv', 'json', 'jsonl', 'parquet', 'unknown']],
			[previewFormats[1], ['text', 'markdown', 'code', 'log', 'json', 'unknown']],
			[previewFormats[2], ['png', 'jpeg', 'gif', 'webp', 'unknown']],
			...destinationKinds.map((schema): [SchemaNode, string[]] => [schema, alertKinds]),
		];

		for (const [schema, values] of typedEnums) {
			expect(schema.enum).toEqual(values);
			expect(schema.description).toContain('Unrecognized values normalize to unknown.');
		}
		expect(Object.keys(capability.properties ?? {})).toEqual(['surfaces']);
		expect(Object.keys(schemas.ProjectAlertDestinationPage.properties ?? {})).toEqual([
			'items',
			'next_cursor',
		]);
	});
});
