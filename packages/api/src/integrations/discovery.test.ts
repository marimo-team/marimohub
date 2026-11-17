import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, ResourceExhaustedError, ValidationError } from '@marimo-hub/core';
import { setupDiscovery } from '../testing/integrationDiscovery';
import { mcpPrincipal, mcpRequest } from '../testing/mcp';
import * as browse from './browse';
import { profileIntegrationTable, searchIntegrationTables } from './discovery';
import { DATA_MAX_BYTES, dataBytes } from './bounds';

async function context() {
	const { deps, project, catalog } = await setupDiscovery();
	return { deps, pid: project.id, iid: catalog.id, user: mcpPrincipal, request: mcpRequest };
}
const search = { q: 'order', namespace: ['sales'], limit: 20 };
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('bounded table discovery failures', () => {
	it('continues through empty pages and deduplicates repeated table names', async () => {
		const target = await context();
		const list = vi
			.spyOn(browse, 'listIntegrationTables')
			.mockResolvedValueOnce({ items: [], next_cursor: 'second' })
			.mockResolvedValueOnce({ items: ['orders', 'orders'], next_cursor: null });
		const result = await searchIntegrationTables(target, search);
		expect(result.items).toEqual([
			{ integration_id: target.iid, namespace: ['sales'], table: 'orders' },
		]);
		expect(result.coverage.complete).toBe(true);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it('reports item and UTF-8 byte caps without claiming complete coverage', async () => {
		const target = await context();
		const list = vi
			.spyOn(browse, 'listIntegrationTables')
			.mockResolvedValue({ items: ['orders', 'order_items'], next_cursor: null });
		expect(await searchIntegrationTables(target, { ...search, limit: 1 })).toMatchObject({
			items: [{ table: 'orders' }],
			coverage: { complete: false, reason: 'limit' },
		});
		list.mockResolvedValue({ items: ['orders', `order_${'界'.repeat(6000)}`], next_cursor: null });
		const result = await searchIntegrationTables(target, search);
		expect(result).toMatchObject({
			items: [{ table: 'orders' }],
			coverage: { complete: false, reason: 'bytes' },
		});
		expect(dataBytes(result)).toBeLessThanOrEqual(DATA_MAX_BYTES);
	});

	it('stops at the browse-call budget even when pages contain no matches', async () => {
		const target = await context();
		let page = 0;
		const list = vi
			.spyOn(browse, 'listIntegrationTables')
			.mockImplementation(async () => ({ items: [], next_cursor: String(++page) }));
		expect(await searchIntegrationTables(target, search)).toMatchObject({
			items: [],
			browse_calls: 32,
			coverage: { complete: false, reason: 'budget' },
		});
		expect(list).toHaveBeenCalledTimes(32);
	});

	it('retains partial results on rate limiting but propagates authorization and invalid-cursor errors', async () => {
		const target = await context();
		const list = vi
			.spyOn(browse, 'listIntegrationTables')
			.mockResolvedValueOnce({ items: ['orders'], next_cursor: 'next' })
			.mockRejectedValue(new ResourceExhaustedError('Rate limited'));
		expect(await searchIntegrationTables(target, search)).toMatchObject({
			items: [{ table: 'orders' }],
			coverage: { complete: false, reason: 'budget' },
		});
		for (const error of [new ForbiddenError('Denied'), new ValidationError('Invalid cursor')]) {
			list.mockRejectedValue(error);
			await expect(searchIntegrationTables(target, search)).rejects.toBe(error);
		}
	});

	it('times out uncooperative metadata calls and ignores their late result', async () => {
		const target = await context();
		vi.useFakeTimers();
		let resolve!: (page: { items: string[]; next_cursor: null }) => void;
		const list = vi.spyOn(browse, 'listIntegrationTables').mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const pending = searchIntegrationTables(target, search);
		await vi.advanceTimersByTimeAsync(6500);
		const result = await pending;
		expect(result).toMatchObject({ items: [], coverage: { complete: false, reason: 'timeout' } });
		resolve({ items: ['orders'], next_cursor: null });
		await vi.advanceTimersByTimeAsync(0);
		expect(result.items).toEqual([]);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it('rejects cancellation rather than returning a successful partial search', async () => {
		const target = await context();
		const controller = new AbortController();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.spyOn(browse, 'listIntegrationTables').mockImplementation(() => {
			started();
			return new Promise(() => {});
		});
		const pending = searchIntegrationTables({ ...target, signal: controller.signal }, search);
		const rejected = expect(pending).rejects.toThrow('Stopped');
		await ready;
		controller.abort(new Error('Stopped'));
		await rejected;
	});

	it('handles empty and mixed-type profile samples without exposing values', async () => {
		const target = await context();
		const preview = vi
			.spyOn(browse, 'previewIntegrationTable')
			.mockResolvedValue({ columns: ['value'], rows: [] });
		const input = { namespace: ['sales'], table: 'orders', sample_rows: 20 };
		expect(await profileIntegrationTable(target, input)).toMatchObject({
			rows_sampled: 0,
			columns: [{ null_count: 0, distinct_count: 0 }],
		});
		preview.mockResolvedValue({
			columns: ['value'],
			rows: [[null], [], [1], ['1'], [true], [{ secret: 'private' }]],
		});
		const result = await profileIntegrationTable(target, input);
		expect(result.columns).toEqual([
			{ name: 'value', null_count: 2, non_null_count: 4, distinct_count: 3, unsupported_count: 1 },
		]);
		expect(JSON.stringify(result)).not.toContain('private');
	});
});
