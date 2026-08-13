import { describe, expect, it, vi } from 'vitest';
import { encodeCursor } from './cursors';
import { boundedKeySearch } from './search';

const entry = (key: string) => ({ kind: 'object' as const, key, name: key });

describe('boundedKeySearch', () => {
	it('resumes within a page without rescanning earlier keys', async () => {
		const loadPage = vi.fn(async ({ startAfter }: { startAfter?: string }) => ({
			items: ['a', 'match-1', 'match-2'].filter((key) => !startAfter || key > startAfter),
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
		const resumed = await boundedKeySearch({
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
		expect(resumed).toMatchObject({ items: [entry('match-2')], scanned: 1 });
	});

	it.each([
		encodeCursor({ token: '' }),
		encodeCursor({ token: '', start_after: 'a' }),
		encodeCursor({ token: 'provider', start_after: 'a' }),
	])('rejects malformed start-after cursors', async (cursor) => {
		await expect(
			boundedKeySearch({
				request: { bucket: 'bucket', query: 'match', limit: 1, cursor },
				maxKeys: 10,
				cursorStyle: 'start-after',
				loadPage: async () => ({ items: [], hasMore: false }),
				toEntry: entry,
			}),
		).rejects.toMatchObject({ code: 'invalid_cursor' });
	});

	it('resumes the first provider page without synthesizing an empty token', async () => {
		const first = await boundedKeySearch({
			request: { bucket: 'bucket', query: 'match', limit: 1 },
			maxKeys: 10,
			cursorStyle: 'page-offset',
			loadPage: async () => ({ items: ['a', 'match-1', 'match-2'], hasMore: false }),
			toEntry: entry,
		});
		const loadPage = vi.fn(async () => ({ items: ['a', 'match-1', 'match-2'], hasMore: false }));
		const resumed = await boundedKeySearch({
			request: {
				bucket: 'bucket',
				query: 'match',
				limit: 1,
				cursor: first.next_cursor!,
			},
			maxKeys: 10,
			cursorStyle: 'page-offset',
			loadPage,
			toEntry: entry,
		});
		expect(loadPage).toHaveBeenCalledWith({ token: undefined, startAfter: undefined, limit: 10 });
		expect(resumed.items).toEqual([entry('match-2')]);
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
