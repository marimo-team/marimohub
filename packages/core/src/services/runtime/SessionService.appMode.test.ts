import { beforeEach, describe, expect, it } from 'vitest';
import { appClaimHolder, MemoryBucket, uid } from '../../testing';
import { createNotebookId, createProjectId } from '../../ids';
import type { SessionMode } from '../../constants';
import type { UserId, VersionId } from '../../ids';
import { paths } from '../../paths';
import { SessionService } from './SessionService';

const USER_A = uid('user_a');
const USER_B = uid('user_b');

describe('SessionService (app mode)', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;

	const projectId = createProjectId();
	const notebookId = createNotebookId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
	});

	async function running(user: UserId, mode: SessionMode = 'edit', nid = notebookId) {
		const s = await sessions.createSession({
			notebook_id: nid,
			project_id: projectId,
			user_id: user,
			mode,
		});
		return sessions.setRunning(projectId, s.session_id, 'https://kernel.example');
	}

	describe('createSession', () => {
		it('omits mode for edit sessions (backward-compatible records)', async () => {
			const s = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_A,
				mode: 'edit',
			});
			const raw = await bucket.get(paths.session(projectId, s.session_id));
			expect(await raw!.json()).not.toHaveProperty('mode');
		});

		it('stores mode and source_version_id for run sessions', async () => {
			const s = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_A,
				mode: 'app',
				source_version_id: 'ver-0000000000000001' as VersionId,
			});
			expect(s.mode).toBe('app');
			expect(s.source_version_id).toBe('ver-0000000000000001');
		});
	});

	describe('findReusable per mode', () => {
		/** An app session as the create saga leaves it: running AND holding the claim. */
		const claimedApp = async (user: UserId) => {
			const app = await running(user, 'app');
			await sessions.claimApp(projectId, notebookId, app.session_id);
			return app;
		};

		it('never crosses modes', async () => {
			await running(USER_A, 'edit');
			expect(await sessions.findReusable(projectId, notebookId, USER_A, 'app')).toBeUndefined();

			await claimedApp(USER_A);
			const edit = await sessions.findReusable(projectId, notebookId, USER_A, 'edit');
			const run = await sessions.findReusable(projectId, notebookId, USER_A, 'app');
			expect(edit?.mode).toBeUndefined(); // stored edit records omit mode
			expect(run?.mode).toBe('app');
			expect(edit?.session_id).not.toBe(run?.session_id);
		});

		it('is user-blind for run: another editor attaches to the shared app', async () => {
			const app = await claimedApp(USER_A);
			const found = await sessions.findReusable(projectId, notebookId, USER_B, 'app');
			expect(found?.session_id).toBe(app.session_id);
		});

		it('hands out the claim holder, not the newest starting racer', async () => {
			// A and B both raced to start the app; A won `claimApp`, so B is already
			// doomed (it throws AppClaimLostError and terminates its own record).
			// Handing B to a third caller would strand it on a session that never runs.
			const a = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_A,
				mode: 'app',
			});
			await sessions.claimApp(projectId, notebookId, a.session_id);
			const b = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_B,
				mode: 'app',
			});
			// B is the newer record, so heartbeat order alone would pick it.
			expect(new Date(b.last_heartbeat).getTime()).toBeGreaterThanOrEqual(
				new Date(a.last_heartbeat).getTime(),
			);

			const found = await sessions.findReusable(projectId, notebookId, uid('user_c'), 'app');
			expect(found?.session_id).toBe(a.session_id);
		});

		it('reuses nothing when the app claim is absent', async () => {
			// No claim = no holder, so the caller starts fresh and steals the (stale)
			// claim via claimApp rather than attaching to an unowned record.
			await running(USER_A, 'app');
			expect(await sessions.findReusable(projectId, notebookId, USER_B, 'app')).toBeUndefined();
		});

		it('reuses nothing once the claim has been released', async () => {
			const app = await claimedApp(USER_A);
			await sessions.releaseApp(projectId, notebookId, app.session_id);
			expect(await sessions.findReusable(projectId, notebookId, USER_B, 'app')).toBeUndefined();
		});

		it('reuses nothing when the claim is corrupt', async () => {
			await claimedApp(USER_A);
			await bucket.put(paths.appClaim(projectId, notebookId), 'not json');
			expect(await sessions.findReusable(projectId, notebookId, USER_B, 'app')).toBeUndefined();
		});

		it('reuses nothing when the claim names a session that is no longer a candidate', async () => {
			const app = await claimedApp(USER_A);
			await sessions.markTerminated(projectId, app.session_id);
			expect(await sessions.findReusable(projectId, notebookId, USER_B, 'app')).toBeUndefined();
		});

		it('stays per-user for edit', async () => {
			await running(USER_A, 'edit');
			expect(await sessions.findReusable(projectId, notebookId, USER_B, 'edit')).toBeUndefined();
		});

		it('defaults the mode parameter to edit', async () => {
			await running(USER_A, 'app');
			expect(await sessions.findReusable(projectId, notebookId, USER_A)).toBeUndefined();
		});
	});

	describe('caps', () => {
		it('countActiveForUser ignores run sessions', async () => {
			await running(USER_A, 'edit');
			await running(USER_A, 'app');
			expect(await sessions.countActiveForUser(USER_A)).toBe(1);
		});

		it('countActiveAppsForProject counts only active run sessions', async () => {
			await running(USER_A, 'edit');
			const app = await running(USER_A, 'app');
			await running(USER_B, 'app', createNotebookId());
			expect(await sessions.countActiveAppsForProject(projectId)).toBe(2);

			await sessions.markTerminated(projectId, app.session_id);
			expect(await sessions.countActiveAppsForProject(projectId)).toBe(1);
		});
	});

	describe('markConnections', () => {
		it('stamps the probe result without touching status', async () => {
			const s = await running(USER_A, 'app');
			const stamped = await sessions.markConnections(
				projectId,
				s.session_id,
				3,
				'2026-07-24T12:00:00.000Z',
			);
			expect(stamped.active_connections).toBe(3);
			expect(stamped.connections_checked_at).toBe('2026-07-24T12:00:00.000Z');
			expect(stamped.status).toBe('running');
		});
	});

	describe('claimApp / releaseApp', () => {
		const claimKey = () => paths.appClaim(projectId, notebookId);
		const holder = () => appClaimHolder(bucket, projectId, notebookId);

		it('first claimer wins; a concurrent claimer loses to the live holder', async () => {
			const a = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_A,
				mode: 'app',
			});
			const b = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_B,
				mode: 'app',
			});

			expect(await sessions.claimApp(projectId, notebookId, a.session_id)).toEqual({
				claimed: true,
				holder: a.session_id,
			});
			// B's fresh `starting` record does not unseat A's fresh `starting` claim.
			expect(await sessions.claimApp(projectId, notebookId, b.session_id)).toEqual({
				claimed: false,
				holder: a.session_id,
			});
		});

		it('exactly one of two simultaneous claims wins', async () => {
			const make = (user: UserId) =>
				sessions.createSession({
					notebook_id: notebookId,
					project_id: projectId,
					user_id: user,
					mode: 'app',
				});
			const [a, b] = await Promise.all([make(USER_A), make(USER_B)]);
			const results = await Promise.all([
				sessions.claimApp(projectId, notebookId, a.session_id),
				sessions.claimApp(projectId, notebookId, b.session_id),
			]);
			expect(results.filter((r) => r.claimed)).toHaveLength(1);
			const winner = results.find((r) => r.claimed)!.holder;
			expect(results.every((r) => r.holder === winner)).toBe(true);
		});

		it('is idempotent for the current holder', async () => {
			const a = await running(USER_A, 'app');
			await sessions.claimApp(projectId, notebookId, a.session_id);
			expect(await sessions.claimApp(projectId, notebookId, a.session_id)).toEqual({
				claimed: true,
				holder: a.session_id,
			});
		});

		it('replaces a claim whose holder is terminal', async () => {
			const a = await running(USER_A, 'app');
			await sessions.claimApp(projectId, notebookId, a.session_id);
			await sessions.markTerminated(projectId, a.session_id);

			const b = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: USER_B,
				mode: 'app',
			});
			expect(await sessions.claimApp(projectId, notebookId, b.session_id)).toEqual({
				claimed: true,
				holder: b.session_id,
			});
		});

		it('replaces a claim whose holder record is gone', async () => {
			const a = await running(USER_A, 'app');
			await sessions.claimApp(projectId, notebookId, a.session_id);
			await bucket.delete(paths.session(projectId, a.session_id));

			const b = await running(USER_B, 'app');
			expect((await sessions.claimApp(projectId, notebookId, b.session_id)).claimed).toBe(true);
		});

		it('replaces a corrupt claim', async () => {
			await bucket.put(claimKey(), 'not json');
			const a = await running(USER_A, 'app');
			expect((await sessions.claimApp(projectId, notebookId, a.session_id)).claimed).toBe(true);
		});

		it('release frees only the holder’s own claim', async () => {
			const a = await running(USER_A, 'app');
			await sessions.claimApp(projectId, notebookId, a.session_id);

			// Someone else's release is a no-op.
			const b = await running(USER_B, 'app');
			await sessions.releaseApp(projectId, notebookId, b.session_id);
			expect(await holder()).toBe(a.session_id);

			await sessions.releaseApp(projectId, notebookId, a.session_id);
			expect(await holder()).toBeNull();
			// The object stays behind, marked free — see releaseSingletonClaim.
			expect(await bucket.get(claimKey())).not.toBeNull();
		});

		it('a stale release cannot unseat the holder that replaced it', async () => {
			const a = await running(USER_A, 'app');
			await sessions.claimApp(projectId, notebookId, a.session_id);
			await sessions.markTerminated(projectId, a.session_id);

			// B takes over the (now stale) claim, then A's teardown releases late.
			const b = await running(USER_B, 'app');
			await sessions.claimApp(projectId, notebookId, b.session_id);
			await sessions.releaseApp(projectId, notebookId, a.session_id);

			expect(await holder()).toBe(b.session_id);
		});

		it('replaces a claim whose live holder is an edit session on this notebook', async () => {
			// A live holder that isn't THIS notebook's app is an invalid pointer, not
			// a reason to refuse the claimant — otherwise the notebook could never be
			// run as an app again.
			const edit = await running(USER_A, 'edit');
			await bucket.put(
				claimKey(),
				JSON.stringify({ session_id: edit.session_id, claimed_at: edit.started_at }),
			);

			const app = await running(USER_B, 'app');
			expect(await sessions.claimApp(projectId, notebookId, app.session_id)).toEqual({
				claimed: true,
				holder: app.session_id,
			});
		});

		it('replaces a claim whose live holder is an app on a different notebook', async () => {
			const otherNotebook = createNotebookId();
			const elsewhere = await running(USER_A, 'app', otherNotebook);
			await bucket.put(
				claimKey(),
				JSON.stringify({ session_id: elsewhere.session_id, claimed_at: elsewhere.started_at }),
			);

			const app = await running(USER_B, 'app');
			expect(await sessions.claimApp(projectId, notebookId, app.session_id)).toEqual({
				claimed: true,
				holder: app.session_id,
			});
		});

		it('release of a missing claim is a no-op', async () => {
			const a = await running(USER_A, 'app');
			await expect(
				sessions.releaseApp(projectId, notebookId, a.session_id),
			).resolves.toBeUndefined();
		});
	});
});
