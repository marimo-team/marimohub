import { afterEach, expect, it, vi } from 'vitest';
import { createTestQueryClient, jsonError, jsonOk } from '@/test/render';
import { firstProjectQueryOptions, projectRosterQueryOptions } from './routePrefetch';
import { projectKeys } from './queryKeys';
import type { ProjectSummary } from '@/types';

function project(id: string, name = id): ProjectSummary {
	return {
		id,
		name,
		description: '',
		owner: 'u',
		status: 'active',
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		notebook_count: 0,
		tags: [],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('invalidates the landing project with project-list mutations without colliding with the roster', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(jsonOk({ items: [{ id: 'old' }], next_cursor: null }))
		.mockResolvedValueOnce(jsonOk({ items: [{ id: 'new' }], next_cursor: null }));
	vi.stubGlobal('fetch', fetch);
	const client = createTestQueryClient();
	const first = firstProjectQueryOptions();
	const roster = projectRosterQueryOptions();
	client.setQueryData(roster.queryKey, [project('roster')]);
	expect(await client.fetchQuery(first)).toMatchObject({ id: 'old' });
	expect(await client.fetchQuery(first)).toMatchObject({ id: 'old' });
	expect(client.getQueryData(roster.queryKey)).toEqual([project('roster')]);
	await client.invalidateQueries({ queryKey: projectKeys.list() });
	expect(await client.fetchQuery(first)).toMatchObject({ id: 'new' });
	expect(fetch).toHaveBeenCalledTimes(2);
});

it('reuses the complete sidebar roster for five minutes and honors invalidation', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const fetch = vi.fn(async (input: RequestInfo | URL) =>
		jsonOk(
			String(input).includes('cursor=next')
				? { items: [{ id: 'p2', name: 'Second' }], next_cursor: null }
				: { items: [{ id: 'p1', name: 'First' }], next_cursor: 'next' },
		),
	);
	vi.stubGlobal('fetch', fetch);
	const client = createTestQueryClient();
	const options = projectRosterQueryOptions();
	expect(await client.fetchQuery(options)).toHaveLength(2);
	vi.setSystemTime(Date.now() + 120_000);
	expect(await client.fetchQuery(options)).toHaveLength(2);
	expect(fetch).toHaveBeenCalledTimes(2);
	await client.invalidateQueries({ queryKey: projectKeys.all });
	await client.fetchQuery(options);
	expect(fetch).toHaveBeenCalledTimes(4);
	vi.setSystemTime(Date.now() + 300_001);
	await client.fetchQuery(options);
	expect(fetch).toHaveBeenCalledTimes(6);
});

it('rejects a repeated roster cursor instead of caching a partial roster', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonOk({ items: [], next_cursor: 'repeated' })),
	);
	await expect(createTestQueryClient().fetchQuery(projectRosterQueryOptions())).rejects.toThrow(
		'Project listing did not advance',
	);
});

it('keeps the complete cached roster when a later page fails and retries from the beginning', async () => {
	const client = createTestQueryClient();
	const options = projectRosterQueryOptions();
	const previous = [project('old', 'Previous project')];
	client.setQueryData(options.queryKey, previous);
	await client.invalidateQueries({ queryKey: options.queryKey });
	let unavailable = true;
	const requested: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			requested.push(String(input));
			if (String(input).includes('cursor=next'))
				return unavailable
					? jsonError('INTERNAL_ERROR', 'Temporarily unavailable', 503)
					: jsonOk({ items: [{ id: 'p2', name: 'Second' }], next_cursor: null });
			return jsonOk({ items: [{ id: 'p1', name: 'First' }], next_cursor: 'next' });
		}),
	);
	await expect(client.fetchQuery(options)).rejects.toThrow('Temporarily unavailable');
	expect(client.getQueryData(options.queryKey)).toEqual(previous);
	unavailable = false;
	expect(await client.fetchQuery(options)).toEqual([
		{ id: 'p1', name: 'First' },
		{ id: 'p2', name: 'Second' },
	]);
	expect(requested).toHaveLength(4);
	expect(requested.slice(2)).toEqual(requested.slice(0, 2));
});
