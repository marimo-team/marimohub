import { describe, expect, it, vi } from 'vitest';
import { boundedKeySearch } from './search';

const entry = (key: string) => ({ kind: 'object' as const, key, name: key });

describe('boundedKeySearch', () => {
	it('resumes within a page without rescanning earlier keys', async () => {
		const loadPage = vi.fn(async () => ({
			items: ['a', 'match-1', 'match-2'],
			nextToken: 'next',
			hasMore: true,
		}));
		const first = await boundedKeySearch({
			request: { bucket: 'bucket', query: 'match', limit: 1 },
			maxKeys: 10,
			cursorStyle: 'start-after',
			loadPage,
			toEntry: entry,
		});
		expect(first).toMatchObject({ items: [entry('match-1')], scanned: 2, complete: false });
		await boundedKeySearch({
			request: { bucket: 'bucket', query: 'match', limit: 1, cursor: first.next_cursor! },
			maxKeys: 10,
			cursorStyle: 'start-after',
			loadPage,
			toEntry: entry,
		});
		expect(loadPage).toHaveBeenLastCalledWith({
			startAfter: 'match-1',
			token: undefined,
			limit: 10,
		});
	});

	it('rejects a provider cursor that does not advance', async () => {
		const first = await boundedKeySearch({
			request: { bucket: 'bucket', query: 'absent', limit: 1 },
			maxKeys: 1,
			cursorStyle: 'page-offset',
			loadPage: async () => ({ items: ['a'], nextToken: 'same', hasMore: true }),
			toEntry: entry,
		});
		await expect(
			boundedKeySearch({
				request: { bucket: 'bucket', query: 'absent', limit: 1, cursor: first.next_cursor! },
				maxKeys: 10,
				cursorStyle: 'page-offset',
				loadPage: async () => ({ items: [], nextToken: 'same', hasMore: true }),
				toEntry: entry,
			}),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
	});
});
