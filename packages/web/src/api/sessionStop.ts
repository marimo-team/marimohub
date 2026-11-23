import { sleep } from '@marimo-hub/core/duration';
import type { Session } from '@/types';
import { apiClient, apiData, ApiRequestError } from './client';
import { isNotFoundError } from './request';

export type StopDecision = 'retry' | 'keep' | 'force';
export class SessionKeptRunningError extends Error {
	constructor(readonly session: Session) {
		super('The session was kept running.');
		this.name = 'SessionKeptRunningError';
	}
}

type DecisionRequest = { session: Session; resolve: (decision: StopDecision) => void };
const queue: DecisionRequest[] = [];
const listeners = new Set<() => void>();
export const subscribeStopDecision = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export const currentStopDecision = () => queue[0];
const notify = () => {
	for (const listener of listeners) listener();
};
export function decideStop(decision: StopDecision) {
	queue.shift()?.resolve(decision);
	notify();
}
function ask(session: Session): Promise<StopDecision> {
	return new Promise((resolve) => {
		queue.push({ session, resolve });
		notify();
	});
}

type StoppedSession = { projectId: string; notebookId: string; sessionId: string };
const stoppedListeners = new Set<(session: StoppedSession) => void>();

export function subscribeSessionStopped(listener: (session: StoppedSession) => void) {
	stoppedListeners.add(listener);
	return () => {
		stoppedListeners.delete(listener);
	};
}

export async function stopSessionSafely(
	projectId: string,
	notebookId: string,
	sessionId: string,
	decision = ask,
	signal?: AbortSignal,
): Promise<void> {
	await stopSessionRequest(projectId, notebookId, sessionId, decision, signal);
	for (const listener of stoppedListeners) listener({ projectId, notebookId, sessionId });
}

async function stopSessionRequest(
	projectId: string,
	notebookId: string,
	sessionId: string,
	decision = ask,
	signal?: AbortSignal,
): Promise<void> {
	const path = { pid: projectId, nid: notebookId, sid: sessionId };
	let previousId: string | undefined;
	let force = false;
	for (;;) {
		const key = crypto.randomUUID();
		let error: unknown;
		try {
			const result = await apiClient.DELETE(
				'/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}',
				{
					params: {
						path,
						query: {
							wait: 'true',
							force: force ? 'true' : 'false',
							previous_attempt_id: previousId,
						},
						header: { 'idempotency-key': key },
					},
					timeout: 120_000,
					signal,
				},
			);
			await apiData(Promise.resolve(result));
			if (result.response.status === 200) return;
		} catch (cause) {
			signal?.throwIfAborted();
			if (isNotFoundError(cause)) return;
			error = cause;
		}
		// A lost HTTP reply is reconciled against the durable attempt before another mutation.
		let retained: Session | undefined;
		for (let poll = 0; poll < 120; poll++) {
			const session = await apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', {
					params: { path },
					signal,
				}),
			).catch((cause: unknown) => {
				signal?.throwIfAborted();
				if (isNotFoundError(cause)) return null;
				// The stop may already be accepted; a transient server error is not an answer.
				if (cause instanceof ApiRequestError && (cause.status ?? 0) >= 500) return;
				throw cause;
			});
			if (session === null) return;
			if (session === undefined) {
				await sleep(1000, signal);
				continue;
			}
			if (session.stop?.outcome === 'stopped' || (session.status === 'terminated' && !session.stop))
				return;
			if (session.stop && ['retained', 'uncertain'].includes(session.stop.outcome)) {
				retained = session;
				break;
			}
			if (!session.stop)
				throw error instanceof Error ? error : new Error('Stop was not accepted. Retry shortly.');
			await sleep(1000, signal);
		}
		if (!retained)
			throw new Error(
				'The stop is still in progress. The session status will update when it finishes.',
			);
		const action = await decision(retained);
		if (action === 'keep') throw new SessionKeptRunningError(retained);
		previousId = retained.stop!.id;
		force = action === 'force';
	}
}
