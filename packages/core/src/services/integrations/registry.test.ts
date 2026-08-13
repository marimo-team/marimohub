import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IntegrationRegistry } from './registry';
import { defineIntegration } from './sdk';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('IntegrationRegistry', () => {
	it('describes table, object, combined, and non-browsable surfaces', () => {
		const registry = new IntegrationRegistry();
		const base = {
			title: 'Test',
			description: 'test',
			category: 'other' as const,
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({}),
			render: () => ({}),
		};
		const browse = {
			available: () => ({ ok: true as const }),
			listNamespaces: async () => ({ items: [], next_cursor: null }),
			listTables: async () => ({ items: [], next_cursor: null }),
			getTableSchema: async () => ({ columns: [] }),
			snippet: () => '',
		};
		const objectBrowse = {
			provider: 's3' as const,
			source: () => ({
				provider: 's3' as const,
				path_style: false,
				auth: { method: 'ambient' as const },
			}),
			snippet: () => '',
		};
		registry.register({ ...base, kind: 'none' });
		registry.register({ ...base, kind: 'tables', browse });
		registry.register({ ...base, kind: 'objects', objectBrowse });
		registry.register({ ...base, kind: 'both', browse, objectBrowse });

		expect(registry.describe('none')).toMatchObject({
			supports_browse: false,
			browse_surfaces: [],
		});
		expect(registry.describe('tables')).toMatchObject({
			supports_browse: true,
			browse_surfaces: ['tables'],
		});
		expect(registry.describe('objects')).toMatchObject({
			supports_test: true,
			supports_browse: true,
			browse_surfaces: ['objects'],
		});
		expect(registry.describe('both')).toMatchObject({
			supports_browse: true,
			browse_surfaces: ['tables', 'objects'],
		});
	});

	it('rejects a generated object source whose provider differs from its definition', () => {
		const registry = new IntegrationRegistry();
		registry.register(
			defineIntegration({
				kind: 'mismatch',
				title: 'Mismatch',
				description: 'test',
				category: 'other',
				brand: { color: '#000000' },
				schemaVersion: 1,
				configSchema: z.object({}),
				render: () => ({}),
				objectBrowse: {
					provider: 's3',
					source: () =>
						({
							provider: 'gcs',
							auth: { method: 'ambient' },
						}) as never,
					snippet: () => '',
				},
			}),
		);
		expect(() => registry.get('mismatch').objectBrowse?.source({})).toThrow(/does not match/);
	});

	it('disables an unrepresentable kind schema and logs without exception text', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const registry = new IntegrationRegistry();
		registry.register({
			kind: 'bad_schema',
			title: 'Bad schema',
			description: 'test',
			category: 'other',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ unsupported: z.date() }),
			render: () => ({}),
		});

		expect(registry.list()).toEqual([]);
		expect(log).toHaveBeenCalledOnce();
		const line = log.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toMatchObject({
			level: 'error',
			event: 'integration_kind_disabled',
			integration_kind: 'bad_schema',
		});
		expect(line).not.toContain('Date cannot be represented');
	});
});
