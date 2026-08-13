import type { ObjectEntry, ObjectSearchRequest } from '@marimo-hub/core';

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
		entry.last_modified &&
		Date.parse(entry.last_modified) > Date.parse(filters.modified_before)
	) {
		return false;
	}
	return true;
}
