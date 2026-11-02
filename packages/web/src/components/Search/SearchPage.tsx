import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, SearchX } from 'lucide-react';
import { CheckboxField, CheckboxButton } from 'react-aria-components';
import { projectQueryOptions, useProjectsQuery } from '@/api/hooks';
import { ApiRequestError } from '@/api/client';
import { useWorkspaceSearch } from '@/api/search';
import type { SearchKind } from '@/api/search';
import { useSearchAccess } from '@/hooks/useSearchAccess';
import { useSearchHotkey } from '@/hooks/useSearchHotkey';
import { Page } from '@/components/ui/Page';
import { SearchField } from '@/components/ui/SearchField';
import { Button } from '@/components/ui/Button';
import { SearchResult } from './SearchResult';
import { searchPath, SEARCH_RESULT_LIMIT } from '@/lib/workspaceSearch';
import { SearchFilters } from './SearchFilters';

export default function SearchPage() {
	const { user, allowed, capabilities, search } = useSearchAccess();
	if (!allowed)
		return (
			<Page title="Search">
				<p>Search is not available for this account.</p>
			</Page>
		);
	if (capabilities.isPending)
		return (
			<Page title="Search">
				<output>Loading search…</output>
			</Page>
		);
	if (capabilities.isError)
		return (
			<Page title="Search">
				<div role="alert">
					<p>Could not load search.</p>
					<Button onPress={() => void capabilities.refetch()}>Retry</Button>
				</div>
			</Page>
		);
	if (!search?.available)
		return (
			<Page title="Search">
				<p>Search is not enabled on this server.</p>
			</Page>
		);
	return <SearchContent userId={user?.id} kinds={search.kinds} semantic={search.semantic} />;
}

