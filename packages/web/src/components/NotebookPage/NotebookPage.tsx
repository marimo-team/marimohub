import { useEffect, useRef, useCallback, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui';
import { useStartSession, useStopSession } from '@/api/hooks';
import type { Session } from '@/types';

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

export function NotebookPage() {
	const { pid, nid } = useParams<{ pid: string; nid: string }>();
	const navigate = useNavigate();
	const location = useLocation();

	const notebookTitle = (location.state as { title?: string } | null)?.title ?? nid ?? 'Notebook';

	const startSession = useStartSession(pid!, nid!);
	const stopSession = useStopSession(pid!, nid!);

	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sessionRef = useRef<Session | null>(null);
	const startedRef = useRef(false);

	const handleStop = useCallback(() => {
		const s = sessionRef.current;
		if (s) {
			stopSession.mutate(s.session_id);
			sessionRef.current = null;
			setSession(null);
		}
		navigate(`/projects/${pid}`);
	}, [stopSession, navigate, pid]);

	// Start session on mount (guarded against React strict mode double-fire)
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		startSession.mutate(undefined, {
			onSuccess: (data) => {
				setSession(data);
				sessionRef.current = data;
			},
			onError: (err) => {
				setError(err.message);
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Heartbeat interval
	useEffect(() => {
		if (!session || session.status !== 'running') return;

		const interval = setInterval(() => {
			fetch(`/api/projects/${pid}/notebooks/${nid}/sessions/${session.session_id}/heartbeat`, {
				method: 'POST',
			}).catch(() => {});
		}, HEARTBEAT_INTERVAL_MS);

		return () => clearInterval(interval);
	}, [session, pid, nid]);

	// Cleanup on unmount / beforeunload
	useEffect(() => {
		const cleanup = () => {
			const s = sessionRef.current;
			if (s) {
				fetch(`/api/projects/${pid}/notebooks/${nid}/sessions/${s.session_id}`, {
					method: 'DELETE',
					keepalive: true,
				});
			}
		};

		window.addEventListener('beforeunload', cleanup);
		return () => {
			window.removeEventListener('beforeunload', cleanup);
			cleanup();
		};
	}, [pid, nid]);

	const isProvisioning = startSession.isPending || session?.status === 'starting';
	const isRunning = session?.status === 'running' && session.sandbox_url;

	return (
		<div className="flex h-screen flex-col">
			<header className="flex h-10 min-h-10 items-center gap-2 border-b bg-background px-3 max-md:h-11 max-md:min-h-11">
				<Button
					variant="unstyled"
					className="flex size-7 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:size-11"
					onPress={handleStop}
					aria-label="Back to project"
				>
					<ArrowLeft className="size-4" />
				</Button>
				<div className="h-5 w-px bg-border" />
				<span className="truncate text-[13px] font-medium">{notebookTitle}</span>
				<div className="ml-auto flex items-center gap-2">
					{isProvisioning && (
						<span
							className="size-2 shrink-0 rounded-full bg-yellow-500 animate-pulse"
							title="Starting"
						/>
					)}
					{isRunning && (
						<span className="size-2 shrink-0 rounded-full bg-green-500" title="Running" />
					)}
					{error && <span className="size-2 shrink-0 rounded-full bg-destructive" title="Error" />}
					{session && (
						<Button
							variant="unstyled"
							className="flex h-[26px] items-center rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive max-md:min-h-11"
							onPress={handleStop}
						>
							Stop
						</Button>
					)}
				</div>
			</header>

			{isProvisioning && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
					<div
						className={cn(
							'size-8 rounded-full border-[3px] border-border border-t-primary',
							'animate-spin',
						)}
					/>
					<p>Starting sandbox...</p>
				</div>
			)}

			{isRunning && (
				<div className="flex-1 overflow-hidden">
					<iframe
						className="size-full border-0"
						src={session.sandbox_url}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
						allow="clipboard-read; clipboard-write"
						title={notebookTitle}
					/>
				</div>
			)}

			{error && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<p className="max-w-md text-sm text-destructive">{error}</p>
					<div className="flex gap-2">
						<Button
							variant="primary"
							onPress={() => {
								setError(null);
								startSession.mutate(undefined, {
									onSuccess: (data) => {
										setSession(data);
										sessionRef.current = data;
									},
									onError: (err) => {
										setError(err.message);
									},
								});
							}}
						>
							Retry
						</Button>
						<Button variant="ghost" onPress={() => navigate(`/projects/${pid}`)}>
							Back
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
