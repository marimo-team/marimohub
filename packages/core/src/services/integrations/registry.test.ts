import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IntegrationRegistry } from './registry';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('IntegrationRegistry', () => {
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
