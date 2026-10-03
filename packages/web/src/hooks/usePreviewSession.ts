import { APP_HEARTBEAT_INTERVAL_MS } from '@marimo-hub/core/constants';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient, apiData, ApiRequestError } from '@/api/client';
import { usePreviewQuery } from '@/api/previews';
import { SESSION_LIFECYCLE_TIMEOUT_MS, useCapabilitiesQuery } from '@/api/hooks';
import { leaveAppVisit } from '@/api/sessionVisits';
import {
	EDITOR_HEARTBEAT_INTERVAL_MS,
	SESSION_STATUS_INTERVAL_MS,
	SESSION_START_POLL_INTERVAL_MS,
	sessionStartupDeadlineMs,
} from '@/lib/sessions';

type Runtime = {
	userId: string;
	startedAt: number;
	nid: string;
	sid: string;
	mode: 'app' | 'edit';
	version?: string;
	assignment?: { visit_id: string; generation: string };
};
function isTerminalSessionError(error: unknown): boolean {
	return (
		error instanceof ApiRequestError &&
		error.status !== undefined &&
		[403, 404, 409].includes(error.status)
	);
}

function isEndedSession(session: { status: string; sandbox_url?: string } | undefined): boolean {
	return (
		!!session &&
		(session.status === 'running' ? !session.sandbox_url : session.status !== 'starting')
	);
}

function readRuntime(key: string, userId: string): Runtime | null {
	try {
		const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Runtime | null;
		return value &&
			typeof value.nid === 'string' &&
			typeof value.sid === 'string' &&
			value.userId === userId &&
			value.mode === 'edit'
			? { ...value, startedAt: Date.now() }
			: null;
	} catch {
		return null;
	}
}

export function usePreviewSession(pid: string, nid: string, previewId: string, userId: string) {
	const storageKey = `preview-session:${userId}:${pid}:${nid}:${previewId}`;
	const [runtime, setRuntime] = useState<Runtime | null>(() => readRuntime(storageKey, userId));
	const [timedOutRuntime, setTimedOutRuntime] = useState<Runtime | null>(null);
	const lastHeartbeat = useRef<{ runtime: Runtime | null; at: number } | null>(null);
	const startupTimedOut = !!runtime && timedOutRuntime === runtime;
	const preview = usePreviewQuery(pid, nid, previewId);
	const capabilities = useCapabilitiesQuery();
	const heartbeatInterval =
		runtime?.mode === 'app'
			? (capabilities.data?.app_pool?.heartbeat_interval_seconds ??
					APP_HEARTBEAT_INTERVAL_MS / 1000) * 1000
			: EDITOR_HEARTBEAT_INTERVAL_MS;
	const start = useMutation({
		mutationFn: async (mode: 'app' | 'edit') => {
			if (runtime?.mode === 'edit')
				await apiData(
					apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', {
						params: { path: { pid, nid: runtime.nid, sid: runtime.sid } },
						timeout: SESSION_LIFECYCLE_TIMEOUT_MS,
					}),
				).catch((error: unknown) => {
					if (!isTerminalSessionError(error)) throw error;
				});

			return apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/previews/{preview_id}/sessions', {
					params: { path: { pid, nid, preview_id: previewId } },
					body: { mode, ...(mode === 'app' ? { app_visit_id: crypto.randomUUID() } : {}) },
					timeout: SESSION_LIFECYCLE_TIMEOUT_MS,
				}),
			);
		},
		onSuccess: (session, mode) => {
			const next: Runtime = {
				userId,
				startedAt: Date.now(),
				nid: session.notebook_id,
				sid: session.session_id,
				mode,
				version: session.origin?.revision_id,
				assignment: session.app_assignment,
			};
			setRuntime(next);
			if (mode === 'edit') sessionStorage.setItem(storageKey, JSON.stringify(next));
			else sessionStorage.removeItem(storageKey);
		},
	});
	const session = useQuery({
		queryKey: [
			'preview-session',
			userId,
			pid,
			previewId,
			runtime?.nid,
			runtime?.sid,
			runtime?.assignment?.visit_id,
		],
		queryFn: async () => {
			const params = { path: { pid, nid: runtime!.nid, sid: runtime!.sid } };
			if (
				runtime?.mode === 'edit' &&
				lastHeartbeat.current?.runtime === runtime &&
				Date.now() - lastHeartbeat.current.at < heartbeatInterval
			) {
				return apiData(
					apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', { params }),
				);
			}
			const response = await apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat', {
					params,
					...(runtime?.assignment ? { body: runtime.assignment } : {}),
				}),
			);
			lastHeartbeat.current = { runtime, at: Date.now() };
			return response;
		},
		enabled: !!runtime && !!preview.data && !preview.isError && !startupTimedOut,
		refetchInterval: (query) =>
			isTerminalSessionError(query.state.error) || isEndedSession(query.state.data)
				? false
				: runtime?.mode === 'app'
					? heartbeatInterval
					: query.state.data?.status === 'running'
						? SESSION_STATUS_INTERVAL_MS
						: SESSION_START_POLL_INTERVAL_MS,
		refetchIntervalInBackground: true,
		retry: false,
		gcTime: 0,
	});
	const sessionEnded = isTerminalSessionError(session.error) || isEndedSession(session.data);
	const startupTimeoutMs = sessionStartupDeadlineMs(
		capabilities.data?.sandbox_startup_timeout_seconds,
	);
	useEffect(() => {
		if (!runtime || sessionEnded || session.data?.status === 'running' || startupTimedOut) return;
		const timer = window.setTimeout(
			() => setTimedOutRuntime(runtime),
			Math.max(0, runtime.startedAt + startupTimeoutMs - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [runtime, sessionEnded, session.data?.status, startupTimedOut, startupTimeoutMs]);
	useEffect(() => {
		const leave = () => {
			if (runtime)
				leaveAppVisit(pid, runtime.nid, {
					session_id: runtime.sid,
					app_assignment: runtime.assignment,
				});
		};
		const onPageHide = (event: PageTransitionEvent) => {
			if (!event.persisted) leave();
		};
		window.addEventListener('pagehide', onPageHide);
		return () => {
			window.removeEventListener('pagehide', onPageHide);
			leave();
		};
	}, [pid, runtime]);
	const sandboxUrl =
		!sessionEnded && !startupTimedOut && !preview.isError && session.data?.status === 'running'
			? session.data.sandbox_url
			: undefined;
	return { preview, runtime, start, session, sessionEnded, startupTimedOut, sandboxUrl };
}
