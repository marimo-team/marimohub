import { CalendarClock } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useCapabilitiesQuery, useJobNotebooksQuery, useProjectQuery } from '@/api/hooks';
import { Button, EmptyState, ListContainer, Page, RowLink } from '@/components/ui';

export function ProjectJobsPage() {
	const { pid = '' } = useParams();
	const project = useProjectQuery(pid);
	const capabilities = useCapabilitiesQuery();
	const notebooks = useJobNotebooksQuery(pid, capabilities.data?.jobs?.available === true);
	const items = notebooks.data?.pages.flatMap((page) => page.items) ?? [];
	if (capabilities.isPending)
		return (
			<output className="m-auto p-8 text-sm text-muted-foreground">
				Checking job availability…
			</output>
		);
	if (capabilities.isError)
		return (
			<div role="alert" className="m-auto space-y-3 p-8">
				<p>Could not check job availability.</p>
				<Button onPress={() => void capabilities.refetch()}>Retry</Button>
			</div>
		);
	if (!capabilities.data.jobs?.available)
		return (
			<div className="m-auto p-8">
				<EmptyState
					icon={<CalendarClock />}
					message="Jobs are not enabled"
					description="Scheduled notebook runs are unavailable on this deployment."
				/>
			</div>
		);
	return (
		<Page
			title="Jobs"
			context={project.data.name}
			subtitle="Schedule notebook runs and inspect their results."
		>
			{notebooks.isPending ? (
				<output className="block text-sm text-muted-foreground">Loading notebooks…</output>
			) : notebooks.isError && !notebooks.data ? (
				<div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
					<p>{notebooks.error.message}</p>
					<Button size="sm" className="mt-3" onPress={() => void notebooks.refetch()}>
						Retry
					</Button>
				</div>
			) : items.length === 0 ? (
				<EmptyState
					icon={<CalendarClock />}
					message="No notebooks yet"
					description="Create a notebook before adding a scheduled run."
				/>
			) : (
				<ListContainer>
					{items.map((notebook) => (
						<RowLink
							key={notebook.id}
							to={`/projects/${encodeURIComponent(pid)}/notebooks/${encodeURIComponent(notebook.id)}/jobs`}
							leading={
								<span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
									<CalendarClock className="size-4" aria-hidden />
								</span>
							}
							contentClassName="flex-col gap-0.5"
						>
							<span className="truncate text-sm font-medium">{notebook.title}</span>
							<span className="text-xs text-muted-foreground">
								Manage schedules and run history
							</span>
						</RowLink>
					))}
				</ListContainer>
			)}
			{notebooks.isFetchNextPageError ? (
				<div role="alert" className="mt-4 space-y-2">
					<p>Could not load more notebooks.</p>
					<Button onPress={() => void notebooks.fetchNextPage()}>Retry loading notebooks</Button>
				</div>
			) : notebooks.hasNextPage ? (
				<Button
					className="mt-4"
					isDisabled={notebooks.isFetchingNextPage}
					onPress={() => void notebooks.fetchNextPage()}
				>
					Load more notebooks
				</Button>
			) : null}
		</Page>
	);
}
