import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
	ValidationError,
} from '../../errors';
import {
	CHAT_LIMITS,
	ConversationIdSchema,
	ConversationIndexSchema,
	ConversationMessagePartSchema,
	ConversationObservationSchema,
	ConversationSchema,
	StoredConversationSchema,
	conversationTextLength,
	messageText,
	summarizeConversation,
} from './schema';
import type {
	Conversation,
	ConversationContinuation,
	ConversationMessage,
	ConversationMessagePart,
	ConversationPermission,
	ConversationSummary,
	PermissionDecision,
	StoredConversation,
} from './schema';

export interface ConversationServiceOptions {
	/** How long a claimed turn stays exclusive without a finish (60s–960s). */
	leaseDurationMs?: number;
	/** How often the turn owner re-reads its head for a stop request. */
	stopPollMs?: number;
}

export type TurnCheckpoint =
	| { type: 'tool_started'; id: string; name: string }
	| {
			type: 'tool_completed';
			id: string;
			name: string;
			result: string;
			outcome?: 'known' | 'uncertain';
	  }
	| { type: 'paused'; reason: 'tool_limit' | 'context_limit' };

/** What a turn runner receives while it owns the claimed turn. */
export interface TurnContext {
	assistantMessageId: string;
	/** The saved task to continue, when this turn resumes an interrupted one. */
	continuation?: ConversationContinuation;
	/** An interrupted task retained as context without automatically resuming it. */
	review?: ConversationContinuation;
	/** Aborted when the user requests a stop from any replica, or the claim is lost. */
	stopSignal: AbortSignal;
	/** Replace the assistant message's parts. Serialized and fenced by the claim. */
	saveParts(parts: readonly ConversationMessagePart[]): Promise<void>;
	checkpoint(event: TurnCheckpoint): Promise<void>;
}

/**
 * Produces the assistant reply for one turn. Returns the final parts; the
 * service persists them and releases the claim.
 */
export type CompleteTurn = (
	messages: Conversation['messages'],
	turn: TurnContext,
) => Promise<readonly ConversationMessagePart[]>;

/** Thrown by a turn runner when it ends because the user asked it to stop. */
export class ChatTurnStoppedError extends ConflictError {
	constructor(message = 'The response was stopped.') {
		super(message);
		this.name = 'ChatTurnStoppedError';
	}
}

const DEFAULT_TITLE = 'New conversation';
const FAILED_MESSAGE =
	'The response stopped before it finished. Review tool activity and continue the saved task.';

export class ConversationService {
	private readonly leaseDurationMs: number;
	private readonly stopPollMs: number;
	constructor(
		private readonly bucket: Bucket,
		private readonly now: () => number = Date.now,
		options: ConversationServiceOptions = {},
	) {
		this.leaseDurationMs = options.leaseDurationMs ?? 240_000;
		this.stopPollMs = options.stopPollMs ?? 2000;
		if (
			!Number.isSafeInteger(this.leaseDurationMs) ||
			this.leaseDurationMs < 60_000 ||
			this.leaseDurationMs > 960_000
		)
			throw new ValidationError('Conversation lease must be between 60 and 960 seconds');
	}

	private key(pid: ProjectId, owner: UserId, id: string): string {
		if (!ConversationIdSchema.safeParse(id).success)
			throw new NotFoundError('Conversation not found');
		return paths.conversation(pid, owner, id);
	}

	private indexKey(pid: ProjectId, owner: UserId): string {
		return paths.conversationIndex(pid, owner);
	}

	private live(pending: StoredConversation['pending']): boolean {
		return pending !== undefined && Date.parse(pending.expires_at) > this.now();
	}

	private async read(pid: ProjectId, owner: UserId, id: string) {
		const key = this.key(pid, owner, id);
		const body = await this.bucket.get(key);
		if (!body) throw new NotFoundError('Conversation not found');
		const conversation = await readStored(StoredConversationSchema, body, key);
		if (conversation.deleted_at) throw new NotFoundError('Conversation not found');
		// A turn whose lease lapsed without a finish was interrupted (crash, lost
		// replica). Surface that at read time; the next write persists it.
		if (conversation.continuation?.status === 'running' && !this.live(conversation.pending)) {
			conversation.pending = undefined;
			conversation.continuation = {
				...conversation.continuation,
				status: conversation.continuation.unresolved_calls.length > 0 ? 'needs_review' : 'paused',
				reason: 'interrupted',
			};
			const last = conversation.messages.at(-1);
			if (last?.role === 'assistant' && last.parts.length === 0)
				conversation.messages = conversation.messages.slice(0, -1);
		}
		return { key, body, conversation };
	}

