export interface ListFilters<Status extends string> {
	status?: Status;
	tag?: string;
	q?: string;
}

interface ListFilterEntry {
	status: string;
	tags?: readonly string[];
}

export function createListFilter<Entry extends ListFilterEntry>(
	filter: ListFilters<Entry['status']> | undefined,
	searchableFields: (entry: Entry) => readonly string[],
	options: { allowUnknownTags?: boolean } = {},
): (entry: Entry) => boolean {
	const query = filter?.q?.toLowerCase();
	return (entry) =>
		(filter?.status ? entry.status === filter.status : entry.status !== 'deleted') &&
		(filter?.tag === undefined ||
			entry.tags?.includes(filter.tag) ||
			(entry.tags === undefined && options.allowUnknownTags === true)) &&
		(query === undefined ||
			searchableFields(entry).some((value) => value.toLowerCase().includes(query)));
}
