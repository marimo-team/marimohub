import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { NotebookChangeRequest } from '../types';
import { apiClient, apiData } from './client';
import { isApiErrorCode } from './request';

export type PublishChangeRequestAction = 'open' | 'update' | 'create-new';

export interface PublishNotebookChangeRequestInput {
	sessionId: string;
	title?: string;
	action: PublishChangeRequestAction;
}

interface PublishAttempt {
	idempotencyKey: string;
}

interface ScopedChangeRequest {
	scope: string;
	value: NotebookChangeRequest;
}

export function notebookChangeRequestScope(projectId: string, notebookId: string): string {
	return JSON.stringify([projectId, notebookId]);
}

function publishAttemptKey(scope: string, signature: string): string {
	return JSON.stringify([scope, signature]);
}

export function useNotebookChangeRequestPublisher(projectId: string, notebookId: string) {
	const scope = notebookChangeRequestScope(projectId, notebookId);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const [published, setPublished] = useState<ScopedChangeRequest>();
	const [mutationScope, setMutationScope] = useState<string>();
	const attempts = useRef(new Map<string, PublishAttempt>());
	const mutation = useMutation({
		mutationFn: async ({ sessionId, title, action }: PublishNotebookChangeRequestInput) => {
			const activeChangeRequest = published?.scope === scope ? published.value : undefined;
			const targetProposalId = action === 'update' ? activeChangeRequest?.proposal_id : undefined;
			if (action === 'update' && !targetProposalId) {
				throw new Error('Cannot update a change request before one has been opened');
			}
			const signature = `${action}:${targetProposalId ?? ''}`;
			const attemptKey = publishAttemptKey(scope, signature);
			let requestAttempt = attempts.current.get(attemptKey);
			if (!requestAttempt) {
				requestAttempt = { idempotencyKey: crypto.randomUUID() };
				attempts.current.set(attemptKey, requestAttempt);
			}
			try {
				const data = await apiData(
					apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests', {
						params: {
							path: { pid: projectId, nid: notebookId, sid: sessionId },
							header: { 'idempotency-key': requestAttempt.idempotencyKey },
						},
						body: {
							...(title ? { title } : {}),
							...(targetProposalId ? { target_proposal_id: targetProposalId } : {}),
						},
						timeout: 120_000,
					}),
				);
				if (currentScope.current === scope && attempts.current.get(attemptKey) === requestAttempt) {
					attempts.current.delete(attemptKey);
					setPublished({ scope, value: data });
				}
				return data;
			} catch (error) {
				if (
					attempts.current.get(attemptKey) === requestAttempt &&
					isApiErrorCode(error, 'PROPOSAL_RETRY_REQUIRED')
				) {
					attempts.current.delete(attemptKey);
				}
				throw error;
			}
		},
		onMutate: () => {
			setMutationScope(scope);
		},
	});
	const activeChangeRequest = published?.scope === scope ? published.value : undefined;
	const mutationIsInScope = mutationScope === scope;
	return {
		...mutation,
		data: mutationIsInScope ? mutation.data : undefined,
		error: mutationIsInScope ? mutation.error : null,
		isError: mutationIsInScope && mutation.isError,
		isIdle: !mutationIsInScope || mutation.isIdle,
		isPending: mutationIsInScope && mutation.isPending,
		isSuccess: mutationIsInScope && mutation.isSuccess,
		status: mutationIsInScope ? mutation.status : ('idle' as const),
		variables: mutationIsInScope ? mutation.variables : undefined,
		activeChangeRequest,
	};
}