	private async mutate(
		pid: ProjectId,
		owner: UserId,
		id: string,
		change: (head: StoredConversation) => void,
	): Promise<StoredConversation> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const { key, body, conversation } = await this.read(pid, owner, id);
			change(conversation);
			const next = StoredConversationSchema.parse(conversation);
			try {
				await this.bucket.put(key, JSON.stringify(next), { onlyIfEtagMatches: body.etag });
				return next;
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
		}
		throw new ConflictError('Conversation changed. Retry the request');
	}

	private async liveIds(pid: ProjectId, owner: UserId, ids: readonly string[]) {
		const live = await Promise.all(
			ids.map(async (id) => {
				try {
					await this.read(pid, owner, id);
					return id;
				} catch (error) {
					if (error instanceof NotFoundError) return null;
					throw error;
				}
			}),
		);
		return live.filter((id): id is string => id !== null);
	}

	async list(pid: ProjectId, owner: UserId): Promise<ConversationSummary[]> {
		const key = this.indexKey(pid, owner);
		const index = await this.bucket.get(key);
		const ids = index ? (await readStored(ConversationIndexSchema, index, key)).ids : [];
		const entries = await Promise.all(
			ids.map(async (id) => {
				try {
					return summarizeConversation(
						ConversationSchema.parse((await this.read(pid, owner, id)).conversation),
					);
				} catch (error) {
					if (error instanceof NotFoundError) return null;
					throw error;
				}
			}),
		);
		return entries
			.filter((entry): entry is ConversationSummary => entry !== null)
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	}

	async get(pid: ProjectId, owner: UserId, id: string): Promise<Conversation> {
		return ConversationSchema.parse((await this.read(pid, owner, id)).conversation);
	}

	async create(pid: ProjectId, owner: UserId, title = DEFAULT_TITLE): Promise<Conversation> {
		const trimmed = title.trim();
		if (trimmed.length === 0 || trimmed.length > 120)
			throw new ValidationError('Title must contain 1–120 characters');
		const timestamp = new Date(this.now()).toISOString();
		const conversation: Conversation = {
			schema_version: 1,
			id: ulid(),
			title: trimmed,
			created_at: timestamp,
			updated_at: timestamp,
			messages: [],
		};
		const key = this.key(pid, owner, conversation.id);
		await this.bucket.put(key, JSON.stringify(conversation), { onlyIfNotExists: true });
		const indexKey = this.indexKey(pid, owner);
		try {
			for (let attempt = 0; attempt < 8; attempt++) {
				const head = await this.bucket.get(indexKey);
				const index = head
					? await readStored(ConversationIndexSchema, head, indexKey)
					: { schema_version: 1 as const, ids: [] };
				const ids = await this.liveIds(pid, owner, index.ids);
				if (ids.length >= CHAT_LIMITS.conversationsPerProject)
					throw new ResourceExhaustedError(
						`Project conversation limit reached (${CHAT_LIMITS.conversationsPerProject} per person)`,
					);
				try {
					await this.bucket.put(
						indexKey,
						JSON.stringify({ schema_version: 1, ids: [...ids, conversation.id] }),
						head ? { onlyIfEtagMatches: head.etag } : { onlyIfNotExists: true },
					);
					return conversation;
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
				}
			}
			throw new ConflictError('Conversations changed; please retry');
		} catch (error) {
			// A lost PUT response may still have published the ID; check before cleanup.
			let published: boolean;
			try {
				const head = await this.bucket.get(indexKey);
				published = head
					? (await readStored(ConversationIndexSchema, head, indexKey)).ids.includes(
							conversation.id,
						)
					: false;
			} catch {
				throw error;
			}
			if (published) return this.get(pid, owner, conversation.id);
			await this.bucket.delete(key);
			throw error;
		}
	}

	async delete(pid: ProjectId, owner: UserId, id: string): Promise<void> {
		const key = this.key(pid, owner, id);
		const body = await this.bucket.get(key);
		if (!body) throw new NotFoundError('Conversation not found');
		const conversation = await readStored(StoredConversationSchema, body, key);
		if (!conversation.deleted_at) {
			if (this.live(conversation.pending))
				throw new ConflictError('Wait for the active response before deleting this conversation');
			try {
				await this.bucket.put(
					key,
					JSON.stringify({ ...conversation, deleted_at: new Date(this.now()).toISOString() }),
					{ onlyIfEtagMatches: body.etag },
				);
			} catch (error) {
				if (error instanceof PreconditionFailedError)
					throw new ConflictError('Conversation changed; refresh and retry');
				throw error;
			}
		}
		const indexKey = this.indexKey(pid, owner);
		for (let attempt = 0; attempt < 8; attempt++) {
			const head = await this.bucket.get(indexKey);
			if (!head) break;
			const index = await readStored(ConversationIndexSchema, head, indexKey);
			if (!index.ids.includes(id)) break;
			try {
				await this.bucket.put(
					indexKey,
					JSON.stringify({ ...index, ids: index.ids.filter((entry) => entry !== id) }),
					{ onlyIfEtagMatches: head.etag },
				);
				break;
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
				if (attempt === 7) throw new ConflictError('Conversations changed; please retry deletion');
			}
		}
		await this.bucket.delete(key);
	}

	async setWorkingNotebook(
		pid: ProjectId,
		owner: UserId,
		id: string,
		notebook: NotebookId | null,
	): Promise<Conversation> {
		return ConversationSchema.parse(
			await this.mutate(pid, owner, id, (head) => {
				head.working_notebook = notebook ?? undefined;
				head.updated_at = new Date(this.now()).toISOString();
			}),
		);
	}

	/** Drop the saved task without resuming it. Refused while a turn is running. */
	async dismissContinuation(pid: ProjectId, owner: UserId, id: string): Promise<Conversation> {
		return ConversationSchema.parse(
			await this.mutate(pid, owner, id, (head) => {
				if (this.live(head.pending))
					throw new ConflictError('Wait for the active response before dismissing the task');
				head.continuation = undefined;
				head.last_error = undefined;
				head.updated_at = new Date(this.now()).toISOString();
			}),
		);
	}

	/**
	 * Ask the running turn to stop. The flag lives on the claim so the replica
	 * that owns the turn sees it on its next head read. Returns false when no
	 * turn is running.
	 */
	async requestStop(pid: ProjectId, owner: UserId, id: string): Promise<boolean> {
		let stopped = false;
		await this.mutate(pid, owner, id, (head) => {
			if (!this.live(head.pending)) return;
			head.pending = { ...head.pending!, stop_requested: true };
			stopped = true;
		});
		return stopped;
	}

	/** The consent card for `requestId` on the running turn, or why it cannot be answered. */
	private openPermission(
		head: StoredConversation,
		requestId: string,
	): { permission: ConversationPermission; turnId: string } | 'cancelled' | 'expired' {
		if (!this.live(head.pending)) return 'cancelled';
		const message = head.messages.at(-1);
		if (message?.role !== 'assistant') return 'cancelled';
		const part = message.parts.find(
			(part) => part.type === 'data-permission' && part.id === requestId,
		);
		if (part?.type !== 'data-permission') return 'cancelled';
		if (Date.parse(part.data.expires_at) <= this.now()) return 'expired';
		if (['expired', 'cancelled', 'unavailable'].includes(part.data.status)) return 'cancelled';
		return { permission: part.data, turnId: head.pending!.id };
	}

	private recordedDecision(head: StoredConversation, turnId: string, requestId: string) {
		return head.permission_decisions?.find(
			(entry) => entry.turn_id === turnId && entry.request_id === requestId,
		)?.decision;
	}

	/**
	 * Record a consent decision for a card of the running turn. `missing` means
	 * the card is not on the saved head yet; a caller that just saw it stream may
	 * retry briefly before treating the request as closed.
	 */
	async decidePermission(
		pid: ProjectId,
		owner: UserId,
		id: string,
		requestId: string,
		decision: PermissionDecision,
	): Promise<'accepted' | 'rejected' | 'missing'> {
		let outcome: 'accepted' | 'rejected' | 'missing' = 'rejected';
		await this.mutate(pid, owner, id, (head) => {
			outcome = 'rejected';
			if (!this.live(head.pending)) return;
			const open = this.openPermission(head, requestId);
			if (open === 'cancelled') {
				outcome = 'missing';
				return;
			}
			if (open === 'expired') return;
			const existing = this.recordedDecision(head, open.turnId, requestId);
			if (existing) {
				outcome = existing === decision ? 'accepted' : 'rejected';
				return;
			}
			if (open.permission.status !== 'open') return;
			head.permission_decisions = [
				...(head.permission_decisions ?? []),
				{ turn_id: open.turnId, request_id: requestId, decision },
			];
			outcome = 'accepted';
		});
		return outcome;
	}

	/** The turn owner polls this to pick up decisions recorded by any replica. */
	async permissionDecision(
		pid: ProjectId,
		owner: UserId,
		id: string,
		requestId: string,
	): Promise<PermissionDecision | 'expired' | 'cancelled' | undefined> {
		let head: StoredConversation;
		try {
			head = (await this.read(pid, owner, id)).conversation;
		} catch (error) {
			if (error instanceof NotFoundError) return 'cancelled';
			throw error;
		}
		const open = this.openPermission(head, requestId);
		if (typeof open === 'string') return open;
		return this.recordedDecision(head, open.turnId, requestId);
	}

	async resume(
		pid: ProjectId,
		owner: UserId,
		id: string,
		complete: CompleteTurn,
		options: { acknowledgeUncertain?: boolean; readOnlyToolNames?: ReadonlySet<string> } = {},
	): Promise<Conversation> {
		return this.send(pid, owner, id, 'Continue the interrupted task.', complete, {
			...options,
			resume: true,
		});
	}

	/**
	 * Run one assistant turn: append the user message, claim the turn with a
	 * lease, let `complete` stream parts into the empty assistant message, then
	 * release the claim. Every head write during the turn is fenced by the claim
	 * id, so a reclaimed or deleted conversation stops a stale runner.
	 */
	async send(
		pid: ProjectId,
		owner: UserId,
		id: string,
		content: string,
		complete: CompleteTurn,
		options: {
			resume?: boolean;
			acknowledgeUncertain?: boolean;
			readOnlyToolNames?: ReadonlySet<string>;
		} = {},
	): Promise<Conversation> {
		const text = content.trim();
		if (!text || text.length > CHAT_LIMITS.messageCharacters)
			throw new ValidationError(
				`Message must contain 1–${CHAT_LIMITS.messageCharacters} characters`,
			);
		const readOnly = options.readOnlyToolNames ?? new Set<string>();
		const { key, body, conversation: previous } = await this.read(pid, owner, id);
		if (this.live(previous.pending)) throw new ConflictError('A response is already in progress');
		if (options.resume && !previous.continuation)
			throw new ConflictError('There is no interrupted task to resume');
		if (
			options.resume &&
			previous.continuation!.unresolved_calls.length > 0 &&
			!options.acknowledgeUncertain
		)
			throw new ConflictError(
				'A tool may have completed without a saved result. Inspect its resources and acknowledge the uncertainty before resuming.',
			);
		// A new message after an interruption keeps the old task visible to the model
		// without resuming it, unless only read-only calls were left unresolved.
		const review =
			!options.resume &&
			previous.continuation?.unresolved_calls.some(({ name }) => !readOnly.has(name))
				? previous.continuation
				: undefined;
		if (
			conversationTextLength(previous.messages) + text.length + CHAT_LIMITS.answerCharacters >
				CHAT_LIMITS.conversationCharacters ||
			previous.messages.length > CHAT_LIMITS.messagesPerConversation
		)
			throw new ValidationError('Conversation is full; start a new conversation');

		const savedTask = options.resume ? previous.continuation : review;
		const timestamp = new Date(this.now()).toISOString();
		const pending = {
			id: ulid(),
			expires_at: new Date(this.now() + this.leaseDurationMs).toISOString(),
		};
		const assistantId = ulid();
		const claimed: StoredConversation = StoredConversationSchema.parse({
			...previous,
			title: previous.messages.length > 0 ? previous.title : text.slice(0, 120),
			updated_at: timestamp,
			pending,
			permission_decisions: undefined,
			last_error: undefined,
			continuation: {
				status: 'running',
				task: savedTask?.task ?? text,
				observations: savedTask?.observations ?? [],
				omitted_observations: savedTask?.omitted_observations,
				unresolved_calls: review?.unresolved_calls ?? [],
			},
			messages: [
				...previous.messages,
				{
					id: ulid(),
					role: 'user',
					metadata: { created_at: timestamp },
					parts: [{ type: 'text', text }],
				},
				{ id: assistantId, role: 'assistant', metadata: { created_at: timestamp }, parts: [] },
			],
		} satisfies StoredConversation);
		try {
			await this.bucket.put(key, JSON.stringify(claimed), { onlyIfEtagMatches: body.etag });
		} catch (error) {
			if (error instanceof PreconditionFailedError)
				throw new ConflictError('Conversation changed; refresh and retry');
			throw error;
		}

		const stop = new AbortController();
		// Part saves and checkpoints are read-modify-write cycles on one ETag; run
		// them one at a time so concurrent read-only tools never lose a CAS race.
		let headWrites: Promise<unknown> = Promise.resolve();
		const serialized = <T>(task: () => Promise<T>): Promise<T> => {
			const next = headWrites.then(task, task);
			headWrites = next.then(
				() => {},
				() => {},
			);
			return next;
		};
		const saveTurn = async (
			change: (latest: StoredConversation) => StoredConversation,
		): Promise<StoredConversation> => {
			for (let attempt = 0; attempt < 8; attempt++) {
				const current = await this.bucket.get(key);
				if (!current) throw new PreconditionFailedError('Conversation was deleted');
				const latest = await readStored(StoredConversationSchema, current, key);
				if (latest.deleted_at || latest.pending?.id !== pending.id) {
					stop.abort(new ChatTurnStoppedError('The turn claim changed.'));
					throw new PreconditionFailedError('Turn claim changed');
				}
				if (latest.pending.stop_requested) stop.abort(new ChatTurnStoppedError());
				const next = StoredConversationSchema.parse(change(latest));
				try {
					await this.bucket.put(key, JSON.stringify(next), { onlyIfEtagMatches: current.etag });
					return next;
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
				}
			}
			throw new ConflictError('Conversation changed during the turn');
		};
		const replaceAssistant = (
			latest: StoredConversation,
			update: (message: ConversationMessage) => ConversationMessage,
		): ConversationMessage[] => {
			const last = latest.messages.at(-1);
			if (last?.id !== assistantId) throw new PreconditionFailedError('Turn claim changed');
			return [...latest.messages.slice(0, -1), update(last)];
		};
		const stamp = () => new Date(this.now()).toISOString();
		const validateParts = (parts: readonly ConversationMessagePart[]) => {
			const result = z.array(ConversationMessagePartSchema).max(80).safeParse(parts);
			if (!result.success) throw new ValidationError('Invalid assistant response');
			return result.data;
		};
		const saveParts = (parts: readonly ConversationMessagePart[]) =>
			serialized(async () => {
				const validated = validateParts(parts);
				await saveTurn((latest) => ({
					...latest,
					updated_at: stamp(),
					messages: replaceAssistant(latest, (message) => ({ ...message, parts: validated })),
				}));
			});
		const checkpoint = (event: TurnCheckpoint) =>
			serialized(async () => {
				await saveTurn((latest) => {
					const state = latest.continuation!;
					let next: ConversationContinuation = { ...state };
					if (event.type === 'paused') next = { ...state, status: 'paused', reason: event.reason };
					else if (event.type === 'tool_started') {
						if (state.unresolved_calls.length >= CHAT_LIMITS.toolCallsPerTurn)
							throw new ResourceExhaustedError('Tool call limit reached');
						const call = ConversationObservationSchema.omit({ result: true }).parse({
							id: `${pending.id}:${event.id}`,
							name: event.name,
						});
						next.unresolved_calls = [
							...state.unresolved_calls.filter((item) => item.id !== call.id),
							call,
						];
					} else {
						const observation = ConversationObservationSchema.parse({
							id: `${pending.id}:${event.id}`,
							name: event.name,
							result: event.result,
						});
						let observations = [
							...state.observations.filter((item) => item.id !== observation.id),
							observation,
						].slice(-16);
						while (observations.reduce((size, item) => size + item.result.length, 0) > 32000)
							observations = observations.slice(1);
						next.observations = observations;
						next.omitted_observations =
							(state.omitted_observations ?? 0) +
							state.observations.filter((item) => item.id !== observation.id).length +
							1 -
							observations.length;
						// A transport failure can follow a committed mutation; its intent stays uncertain.
						if (event.outcome !== 'uncertain')
							next.unresolved_calls = state.unresolved_calls.filter(
								(item) => item.id !== observation.id,
							);
					}
					return { ...latest, continuation: next };
				});
			});
		// Long tool calls produce no head writes, so a stop asked for elsewhere
		// would otherwise wait for the next save. Poll the claim meanwhile.
		const poll = setInterval(() => {
			void this.bucket
				.get(key)
				.then(async (current) => {
					if (stop.signal.aborted) return;
					if (!current) return stop.abort(new ChatTurnStoppedError('The turn claim changed.'));
					const latest = await readStored(StoredConversationSchema, current, key);
					if (latest.deleted_at || latest.pending?.id !== pending.id)
						stop.abort(new ChatTurnStoppedError('The turn claim changed.'));
					else if (latest.pending.stop_requested) stop.abort(new ChatTurnStoppedError());
				})
				.catch(() => {});
		}, this.stopPollMs);
		try {
			const parts = await complete(claimed.messages.slice(0, -1), {
				assistantMessageId: assistantId,
				...(options.resume
					? {
							continuation: {
								...claimed.continuation!,
								unresolved_calls: previous.continuation!.unresolved_calls,
							},
						}
					: {}),
				...(review ? { review } : {}),
				stopSignal: stop.signal,
				saveParts,
				checkpoint,
			});
			const finalParts = validateParts(parts);
			const answer = messageText({ parts: finalParts });
			if (!answer.trim() || answer.length > CHAT_LIMITS.answerCharacters)
				throw new ValidationError('Invalid assistant response');
			await headWrites;
			const finished = await serialized(() =>
				saveTurn((latest) => ({
					...latest,
					pending: undefined,
					permission_decisions: undefined,
					updated_at: stamp(),
					continuation:
						latest.continuation!.unresolved_calls.length > 0
							? { ...latest.continuation!, status: 'needs_review', reason: 'interrupted' }
							: latest.continuation!.status === 'paused'
								? latest.continuation
								: undefined,
					messages: replaceAssistant(latest, (message) => ({ ...message, parts: finalParts })),
				})),
			);
			return ConversationSchema.parse(finished);
		} catch (error) {
			const stopped = error instanceof ChatTurnStoppedError || stop.signal.aborted;
			try {
				await headWrites;
				await this.mutate(pid, owner, id, (head) => {
					if (head.pending?.id !== pending.id)
						throw new PreconditionFailedError('Turn claim changed');
					head.pending = undefined;
					head.permission_decisions = undefined;
					head.updated_at = stamp();
					const last = head.messages.at(-1);
					if (last?.role === 'assistant' && last.parts.length === 0)
						head.messages = head.messages.slice(0, -1);
					else if (last?.role === 'assistant')
						last.parts = last.parts.map((part) =>
							part.type === 'text' && part.state === 'streaming'
								? { ...part, state: 'done' }
								: part,
						);
					head.last_error = stopped ? undefined : FAILED_MESSAGE;
					head.continuation = {
						...head.continuation!,
						status: head.continuation!.unresolved_calls.length > 0 ? 'needs_review' : 'paused',
						reason: stopped ? 'stopped' : 'interrupted',
					};
				});
			} catch (cleanupError) {
				// The claim moved on (expired and reclaimed, or deleted); nothing left to release.
				if (
					!(cleanupError instanceof PreconditionFailedError) &&
					!(cleanupError instanceof NotFoundError)
				)
					throw cleanupError;
			}
			throw error;
		} finally {
			clearInterval(poll);
			stop.abort();
		}
	}
}
