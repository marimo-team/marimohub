import { useParams } from 'react-router-dom';
import { useDeepLinkQuery } from '@/api/deepLinks';
import { isNotFoundError } from '@/api/request';
import { Button } from '@/components/ui';
import { AppEntryPage } from '@/components/Apps/AppEntryPage';

export function AppLinkPage() {
	const { slug = '' } = useParams<{ slug: string }>();
	const query = useDeepLinkQuery(slug);
	if (query.isError) {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6" role="alert">
				<h1 className="text-lg font-semibold">
					{isNotFoundError(query.error) ? 'App link not found' : 'Unable to open app'}
				</h1>
				<p className="text-sm text-muted-foreground">
					{isNotFoundError(query.error)
						? 'This link is unavailable or you do not have access.'
						: query.error.message}
				</p>
				{!isNotFoundError(query.error) && (
					<Button onPress={() => void query.refetch()}>Try again</Button>
				)}
			</div>
		);
	}
	// A remounted route must resolve again before it can start a session for a reused slug.
	if (!query.data || !query.isFetchedAfterMount) {
		return (
			<output className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
				Opening app…
			</output>
		);
	}
	const { target } = query.data;
	return (
		<AppEntryPage
			key={`${target.project_id}/${target.notebook_id}`}
			variant="app"
			target={{ projectId: target.project_id, notebookId: target.notebook_id }}
		/>
	);
}
