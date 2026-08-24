import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateCliManifest } from './cliManifest';
import { generateOpenApiDocument } from './createApi';

const manifestPath = fileURLToPath(
	new URL('../../../apps/cli/generated/cli-manifest.json', import.meta.url),
);

describe('CLI manifest', () => {
	it('matches the API contract', async () => {
		const manifest = generateCliManifest(generateOpenApiDocument());
		if (process.env.UPDATE_CLI_MANIFEST === '1') {
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
			return;
		}
		expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
	});

	it('has a unique command for every documented operation', () => {
		const manifest = generateCliManifest(generateOpenApiDocument());
		expect(new Set(manifest.operations.map((operation) => operation.id)).size).toBe(
			manifest.operations.length,
		);
		expect(new Set(manifest.operations.map((operation) => operation.command.join('\0'))).size).toBe(
			manifest.operations.length,
		);
	});

	it('lets operation parameters override matching path parameters', () => {
		const manifest = generateCliManifest({
			openapi: '3.1.0',
			info: { title: 'Test', version: '1.0.0' },
			paths: {
				'/items/{id}': {
					parameters: [
						{
							name: 'id',
							in: 'path',
							required: true,
							description: 'Path-level description',
							schema: { type: 'string' },
						},
						{ name: 'id', in: 'query', schema: { type: 'string' } },
					],
					get: {
						operationId: 'items.get',
						parameters: [
							{
								name: 'id',
								in: 'path',
								required: true,
								description: 'Operation-level description',
								schema: { type: 'integer' },
							},
						],
						responses: {
							200: {
								description: 'Item',
								content: { 'application/json': { schema: { type: 'object' } } },
							},
						},
					},
				},
			},
		});

		expect(manifest.operations[0]?.parameters).toEqual([
			{
				name: 'id',
				cli_name: 'id',
				in: 'path',
				required: true,
				description: 'Operation-level description',
				value_type: 'integer',
				repeatable: false,
			},
			{
				name: 'id',
				cli_name: 'id',
				in: 'query',
				required: false,
				value_type: 'string',
				repeatable: false,
			},
		]);
	});

	it('classifies disruptive non-DELETE operations explicitly', () => {
		const operations = new Map(
			generateCliManifest(generateOpenApiDocument()).operations.map((operation) => [
				operation.id,
				operation,
			]),
		);

		expect(operations.get('notebooks.rotate-sync-token')?.destructive).toBe(true);
		expect(operations.get('notebooks.versions.restore')?.destructive).toBe(true);
		expect(operations.get('sessions.editor.takeover')?.destructive).toBe(true);
		expect(operations.get('projects.delete')?.destructive).toBe(true);
		expect(operations.get('projects.create')?.destructive).toBe(false);
		expect(operations.get('projects.update')?.destructive).toBe(false);
	});

	it('resolves the annotated role reference for member updates as a string', () => {
		const operation = generateCliManifest(generateOpenApiDocument()).operations.find(
			(operation) => operation.id === 'projects.members.update',
		);

		expect(operation?.body?.properties).toContainEqual({
			name: 'role',
			cli_name: 'role',
			required: true,
			value_type: 'string',
			repeatable: false,
		});
	});

	it('rejects circular OpenAPI references', () => {
		expect(() =>
			generateCliManifest({
				openapi: '3.1.0',
				info: { title: 'Test', version: '1.0.0' },
				components: {
					schemas: {
						First: { $ref: '#/components/schemas/Second' },
						Second: { $ref: '#/components/schemas/First' },
					},
				},
				paths: {
					'/items': {
						get: {
							operationId: 'items.list',
							parameters: [
								{
									name: 'cursor',
									in: 'query',
									schema: { $ref: '#/components/schemas/First' },
								},
							],
							responses: { 204: { description: 'Items' } },
						},
					},
				},
			}),
		).toThrow('Circular OpenAPI reference: #/components/schemas/First');
	});

	it('reads disruptive behavior from OpenAPI operation metadata', () => {
		const manifest = generateCliManifest({
			openapi: '3.1.0',
			info: { title: 'Test', version: '1.0.0' },
			paths: {
				'/items/rotate': {
					post: {
						operationId: 'items.rotate',
						'x-cli-destructive': true,
						responses: { 204: { description: 'Rotated' } },
					},
				},
			},
		});

		expect(manifest.operations[0]?.destructive).toBe(true);
	});
});
