import { HelpMenu } from '@/components/Header/HelpMenu';
import { AnnouncementBanner } from '@/components/Shell/AnnouncementBanner';
import { hasNotebookPreviews } from '@/api/previews';
import { PageTitle } from '@/components/ui/PageTitle';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAppQuery } from '@/api/apps';
import { ApiRequestError } from '@/api/client';
import {
	editorSessionQueryOptions,
	projectQueryOptions,
	useCapabilitiesQuery,
	useUserQuery,
} from '@/api/hooks';
import { NotebookPage } from '@/components/NotebookPage/NotebookPage';
import { NotebookFrame } from '@/components/NotebookPage/NotebookFrame';
import { ShareUrlMenu } from '@/components/NotebookPage/ShareMenu';
import { Button } from '@/components/ui';
import { Callout } from '@/components/ui/Callout';
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
	// A moving notebook reopens without a reload once a manager cancels the move.
	const query = useAppQuery(pid, nid, {
		refetchIntervalMs: (error) => (isMoveInProgress(error) ? 30_000 : undefined),
	});
	const user = useUserQuery();
	const canLoadProject = !!user.data && !user.data.app_only;
	const project = useQuery({ ...projectQueryOptions(pid), enabled: canLoadProject });
	const { data: capabilities } = useCapabilitiesQuery();
	const projectRole = project.data?.your_role;
	// The project's `your_role` and the app's come from the same server-side role
	// resolution, so a fresh non-app-user project role opens the editor without
	// waiting for `/app`, which still reroutes an app-user when it answers.
	const projectGrantsEditor =
		canLoadProject &&
		project.isSuccess &&
		!project.isStale &&
		!!projectRole &&
		projectRole !== 'app-user';
	// Viewers never take the editor lease, so wait for a role that does.
	const prefetchEditorSession =
		variant === 'edit' &&
		projectGrantsEditor &&
		projectRole !== 'viewer' &&
		capabilities?.editor_sandbox_sharing === 'exclusive';
	const queryClient = useQueryClient();
	useEffect(() => {
		if (prefetchEditorSession) void queryClient.prefetchQuery(editorSessionQueryOptions(pid, nid));
	}, [queryClient, pid, nid, prefetchEditorSession]);
	const entryKey = `${pid}/${nid}`;
	const [projectGateKey, setProjectGateKey] = useState<string | null>(null);
	// Latched: moving to the direct NotebookPage branch later would remount the editor
	// and restart its session.
	const projectGated =
		projectGateKey === entryKey ||
		(query.data === undefined &&
			((query.isError && !isMoveInProgress(query.error)) || projectGrantsEditor));
	if (projectGated && projectGateKey !== entryKey) setProjectGateKey(entryKey);
	if (isMoveInProgress(query.error)) return <NotebookMovingNotice pid={pid} />;
	if (query.data?.your_role === 'app-user') {
		if (variant === 'edit') return <Navigate to={`${query.data.url}${location.search}`} replace />;
		return (
			<StakeholderApp
				key={entryKey}
				pid={pid}
				nid={nid}
				title={query.data.title}
				canRun={query.data.can.run}
			/>
		);
	}
	if (projectGated)
		return (
			<NotebookFallback
				key={entryKey}
				pid={pid}
				nid={nid}
				variant={variant}
				error={query.error}
				user={user}
			/>
		);
	if (!query.data) return <p className="p-6">Opening app…</p>;
	return <NotebookPage variant={variant} target={{ projectId: pid, notebookId: nid }} />;
}

function isMoveInProgress(error: Error | null): boolean {
	return error instanceof ApiRequestError && error.code === 'MOVE_IN_PROGRESS';
}

function NotebookMovingNotice({ pid }: { pid: string }) {
	return (
		<div className="flex flex-1 items-center justify-center p-6">
			<Callout variant="info" className="flex max-w-md flex-col gap-2">
				<p className="font-medium">This notebook is being moved</p>
				<p className="text-muted-foreground">
					It opens in its new project once the move finishes, or here if a project manager cancels
					it.
				</p>
				<Link to={`/projects/${pid}`} className="text-primary underline-offset-4 hover:underline">
					Back to project
				</Link>
			</Callout>
		</div>
	);
}

function NotebookFallback({
	pid,
	nid,
	variant,
	error,
	user,
}: {
	pid: string;
	nid: string;
	variant: 'app' | 'edit';
	error: Error | null;
	user: ReturnType<typeof useUserQuery>;
}) {
	const canLoadProject = !!user.data && !user.data.app_only;
	const [projectReady, setProjectReady] = useState(false);
	const project = useQuery({
		...projectQueryOptions(pid),
		enabled: canLoadProject,
		retry: false,
	});
	// Wait for initial access validation without interrupting later background refreshes.
	if (!projectReady && canLoadProject && project.isSuccess && !project.isFetching)
		setProjectReady(true);
	if (user.isPending || (canLoadProject && !projectReady && project.isFetching))
		return <p className="p-6">Opening notebook…</p>;
	// Once open, only a confirmed loss of access closes the notebook; a transient refresh
	// failure keeps the last successful user and project data.
	const projectFailed = projectReady ? isAccessError(project.error, [403, 404]) : project.isError;
	const userFailed = projectReady ? isAccessError(user.error, [401, 403]) : user.isError;
	if (
		userFailed ||
		user.data?.app_only ||
		projectFailed ||
		!project.data?.your_role ||
		project.data.your_role === 'app-user'
	)
		return (
			<AppAccessError
				error={error ?? project.error ?? user.error ?? new Error('You cannot open this notebook.')}
			/>
		);
	return <NotebookPage variant={variant} target={{ projectId: pid, notebookId: nid }} />;
}

function isAccessError(error: unknown, statuses: number[]): boolean {
	return (
		error instanceof ApiRequestError &&
		error.status !== undefined &&
		statuses.includes(error.status)
	);
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
			<PageTitle>{title}</PageTitle>
			<header className="flex min-h-12 items-center gap-4 border-b px-4">
				<Link to="/apps" className="text-sm text-muted-foreground hover:text-foreground">
					Back to apps
				</Link>
				<h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
				{hasNotebookPreviews(capabilities) && (
					<Link to={`/projects/${pid}/notebooks/${nid}/previews`} className="text-sm">
						Previews
					</Link>
				)}
				<HelpMenu linkRole="app-user" />
				<ShareUrlMenu label="Share app" successMessage="App URL copied" />
			</header>
			<AnnouncementBanner />
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
						title={title}
					/>
				</div>
			)}
		</div>
	);
}
