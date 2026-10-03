import { usePreviewSession } from '@/hooks/usePreviewSession';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui';
import { NotebookFrame } from '@/components/NotebookPage/NotebookFrame';
import { useNotebookFrameLocation } from '@/hooks/useNotebookFrameLocation';
import { useTheme } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import { copyPreviewLink } from './copyPreviewLink';
import { PreviewBadge } from './PreviewsPage';

export function PreviewPage() {
	const { pid = '', nid = '', previewId = '' } = useParams();
	const { user } = useAuth();
	if (!user) return null;
	return (
		<PreviewRuntime
			key={`${user.id}/${pid}/${nid}/${previewId}`}
			userId={user.id}
			pid={pid}
			nid={nid}
			previewId={previewId}
		/>
	);
}
function PreviewRuntime({
	pid,
	nid,
	previewId,
	userId,
}: {
	pid: string;
	nid: string;
	previewId: string;
	userId: string;
}) {
	const { preview, runtime, start, session, sessionEnded, startupTimedOut, sandboxUrl } =
		usePreviewSession(pid, nid, previewId, userId);
	const { theme } = useTheme();
	const frame = useNotebookFrameLocation(sandboxUrl, theme, runtime?.mode === 'app');
	if (preview.isError)
		return (
			<main className="p-6" role="alert">
				This preview is unavailable or you no longer have access.
			</main>
		);
	if (!preview.data) return <p className="p-6">Loading preview…</p>;
	const record = preview.data;
	return (
		<div className="flex h-dvh flex-col">
			<header className="flex flex-wrap items-center gap-3 border-b p-3">
				<Link to={`/projects/${pid}/notebooks/${nid}/previews`} className="text-sm">
					Previews
				</Link>
				<h1 className="font-medium">{record.name}</h1>
				<PreviewBadge preview={record} />
				<span className="text-xs text-muted-foreground">
					{record.commit ? `Latest: ${record.commit.slice(0, 12)}` : 'Awaiting first revision'}
				</span>
				<Button variant="default" onPress={() => void copyPreviewLink(record.url)}>
					Copy link
				</Button>
				{record.can.app && (
					<Button
						isDisabled={start.isPending || !record.commit}
						onPress={() => start.mutate('app')}
					>
						{runtime?.mode === 'edit'
							? 'Discard edits and open app'
							: runtime
								? 'Open latest app'
								: 'Open app'}
					</Button>
				)}
				{record.can.edit && (
					<Button
						variant="default"
						isDisabled={start.isPending || !record.commit}
						onPress={() => start.mutate('edit')}
					>
						{runtime?.mode === 'edit' ? 'Discard edits and open latest' : 'Open temporary editor'}
					</Button>
				)}
			</header>
			{runtime?.mode === 'edit' && (
				<p className="border-b bg-muted px-4 py-2 text-sm">
					Temporary preview editor · Changes stay in your sandbox and will be discarded.
				</p>
			)}
			{runtime?.version && record.version_id && runtime.version !== record.version_id && (
				<p className="border-b px-4 py-2 text-sm">
					A newer revision is available. Your session is still running its original commit.
				</p>
			)}
			{record.error && (
				<p role="alert" className="px-4 py-2 text-sm">
					{record.error} {record.commit && 'Serving the last prepared revision.'}
				</p>
			)}
			{start.isError && (
				<p role="alert" className="p-4">
					{start.error.message}
				</p>
			)}
			{sessionEnded && (
				<p role="alert" className="p-4">
					This session has ended or is unavailable. Open the preview again.
				</p>
			)}
			{startupTimedOut && (
				<p role="alert" className="p-4">
					The preview did not start in time. Open the preview again.
				</p>
			)}
			{session.isError && !sessionEnded && !startupTimedOut && (
				<output className="block p-4">Unable to check the session. Retrying…</output>
			)}
			{start.isPending ||
			(runtime &&
				!sessionEnded &&
				!startupTimedOut &&
				(!session.data || session.data.status === 'starting')) ? (
				<output className="p-6">Starting preview…</output>
			) : sandboxUrl ? (
				<div className="min-h-0 flex-1">
					<NotebookFrame
						key={frame.frameKey}
						src={frame.iframeSrc}
						retrySrc={frame.latestSrc}
						sandboxUrl={sandboxUrl}
						onQuery={frame.onQuery}
						title={record.name}
					/>
				</div>
			) : !runtime ? (
				<p className="p-6 text-sm text-muted-foreground">
					Choose an app or temporary editor to open this preview.
				</p>
			) : null}
		</div>
	);
}