function SearchContent({
	userId,
	kinds,
	semantic,
}: {
	userId?: string;
	kinds: SearchKind[];
	semantic: boolean;
}) {
	const { pid } = useParams();
	const [params, setParams] = useSearchParams();
	const location = useLocation();
	const navigate = useNavigate();
	const input = useRef<HTMLInputElement>(null);
	const results = useRef<HTMLOListElement>(null);
	const query = params.get('q') ?? '';
	const normalized = query.trim();
	const [composing, setComposing] = useState(false);
	const [pendingInput, setPendingInput] = useState(false);
	const typing = composing || pendingInput;
	useEffect(() => {
		if (!pendingInput || composing) return;
		const timer = setTimeout(() => setPendingInput(false), 500);
		return () => clearTimeout(timer);
	}, [query, pendingInput, composing]);
	const kind = params.get('kind');
	const validKind = kind === null || kinds.includes(kind as SearchKind);
	const mode = params.get('mode') ?? 'keyword';
	const validMode = mode === 'keyword' || (mode === 'hybrid' && semantic);
	const valid = normalized.length <= 256 && validKind && validMode;
	const projects = useProjectsQuery({ status: 'active' }, { throwOnError: false });
	const project = useQuery({
		...projectQueryOptions(pid ?? ''),
		enabled: Boolean(pid),
		throwOnError: false,
	});
	const result = useWorkspaceSearch(
		{
			q: normalized,
			project_id: pid,
			kinds: validKind ? (kind ?? undefined) : undefined,
			mode: mode === 'hybrid' ? 'hybrid' : 'keyword',
			limit: SEARCH_RESULT_LIMIT,
		},
		userId,
		Boolean(normalized) && valid && !typing,
	);
	// Do not retain authorized results while revalidating after focus or reconnect.
	const data =
		valid && normalized && !typing && result.fetchStatus === 'idle' && !result.isError
			? result.data
			: undefined;
	const items = data?.items ?? [];
	const searching =
		Boolean(normalized) && valid && (typing || result.isPending || result.fetchStatus !== 'idle');
	const failed = !typing && valid && normalized && result.isError;
	useSearchHotkey(input);
	useEffect(() => {
		if (location.state?.focusSearch === true) input.current?.focus();
	}, [location.key, location.state]);
	const update = (key: string, value: string, replace = false) => {
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace },
		);
	};
	const moveFocus = (event: KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			composing ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			event.nativeEvent.isComposing
		)
			return;
		const links = [
			...(results.current?.querySelectorAll<HTMLAnchorElement>('[data-search-hit]') ?? []),
		];
		const current = links.indexOf(document.activeElement as HTMLAnchorElement);
		if (current !== -1 && event.key === 'Escape') {
			event.preventDefault();
			input.current?.focus();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		if (current === -1 && document.activeElement !== input.current) return;
		if (links.length === 0) return;
		event.preventDefault();
		if (event.key === 'ArrowUp' && current <= 0) input.current?.focus();
		else links[Math.min(links.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
	};
	const submit = () => {
		if (composing || !valid || !normalized) return;
		if (pendingInput) setPendingInput(false);
		else if (result.fetchStatus === 'idle') void result.refetch();
	};
	const status =
		typing && normalized && valid
			? 'Press Enter to search now'
			: searching
				? result.fetchStatus === 'paused'
					? 'Waiting for connection…'
					: 'Searching…'
				: data
					? `${items.length === SEARCH_RESULT_LIMIT ? `Top ${SEARCH_RESULT_LIMIT}` : items.length} result${items.length === 1 ? '' : 's'}`
					: '';
	const inaccessible =
		failed &&
		result.error instanceof ApiRequestError &&
		[403, 404].includes(result.error.status ?? 0);
	return (
		<Page
			title="Search"
			context={pid ? (project.data?.name ?? 'Project') : 'All projects'}
			subtitle="Find notebooks, saved code, outputs, and data."
		>
			<div className="space-y-5">
				<search
					aria-label="Workspace content"
					className="space-y-4 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
				>
					<div className="flex items-start gap-2">
						<SearchField
							aria-label="Search content"
							placeholder={pid ? 'Search this project…' : 'Search across projects…'}
							value={query}
							onChange={(value) => {
								// Pause requests until the URL update commits, including when clearing.
								setPendingInput(true);
								update('q', value, true);
							}}
							onSubmit={submit}
							className="min-w-0 flex-1"
							inputClassName="h-12 text-base max-md:h-12"
							inputRef={input}
							onKeyDown={moveFocus}
							onCompositionStart={() => setComposing(true)}
							onCompositionEnd={() => {
								setComposing(false);
								setPendingInput(true);
							}}
						/>
						<Button
							variant="primary"
							className="h-12 px-4"
							isDisabled={!normalized || !valid || composing}
							onPress={submit}
						>
							Search
						</Button>
					</div>
					<SearchFilters
						projectId={pid}
						projectName={project.data?.name}
						projects={projects.data ?? []}
						kinds={kinds}
						kind={kind}
						validKind={validKind}
						onProjectChange={(id) =>
							void navigate({ pathname: searchPath(id), search: params.toString() })
						}
						onKindChange={(value) => update('kind', value)}
					/>
					{projects.isError && (
						<div role="alert" className="text-sm text-muted-foreground">
							Could not load project choices.{' '}
							<Button size="sm" onPress={() => void projects.refetch()}>
								Retry projects
							</Button>
						</div>
					)}
					{semantic && (
						<CheckboxField
							isSelected={mode === 'hybrid'}
							onChange={(selected) => update('mode', selected ? 'hybrid' : '')}
						>
							<CheckboxButton className="group flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-muted-foreground">
								<span className="flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background group-data-[selected]:border-primary group-data-[selected]:bg-primary group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2">
									<Check
										className="size-3 text-primary-foreground opacity-0 group-data-[selected]:opacity-100"
										aria-hidden
									/>
								</span>
								Include related notebook content
							</CheckboxButton>
						</CheckboxField>
					)}
				</search>
				{!valid && (
					<div role="alert" className="text-sm text-destructive">
						{normalized.length > 256
							? 'Use 256 characters or fewer.'
							: !validKind
								? 'This result type is unavailable. Choose another type.'
								: 'This search mode is unavailable.'}
						{!validMode && (
							<Button size="sm" onPress={() => update('mode', '')}>
								Use keyword search
							</Button>
						)}
					</div>
				)}
				<div className="flex min-h-6 items-center justify-between gap-3 text-xs text-muted-foreground">
					<output aria-live="polite">{status}</output>
					<span className="max-sm:hidden">↑ ↓ to navigate · Enter to search or open</span>
				</div>
				{data?.partial && (
					<div
						aria-live="polite"
						className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
					>
						<p className="font-medium">Some content could not be searched.</p>
						<p className="mt-1 text-muted-foreground">
							Results may be incomplete or awaiting an index update. Try again
							{pid ? '.' : ' or choose a project to narrow the search.'}
						</p>
						<Button size="sm" className="mt-2" onPress={() => void result.refetch()}>
							Retry search
						</Button>
					</div>
				)}
				{failed && (
					<div role="alert" className="rounded-lg border p-4 text-sm">
						<p>
							{inaccessible
								? 'Search is unavailable, or you no longer have access to this project.'
								: 'Search could not finish. Please try again.'}
						</p>
						<Button className="mt-3" onPress={() => void result.refetch()}>
							Retry search
						</Button>
					</div>
				)}
				{!normalized && (
					<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-5 py-14 text-center text-muted-foreground">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
							<Search className="size-6" aria-hidden />
						</span>
						<p className="font-medium text-foreground">
							Search {pid ? 'this project' : 'your workspace'}
						</p>
						<p className="max-w-sm text-sm">
							Enter a name, a phrase, or a column to find content you can access.
						</p>
					</div>
				)}
				{data && items.length === 0 && (
					<div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
						<SearchX className="size-8" aria-hidden />
						<p className="font-medium text-foreground">
							{data.partial ? 'No matches in the content searched' : 'No results found'}
						</p>
						<p className="text-sm">Try different keywords or broaden your filters.</p>
					</div>
				)}
				<ol
					ref={results}
					aria-label="Search results"
					aria-busy={searching}
					className="divide-y divide-border/60"
				>
					{items.map((item) => (
						<SearchResult
							key={`${item.project_id}:${item.kind}:${item.id}`}
							item={item}
							onKeyDown={moveFocus}
						/>
					))}
				</ol>
			</div>
		</Page>
	);
}
