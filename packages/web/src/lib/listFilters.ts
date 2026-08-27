export interface ListFilterValues<Status extends string = string> {
	q?: string;
	status?: Status;
	tag?: string;
}

export interface ListFilterStatus<Status extends string> {
	value: Status;
	label: string;
}

export function readListFilters<Status extends string>(
	params: URLSearchParams,
	statuses: readonly ListFilterStatus<Status>[],
): ListFilterValues<Status> {
	const readParam = (name: string) => params.get(name)?.trim() || undefined;
	const status = readParam('status');
	return {
		q: readParam('q'),
		tag: readParam('tag'),
		status: statuses.some((option) => option.value === status) ? (status as Status) : undefined,
	};
}

export function updateListFilterParams(
	current: URLSearchParams,
	values: ListFilterValues,
): URLSearchParams {
	const next = new URLSearchParams(current);
	for (const name of ['q', 'status', 'tag'] as const) {
		next.delete(name);
		if (values[name]) next.set(name, values[name]);
	}
	return next;
}

export function hasListFilters(values: ListFilterValues): boolean {
	return values.q !== undefined || values.status !== undefined || values.tag !== undefined;
}
