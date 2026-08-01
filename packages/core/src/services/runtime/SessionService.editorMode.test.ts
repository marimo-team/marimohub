import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import type { UserId } from '../../ids';
import { MemoryBucket, uid } from '../../testing';
import { SessionService } from './SessionService';

const USER_A = uid('user_a');
const USER_B = uid('user_b');

describe('SessionService editor claims', () => {
	let sessions: SessionService;
	const projectId = createProjectId();
	const notebookId = createNotebookId();

	beforeEach(() => {
		sessions = new SessionService(new MemoryBucket());
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
