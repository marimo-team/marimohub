import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { apiClient, apiData, ApiRequestError } from './client';
import { notebookKeys } from './queryKeys';

export function workingBranchKey(pid: string, nid: string) {
	return ['working-branch', pid, nid] as const;
}

export function useWorkingBranch(pid: string, nid: string, enabled = true) {
	return useQuery({
		queryKey: workingBranchKey(pid, nid),
		enabled,
		retry: false,
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/working-branch', {
					params: { path: { pid, nid } },
				}),
			),
		staleTime: 60_000,
	});
}

export function useSaveToBranch(pid: string, nid: string) {
	const client = useQueryClient();
	const attempt = useRef<{ scope: string; key: string } | undefined>(undefined);
	return useMutation({
		mutationFn: async ({
			sessionId,
			operationId,
		}: {
			sessionId?: string;
			operationId?: string;
		}) => {
			if (operationId)
				return apiData(
					apiClient.POST(
						'/api/v1/projects/{pid}/notebooks/{nid}/working-branch/saves/{save_id}/retry',
						{
							params: { path: { pid, nid, save_id: operationId } },
						},
					),
				);
			if (!sessionId) throw new Error('Start an edit session before saving');
			const scope = JSON.stringify([pid, nid, sessionId]);
			if (attempt.current?.scope !== scope) attempt.current = { scope, key: crypto.randomUUID() };
			const currentAttempt = attempt.current;
			try {
				return await apiData(
					apiClient.POST(
						'/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/working-branch/saves',
						{
							params: {
								path: { pid, nid, sid: sessionId },
								header: { 'idempotency-key': currentAttempt.key },
							},
							body: {},
						},
					),
				);
			} catch (error) {
				if (
					error instanceof ApiRequestError &&
					error.status !== undefined &&
					error.status >= 400 &&
					error.status < 500 &&
					attempt.current === currentAttempt
				)
					attempt.current = undefined;
				throw error;
			}
		},
		onSuccess: (data) => {
			if (
				attempt.current?.scope ===
					JSON.stringify([data.project_id, data.notebook_id, data.session_id]) &&
				['complete', 'no_changes', 'conflict', 'expired'].includes(data.state)
			)
				attempt.current = undefined;
		},
		onSettled: () =>
			Promise.all([
				client.invalidateQueries({ queryKey: workingBranchKey(pid, nid) }),
				client.invalidateQueries({ queryKey: notebookKeys.detail(pid, nid) }),
			]),
	});
}

export function useOpenBranchPR(pid: string, nid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/working-branch/change-request', {
					// The branch has at most one PR, so a fresh key per attempt cannot open a duplicate.
					params: { path: { pid, nid }, header: { 'idempotency-key': crypto.randomUUID() } },
					body: { draft: true },
				}),
			),
		onSettled: () => client.invalidateQueries({ queryKey: workingBranchKey(pid, nid) }),
	});
}
