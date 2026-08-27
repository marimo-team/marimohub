/* oxlint-disable jsx-a11y/prefer-tag-over-role -- React does not recognize the HTML search element. */
import { useId, useRef } from 'react';
import { Filter, RotateCcw } from 'lucide-react';
import { Button } from './Button';
import { SearchField } from './SearchField';
import { TextField } from './TextField';
import { useSearchHotkey } from '@/hooks/useSearchHotkey';
import { hasListFilters } from '@/lib/listFilters';
import type { ListFilterStatus, ListFilterValues } from '@/lib/listFilters';

interface ListFiltersProps<Status extends string> {
	label: string;
	itemName: string;
	values: ListFilterValues<Status>;
	statuses: readonly ListFilterStatus<Status>[];
	resultCount: number;
	resultsId: string;
	isLoading: boolean;
	isFetching: boolean;
	onChange: (values: ListFilterValues<Status>) => void;
}

function formValue(data: FormData, name: string): string | undefined {
	const value = data.get(name);
	if (typeof value !== 'string') return undefined;
	return value.trim() || undefined;
}

export function ListFilters<Status extends string>({
	label,
	itemName,
	values,
	statuses,
	resultCount,
	resultsId,
	isLoading,
	isFetching,
	onChange,
}: ListFiltersProps<Status>) {
	const statusId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	useSearchHotkey(searchRef);
	const active = hasListFilters(values);
	const pluralName = `${itemName}${resultCount === 1 ? '' : 's'}`;
	const announcement = isLoading
		? `Loading ${itemName}s…`
		: isFetching
			? `Updating ${itemName}s…`
			: `${resultCount} ${pluralName}`;

	return (
		<form
			key={`${values.q ?? ''}\0${values.tag ?? ''}\0${values.status ?? ''}`}
			role="search"
			aria-label={label}
			onSubmit={(event) => {
				event.preventDefault();
				const data = new FormData(event.currentTarget);
				onChange({
					q: formValue(data, 'q'),
					tag: formValue(data, 'tag'),
					status: formValue(data, 'status') as Status | undefined,
				});
			}}
			className="mb-4 rounded-xl border bg-card p-3 shadow-xs"
		>
			<div className="grid grid-cols-[minmax(0,2fr)_minmax(8rem,1fr)_minmax(9rem,1fr)_auto] items-end gap-3 max-md:grid-cols-1">
				<SearchField
					label="Search"
					name="q"
					defaultValue={values.q ?? ''}
					placeholder="Name or description…"
					inputRef={searchRef}
				/>
				<TextField
					label="Tag (exact)"
					name="tag"
					defaultValue={values.tag ?? ''}
					placeholder="analytics…"
					autoComplete="off"
					className="[&_input]:max-md:h-11"
				/>
				<div className="flex flex-col gap-1.5">
					<label htmlFor={statusId} className="text-xs font-medium text-muted-foreground">
						Status
					</label>
					<select
						id={statusId}
						name="status"
						defaultValue={values.status ?? ''}
						className="h-9 cursor-pointer rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm transition-colors [color-scheme:light] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11 dark:[color-scheme:dark]"
					>
						<option value="">All current statuses</option>
						{statuses.map((status) => (
							<option key={status.value} value={status.value}>
								{status.label}
							</option>
						))}
					</select>
				</div>
				<div className="flex gap-2 max-md:grid max-md:grid-cols-2">
					<Button type="submit" aria-controls={resultsId}>
						<Filter className="size-4" aria-hidden="true" />
						Apply Filters
					</Button>
					<Button
						type="button"
						variant="ghost"
						isDisabled={!active}
						aria-controls={resultsId}
						onPress={() => onChange({})}
					>
						<RotateCcw className="size-4" aria-hidden="true" />
						Reset
					</Button>
				</div>
			</div>
			<output
				aria-live="polite"
				aria-atomic="true"
				className="mt-2 block min-h-4 text-xs tabular-nums text-muted-foreground"
			>
				{announcement}
			</output>
		</form>
	);
}
