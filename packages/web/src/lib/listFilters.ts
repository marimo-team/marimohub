import { isValidTagNamespace } from '@marimo-hub/core/tag-paths';

export interface ListFilterValues<Status extends string = string> {
	q?: string;
	status?: Status;
	tag?: string;
	tag_namespace?: string;
}

export interface ListFilterStatus<Status extends string> {
	value: Status;
	label: string;
}

export function readListFilters<Status extends string>(
	params: URLSearchParams,
	statuses: readonly ListFilterStatus<Status>[],
	{ tagNamespace = false }: { tagNamespace?: boolean } = {},
): ListFilterValues<Status> {
	const readParam = (name: string) => params.get(name)?.trim() || undefined;
	const status = readParam('status');
	const namespace = tagNamespace ? readParam('tag_namespace') : undefined;
	return {
		q: readParam('q'),
		...(tagNamespace
			? {
					tag_namespace:
						namespace !== undefined && isValidTagNamespace(namespace) ? namespace : undefined,
				}
			: {}),
		tag: readParam('tag'),
		status: statuses.some((option) => option.value === status) ? (status as Status) : undefined,
	};
}

export function updateListFilterParams(
	current: URLSearchParams,
	values: ListFilterValues,
	{ tagNamespace = false }: { tagNamespace?: boolean } = {},
): URLSearchParams {
	const next = new URLSearchParams(current);
	const names: (keyof ListFilterValues)[] = ['q', 'status', 'tag'];
	if (tagNamespace) names.push('tag_namespace');
	for (const name of names) {
		next.delete(name);
		if (values[name] !== undefined) next.set(name, values[name]);
	}
	return next;
}

export function hasListFilters(values: ListFilterValues): boolean {
	return (
		values.q !== undefined ||
		values.status !== undefined ||
		values.tag !== undefined ||
		values.tag_namespace !== undefined
	);
}
