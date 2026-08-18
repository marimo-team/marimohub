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
	scope: string;
	signature: string;
	idempotencyKey: string;
}

interface ScopedChangeRequest {
	scope: string;
	value: NotebookChangeRequest;
}

export function notebookChangeRequestScope(projectId: string, notebookId: string): string {
	return JSON.stringify([projectId, notebookId]);
}

export function useNotebookChangeRequestPublisher(projectId: string, notebookId: string) {
	const scope = notebookChangeRequestScope(projectId, notebookId);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const [published, setPublished] = useState<ScopedChangeRequest>();
	const [mutationScope, setMutationScope] = useState<string>();
	const attempt = useRef<PublishAttempt | undefined>(undefined);
	const mutation = useMutation({
		mutationFn: async ({ sessionId, title, action }: PublishNotebookChangeRequestInput) => {
			const activeChangeRequest = published?.scope === scope ? published.value : undefined;
			const targetProposalId = action === 'update' ? activeChangeRequest?.proposal_id : undefined;
			if (action === 'update' && !targetProposalId) {
				throw new Error('Cannot update a change request before one has been opened');
			}
			const signature = `${action}:${targetProposalId ?? ''}`;
			if (attempt.current?.scope !== scope || attempt.current.signature !== signature) {
				attempt.current = { scope, signature, idempotencyKey: crypto.randomUUID() };
			}
			const requestAttempt = attempt.current;
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
				if (currentScope.current === scope && attempt.current === requestAttempt) {
					attempt.current = undefined;
					setPublished({ scope, value: data });
				}
				return data;
			} catch (error) {
				if (
					attempt.current === requestAttempt &&
					isApiErrorCode(error, 'PROPOSAL_RETRY_REQUIRED')
				) {
					attempt.current = undefined;
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
