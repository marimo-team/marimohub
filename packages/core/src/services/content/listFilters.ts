import { tagsInNamespace } from '../../tagPaths';

export interface ListFilters<Status extends string> {
	status?: Status;
	tag?: string;
	q?: string;
}

export interface ProjectListFilters<Status extends string> extends ListFilters<Status> {
	tagNamespace?: string;
}

interface ListFilterEntry {
	status: string;
	tags?: readonly string[];
}

export function tagsMatchFilters(
	tags: readonly string[],
	filter: Pick<ProjectListFilters<string>, 'tag' | 'tagNamespace'>,
): boolean {
	return (
		(filter.tag === undefined || tags.includes(filter.tag)) &&
		(filter.tagNamespace === undefined || tagsInNamespace(tags, filter.tagNamespace))
	);
}

export function createListFilter<Entry extends ListFilterEntry>(
	filter: ProjectListFilters<Entry['status']> | undefined,
	searchableFields: (entry: Entry) => readonly string[],
	options: { allowUnknownTags?: boolean } = {},
): (entry: Entry) => boolean {
	const query = filter?.q?.toLowerCase();
	return (entry) =>
		(filter?.status ? entry.status === filter.status : entry.status !== 'deleted') &&
		((filter?.tag === undefined && filter?.tagNamespace === undefined) ||
			tagsMatchFilters(entry.tags ?? [], filter ?? {}) ||
			(entry.tags === undefined && options.allowUnknownTags === true)) &&
		(query === undefined ||
			searchableFields(entry).some((value) => value.toLowerCase().includes(query)));
}
