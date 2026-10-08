import { tagsMatchPrefix } from '../../tagPaths';

export interface ListFilters<Status extends string> {
	status?: Status;
	tag?: string;
	tagPrefix?: string;
	q?: string;
}

interface ListFilterEntry {
	status: string;
	tags?: readonly string[];
}

export function tagsMatchFilters(
	tags: readonly string[],
	filter: Pick<ListFilters<string>, 'tag' | 'tagPrefix'>,
): boolean {
	return (
		(filter.tag === undefined || tags.includes(filter.tag)) &&
		(filter.tagPrefix === undefined || tagsMatchPrefix(tags, filter.tagPrefix))
	);
}

export function createListFilter<Entry extends ListFilterEntry>(
	filter: ListFilters<Entry['status']> | undefined,
	searchableFields: (entry: Entry) => readonly string[],
	options: { allowUnknownTags?: boolean } = {},
): (entry: Entry) => boolean {
	const query = filter?.q?.toLowerCase();
	return (entry) =>
		(filter?.status ? entry.status === filter.status : entry.status !== 'deleted') &&
		((filter?.tag === undefined && filter?.tagPrefix === undefined) ||
			tagsMatchFilters(entry.tags ?? [], filter ?? {}) ||
			(entry.tags === undefined && options.allowUnknownTags === true)) &&
		(query === undefined ||
			searchableFields(entry).some((value) => value.toLowerCase().includes(query)));
}
