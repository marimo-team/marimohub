import { useMutation, useMutationState } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { SURFACE_LABELS } from '@/lib/surfaces';
import type { SecondarySurfaceId, Surface } from '@/types';
import { apiClient, apiData } from './client';
import { useInvalidate } from './mutation';
import { sessionKeys } from './queryKeys';

const SURFACE_POLL_INTERVAL_MS = 1_000;
export const SURFACE_START_TIMEOUT_MS = 180_000;

interface StartSurfaceVariables {
	surfaceId: SecondarySurfaceId;
	sessionId: string;
	open?: string;
}

interface StopSurfaceVariables {
	surfaceId: SecondarySurfaceId;
	sessionId: string;
}

interface SurfaceActionState {
	sessionId: string;
	surface: Surface;
}

function surfaceParams(projectId: string, notebookId: string, variables: StopSurfaceVariables) {
	return {
		path: {
			pid: projectId,
			nid: notebookId,
			sid: variables.sessionId,
			surface: variables.surfaceId,
		},
	};
}

function abortError(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function useSurfaceActions(projectId: string, notebookId: string) {
	const [states, setStates] = useState<Partial<Record<SecondarySurfaceId, SurfaceActionState>>>({});
	const invalidate = useInvalidate();
	// A start can poll for minutes; unmounting must end the loop rather than let
	// it keep hitting the API (and setting state) for a page that is gone.
	const lifetime = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		lifetime.current = controller;
		return () => controller.abort();
	}, []);
	const startKey = ['surface', projectId, notebookId, 'start'] as const;
	const stopKey = ['surface', projectId, notebookId, 'stop'] as const;
	const start = useMutation({
		mutationKey: startKey,
		mutationFn: async (variables: StartSurfaceVariables) => {
			const { surfaceId, open } = variables;
			const params = surfaceParams(projectId, notebookId, variables);
			const signal = lifetime.current?.signal;
			let surface = await apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}', {
					params,
					body: open ? { open } : {},
					signal,
				}),
			);
			const deadline = Date.now() + SURFACE_START_TIMEOUT_MS;
			while (surface.status === 'starting' && Date.now() < deadline) {
				await delay(SURFACE_POLL_INTERVAL_MS, signal);
				surface = await apiData(
					apiClient.GET(
						'/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}',
						{ params, signal },
					),
				);
			}
			if (surface.status !== 'ready' || !surface.url) {
				throw new Error(surface.last_error ?? `${SURFACE_LABELS[surfaceId]} did not become ready`);
			}
			return surface;
		},
		onSuccess: (surface, { surfaceId, sessionId }) => {
			setStates((current) => ({ ...current, [surfaceId]: { sessionId, surface } }));
			invalidate(sessionKeys.listByProject(projectId));
		},
	});
	const stop = useMutation({
		mutationKey: stopKey,
		mutationFn: (variables: StopSurfaceVariables) =>
			apiData(
				apiClient.DELETE(
					'/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}',
					{ params: surfaceParams(projectId, notebookId, variables) },
				),
			),
		onSuccess: (_, { surfaceId, sessionId }) => {
			setStates((current) => ({
				...current,
				[surfaceId]: { sessionId, surface: { status: 'stopped' } },
			}));
			invalidate(sessionKeys.listByProject(projectId));
		},
	});
	const starting = new Set(
		useMutationState({
			filters: { mutationKey: startKey, status: 'pending', exact: true },
			select: (mutation) => (mutation.state.variables as StartSurfaceVariables).surfaceId,
		}),
	);
	const stopping = new Set(
		useMutationState({
			filters: { mutationKey: stopKey, status: 'pending', exact: true },
			select: (mutation) => (mutation.state.variables as StopSurfaceVariables).surfaceId,
		}),
	);

	return { start, stop, states, starting, stopping };
}
