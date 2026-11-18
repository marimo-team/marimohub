import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '../../testing';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { paths } from '../../paths';
import { ConflictError } from '../../errors';
import { SessionService } from './SessionService';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const bucket = new MemoryBucket();
	const sessions = new SessionService(bucket);
	const session = await sessions.createSession({
		project_id: createProjectId(),
		notebook_id: createNotebookId(),
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
	});
	const replica = new SessionService(bucket);
	const at = '2030-01-01T00:00:00.000Z';
	const reclaim = (expected = session.sandbox_id) =>
		sessions.markSandboxReclaimed(session.project_id, session.session_id, at, expected);
	async function endAttempt(outcome: 'retained' | 'uncertain') {
		const attempt = await sessions.requestStop(session.project_id, session.session_id, {
			key: 'initial',
			requestedBy: ACTOR,
		});
		const leaseId = crypto.randomUUID();
		await sessions.claimStop(attempt, leaseId);
		return sessions.updateStop(attempt, leaseId, {
			outcome,
			runtime_state: 'unknown',
			failure: { code: 'CAPTURE_UNAVAILABLE', retryable: true },
		});
	}
	return { bucket, sessions, replica, session, at, reclaim, endAttempt };
}

describe('confirmed sandbox reclamation', () => {
	it.each(['retained', 'uncertain'] as const)(
		'finishes a %s receipt without losing its diagnostics',
		async (outcome) => {
			const { session, at, reclaim, endAttempt } = await fixture();
			const ended = await endAttempt(outcome);
			const result = await reclaim();
			expect(result.sandbox_reclaimed_at).toBe(at);
			expect(result.stop).toEqual({
				...ended.stop,
				outcome: 'stopped',
				runtime_state: 'stopped',
				updated_at: at,
			});
			expect(result.stop?.finalized_at).toBeUndefined();
			expect(result.sandbox_id).toBe(session.sandbox_id);
		},
	);
	it('leaves the session unchanged when another sandbox was destroyed', async () => {
		const { reclaim, endAttempt } = await fixture();
		const ended = await endAttempt('retained');
		expect(await reclaim(createSandboxId())).toEqual(ended);
	});
	it('does not finish a receipt without an explicit sandbox match', async () => {
		const { sessions, session, at, endAttempt } = await fixture();
		const ended = await endAttempt('uncertain');
		const result = await sessions.markSandboxReclaimed(session.project_id, session.session_id, at);
		expect(result.stop).toEqual(ended.stop);
	});
	it('fences retries and sandbox replacement before retirement finalization', async () => {
		const { session, replica, reclaim, endAttempt } = await fixture();
		const ended = await endAttempt('retained');
		const reclaimed = await reclaim();
		expect(
			await replica.requestStop(session.project_id, session.session_id, {
				key: 'late-retry',
				previousId: ended.stop!.id,
			}),
		).toEqual(reclaimed);
		expect(await replica.claimStop(reclaimed, crypto.randomUUID())).toBeNull();
		expect(await replica.confirmRetainedRuntimeResumed(ended)).toEqual(reclaimed);
		await expect(
			replica.replaceStartingSandbox(
				session.project_id,
				session.session_id,
				session.sandbox_id!,
				createSandboxId(),
			),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('does not invent a stop attempt', async () => {
		const { at, reclaim } = await fixture();
		const result = await reclaim();
		expect(result.sandbox_reclaimed_at).toBe(at);
		expect(result.stop).toBeUndefined();
	});
	it('leaves an active stop lease with its owner', async () => {
		const { sessions, session, reclaim } = await fixture();
		const attempt = await sessions.requestStop(session.project_id, session.session_id);
		const owned = await sessions.claimStop(attempt, crypto.randomUUID());
		expect((await reclaim()).stop).toEqual(owned?.stop);
	});
	it('rechecks a replacement sandbox after a CAS conflict', async () => {
		const { bucket, session, replica, reclaim } = await fixture();
		const replacement = createSandboxId();
		const put = bucket.put.bind(bucket);
		let raced = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (!raced && key === paths.session(session.project_id, session.session_id)) {
				raced = true;
				await replica.replaceStartingSandbox(
					session.project_id,
					session.session_id,
					session.sandbox_id!,
					replacement,
				);
			}
			return put(key, value, options);
		});
		const result = await reclaim();
		expect(result.sandbox_id).toBe(replacement);
		expect(result.sandbox_reclaimed_at).toBeUndefined();
	});
	it('does not complete a new stop attempt that wins a CAS race', async () => {
		const { bucket, sessions, session, replica, reclaim, endAttempt } = await fixture();
		const ended = await endAttempt('retained');
		const put = bucket.put.bind(bucket);
		const leaseId = crypto.randomUUID();
		let raced = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (!raced && key === paths.session(session.project_id, session.session_id)) {
				raced = true;
				const next = await replica.requestStop(session.project_id, session.session_id, {
					key: 'retry',
					previousId: ended.stop!.id,
				});
				await replica.claimStop(next, leaseId);
			}
			return put(key, value, options);
		});
		const result = await reclaim();
		expect(result.stop).toMatchObject({ outcome: 'pending', lease_id: leaseId });
		expect(result.stop?.id).not.toBe(ended.stop?.id);
		expect(result.stop_receipts).toEqual([ended.stop]);
		expect(await sessions.getSession(session.project_id, session.session_id)).toEqual(result);
	});
});
