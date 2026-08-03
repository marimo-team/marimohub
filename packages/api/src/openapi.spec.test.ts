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
});
