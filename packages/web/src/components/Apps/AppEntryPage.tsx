import { useState } from 'react';
import { PageTitle } from '@/components/ui/PageTitle';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAppQuery } from '@/api/apps';
import { projectQueryOptions, useCapabilitiesQuery, useUserQuery } from '@/api/hooks';
import { NotebookPage } from '@/components/NotebookPage/NotebookPage';
import { NotebookFrame } from '@/components/NotebookPage/NotebookFrame';
import { ShareUrlMenu } from '@/components/NotebookPage/ShareMenu';
import { Button } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import { useNotebookSession } from '@/hooks/useNotebookSession';
import { useNotebookFrameLocation } from '@/hooks/useNotebookFrameLocation';
import { AppAccessError } from './AppsPage';

export function AppEntryPage({
	variant = 'app',
	target,
}: {
	variant?: 'app' | 'edit';
	target?: { projectId: string; notebookId: string };
}) {
	const params = useParams();
	const pid = target?.projectId ?? params.pid ?? '';
	const nid = target?.notebookId ?? params.nid ?? '';
	const location = useLocation();
	const query = useAppQuery(pid, nid);
	if (query.isError)
		return <NotebookFallback pid={pid} nid={nid} variant={variant} error={query.error} />;
	if (!query.data) return <p className="p-6">Opening app…</p>;
	if (query.data.your_role !== 'app-user')
		return <NotebookPage variant={variant} target={{ projectId: pid, notebookId: nid }} />;
	if (variant === 'edit') return <Navigate to={`${query.data.url}${location.search}`} replace />;
	return (
		<StakeholderApp
			key={`${pid}/${nid}`}
			pid={pid}
			nid={nid}
			title={query.data.title}
			canRun={query.data.can.run}
		/>
	);
}

function NotebookFallback({
	pid,
	nid,
	variant,
	error,
}: {
	pid: string;
	nid: string;
	variant: 'app' | 'edit';
	error: Error;
}) {
	const user = useUserQuery();
	const project = useQuery({
		...projectQueryOptions(pid),
		enabled: !!user.data && !user.data.app_only,
		retry: false,
	});
	if (
		user.isPending ||
		(user.data && !user.data.app_only && !project.isFetchedAfterMount && project.isFetching)
	)
		return <p className="p-6">Opening notebook…</p>;
	if (
		user.isError ||
		user.data?.app_only ||
		project.isError ||
		!project.data?.your_role ||
		project.data.your_role === 'app-user'
	)
		return <AppAccessError error={error} />;
	return <NotebookPage variant={variant} target={{ projectId: pid, notebookId: nid }} />;
}

function StakeholderApp({
	pid,
	nid,
	title,
	canRun,
}: {
	pid: string;
	nid: string;
	title: string;
	canRun: boolean;
}) {
	const [documentTitle, onTitle] = useState<string | null>(null);
	const { data: capabilities } = useCapabilitiesQuery();
	const { sandboxUrl, isProvisioning, error, ended, start } = useNotebookSession(pid, nid, {
		enabled: canRun,
		mode: 'app',
		startupTimeoutSeconds: capabilities?.sandbox_startup_timeout_seconds,
		appHeartbeatIntervalSeconds: capabilities?.app_pool?.heartbeat_interval_seconds,
	});
	const { theme } = useTheme();
	const {
		iframeSrc: src,
		frameKey,
		latestSrc,
		onQuery,
	} = useNotebookFrameLocation(sandboxUrl, theme, true);
	return (
		<div className="flex h-dvh flex-col">
			<PageTitle>{documentTitle ?? title}</PageTitle>
			<header className="flex min-h-12 items-center gap-4 border-b px-4">
				<Link to="/apps" className="text-sm text-muted-foreground hover:text-foreground">
					Back to apps
				</Link>
				<h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
				<ShareUrlMenu label="Share app" successMessage="App URL copied" />
			</header>
			{!canRun ? (
				<p className="p-6">You cannot run this app.</p>
			) : error || ended ? (
				<div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
					<p>
						{error?.code === 'RESOURCE_EXHAUSTED'
							? 'App is busy. Try again shortly.'
							: error
								? 'The app could not start. Contact its owner.'
								: 'This app session has ended.'}
					</p>
					{ended !== 'access_lost' ? (
						<Button onPress={start}>{error ? 'Retry' : 'Open app'}</Button>
					) : null}
				</div>
			) : isProvisioning || !src ? (
				<output className="p-6">Starting app…</output>
			) : (
				<div className="min-h-0 flex-1">
					<NotebookFrame
						key={frameKey}
						src={src}
						retrySrc={latestSrc}
						sandboxUrl={sandboxUrl}
						onQuery={onQuery}
						onTitle={onTitle}
						title={title}
					/>
				</div>
			)}
		</div>
	);
}
