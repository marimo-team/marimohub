import { createUIMessageStream } from 'ai';
import type { UIMessageChunk } from 'ai';
import {
	ChatPermissionStore,
	ChatTurnStoppedError,
	ConversationService,
} from '@marimo-hub/core/chat';
import type { Conversation, PermissionDecision } from '@marimo-hub/core/chat';
import { sleep } from '@marimo-hub/core';
import type { NotebookId } from '@marimo-hub/core';
import { DomainError, UnavailableError } from '@marimo-hub/core/errors';
import { DEFAULT_CHAT_CONFIG } from '../context';
import type { ApiDeps } from '../context';
import { logEvent } from '../log';
import type { StartRequestContext } from '../mcp/server';
import { withRequestMemo } from '../requestMemo';
import { loadAuthorizedNotebookMeta } from '../shared';
import { authorizeConversation, chatPrincipalDeadline } from './access';
import type { ConversationOperationContext } from './access';
import { registerLiveTurn, stopLiveTurn, subscribeLiveTurn } from './liveTurns';
import { permissionBroker, permissionKey } from './permissions/broker';
import { openToolSession } from './tools';
import { runTurn } from './turn';

export { assertConversationPrincipal, chatAvailable } from './access';
export type { ConversationOperationContext } from './access';

const CONTEXT_NOTEBOOKS = 30;
const STREAM_FAILURE =
	'The response could not complete. Check tool activity before retrying; completed changes remain saved.';

function conversations(deps: ApiDeps, leaseDurationMs?: number): ConversationService {
	return new ConversationService(deps.bucket, Date.now, leaseDurationMs ? { leaseDurationMs } : {});
}

export async function listConversations(input: ConversationOperationContext) {
	await authorizeConversation(input);
	return { conversations: await conversations(input.deps).list(input.pid, input.principal.id) };
}

export async function getConversation(input: ConversationOperationContext & { cid: string }) {
	await authorizeConversation(input);
	return {
		conversation: await conversations(input.deps).get(input.pid, input.principal.id, input.cid),
	};
}

export async function createConversation(input: ConversationOperationContext & { title?: string }) {
	await authorizeConversation(input);
	return {
		conversation: await conversations(input.deps).create(
			input.pid,
			input.principal.id,
			input.title,
		),
	};
}

export async function deleteConversation(input: ConversationOperationContext & { cid: string }) {
	await authorizeConversation(input);
	await conversations(input.deps).delete(input.pid, input.principal.id, input.cid);
	return { deleted: true as const };
}

export async function updateConversation(
	input: ConversationOperationContext & { cid: string; working_notebook: NotebookId | null },
) {
	const project = await authorizeConversation(input);
	if (input.working_notebook !== null)
		await loadAuthorizedNotebookMeta(
			input.deps,
			project,
			input.working_notebook,
			input.principal,
			'project.read',
		);
	return {
		conversation: await conversations(input.deps).setWorkingNotebook(
			input.pid,
			input.principal.id,
			input.cid,
			input.working_notebook,
		),
	};
}

export async function dismissContinuation(input: ConversationOperationContext & { cid: string }) {
	await authorizeConversation(input);
	return {
		conversation: await conversations(input.deps).dismissContinuation(
			input.pid,
			input.principal.id,
			input.cid,
		),
	};
}

/** Stop the running turn wherever it runs: locally at once, elsewhere through the claim flag. */
export async function stopConversation(input: ConversationOperationContext & { cid: string }) {
	await authorizeConversation(input);
	const durable = await conversations(input.deps).requestStop(
		input.pid,
		input.principal.id,
		input.cid,
	);
	const local = stopLiveTurn(input.pid, input.cid, new ChatTurnStoppedError());
	return { stopped: durable || local };
}

const DECISION_RETRY = { attempts: 10, delayMs: 200 };

/**
 * Answer a consent card. The card streams to the client slightly before it is
 * written to the head, so a fast click can arrive first; wait briefly for the
 * card to land before calling the request closed.
 */
