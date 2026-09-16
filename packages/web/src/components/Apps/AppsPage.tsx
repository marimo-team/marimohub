import { useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppsQuery } from '@/api/apps';
import { Project } from '@/components/Project/Project';
import { Button } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

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
	const query = useAppsQuery(pid);
	if (query.isError)
		return (
			<AppAccessError
				error={query.error}
				onRetry={() => void query.refetch()}
				isRetrying={query.isFetching}
			/>
		);
	if (!query.data) return <p className="p-6">Loading project…</p>;
	return query.data.pages[0].project?.your_role === 'app-user' ? (
		<Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />
	) : (
		<Project />
	);
}

export function AppsPage() {
	const [params] = useSearchParams();
	const [search, setSearch] = useState('');
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
	const groups = new Map<string, typeof items>();
	for (const item of items) {
		const group = groups.get(item.project_id) ?? [];
		group.push(item);
		groups.set(item.project_id, group);
	}
	return (
		<section className="min-w-0 flex-1 overflow-auto p-6">
			<title>Apps · marimohub</title>
			<div className="mx-auto max-w-6xl space-y-6">
				<h1 className="text-2xl font-semibold">Apps</h1>
				<input
					aria-label="Search apps"
					placeholder="Search apps"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
				/>
				{query.isPending ? (
					<p>Loading apps…</p>
				) : items.length === 0 ? (
					<p className="text-muted-foreground">
						No apps available{debouncedSearch ? ' matching your search' : ''}.
					</p>
				) : null}
				{[...groups].map(([pid, apps]) => (
					<section key={pid} className="space-y-3">
						<h2 className="text-lg font-medium">{apps[0].project_name}</h2>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{apps.map((app) => (
								<Link
									key={app.notebook_id}
									to={app.url}
									className="rounded-lg border bg-card p-5 text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<h3 className="font-medium">{app.title}</h3>
									<p className="mt-2 text-sm text-muted-foreground">
										{app.can.run ? 'Open app' : 'App access is unavailable for your role'}
									</p>
								</Link>
							))}
						</div>
					</section>
				))}
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
