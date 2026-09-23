import { PageTitle } from '@/components/ui/PageTitle';
import { ArrowRight, Folder, LayoutGrid, Search } from 'lucide-react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppsQuery, useProjectAppsQuery } from '@/api/apps';
import { Project } from '@/components/Project/Project';
import { Button, EmptyState, SearchField, Skeleton } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSearchField } from '@/hooks/useSearchField';

export function AppAccessError({
	error,
	onRetry,
	isRetrying,
}: {
	error: Error;
	onRetry?: () => void;
	isRetrying?: boolean;
}) {
	return (
		<div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
			<h1 className="text-lg font-semibold">Unable to open apps</h1>
			<p className="text-sm text-muted-foreground">{error.message}</p>
			{onRetry ? (
				<Button onPress={onRetry} isDisabled={isRetrying}>
					Retry
				</Button>
			) : (
				<Link to="/apps">Back to apps</Link>
			)}
		</div>
	);
}

export function ProjectEntryPage() {
	const { pid = '' } = useParams();
	const query = useProjectAppsQuery(pid);
	return query.data.pages[0].project?.your_role === 'app-user' ? (
		<Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />
	) : (
		<Project />
	);
}

export function AppsPage() {
	const [params] = useSearchParams();
	const { query: search, setQuery: setSearch, inputRef } = useSearchField();
	const debouncedSearch = useDebouncedValue(search);
	const query = useAppsQuery(params.get('project_id') ?? undefined, debouncedSearch);
	if (query.isError && !query.data)
		return (
			<AppAccessError
				error={query.error}
				onRetry={() => void query.refetch()}
				isRetrying={query.isFetching}
			/>
		);
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];
	const project = query.data?.pages[0].project;
	return (
		<section aria-label="Apps" className="min-w-0 flex-1 overflow-auto px-5 py-8 sm:px-8 sm:py-10">
			<PageTitle>Apps</PageTitle>
			<div className="mx-auto max-w-6xl space-y-8">
				<header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-2">
						<h1 className="text-3xl font-semibold tracking-tight">Apps</h1>
						<p className="text-sm text-muted-foreground">
							{project ? `Explore apps in ${project.name}.` : 'Explore the apps shared with you.'}
						</p>
					</div>
					<SearchField
						aria-label="Search apps"
						placeholder="Search apps…"
						value={search}
						onChange={setSearch}
						inputRef={inputRef}
						className="w-full sm:max-w-xs"
					/>
				</header>
				<div className="space-y-4">
					<div className="flex items-center gap-2 border-b pb-4">
						<LayoutGrid className="size-4 text-muted-foreground" aria-hidden />
						<h2 className="text-sm font-medium">
							{debouncedSearch ? 'Search results' : 'All apps'}
						</h2>
						{query.data ? (
							<span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
								{items.length}
								{query.hasNextPage ? '+' : ''}
							</span>
						) : null}
					</div>
					{query.isPending ? (
						<div>
							<output className="sr-only">Loading apps…</output>
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
								{Array.from({ length: 6 }, (_, index) => (
									<div key={index} className="space-y-5 rounded-xl border bg-card p-5">
										<div className="flex items-center gap-3">
											<Skeleton className="size-10 shrink-0 rounded-lg motion-reduce:animate-none" />
											<div className="flex flex-1 flex-col gap-2">
												<Skeleton className="h-4 w-3/4 motion-reduce:animate-none" />
												<Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
											</div>
										</div>
										<Skeleton className="h-4 w-16 motion-reduce:animate-none" />
									</div>
								))}
							</div>
						</div>
					) : items.length === 0 ? (
						<EmptyState
							icon={debouncedSearch ? <Search aria-hidden /> : <LayoutGrid aria-hidden />}
							message={`No apps available${debouncedSearch ? ' matching your search' : ''}.`}
							description={
								debouncedSearch
									? 'Try a different name or clear your search.'
									: 'Apps will appear here when they are shared with you.'
							}
							action={
								debouncedSearch ? (
									<Button onPress={() => setSearch('')}>Clear search</Button>
								) : undefined
							}
						/>
					) : (
						<ul aria-label="Available apps" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
							{items.map((app) => (
								<li key={`${app.project_id}/${app.notebook_id}`} className="min-w-0">
									<Link
										to={app.url}
										className="group flex h-full flex-col rounded-xl border bg-card p-5 text-card-foreground shadow-xs transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
									>
										<div className="flex items-start gap-3">
											<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
												<LayoutGrid className="size-5" aria-hidden />
											</div>
											<div className="min-w-0 space-y-1.5">
												<h3 className="break-words text-sm font-semibold leading-5">{app.title}</h3>
												<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
													<Folder className="size-3.5 shrink-0" aria-hidden />
													<span className="truncate" title={app.project_name}>
														{app.project_name}
													</span>
												</p>
											</div>
										</div>
										<div className="mt-auto flex items-center justify-between gap-3 pt-5 text-xs text-muted-foreground group-hover:text-primary group-focus-visible:text-primary">
											<span>
												{app.can.run ? 'Open app' : 'App access is unavailable for your role'}
											</span>
											<ArrowRight className="size-4 shrink-0" aria-hidden />
										</div>
									</Link>
								</li>
							))}
						</ul>
					)}
				</div>
				{query.isError ? (
					<div role="alert" className="space-y-3">
						<p className="text-sm text-muted-foreground">{query.error.message}</p>
						<Button
							isDisabled={query.isFetching}
							onPress={() =>
								void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
							}
						>
							Retry
						</Button>
					</div>
				) : query.hasNextPage ? (
					<Button isDisabled={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()}>
						Load more
					</Button>
				) : null}
			</div>
		</section>
	);
}
