import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { MemoryBucket, uid } from '../../testing';
import { SessionService } from './SessionService';

const USER_A = uid('user_a');
const USER_B = uid('user_b');

describe('SessionService editor claims', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;
	const projectId = createProjectId();
	const notebookId = createNotebookId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
	});

	afterEach(() => vi.useRealTimers());

	async function running(user: UserId, ephemeral = false) {
		const session = await sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: user,
			ephemeral,
			mode: 'edit',
			editor_sandbox_sharing: 'exclusive',
		});
		return sessions.setRunning(projectId, session.session_id, 'https://kernel.example');
	}

	it('allows exactly one concurrent persistent claimant', async () => {
		const [a, b] = await Promise.all([running(USER_A), running(USER_B)]);
		const results = await Promise.all([
			sessions.claimEditor(projectId, notebookId, a.session_id, 'shared', USER_A),
			sessions.claimEditor(projectId, notebookId, b.session_id, 'shared', USER_B),
		]);
		expect(results.filter((result) => result.claimed)).toHaveLength(1);
		expect(new Set(results.map((result) => result.claim.session_id))).toHaveLength(1);
	});

	it('shares the claim holder in shared mode and reports an exclusive owner', async () => {
		const owner = await running(USER_A);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'shared', USER_A);
		expect(
			(await sessions.findReusableEditor(projectId, notebookId, USER_B, 'shared', false)).session
				?.session_id,
		).toBe(owner.session_id);

		await sessions.releaseEditorFor(owner);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		const exclusive = await sessions.findReusableEditor(
			projectId,
			notebookId,
			USER_B,
			'exclusive',
			false,
		);
		expect(exclusive.ownedByOther?.session_id).toBe(owner.session_id);
	});

	it('keeps temporary editor sessions outside the persistent claim', async () => {
		const owner = await running(USER_A);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		const temporary = await running(USER_B, true);
		const found = await sessions.findReusableEditor(
			projectId,
			notebookId,
			USER_B,
			'exclusive',
			true,
		);
		expect(found.session?.session_id).toBe(temporary.session_id);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
			owner.session_id,
		);
	});

	it('protects a claimed sandbox until teardown confirms it was reclaimed', async () => {
		const owner = await sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: USER_A,
			sandbox_id: createSandboxId(),
			mode: 'edit',
			editor_sandbox_sharing: 'exclusive',
		});
		const runningOwner = await sessions.setRunning(
			projectId,
			owner.session_id,
			'https://owner.example',
		);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		const replacement = await running(USER_B);

		await sessions.beginTerminating(projectId, owner.session_id);
		expect(
			(
				await sessions.claimEditor(
					projectId,
					notebookId,
					replacement.session_id,
					'exclusive',
					USER_B,
				)
			).claimed,
		).toBe(false);

		await sessions.markTerminated(projectId, owner.session_id);
		expect(
			(
				await sessions.claimEditor(
					projectId,
					notebookId,
					replacement.session_id,
					'exclusive',
					USER_B,
				)
			).claimed,
		).toBe(false);

		await sessions.markSandboxReclaimed(
			projectId,
			runningOwner.session_id,
			new Date().toISOString(),
		);
		expect(
			(
				await sessions.claimEditor(
					projectId,
					notebookId,
					replacement.session_id,
					'exclusive',
					USER_B,
				)
			).claimed,
		).toBe(true);
	});

	it('preserves unknown editor claim and transfer fields during CAS mutations', async () => {
		const owner = await running(USER_A);
		const key = paths.editorClaim(projectId, notebookId);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId: 'future-fields',
			requestedBy: USER_B,
			expectedHolder: owner.session_id,
			expectedActivity: 'idle',
		});
		const stored = await bucket.get(key);
		const claim = (await stored!.json()) as Record<string, unknown>;
		await bucket.put(
			key,
			JSON.stringify({
				...claim,
				future_claim_field: { value: 1 },
				transfer: {
					...(claim.transfer as Record<string, unknown>),
					future_transfer_field: ['kept'],
				},
			}),
		);

		await sessions.setTakeoverPhase(projectId, notebookId, 'future-fields', 'draining');

		const updated = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
		expect(updated.future_claim_field).toEqual({ value: 1 });
		expect(updated.transfer).toMatchObject({
			phase: 'draining',
			future_transfer_field: ['kept'],
		});

		const replacement = await running(USER_B);
		await sessions.setTakeoverPhase(
			projectId,
			notebookId,
			'future-fields',
			'ready',
			replacement.session_id,
		);
		await sessions.completeTakeover(projectId, notebookId, 'future-fields', replacement.session_id);
		const completed = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
		expect(completed.future_claim_field).toEqual({ value: 1 });
		expect(completed.transfer).toBeUndefined();
	});

	it('preserves unknown editor claim fields when replacing a free claim', async () => {
		const owner = await running(USER_A);
		const key = paths.editorClaim(projectId, notebookId);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		await sessions.releaseEditorFor(owner);
		const stored = await bucket.get(key);
		await bucket.put(
			key,
			JSON.stringify({
				...(await stored!.json()),
				future_claim_field: 'kept',
			}),
		);
		const replacement = await running(USER_B);

		await sessions.claimEditor(projectId, notebookId, replacement.session_id, 'exclusive', USER_B);

		expect(await (await bucket.get(key))!.json()).toMatchObject({
			session_id: replacement.session_id,
			future_claim_field: 'kept',
		});
	});

	it.each(['terminated', 'failed'] as const)(
		'adopts a pre-claim editor when another sandbox is already %s',
		async (terminalStatus) => {
			const owner = await sessions.createSession({
				project_id: projectId,
				notebook_id: notebookId,
				user_id: USER_A,
				sandbox_id: createSandboxId(),
				mode: 'edit',
			});
			const stale = await sessions.createSession({
				project_id: projectId,
				notebook_id: notebookId,
				user_id: USER_B,
				sandbox_id: createSandboxId(),
				mode: 'edit',
			});
			const runningOwner = await sessions.setRunning(
				projectId,
				owner.session_id,
				'https://owner.example',
			);
			await sessions.setRunning(projectId, stale.session_id, 'https://stale.example');
			if (terminalStatus === 'terminated') {
				await sessions.terminate(projectId, stale.session_id);
			} else {
				await sessions.markFailed(projectId, stale.session_id);
			}

			await expect(sessions.ownsEditorClaim(runningOwner)).resolves.toBe(true);
			expect((await sessions.getEditorClaim(projectId, notebookId))?.session_id).toBe(
				runningOwner.session_id,
			);
		},
	);

	it('keeps an unreclaimed expired sandbox in the pre-claim conflict set', async () => {
		vi.useFakeTimers();
		const stale = await sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: USER_B,
			sandbox_id: createSandboxId(),
			mode: 'edit',
		});
		await sessions.setRunning(projectId, stale.session_id, 'https://stale.example');
		vi.advanceTimersByTime(6 * 60 * 1000);
		const owner = await sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: USER_A,
			sandbox_id: createSandboxId(),
			mode: 'edit',
		});
		const runningOwner = await sessions.setRunning(
			projectId,
			owner.session_id,
			'https://owner.example',
		);
		await sessions.expireStale();

		await expect(sessions.ownsEditorClaim(runningOwner)).resolves.toBe(false);
		expect(await sessions.getEditorClaim(projectId, notebookId)).toBeUndefined();
	});

	it('reserves takeover idempotently and only releases ready state to the requester', async () => {
		const owner = await running(USER_A);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		const request = {
			takeoverId: 'takeover-1',
			requestedBy: USER_B,
			expectedHolder: owner.session_id,
			expectedActivity: 'idle',
		} as const;
		await sessions.reserveTakeover(projectId, notebookId, request);
		expect((await sessions.reserveTakeover(projectId, notebookId, request)).transfer?.phase).toBe(
			'requested',
		);
		await expect(
			sessions.reserveTakeover(projectId, notebookId, {
				...request,
				expectedActivity: 'active',
			}),
		).rejects.toMatchObject({ code: 'EDIT_SESSION_CHANGED' });
		await sessions.setTakeoverPhase(projectId, notebookId, 'takeover-1', 'ready');
		const failedReplacement = await running(USER_B);
		const firstAttempt = await sessions.claimEditor(
			projectId,
			notebookId,
			failedReplacement.session_id,
			'exclusive',
			USER_B,
		);
		expect(firstAttempt.claim.transfer?.replacement_session_id).toBe(failedReplacement.session_id);
		await sessions.markFailed(projectId, failedReplacement.session_id);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer?.phase).toBe('ready');

		const replacement = await running(USER_B);
		const retry = await sessions.claimEditor(
			projectId,
			notebookId,
			replacement.session_id,
			'exclusive',
			USER_B,
		);
		expect(retry.claimed).toBe(true);
		expect(retry.claim.transfer?.replacement_session_id).toBe(replacement.session_id);
		const completed = await sessions.completeTakeover(
			projectId,
			notebookId,
			'takeover-1',
			replacement.session_id,
		);
		expect(completed.session_id).toBe(replacement.session_id);
	});

	it('grants only one drain lease and releases it only for its owner', async () => {
		const owner = await running(USER_A);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId: 'lease-race',
			requestedBy: USER_B,
			expectedHolder: owner.session_id,
			expectedActivity: 'idle',
		});
		await sessions.setTakeoverPhase(projectId, notebookId, 'lease-race', 'draining');

		const attempts = await Promise.all([
			sessions.acquireTakeoverDrainLease(projectId, notebookId, 'lease-race', 'lease-a'),
			sessions.acquireTakeoverDrainLease(projectId, notebookId, 'lease-race', 'lease-b'),
		]);
		expect(attempts.filter(Boolean)).toHaveLength(1);
		const winner = attempts[0] ? 'lease-a' : 'lease-b';
		const loser = attempts[0] ? 'lease-b' : 'lease-a';

		await sessions.releaseTakeoverDrainLease(projectId, notebookId, 'lease-race', loser);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer).toMatchObject({
			drain_lease_id: winner,
		});

		await sessions.releaseTakeoverDrainLease(projectId, notebookId, 'lease-race', winner);
		await expect(
			sessions.acquireTakeoverDrainLease(projectId, notebookId, 'lease-race', loser),
		).resolves.toBe(true);
	});

	it('recovers an abandoned drain lease after its bounded lifetime', async () => {
		vi.useFakeTimers();
		const owner = await running(USER_A);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId: 'expired-lease',
			requestedBy: USER_B,
			expectedHolder: owner.session_id,
			expectedActivity: 'idle',
		});
		await sessions.setTakeoverPhase(projectId, notebookId, 'expired-lease', 'draining');
		await sessions.acquireTakeoverDrainLease(
			projectId,
			notebookId,
			'expired-lease',
			'lease-abandoned',
		);

		vi.advanceTimersByTime(10 * 60 * 1000);

		await expect(
			sessions.acquireTakeoverDrainLease(projectId, notebookId, 'expired-lease', 'lease-recovery'),
		).resolves.toBe(true);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer).toMatchObject({
			drain_lease_id: 'lease-recovery',
		});
	});

	it('expires only an abandoned pre-drain takeover reservation', async () => {
		vi.useFakeTimers();
		const owner = await running(USER_A);
		await sessions.claimEditor(projectId, notebookId, owner.session_id, 'exclusive', USER_A);
		await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId: 'abandoned',
			requestedBy: USER_B,
			expectedHolder: owner.session_id,
			expectedActivity: 'idle',
		});
		vi.advanceTimersByTime(5 * 60 * 1000);
		const replacement = await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId: 'replacement',
			requestedBy: USER_B,
			expectedHolder: owner.session_id,
			expectedActivity: 'active',
		});
		expect(replacement.transfer?.takeover_id).toBe('replacement');
		await sessions.setTakeoverPhase(projectId, notebookId, 'replacement', 'draining');
		vi.advanceTimersByTime(60 * 60 * 1000);
		await expect(
			sessions.reserveTakeover(projectId, notebookId, {
				takeoverId: 'too-late',
				requestedBy: USER_B,
				expectedHolder: owner.session_id,
				expectedActivity: 'active',
			}),
		).rejects.toMatchObject({ code: 'TAKEOVER_IN_PROGRESS' });
	});
});
