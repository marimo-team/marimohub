/* oxlint-disable jsx-a11y/prefer-tag-over-role -- React does not recognize the HTML search element. */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Filter } from 'lucide-react';
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
	const panelId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const active = hasListFilters(values);
	const [isOpen, setIsOpen] = useState(active);
	const focusSearchOnOpen = useRef(false);
	const openFilters = useCallback(() => {
		if (searchRef.current) return;
		focusSearchOnOpen.current = true;
		setIsOpen(true);
	}, []);
	useSearchHotkey(searchRef, openFilters);
	useEffect(() => {
		if (active) setIsOpen(true);
	}, [active]);
	useEffect(() => {
		const input = searchRef.current;
		if (!isOpen || !focusSearchOnOpen.current || !input) return;
		focusSearchOnOpen.current = false;
		input.focus();
	}, [isOpen]);
	const pluralName = `${itemName}${resultCount === 1 ? '' : 's'}`;
	const announcement = isLoading
		? `Loading ${itemName}s…`
		: isFetching
			? `Updating ${itemName}s…`
			: `${resultCount} ${pluralName}`;

	return (
		<div className="mb-3">
			<div className="flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					aria-expanded={isOpen}
					aria-controls={panelId}
					onPress={() => setIsOpen((open) => !open)}
				>
					<Filter className="size-3.5" aria-hidden="true" />
					Filters
					{active ? <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" /> : null}
					<ChevronDown
						className={`size-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
						aria-hidden="true"
					/>
				</Button>
				<output
					aria-live="polite"
					aria-atomic="true"
					className="text-xs tabular-nums text-muted-foreground"
				>
					{announcement}
				</output>
			</div>
			{isOpen ? (
				<form
					id={panelId}
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
					className="mt-2 rounded-lg border bg-card p-2 shadow-xs"
				>
					<div className="grid grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)_minmax(8.5rem,1fr)_auto] items-end gap-2 max-md:grid-cols-1">
						<SearchField
							label="Search"
							name="q"
							defaultValue={values.q ?? ''}
							placeholder="Name or description…"
							inputRef={searchRef}
							className="gap-1 [&_input]:h-8 [&_input]:rounded-md [&_input]:pl-8 [&_input]:pr-8 [&_input]:text-xs"
						/>
						<TextField
							label="Exact tag"
							name="tag"
							defaultValue={values.tag ?? ''}
							placeholder="analytics…"
							autoComplete="off"
							className="gap-1 [&_input]:h-8 [&_input]:text-xs [&_input]:max-md:h-11"
						/>
						<div className="flex flex-col gap-1">
							<label htmlFor={statusId} className="text-xs font-medium text-muted-foreground">
								Status
							</label>
							<select
								id={statusId}
								name="status"
								defaultValue={values.status ?? ''}
								className="h-8 cursor-pointer rounded-md border border-input bg-background px-2.5 text-xs text-foreground shadow-sm transition-colors [color-scheme:light] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11 dark:[color-scheme:dark]"
							>
								<option value="">All current statuses</option>
								{statuses.map((status) => (
									<option key={status.value} value={status.value}>
										{status.label}
									</option>
								))}
							</select>
						</div>
						<div className="flex gap-1 max-md:grid max-md:grid-cols-2">
							<Button type="submit" size="sm" aria-controls={resultsId}>
								Apply
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								isDisabled={!active}
								aria-controls={resultsId}
								onPress={() => onChange({})}
							>
								Reset
							</Button>
						</div>
					</div>
				</form>
			) : null}
		</div>
	);
}
