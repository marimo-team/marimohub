import { z } from '@hono/zod-openapi';
import { BadRequestError, NOTEBOOK_STATUSES, PROJECT_STATUSES } from '@marimo-hub/core';

/**
 * Keyset (cursor) pagination for the list endpoints. List responses carry their
 * items under `data.items` alongside an opaque `data.next_cursor`; a client
 * fetches the next page by echoing that cursor back as `?cursor=`.
 *
 * The cursor encodes the LAST returned item's sort position — its primary key
 * plus a tiebreak — not a numeric offset. Keying on a value (not a position)
 * keeps a page stable when rows are inserted or deleted between fetches: an
 * offset cursor would skip or duplicate rows as the list shifts under it. The
 * cursor stays opaque (base64) so the encoding can change without breaking the
 * wire contract.
 */

/** Default page size when a list request omits `limit`. */
export const DEFAULT_PAGE_SIZE = 100;
/** Hard ceiling on `limit`; larger requests are clamped to this. */
export const MAX_PAGE_SIZE = 500;

/** Query params accepted by every list endpoint. */
export const PaginationQuery = z.object({
	limit: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.openapi({ param: { name: 'limit', in: 'query' }, example: 100 }),
	cursor: z
		.string()
		.optional()
		.openapi({
			param: { name: 'cursor', in: 'query' },
			example: 'WyIyMDI1LTAzLTA1VDE0OjAwOjAwWiIsIm5iLTEiXQ',
		}),
});

const ListFilterQuery = {
	tag: z
		.string()
		.optional()
		.openapi({
			param: { name: 'tag', in: 'query' },
			description: 'Exact tag to match.',
			example: 'analytics',
		}),
	q: z
		.string()
		.optional()
		.openapi({
			param: { name: 'q', in: 'query' },
			description: 'Case-insensitive substring to match against the name or title and description.',
			example: 'revenue',
		}),
};

export const ProjectListQuery = PaginationQuery.extend({
	status: z
		.enum(PROJECT_STATUSES)
		.optional()
		.openapi({
			param: { name: 'status', in: 'query' },
			description: 'Project status to match. Deleted projects are excluded when omitted.',
			example: 'active',
		}),
	...ListFilterQuery,
});

export const NotebookListQuery = PaginationQuery.extend({
	status: z
		.enum(NOTEBOOK_STATUSES)
		.optional()
		.openapi({
			param: { name: 'status', in: 'query' },
			description: 'Notebook status to match. Deleted notebooks are excluded when omitted.',
			example: 'active',
		}),
	...ListFilterQuery,
});

export interface Page<T> {
	items: T[];
	next_cursor: string | null;
}

/**
 * Extracts the sort position of an item: a primary `key` (descending, e.g. an
 * ISO timestamp — newest first) and a `tiebreak` (descending, e.g. the id) so
 * equal primary keys still order deterministically and the cursor is unambiguous.
 */
export interface SortKeys<T> {
	key: (t: T) => string;
	tiebreak: (t: T) => string;
}

/** A descending total order over the two keys. ISO-8601 strings sort lexically by time. */
function comparator<T>(keys: SortKeys<T>) {
	return (a: T, b: T) =>
		keys.key(b).localeCompare(keys.key(a)) || keys.tiebreak(b).localeCompare(keys.tiebreak(a));
}

/** Wrap an item schema in the `{ items, next_cursor }` page envelope for OpenAPI. */
export function pageSchema<T extends z.ZodType>(item: T, name: string) {
	return z
		.object({
			items: z.array(item),
			next_cursor: z.string().nullable(),
		})
		.openapi(name);
}

export function encodeCursor(key: string, tiebreak: string): string {
	return btoa(JSON.stringify([key, tiebreak]));
}

export function decodeCursor(cursor: string | undefined): [string, string] | null {
	if (cursor === undefined || cursor === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(atob(cursor));
	} catch {
		throw new BadRequestError('Invalid pagination cursor');
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		typeof parsed[0] !== 'string' ||
		typeof parsed[1] !== 'string'
	) {
		throw new BadRequestError('Invalid pagination cursor');
	}
	return [parsed[0], parsed[1]];
}

/**
 * Slice a fully-materialized list into a page. The list is ordered by `keys`
 * (descending); when a `cursor` is supplied the page begins at the first item
 * strictly after the cursor's position, so inserts/deletes elsewhere never shift
 * the boundary. `next_cursor` is the last returned item's position, or null on
 * the final page.
 */
export function paginate<T>(
	all: readonly T[],
	query: { limit?: number; cursor?: string },
	keys: SortKeys<T>,
): Page<T> {
	const cmp = comparator(keys);
	const sorted = [...all].sort(cmp);

	const after = decodeCursor(query.cursor);
	let start = 0;
	if (after) {
		const [k, t] = after;
		// Strictly after the cursor in the descending order: a smaller primary key,
		// or an equal key with a smaller tiebreak. Reuses the comparator's
		// localeCompare so the boundary test matches the sort exactly.
		start = sorted.findIndex((item) => {
			const byKey = keys.key(item).localeCompare(k);
			return byKey !== 0 ? byKey < 0 : keys.tiebreak(item).localeCompare(t) < 0;
		});
		if (start === -1) start = sorted.length;
	}

	const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const items = sorted.slice(start, start + limit);
	const last = items[items.length - 1];
	const more = start + items.length < sorted.length;
	return {
		items,
		next_cursor: more && last ? encodeCursor(keys.key(last), keys.tiebreak(last)) : null,
	};
}