export async function decidePermission(
	input: ConversationOperationContext & { cid: string; rid: string; decision: PermissionDecision },
) {
	await authorizeConversation(input);
	const service = conversations(input.deps);
	let outcome: Awaited<ReturnType<ConversationService['decidePermission']>> = 'missing';
	for (let attempt = 0; attempt < DECISION_RETRY.attempts; attempt++) {
		outcome = await service.decidePermission(
			input.pid,
			input.principal.id,
			input.cid,
			input.rid,
			input.decision,
		);
		if (outcome !== 'missing') break;
		input.signal?.throwIfAborted();
		await (input.deps.sleep ?? sleep)(DECISION_RETRY.delayMs);
	}
	const accepted = outcome === 'accepted';
	if (accepted)
		permissionBroker.decide(permissionKey(input.pid, input.cid, input.rid), input.decision);
	return { accepted, ...(accepted ? {} : { reason: 'closed' as const }) };
}

export async function listChatPermissions(input: ConversationOperationContext) {
	await authorizeConversation(input);
	return {
		grants: await new ChatPermissionStore(input.deps.bucket).list(input.pid, input.principal.id),
	};
}

export async function revokeChatPermission(
	input: ConversationOperationContext & { grant_id: string },
) {
	await authorizeConversation(input);
	return {
		removed: await new ChatPermissionStore(input.deps.bucket).revoke(
			input.pid,
			input.principal.id,
			input.grant_id,
		),
	};
}

export interface TurnInput extends ConversationOperationContext {
	cid: string;
	content?: string;
	resume?: boolean;
	acknowledgeUncertain?: boolean;
	/** Whether the caller can show consent cards and wait for answers. */
	canPrompt?: boolean;
	/** Receives the live chunk stream for the requesting client. */
	publish?(chunk: UIMessageChunk): void;
	/** Called once the turn is claimed and the model starts. */
	onStarted?(): void;
	/** Keep the turn running when the request signal aborts (streaming clients reconnect). */
	detachClient?: boolean;
}

function streamErrorText(error: unknown): string {
	return error instanceof DomainError ? error.message : STREAM_FAILURE;
}

/**
 * Run one turn end to end: authorize, open the tool session, claim the turn,
 * stream the model, and release the claim. Tool access is re-authorized on every
 * call and the whole turn is re-authorized before the answer is accepted.
 */
