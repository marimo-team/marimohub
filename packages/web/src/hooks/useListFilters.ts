import { useSearchParams } from 'react-router-dom';
import { hasListFilters, readListFilters, updateListFilterParams } from '@/lib/listFilters';
import type { ListFilterStatus, ListFilterValues } from '@/lib/listFilters';

export function useListFilters<Status extends string>(
	statuses: readonly ListFilterStatus<Status>[],
	options?: { tagPrefix?: boolean },
) {
	const [searchParams, setSearchParams] = useSearchParams();
	const filters = readListFilters(searchParams, statuses, options);
	const setFilters = (values: ListFilterValues<Status>) =>
		setSearchParams(updateListFilterParams(searchParams, values, options));

	return { filters, setFilters, filtersActive: hasListFilters(filters) };
}
