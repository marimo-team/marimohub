import { ObjectBrowseError } from '@marimo-hub/core';
import type { ObjectEntry, ObjectSearchPage, ObjectSearchRequest } from '@marimo-hub/core';
import { decodeCursor, encodeCursor } from './cursors';

export interface BoundedSearchPage<T> {
	items: T[];
	nextToken?: string;
	hasMore: boolean;
}

export interface BoundedKeySearchOptions<T> {
	request: ObjectSearchRequest;
	maxKeys: number;
	batchSize?: number;
	cursorStyle: 'start-after' | 'page-offset';
	loadPage(input: {
		token?: string;
		startAfter?: string;
		limit: number;
	}): Promise<BoundedSearchPage<T>>;
	toEntry(item: T): ObjectEntry;
}

export async function boundedKeySearch<T>(
	options: BoundedKeySearchOptions<T>,
): Promise<ObjectSearchPage> {
	const { request, cursorStyle } = options;
	const batchSize = options.batchSize ?? 1_000;
	const decoded = decodeCursor(request.cursor, ['token', 'start_after', 'skip']);
	if (cursorStyle === 'start-after' && decoded.token && decoded.start_after) throw invalidCursor();
	if (cursorStyle === 'start-after' && decoded.skip !== undefined) throw invalidCursor();
	if (cursorStyle === 'page-offset' && decoded.start_after !== undefined) throw invalidCursor();
	const initialSkip = cursorStyle === 'page-offset' ? Number(decoded.skip ?? 0) : 0;
	if (!Number.isSafeInteger(initialSkip) || initialSkip < 0) throw invalidCursor();
	let token = decoded.token;
	let startAfter = decoded.start_after;
	let skip = initialSkip;
	let scanned = 0;
	let complete = false;
	let nextCursor: string | null = null;
	const items: ObjectEntry[] = [];
	const prefix = request.prefix ?? '';
	const query = request.query.toLocaleLowerCase();

	while (scanned < options.maxKeys && items.length < request.limit) {
		const requestedToken = token;
		const page = await options.loadPage({
			token,
			startAfter,
			limit: Math.min(batchSize, options.maxKeys - scanned),
		});
		if (skip > page.items.length) throw invalidCursor();
		for (let index = skip; index < page.items.length; index += 1) {
			const entry = options.toEntry(page.items[index]);
			scanned += 1;
			if (
				entry.key.slice(prefix.length).toLocaleLowerCase().includes(query) &&
				matchesObjectSearchFilters(entry, request)
			) {
				items.push(entry);
			}
			if (scanned < options.maxKeys && items.length < request.limit) continue;
			if (index < page.items.length - 1) {
				nextCursor =
					cursorStyle === 'start-after'
						? encodeCursor({ start_after: entry.key })
						: encodeCursor({ token: requestedToken ?? '', skip: String(index + 1) });
			} else if (page.hasMore && page.nextToken) {
				nextCursor = encodeCursor(
					cursorStyle === 'start-after'
						? { token: page.nextToken }
						: { token: page.nextToken, skip: '0' },
				);
			} else {
				complete = true;
			}
			break;
		}
		if (nextCursor || complete) break;
		if (!page.hasMore) {
			complete = true;
			break;
		}
		if (!page.nextToken || page.nextToken === requestedToken) throw nonAdvancingCursor();
		token = page.nextToken;
		startAfter = undefined;
		skip = 0;
	}
	if (!complete && !nextCursor && token) {
		nextCursor = encodeCursor(
			cursorStyle === 'start-after' ? { token } : { token, skip: String(skip) },
		);
	}
	return { items, scanned, complete, next_cursor: complete ? null : nextCursor };
}

export function matchesObjectSearchFilters(
	entry: ObjectEntry,
	filters: ObjectSearchRequest,
): boolean {
	const extension = entry.key.split('.').at(-1)?.toLowerCase();
	if (filters.formats?.length && (!extension || !filters.formats.includes(extension))) return false;
	if (filters.min_size !== undefined && (entry.size ?? 0) < filters.min_size) return false;
	if (filters.max_size !== undefined && (entry.size ?? 0) > filters.max_size) return false;
	if (
		filters.modified_after &&
		(!entry.last_modified || Date.parse(entry.last_modified) < Date.parse(filters.modified_after))
	) {
		return false;
	}
	if (
		filters.modified_before &&
		(!entry.last_modified || Date.parse(entry.last_modified) > Date.parse(filters.modified_before))
	) {
		return false;
	}
	return true;
}

function invalidCursor(): ObjectBrowseError {
	return new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
}

function nonAdvancingCursor(): ObjectBrowseError {
	return new ObjectBrowseError('invalid_cursor', 'The object-store cursor did not advance.');
}
