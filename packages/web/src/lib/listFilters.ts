import { isPathTag, MAX_TAG_PREFIX_LENGTH } from '@marimo-hub/core/tag-paths';

export interface ListFilterValues<Status extends string = string> {
	q?: string;
	status?: Status;
	tag?: string;
	tag_prefix?: string;
}

export interface ListFilterStatus<Status extends string> {
	value: Status;
	label: string;
}

export function readListFilters<Status extends string>(
	params: URLSearchParams,
	statuses: readonly ListFilterStatus<Status>[],
	{ tagPrefix = false }: { tagPrefix?: boolean } = {},
): ListFilterValues<Status> {
	const readParam = (name: string) => params.get(name)?.trim() || undefined;
	const status = readParam('status');
	const prefix = tagPrefix ? readParam('tag_prefix') : undefined;
	return {
		q: readParam('q'),
		...(tagPrefix
			? {
					tag_prefix:
						prefix && prefix.length <= MAX_TAG_PREFIX_LENGTH && isPathTag(prefix)
							? prefix
							: undefined,
				}
			: {}),
		tag: readParam('tag'),
		status: statuses.some((option) => option.value === status) ? (status as Status) : undefined,
	};
}

export function updateListFilterParams(
	current: URLSearchParams,
	values: ListFilterValues,
	{ tagPrefix = false }: { tagPrefix?: boolean } = {},
): URLSearchParams {
	const next = new URLSearchParams(current);
	const names: (keyof ListFilterValues)[] = ['q', 'status', 'tag'];
	if (tagPrefix) names.push('tag_prefix');
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
		values.tag_prefix !== undefined
	);
}