export async function executeTurn(input: TurnInput): Promise<{ conversation: Conversation }> {
	const { deps, principal, pid, cid } = input;
	const project = await authorizeConversation(input);
	const ai = deps.ai!;
	const model = ai.languageModel!;
	const chat = ai.chat ?? DEFAULT_CHAT_CONFIG;
	const taskTimeoutMs = chat.taskTimeoutSeconds * 1000;
	const service = conversations(deps, Math.min(960_000, Math.max(60_000, taskTimeoutMs + 60_000)));
	const controller = new AbortController();
	const request: StartRequestContext = {
		method: 'POST',
		path: `/projects/${pid}/conversations/${cid}/messages`,
		hostname: input.appBaseUrl ? new URL(input.appBaseUrl).hostname : 'localhost',
		appBaseUrl: input.appBaseUrl ?? '',
		signal: controller.signal,
	};
	const session = await openToolSession(deps, principal, project, request);
	try {
		const complete = async (
			messages: Conversation['messages'],
			turn: Parameters<Parameters<ConversationService['send']>[4]>[1],
		) => {
			input.onStarted?.();
			const live = registerLiveTurn(pid, cid, controller);
			const onClientAbort = () =>
				controller.abort(new UnavailableError('The request was cancelled'));
			const deadline = Math.max(
				0,
				Math.min(taskTimeoutMs, chatPrincipalDeadline(principal) - Date.now()),
			);
			const timer = setTimeout(
				() => controller.abort(new UnavailableError('The response timed out. Please retry.')),
				deadline,
			);
			if (!input.detachClient) {
				input.signal?.addEventListener('abort', onClientAbort, { once: true });
				if (input.signal?.aborted) onClientAbort();
			}
			const signal = AbortSignal.any([controller.signal, turn.stopSignal]);
			try {
				signal.throwIfAborted();
				const notebooks = await deps.services.notebooks.listNotebooks(pid, {
					subject: principal,
					policy: deps.policy,
					resourceSecurity: deps.resourceSecurity,
				});
				const current = await service.get(pid, principal.id, cid);
				const context = JSON.stringify({
					project: { name: project.name, description: project.description.slice(0, 2000) },
					working_notebook: current.working_notebook ?? null,
					notebooks: notebooks
						.slice(0, CONTEXT_NOTEBOOKS)
						.map((n) => ({ id: n.id, title: n.title.slice(0, 200), status: n.status })),
					notebook_count: notebooks.length,
					notebooks_has_more: notebooks.length > CONTEXT_NOTEBOOKS,
				});
				const publish = (chunk: UIMessageChunk) => {
					live.publish(chunk);
					input.publish?.(chunk);
				};
				let parts: Awaited<ReturnType<typeof runTurn>>;
				try {
					parts = await runTurn({
						deps,
						model,
						context,
						messages,
						turn,
						session,
						signal,
						createdAt: new Date().toISOString(),
						publish,
						trace: { project_id: pid, conversation_id: cid },
						buildTools: (emit) =>
							session.buildTools({
								turn,
								conversationId: cid,
								canPrompt: input.canPrompt ?? false,
								signal,
								emit,
								onNotebookCreated: async (notebookId) => {
									const latest = await service.get(pid, principal.id, cid);
									if (latest.working_notebook) return;
									await service.setWorkingNotebook(pid, principal.id, cid, notebookId);
									publish({
										type: 'data-working-notebook',
										data: { notebook_id: notebookId },
										transient: true,
									});
								},
							}),
					});
				} catch (error) {
					if (!(error instanceof ChatTurnStoppedError))
						logEvent({
							level: 'warn',
							event: 'chat_turn_failed',
							project_id: pid,
							conversation_id: cid,
							error_name: error instanceof Error ? error.name : typeof error,
							aborted: controller.signal.aborted,
						});
					if (error instanceof DomainError) throw error;
					if (controller.signal.aborted && controller.signal.reason instanceof Error)
						throw controller.signal.reason;
					throw new UnavailableError(STREAM_FAILURE);
				}
				// Access may have changed during a long turn; never publish an answer the
				// caller could no longer have asked for. A fresh scope skips the turn-start context.
				await authorizeConversation({ ...input, deps: withRequestMemo(deps), signal: undefined });
				return parts;
			} catch (error) {
				live.publish({ type: 'error', errorText: streamErrorText(error) });
				throw error;
			} finally {
				clearTimeout(timer);
				input.signal?.removeEventListener('abort', onClientAbort);
				live.publish({ type: 'finish' });
				live.release();
				controller.abort();
			}
		};
		const conversation = input.resume
			? await service.resume(pid, principal.id, cid, complete, {
					acknowledgeUncertain: input.acknowledgeUncertain,
					readOnlyToolNames: session.readOnlyToolNames,
				})
			: await service.send(pid, principal.id, cid, input.content ?? '', complete, {
					readOnlyToolNames: session.readOnlyToolNames,
				});
		return { conversation };
	} finally {
		await session.close();
	}
}

/**
 * Run a turn as a UI message stream. The turn keeps running after the client
 * disconnects; `started` rejects with the claim error when it never begins, so
 * the route can answer with a normal error envelope instead of an SSE body.
 */
export function streamTurn(input: Omit<TurnInput, 'publish' | 'onStarted' | 'detachClient'>) {
	const started = Promise.withResolvers<void>();
	const done = Promise.withResolvers<{ conversation: Conversation }>();
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			try {
				const result = await executeTurn({
					...input,
					canPrompt: true,
					detachClient: true,
					onStarted: () => started.resolve(),
					publish: (chunk) => writer.write(chunk),
				});
				writer.write({ type: 'finish' });
				done.resolve(result);
			} catch (error) {
				started.reject(error);
				done.reject(error);
				throw error;
			}
		},
		onError: streamErrorText,
	});
	done.promise.catch(() => {});
	return { stream, started: started.promise, done: done.promise };
}

/** Re-attach to the turn running here for this conversation, or null when none runs here. */
export async function reconnectTurn(input: ConversationOperationContext & { cid: string }) {
	await authorizeConversation(input);
	await conversations(input.deps).get(input.pid, input.principal.id, input.cid);
	return subscribeLiveTurn(input.pid, input.cid);
}
