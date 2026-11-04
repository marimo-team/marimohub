import { describe, expect, it, vi } from 'vitest';
import { NotebookId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { MemoryBucket } from '../../testing/MemoryBucket';
import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
	ValidationError,
} from '../../errors';
import { ChatTurnStoppedError, ConversationService } from './ConversationService';
import type { CompleteTurn, TurnContext } from './ConversationService';
import { CHAT_LIMITS, messageText } from './schema';
import type { ConversationMessagePart, ConversationPermission } from './schema';

const pid = ProjectId.parse('proj-0000000000000000');
const alice = UserId.parse('alice');
const bob = UserId.parse('bob');

const text = (value: string): ConversationMessagePart => ({ type: 'text', text: value });
const answer =
	(value: string): CompleteTurn =>
	async () => [text(value)];

function permission(
	toolCallId: string,
	overrides: Partial<ConversationPermission> = {},
): ConversationPermission {
	return {
		id: crypto.randomUUID(),
		tool_call_id: toolCallId,
		kind: 'tool',
		action: 'Create a notebook',
		details: [],
		scope: { key: 'tool:create_notebook', label: 'creating notebooks' },
		can_remember: true,
		status: 'open',
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

/** A turn that waits until the test releases it, exposing its context. */
function heldTurn() {
	const entered = Promise.withResolvers<TurnContext>();
	const release = Promise.withResolvers<readonly ConversationMessagePart[]>();
	const complete: CompleteTurn = async (_messages, turn) => {
		entered.resolve(turn);
		return release.promise;
	};
	return { complete, entered: entered.promise, release };
}

describe('ConversationService', () => {
	it('isolates owners and projects', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		await expect(service.get(pid, bob, created.id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			service.get(ProjectId.parse('proj-1111111111111111'), alice, created.id),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(await service.list(pid, bob)).toEqual([]);
		expect((await service.list(pid, alice)).map((entry) => entry.id)).toEqual([created.id]);
		await expect(service.get(pid, alice, 'not-a-ulid')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('titles a conversation from its first message and summarizes it in listings', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		expect(created.title).toBe('New conversation');
		const saved = await service.send(pid, alice, created.id, '  Summarize sales  ', answer('Done'));
		expect(saved.title).toBe('Summarize sales');
		expect(saved.messages.map(messageText)).toEqual(['Summarize sales', 'Done']);
		expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
		expect(saved.pending).toBeUndefined();
		expect(saved.continuation).toBeUndefined();
		const [summary] = await service.list(pid, alice);
		expect(summary).toMatchObject({ id: created.id, title: 'Summarize sales', message_count: 2 });
		expect(summary).not.toHaveProperty('messages');
	});

	it('refuses a second turn while one is claimed and persists the finished turn', async () => {
		const bucket = new MemoryBucket();
		const service = new ConversationService(bucket);
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'hello', held.complete);
		const context = await held.entered;
		await expect(
			service.send(pid, alice, created.id, 'second', answer('x')),
		).rejects.toBeInstanceOf(ConflictError);
		await expect(service.delete(pid, alice, created.id)).rejects.toBeInstanceOf(ConflictError);
		const claimed = await service.get(pid, alice, created.id);
		expect(claimed.pending).toBeDefined();
		expect(claimed.continuation?.status).toBe('running');
		expect(claimed.messages.at(-1)).toMatchObject({ id: context.assistantMessageId, parts: [] });
		held.release.resolve([text('first answer')]);
		await turn;
		const saved = await new ConversationService(bucket).get(pid, alice, created.id);
		expect(saved.messages.map(messageText)).toEqual(['hello', 'first answer']);
		expect(saved.pending).toBeUndefined();
	});

	it('persists streamed parts during the turn in order, including consent cards', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'make a notebook', held.complete);
		const context = await held.entered;
		const card = permission('call-1');
		await context.saveParts([
			text('Working on it.'),
			{
				type: 'dynamic-tool',
				toolName: 'create_notebook',
				toolCallId: 'call-1',
				state: 'input-available',
				input: '{"title":"Sales"}',
			},
			{ type: 'data-permission', id: card.id, data: card },
		]);
		const partial = await service.get(pid, alice, created.id);
		expect(partial.messages.at(-1)?.parts.map((part) => part.type)).toEqual([
			'text',
			'dynamic-tool',
			'data-permission',
		]);
		held.release.resolve([
			text('Working on it.'),
			{
				type: 'dynamic-tool',
				toolName: 'create_notebook',
				toolCallId: 'call-1',
				state: 'output-available',
				input: '{"title":"Sales"}',
				output: '{"notebook_id":"nb"}',
			},
			{ type: 'data-permission', id: card.id, data: { ...card, status: 'allowed' } },
			text('Created the notebook.'),
		]);
		const saved = await turn;
		expect(saved.messages.at(-1)?.parts).toHaveLength(4);
		expect(messageText(saved.messages.at(-1)!)).toBe('Working on it.Created the notebook.');
	});

	it('keeps saved partial output, records the failure, and allows another message', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'hello', held.complete);
		const context = await held.entered;
		await context.saveParts([
			text('Partial '),
			{ type: 'text', text: 'reply', state: 'streaming' },
		]);
		held.release.reject(new Error('provider exploded'));
		await expect(turn).rejects.toThrow('provider exploded');
		const failed = await service.get(pid, alice, created.id);
		expect(failed.pending).toBeUndefined();
		expect(failed.last_error).toMatch(/stopped before it finished/);
		expect(failed.continuation).toMatchObject({ status: 'paused', reason: 'interrupted' });
		expect(failed.messages.at(-1)?.parts).toEqual([
			text('Partial '),
			{ type: 'text', text: 'reply', state: 'done' },
		]);
		const recovered = await service.send(pid, alice, created.id, 'again', answer('Recovered'));
		expect(recovered.last_error).toBeUndefined();
		expect(recovered.continuation).toBeUndefined();
		expect(recovered.messages.map(messageText)).toEqual([
			'hello',
			'Partial reply',
			'again',
			'Recovered',
		]);
	});

	it('drops an assistant message that produced nothing before failing', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		await expect(
			service.send(pid, alice, created.id, 'hello', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		const failed = await service.get(pid, alice, created.id);
		expect(failed.messages.map(messageText)).toEqual(['hello']);
	});

	it('bounds the assistant text across parts and the stored record across cards', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'task', held.complete);
		const context = await held.entered;
		const half = text('x'.repeat(CHAT_LIMITS.answerCharacters / 2 + 1));
		await expect(context.saveParts([half, half])).rejects.toBeInstanceOf(ValidationError);
		// Consent cards count toward the record size even though they are not visible text.
		const value = 'c'.repeat(CHAT_LIMITS.consentDetailCharacters);
		const card = (id: string): ConversationMessagePart => ({
			type: 'data-permission',
			id: crypto.randomUUID(),
			data: permission(id, {
				details: Array.from({ length: 8 }, (_, i) => ({ label: `f${i}`, value })),
			}),
		});
		const cards = Array.from({ length: 4 }, (_, i) => card(`call-${i}`));
		await context.saveParts([...cards, text('done')]);
		held.release.resolve([...cards, text('done')]);
		await turn;
		await expect(service.send(pid, alice, created.id, 'more', answer('x'))).rejects.toThrow(
			/Conversation is full/,
		);
	});

	it('rejects an empty or oversized final answer', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		await expect(service.send(pid, alice, created.id, 'hi', answer('  '))).rejects.toBeInstanceOf(
			ValidationError,
		);
		await expect(
			service.send(
				pid,
				alice,
				created.id,
				'hi',
				answer('x'.repeat(CHAT_LIMITS.answerCharacters + 1)),
			),
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('stops a turn requested from another replica and marks the task stopped', async () => {
		const bucket = new MemoryBucket();
		const service = new ConversationService(bucket, Date.now, { stopPollMs: 10 });
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'long task', held.complete);
		const context = await held.entered;
		await context.saveParts([text('Thinking')]);
		expect(await new ConversationService(bucket).requestStop(pid, alice, created.id)).toBe(true);
		await new Promise<void>((resolve) =>
			context.stopSignal.addEventListener('abort', () => resolve()),
		);
		expect(context.stopSignal.reason).toBeInstanceOf(ChatTurnStoppedError);
		held.release.reject(context.stopSignal.reason);
		await expect(turn).rejects.toBeInstanceOf(ChatTurnStoppedError);
		const stopped = await service.get(pid, alice, created.id);
		expect(stopped.pending).toBeUndefined();
		expect(stopped.last_error).toBeUndefined();
		expect(stopped.continuation).toMatchObject({ status: 'paused', reason: 'stopped' });
		expect(messageText(stopped.messages.at(-1)!)).toBe('Thinking');
		expect(await service.requestStop(pid, alice, created.id)).toBe(false);
	});

	it('surfaces a stop on the next head write when nothing polls', async () => {
		const bucket = new MemoryBucket();
		const service = new ConversationService(bucket, Date.now, { stopPollMs: 600_000 });
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'task', held.complete);
		const context = await held.entered;
		await service.requestStop(pid, alice, created.id);
		expect(context.stopSignal.aborted).toBe(false);
		await context.saveParts([text('step')]);
		expect(context.stopSignal.aborted).toBe(true);
		held.release.resolve([text('step')]);
		// The runner finished anyway; the service still honours the final parts.
		const saved = await turn;
		expect(saved.pending).toBeUndefined();
		expect(messageText(saved.messages.at(-1)!)).toBe('step');
	});

	it('treats an expired lease as interrupted and fences the stale runner', async () => {
		const bucket = new MemoryBucket();
		let now = Date.parse('2026-01-01T00:00:00Z');
		const service = new ConversationService(bucket, () => now, { leaseDurationMs: 60_000 });
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const stale = service.send(pid, alice, created.id, 'first', held.complete);
		const context = await held.entered;
		now += 61_000;
		const interrupted = await service.get(pid, alice, created.id);
		expect(interrupted.pending).toBeUndefined();
		expect(interrupted.continuation).toMatchObject({ status: 'paused', reason: 'interrupted' });
		const next = await service.send(pid, alice, created.id, 'second', answer('fresh'));
		expect(next.messages.map(messageText)).toEqual(['first', 'second', 'fresh']);
		await expect(context.saveParts([text('late')])).rejects.toBeInstanceOf(PreconditionFailedError);
		held.release.resolve([text('late answer')]);
		await expect(stale).rejects.toBeInstanceOf(PreconditionFailedError);
		const final = await service.get(pid, alice, created.id);
		expect(final.messages.map(messageText)).toEqual(['first', 'second', 'fresh']);
		expect(final.pending).toBeUndefined();
	});

	it('fences a runner whose lease lapsed even before anyone reclaims the turn', async () => {
		const bucket = new MemoryBucket();
		let now = Date.parse('2026-01-01T00:00:00Z');
		const service = new ConversationService(bucket, () => now, { leaseDurationMs: 60_000 });
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const stale = service.send(pid, alice, created.id, 'first', held.complete);
		const context = await held.entered;
		now += 61_000;
		await expect(context.saveParts([text('late')])).rejects.toBeInstanceOf(PreconditionFailedError);
		expect(context.stopSignal.aborted).toBe(true);
		held.release.resolve([text('late answer')]);
		await expect(stale).rejects.toBeInstanceOf(PreconditionFailedError);
		const final = await service.get(pid, alice, created.id);
		expect(final.messages.map(messageText)).toEqual(['first']);
		expect(final.continuation).toMatchObject({ status: 'paused', reason: 'interrupted' });
	});

	it('records checkpoints into the saved task and resumes it', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'build the report', held.complete);
		const context = await held.entered;
		await context.checkpoint({ type: 'tool_started', id: 'c1', name: 'list_catalog' });
		await context.checkpoint({
			type: 'tool_completed',
			id: 'c1',
			name: 'list_catalog',
			result: 'ok',
		});
		await context.checkpoint({ type: 'tool_started', id: 'c2', name: 'create_notebook' });
		await context.checkpoint({ type: 'paused', reason: 'tool_limit' });
		held.release.resolve([text('Paused before finishing.')]);
		const paused = await turn;
		expect(paused.continuation).toMatchObject({
			status: 'needs_review',
			reason: 'interrupted',
			task: 'build the report',
			observations: [{ name: 'list_catalog', result: 'ok' }],
			unresolved_calls: [{ name: 'create_notebook' }],
		});
		await expect(service.resume(pid, alice, created.id, answer('x'))).rejects.toBeInstanceOf(
			ConflictError,
		);
		const resumed = await service.resume(
			pid,
			alice,
			created.id,
			async (_messages, turn) => {
				expect(turn.continuation).toMatchObject({
					task: 'build the report',
					observations: [{ name: 'list_catalog', result: 'ok' }],
					unresolved_calls: [{ name: 'create_notebook' }],
				});
				expect(turn.review).toBeUndefined();
				return [text('Finished the report.')];
			},
			{ acknowledgeUncertain: true },
		);
		expect(resumed.continuation).toBeUndefined();
		expect(resumed.messages.map(messageText).slice(-2)).toEqual([
			'Continue the interrupted task.',
			'Finished the report.',
		]);
	});

	it('keeps an unresolved mutating task as review context for an unrelated question', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'deploy', held.complete);
		const context = await held.entered;
		await context.checkpoint({ type: 'tool_started', id: 'c1', name: 'update_notebook' });
		await context.checkpoint({ type: 'tool_started', id: 'c2', name: 'get_notebook' });
		held.release.reject(new Error('crash'));
		await expect(turn).rejects.toThrow('crash');
		const reviewed = await service.send(
			pid,
			alice,
			created.id,
			'what time is it?',
			async (_messages, turn) => {
				expect(turn.continuation).toBeUndefined();
				expect(turn.review?.unresolved_calls.map((call) => call.name)).toEqual([
					'update_notebook',
					'get_notebook',
				]);
				return [text('Noon.')];
			},
			{ readOnlyToolNames: new Set(['get_notebook']) },
		);
		expect(reviewed.continuation).toMatchObject({ status: 'needs_review', task: 'deploy' });
		await expect(service.dismissContinuation(pid, alice, created.id)).resolves.toMatchObject({
			continuation: undefined,
		});
		const uncertain = heldTurn();
		const readOnlyTurn = service.send(pid, alice, created.id, 'read something', uncertain.complete);
		const uncertainContext = await uncertain.entered;
		await uncertainContext.checkpoint({ type: 'tool_started', id: 'c3', name: 'get_notebook' });
		uncertain.release.reject(new Error('crash'));
		await expect(readOnlyTurn).rejects.toThrow('crash');
		expect((await service.get(pid, alice, created.id)).continuation?.status).toBe('needs_review');
		const cleared = await service.send(
			pid,
			alice,
			created.id,
			'another',
			async (_messages, turn) => {
				expect(turn.review).toBeUndefined();
				return [text('ok')];
			},
			{ readOnlyToolNames: new Set(['get_notebook']) },
		);
		expect(cleared.continuation).toBeUndefined();
	});

	it('bounds observations and keeps uncertain calls unresolved', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'task', held.complete);
		const context = await held.entered;
		for (let index = 0; index < 20; index++)
			await context.checkpoint({
				type: 'tool_completed',
				id: `c${index}`,
				name: 'list_catalog',
				result: 'x'.repeat(4000),
			});
		await context.checkpoint({ type: 'tool_started', id: 'm', name: 'run_job' });
		await context.checkpoint({
			type: 'tool_completed',
			id: 'm',
			name: 'run_job',
			result: 'timeout',
			outcome: 'uncertain',
		});
		held.release.resolve([text('done')]);
		const saved = await turn;
		expect(saved.continuation?.observations.length).toBeLessThanOrEqual(8);
		expect(saved.continuation?.omitted_observations).toBeGreaterThan(0);
		expect(saved.continuation?.unresolved_calls.map((call) => call.name)).toEqual(['run_job']);
		expect(saved.continuation?.status).toBe('needs_review');
	});

	it('keeps acknowledged uncertain calls listed when the resumed turn fails too', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'deploy', held.complete);
		const context = await held.entered;
		await context.checkpoint({ type: 'tool_started', id: 'c1', name: 'run_job' });
		held.release.reject(new Error('crash'));
		await expect(turn).rejects.toThrow('crash');
		const again = heldTurn();
		const resumed = service.resume(pid, alice, created.id, again.complete, {
			acknowledgeUncertain: true,
		});
		const resumedContext = await again.entered;
		expect(
			(await service.get(pid, alice, created.id)).continuation?.unresolved_calls.map((c) => c.name),
		).toEqual(['run_job']);
		await resumedContext.checkpoint({ type: 'tool_started', id: 'c2', name: 'update_notebook' });
		again.release.reject(new Error('crash again'));
		await expect(resumed).rejects.toThrow('crash again');
		const after = await service.get(pid, alice, created.id);
		expect(after.continuation).toMatchObject({ status: 'needs_review' });
		expect(after.continuation?.unresolved_calls.map((c) => c.name)).toEqual([
			'run_job',
			'update_notebook',
		]);
		// Finishing clears only the acknowledged ones; this turn's own starts still need review.
		const third = heldTurn();
		const finished = service.resume(pid, alice, created.id, third.complete, {
			acknowledgeUncertain: true,
		});
		const thirdContext = await third.entered;
		await thirdContext.checkpoint({ type: 'tool_started', id: 'c3', name: 'delete_notebook' });
		third.release.resolve([text('done')]);
		expect((await finished).continuation?.unresolved_calls.map((c) => c.name)).toEqual([
			'delete_notebook',
		]);
	});

	it('caps tool starts at the per-turn limit even when earlier calls completed', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'task', held.complete);
		const context = await held.entered;
		for (let index = 0; index < CHAT_LIMITS.toolCallsPerTurn; index++) {
			await context.checkpoint({ type: 'tool_started', id: `c${index}`, name: 'create_notebook' });
			await context.checkpoint({
				type: 'tool_completed',
				id: `c${index}`,
				name: 'create_notebook',
				result: 'ok',
			});
		}
		await expect(
			context.checkpoint({ type: 'tool_started', id: 'extra', name: 'create_notebook' }),
		).rejects.toBeInstanceOf(ResourceExhaustedError);
		held.release.resolve([text('done')]);
		await turn;
	});

	it('serializes concurrent part saves and checkpoints without losing either', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'task', held.complete);
		const context = await held.entered;
		await Promise.all([
			context.checkpoint({ type: 'tool_started', id: 'a', name: 'get_notebook' }),
			context.saveParts([text('one')]),
			context.checkpoint({ type: 'tool_started', id: 'b', name: 'get_notebook' }),
			context.saveParts([text('one'), text('two')]),
		]);
		const mid = await service.get(pid, alice, created.id);
		expect(mid.continuation?.unresolved_calls.map((call) => call.id)).toHaveLength(2);
		expect(messageText(mid.messages.at(-1)!)).toBe('onetwo');
		held.release.resolve([text('done')]);
		await turn;
	});

	it('keeps the working notebook chosen during a turn', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		const held = heldTurn();
		const turn = service.send(pid, alice, created.id, 'task', held.complete);
		const context = await held.entered;
		const notebook = NotebookId.parse('nb-0123456789abcdef');
		await service.setWorkingNotebook(pid, alice, created.id, notebook);
		await context.saveParts([text('x')]);
		held.release.resolve([text('done')]);
		const saved = await turn;
		expect(saved.working_notebook).toBe(notebook);
		expect((await service.setWorkingNotebook(pid, alice, created.id, null)).working_notebook).toBe(
			undefined,
		);
	});

	it('enforces the conversation size limits', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await service.create(pid, alice);
		await expect(service.send(pid, alice, created.id, '   ', answer('x'))).rejects.toBeInstanceOf(
			ValidationError,
		);
		await expect(
			service.send(
				pid,
				alice,
				created.id,
				'x'.repeat(CHAT_LIMITS.messageCharacters + 1),
				answer('x'),
			),
		).rejects.toBeInstanceOf(ValidationError);
		for (let index = 0; index < 3; index++)
			await service.send(
				pid,
				alice,
				created.id,
				'q',
				answer('a'.repeat(CHAT_LIMITS.answerCharacters)),
			);
		await expect(service.send(pid, alice, created.id, 'q', answer('a'))).rejects.toThrow(
			/Conversation is full/,
		);
	});

	it('limits conversations per person and frees capacity on delete', async () => {
		const bucket = new MemoryBucket();
		const service = new ConversationService(bucket);
		const ids: string[] = [];
		for (let index = 0; index < CHAT_LIMITS.conversationsPerProject; index++)
			ids.push((await service.create(pid, alice)).id);
		await expect(service.create(pid, alice)).rejects.toBeInstanceOf(ResourceExhaustedError);
		expect(await bucket.get(paths.conversation(pid, alice, ids[0]))).not.toBeNull();
		await service.delete(pid, alice, ids[0]);
		expect(await bucket.get(paths.conversation(pid, alice, ids[0]))).toBeNull();
		await expect(service.get(pid, alice, ids[0])).rejects.toBeInstanceOf(NotFoundError);
		const replacement = await service.create(pid, alice);
		expect((await service.list(pid, alice)).map((entry) => entry.id)).toContain(replacement.id);
		await service.delete(pid, alice, replacement.id);
		await expect(service.delete(pid, alice, replacement.id)).rejects.toBeInstanceOf(NotFoundError);
	});

	it('publishes concurrent conversations without losing index entries', async () => {
		const service = new ConversationService(new MemoryBucket());
		const created = await Promise.all(Array.from({ length: 6 }, () => service.create(pid, alice)));
		const listed = await service.list(pid, alice);
		expect(listed.map((entry) => entry.id).sort()).toEqual(created.map((entry) => entry.id).sort());
	});

	it('removes the orphaned head when the index cannot be published', async () => {
		const bucket = new MemoryBucket();
		const service = new ConversationService(bucket);
		for (let index = 0; index < CHAT_LIMITS.conversationsPerProject; index++)
			await service.create(pid, alice);
		const before = (await bucket.list({ prefix: paths.conversationsForOwner(pid, alice) })).objects
			.length;
		await expect(service.create(pid, alice)).rejects.toBeInstanceOf(ResourceExhaustedError);
		const after = (await bucket.list({ prefix: paths.conversationsForOwner(pid, alice) })).objects
			.length;
		expect(after).toBe(before);
	});

	describe('permission decisions', () => {
		async function openCard(service: ConversationService) {
			const created = await service.create(pid, alice);
			const held = heldTurn();
			const turn = service.send(pid, alice, created.id, 'create', held.complete);
			const context = await held.entered;
			const card = permission('call-1');
			await context.saveParts([
				{
					type: 'dynamic-tool',
					toolName: 'create_notebook',
					toolCallId: 'call-1',
					state: 'input-available',
				},
				{ type: 'data-permission', id: card.id, data: card },
			]);
			return { created, turn, context, card, held };
		}

		it('accepts one decision per card and exposes it to the turn owner', async () => {
			const service = new ConversationService(new MemoryBucket());
			const { created, card, held, turn } = await openCard(service);
			expect(await service.permissionDecision(pid, alice, created.id, card.id)).toBeUndefined();
			expect(await service.decidePermission(pid, alice, created.id, card.id, 'always')).toBe(
				'accepted',
			);
			expect(await service.decidePermission(pid, alice, created.id, card.id, 'always')).toBe(
				'accepted',
			);
			expect(await service.decidePermission(pid, alice, created.id, card.id, 'deny')).toBe(
				'rejected',
			);
			expect(await service.permissionDecision(pid, alice, created.id, card.id)).toBe('always');
			held.release.resolve([text('done')]);
			const saved = await turn;
			expect(saved).not.toHaveProperty('permission_decisions');
			expect(await service.permissionDecision(pid, alice, created.id, card.id)).toBe('cancelled');
		});

		it('rejects decisions for unknown, closed, other-owner, or expired requests', async () => {
			const bucket = new MemoryBucket();
			let now = Date.now();
			const service = new ConversationService(bucket, () => now);
			const { created, card, context, held, turn } = await openCard(service);
			// A card that has not reached the head yet is still undecided, not cancelled.
			const unseen = crypto.randomUUID();
			expect(await service.permissionDecision(pid, alice, created.id, unseen)).toBeUndefined();
			expect(await service.decidePermission(pid, alice, created.id, unseen, 'allow')).toBe(
				'missing',
			);
			await expect(
				service.decidePermission(pid, bob, created.id, card.id, 'allow'),
			).rejects.toBeInstanceOf(NotFoundError);
			now += 61_000;
			expect(await service.decidePermission(pid, alice, created.id, card.id, 'allow')).toBe(
				'rejected',
			);
			expect(await service.permissionDecision(pid, alice, created.id, card.id)).toBe('expired');
			now -= 61_000;
			await context.saveParts([
				{ type: 'data-permission', id: card.id, data: { ...card, status: 'denied' } },
			]);
			expect(await service.decidePermission(pid, alice, created.id, card.id, 'allow')).toBe(
				'rejected',
			);
			held.release.resolve([text('done')]);
			await turn;
			// Once the turn is over nothing can be waiting on a decision.
			expect(await service.decidePermission(pid, alice, created.id, unseen, 'allow')).toBe(
				'rejected',
			);
			expect(await service.permissionDecision(pid, alice, created.id, unseen)).toBe('cancelled');
		});

		it('does not carry a decision into a later turn', async () => {
			const service = new ConversationService(new MemoryBucket());
			const { created, card, held, turn } = await openCard(service);
			await service.decidePermission(pid, alice, created.id, card.id, 'allow');
			held.release.reject(new Error('crash'));
			await expect(turn).rejects.toThrow('crash');
			const again = heldTurn();
			const nextTurn = service.send(pid, alice, created.id, 'retry', again.complete);
			const context = await again.entered;
			const reused = { ...card, id: crypto.randomUUID() };
			await context.saveParts([{ type: 'data-permission', id: reused.id, data: reused }]);
			expect(await service.permissionDecision(pid, alice, created.id, reused.id)).toBeUndefined();
			expect(await service.permissionDecision(pid, alice, created.id, card.id)).toBe('cancelled');
			again.release.resolve([text('ok')]);
			await nextTurn;
		});
	});

	it('rejects invalid lease durations', () => {
		expect(
			() => new ConversationService(new MemoryBucket(), Date.now, { leaseDurationMs: 1 }),
		).toThrow(ValidationError);
		vi.restoreAllMocks();
	});
});
