import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { SessionService } from './SessionService';
import { ConflictError, NotFoundError } from '../../errors';
import { paths } from '../../paths';
import { SessionSchema } from '../../schema';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const bucket = new MemoryBucket();
	const first = new SessionService(bucket);
	const second = new SessionService(bucket);
	const session = await first.createSession({
		project_id: createProjectId(),
		notebook_id: createNotebookId(),
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
	});
	return { first, second, session };
}

describe('durable stop attempts', () => {
	it('admits one cross-worker attempt and replays the same request', async () => {
		const { first, second, session } = await fixture();
		const request = { key: 'first' };
		const [a, b] = await Promise.all([
			first.requestStop(session.project_id, session.session_id, request),
			second.requestStop(session.project_id, session.session_id, request),
		]);
		expect(a.stop?.id).toBe(b.stop?.id);
		const lease = crypto.randomUUID();
		expect(await first.claimStop(a, lease)).not.toBeNull();
		expect(await second.claimStop(b, crypto.randomUUID())).toBeNull();
		await expect(
			second.requestStop(session.project_id, session.session_id, {
				key: 'force',
				force: true,
				previousId: a.stop!.id,
			}),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('retains a resumed session and requires acknowledgement for retry or force', async () => {
		const { first, second, session } = await fixture();
		const attempt = await first.requestStop(session.project_id, session.session_id, {
			key: 'initial',
		});
		const lease = crypto.randomUUID();
		await first.claimStop(attempt, lease);
		const retained = await first.updateStop(attempt, lease, {
			outcome: 'retained',
			runtime_state: 'running',
			failure: { code: 'SOURCE_UNAVAILABLE', retryable: true },
		});
		expect(retained.status).toBe('running');
		expect(retained.sandbox_reclaimed_at).toBeUndefined();
		await expect(second.requestStop(session.project_id, session.session_id)).rejects.toBeInstanceOf(
			ConflictError,
		);
		await expect(
			second.requestStop(session.project_id, session.session_id, { key: 'retry' }),
		).rejects.toBeInstanceOf(ConflictError);
		const forced = await second.requestStop(session.project_id, session.session_id, {
			key: 'force',
			force: true,
			previousId: retained.stop!.id,
		});
		expect(forced.stop).toMatchObject({ force: true, previous_id: retained.stop!.id });
		await expect(first.updateStop(attempt, lease, { outcome: 'stopped' })).rejects.toBeInstanceOf(
			ConflictError,
		);
		await expect(
			first.requestStop(session.project_id, session.session_id, { key: 'initial' }),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('fences an evicted request using its previous attempt id', async () => {
		const { first, session } = await fixture();
		let previousId: string | undefined;
		for (let index = 0; index < 19; index++) {
			const attempt = await first.requestStop(session.project_id, session.session_id, {
				key: `request-${index}`,
				previousId,
			});
			const lease = crypto.randomUUID();
			await first.claimStop(attempt, lease);
			await first.updateStop(attempt, lease, { outcome: 'retained', runtime_state: 'running' });
			previousId = attempt.stop!.id;
		}
		const current = await first.getSession(session.project_id, session.session_id);
		expect(current.stop_receipts).toHaveLength(16);
		await expect(
			first.requestStop(session.project_id, session.session_id, { key: 'request-0' }),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('does not claim a runtime is running when resume was not confirmed', async () => {
		const { first, session } = await fixture();
		const attempt = await first.requestStop(session.project_id, session.session_id);
		const lease = crypto.randomUUID();
		await first.claimStop(attempt, lease);
		const result = await first.updateStop(attempt, lease, {
			outcome: 'uncertain',
			runtime_state: 'unknown',
		});
		expect(result.status).toBe('terminating');
	});
});

import { ACTOR, fakeComputeFrom, makeFakeSandbox, setupTestEnv } from '../../testing';
import { SessionRetirer } from './SessionRetirer';
import { SessionCaptureCoordinator } from './SessionCaptureCoordinator';
import { RuntimeCaptureClient } from './runtimeCapture';

async function stopFixture() {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'Stops', description: '' }, ACTOR);
	const notebook = await env.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: '# durable' },
		ACTOR,
	);
	const session = await env.sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
	});
	await env.sessions.claimEditor(project.id, notebook.id, session.session_id, 'shared');
	const { instance, calls } = makeFakeSandbox();
	const retirer = new SessionRetirer({
		...env,
		compute: fakeComputeFrom(instance),
		persistWorkspace: 'source',
		automaticThumbnails: false,
	});
	const requested = await env.sessions.requestStop(project.id, session.session_id, {
		key: 'initial',
	});
	return { ...env, project, notebook, session, instance, calls, retirer, requested };
}

describe('safe retirement', () => {
	it('keeps the editor and its capacity after failed persistence; force requires a separate acknowledged request', async () => {
		const env = await stopFixture();
		vi.spyOn(SessionCaptureCoordinator.prototype, 'capture').mockResolvedValue({
			critical: {
				status: 'failed',
				code: 'SOURCE_UNAVAILABLE',
				retryable: true,
				cause: new Error('private detail'),
			},
			workspace: { status: 'skipped' },
			runtimeState: 'running',
		});
		const retained = await env.retirer.stop(env.requested);
		expect(retained).toMatchObject({
			status: 'running',
			stop: { outcome: 'retained', failure: { code: 'SOURCE_UNAVAILABLE' } },
		});
		expect(env.calls.destroy).toBe(0);
		expect(await env.sessions.ownsEditorClaim(retained)).toBe(true);
		const force = await env.sessions.requestStop(env.project.id, env.session.session_id, {
			key: 'force',
			previousId: retained.stop!.id,
			force: true,
		});
		const stopped = await env.retirer.stop(force);
		expect(stopped.stop?.outcome).toBe('stopped');
		expect(env.calls.destroy).toBe(1);
		expect(await env.sessions.ownsEditorClaim(stopped)).toBe(false);
	});

	it('never destroys when the checkpoint expired before commit-stop', async () => {
		const env = await stopFixture();
		const token = crypto.randomUUID();
		vi.spyOn(SessionCaptureCoordinator.prototype, 'capture').mockResolvedValue({
			critical: {
				status: 'durable',
				capturedAt: new Date().toISOString(),
				publication: {
					versionId: (await env.notebooks.getNotebookSource(env.project.id, env.notebook.id))
						.current_version_id!,
					newVersion: false,
					capturedHtml: false,
					capturedSession: false,
				},
			},
			workspace: { status: 'skipped' },
			runtime: { token, directory: '/checkpoint' },
			runtimeState: 'paused',
		});
		vi.spyOn(RuntimeCaptureClient.prototype, 'commitStop').mockRejectedValue(new Error('expired'));
		await env.retirer.stop(env.requested);
		expect(env.calls.destroy).toBe(0);
		const current = await env.sessions.getSession(env.project.id, env.session.session_id);
		expect(current.stop).toMatchObject({ outcome: 'durable', runtime_token: token });
	});

	it('retries cleanup after a lost commit-stop acknowledgement using its durable runtime token', async () => {
		const env = await stopFixture();
		const token = crypto.randomUUID();
		const lease = crypto.randomUUID();
		await env.sessions.claimStop(env.requested, lease);
		const recorded = await env.sessions.updateStop(env.requested, lease, {
			outcome: 'durable',
			runtime_token: token,
			runtime_directory: '/checkpoint',
		});
		const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 4 * 60_000);
		vi.spyOn(RuntimeCaptureClient.prototype, 'status').mockResolvedValue({
			ok: true,
			state: 'stopped',
			token,
		});
		const commit = vi.spyOn(RuntimeCaptureClient.prototype, 'commitStop').mockResolvedValue();
		const capture = vi.spyOn(SessionCaptureCoordinator.prototype, 'capture');
		try {
			const stopped = await env.retirer.stop(recorded);
			expect(stopped.stop?.outcome).toBe('stopped');
			expect(capture).not.toHaveBeenCalled();
			expect(commit).toHaveBeenCalledWith({ token, directory: '/checkpoint' });
			expect(env.calls.destroy).toBe(1);
		} finally {
			time.mockRestore();
		}
	});
});

it('keeps retained editor ownership, index membership, and capacity despite a stale heartbeat', async () => {
	const env = await stopFixture();
	vi.spyOn(SessionCaptureCoordinator.prototype, 'capture').mockResolvedValue({
		critical: {
			status: 'failed',
			code: 'SOURCE_UNAVAILABLE',
			retryable: true,
			cause: new Error('unavailable'),
		},
		workspace: { status: 'skipped' },
		runtimeState: 'running',
	});
	await env.retirer.stop(env.requested);
	vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 48 * 60 * 60_000);
	expect(await env.sessions.expireStale()).toBe(0);
	await env.sessions.reconcileSessionIndexes(await env.sessions.listSessions());
	expect(await env.sessions.reapTerminated()).toBe(0);
	expect(await env.sessions.countActiveForUser(ACTOR)).toBe(1);
	expect(
		await env.sessions.ownsEditorClaim(
			await env.sessions.getSession(env.project.id, env.session.session_id),
		),
	).toBe(true);
});

it('clears only the captured dirty generation when another native save is acknowledged', async () => {
	const { first, session } = await fixture();
	const versionId = (await import('../../ids')).createVersionId();
	const a = await first.acknowledgeRuntimeSave(session.project_id, session.session_id);
	const b = await first.acknowledgeRuntimeSave(session.project_id, session.session_id);
	const committedA = await first.recordDurableCapture(a, new Date().toISOString(), versionId);
	expect(committedA.save_dirty?.id).toBe(b.save_dirty?.id);
	const committedB = await first.recordDurableCapture(b, new Date().toISOString(), versionId);
	expect(committedB.save_dirty).toBeUndefined();
});

it('resumes finalization after a stopped receipt was saved but the terminal transition failed', async () => {
	const env = await stopFixture();
	const forced = await env.sessions.requestStop(env.project.id, env.session.session_id);
	const lease = crypto.randomUUID();
	await env.sessions.claimStop(forced, lease);
	await env.sessions.markSandboxReclaimed(
		env.project.id,
		env.session.session_id,
		new Date().toISOString(),
	);
	const stopped = await env.sessions.updateStop(forced, lease, {
		outcome: 'stopped',
		runtime_state: 'stopped',
	});
	const terminal = vi
		.spyOn(env.sessions, 'markTerminated')
		.mockRejectedValueOnce(new Error('lost terminal write'));
	await expect(env.retirer.stop(stopped)).rejects.toThrow('lost terminal write');
	const result = await env.retirer.stop(stopped);
	expect(result.status).toBe('terminated');
	expect(terminal).toHaveBeenCalledTimes(2);
	expect(await env.sessions.ownsEditorClaim(result)).toBe(false);
	expect(env.calls.destroy).toBe(0);
});

it('invalidates an automatic stop if the user returns before the worker resumes it', async () => {
	const env = await stopFixture();
	const lease = crypto.randomUUID();
	await env.sessions.claimStop(env.requested, lease);
	const retained = await env.sessions.updateStop(env.requested, lease, {
		outcome: 'retained',
		runtime_state: 'running',
	});
	const automatic = await env.sessions.requestStop(env.project.id, env.session.session_id, {
		key: 'idle',
		previousId: retained.stop!.id,
		trigger: 'idle',
	});
	const key = (await import('../../paths')).paths.session(env.project.id, env.session.session_id);
	await env.bucket.put(
		key,
		JSON.stringify({ ...automatic, last_heartbeat: new Date(Date.now() + 1000).toISOString() }),
	);
	const capture = vi.spyOn(SessionCaptureCoordinator.prototype, 'capture');
	const result = await env.retirer.stop(automatic);
	expect(result.stop).toMatchObject({
		outcome: 'retained',
		failure: { code: 'STOP_NO_LONGER_ELIGIBLE' },
	});
	expect(capture).not.toHaveBeenCalled();
	expect(env.calls.destroy).toBe(0);
});

it('security expiry preempts a wedged ordinary stop lease and fences its delayed worker', async () => {
	const env = await stopFixture();
	const lease = crypto.randomUUID();
	await env.sessions.claimStop(env.requested, lease);
	const key = (await import('../../paths')).paths.session(env.project.id, env.session.session_id);
	const current = await env.sessions.getSession(env.project.id, env.session.session_id);
	await env.bucket.put(
		key,
		JSON.stringify({
			...current,
			authorization_expires_at: new Date(Date.now() - 1000).toISOString(),
		}),
	);
	const security = await env.sessions.requestStop(env.project.id, env.session.session_id, {
		trigger: 'security',
		force: true,
	});
	expect(security.stop?.id).not.toBe(env.requested.stop?.id);
	await expect(
		env.sessions.updateStop(env.requested, lease, { outcome: 'durable' }),
	).rejects.toBeInstanceOf(ConflictError);
	expect((await env.retirer.stop(security)).stop).toMatchObject({
		trigger: 'security',
		outcome: 'stopped',
	});
	expect(env.calls.destroy).toBe(1);
});

async function preparedStopFixture() {
	const env = await stopFixture();
	await env.instance.writeFiles([{ path: '/checkpoint/notebook.py', content: '# durable' }]);
	const checkpoint = { token: crypto.randomUUID(), directory: '/checkpoint' };
	const prepare = vi.spyOn(RuntimeCaptureClient.prototype, 'prepare').mockResolvedValue(checkpoint);
	const resume = vi.spyOn(RuntimeCaptureClient.prototype, 'resume').mockResolvedValue();
	const commitStop = vi.spyOn(RuntimeCaptureClient.prototype, 'commitStop').mockResolvedValue();
	const capture = vi.spyOn(SessionCaptureCoordinator.prototype, 'capture');
	const compute = fakeComputeFrom(env.instance);
	const freshWorker = () => {
		const sessions = new SessionService(env.bucket);
		return {
			sessions,
			retirer: new SessionRetirer({
				...env,
				sessions,
				compute,
				persistWorkspace: 'source',
				automaticThumbnails: false,
			}),
		};
	};
	return { ...env, checkpoint, prepare, resume, commitStop, capture, compute, freshWorker };
}

it.each(['attach', 'exec'] as const)(
	'reconciles lost destroy acknowledgement after provider-confirmed absence during %s',
	async (confirmation) => {
		const env = await preparedStopFixture();
		let exists = true;
		const destroy = vi.spyOn(env.instance, 'destroy').mockImplementation(async () => {
			exists = false;
			throw new Error('Destroy acknowledgement lost');
		});
		const exec = env.instance.exec.bind(env.instance);
		vi.spyOn(env.instance, 'exec').mockImplementation((command, options) => {
			if (!exists) throw new NotFoundError('Provider confirms sandbox absent');
			return exec(command, options);
		});
		if (confirmation === 'attach')
			env.compute.connectExisting = () => {
				if (!exists) throw new NotFoundError('Provider confirms sandbox absent');
				return env.instance;
			};
		const pending = await env.retirer.stop(env.requested);
		expect(pending.stop).toMatchObject({ outcome: 'stopping', runtime_state: 'stopped' });
		expect(pending.sandbox_reclaimed_at).toBeUndefined();
		expect(await env.sessions.ownsEditorClaim(pending)).toBe(true);
		expect(env.commitStop).toHaveBeenCalledOnce();
		const worker = env.freshWorker();
		const stopped = await worker.retirer.stop(
			await worker.sessions.getSession(env.project.id, env.session.session_id),
		);
		expect(stopped).toMatchObject({
			status: 'terminated',
			stop: { outcome: 'stopped', finalized_at: expect.any(String) },
			sandbox_reclaimed_at: expect.any(String),
		});
		expect(await worker.sessions.ownsEditorClaim(stopped)).toBe(false);
		expect(env.capture).toHaveBeenCalledOnce();
		expect(destroy).toHaveBeenCalledOnce();
	},
);

it('keeps ownership after destroy timeouts until a later worker confirms destruction', async () => {
	const env = await preparedStopFixture();
	const destroy = vi
		.spyOn(env.instance, 'destroy')
		.mockRejectedValueOnce(new Error('Provider timeout'))
		.mockRejectedValueOnce(new Error('Provider still unavailable'))
		.mockResolvedValue();
	vi.spyOn(RuntimeCaptureClient.prototype, 'status').mockResolvedValue({
		ok: true,
		state: 'stopped',
		token: env.checkpoint.token,
	});
	await env.retirer.stop(env.requested);
	const worker = env.freshWorker();
	const pending = await worker.retirer.stop(
		await worker.sessions.getSession(env.project.id, env.session.session_id),
	);
	expect(pending.stop?.outcome).toBe('stopping');
	expect(pending.sandbox_reclaimed_at).toBeUndefined();
	expect(await worker.sessions.ownsEditorClaim(pending)).toBe(true);
	expect(await worker.sessions.countActiveForUser(ACTOR)).toBe(1);
	const stopped = await env.freshWorker().retirer.stop(pending);
	expect(stopped).toMatchObject({
		status: 'terminated',
		stop: { outcome: 'stopped' },
		sandbox_reclaimed_at: expect.any(String),
	});
	expect(await worker.sessions.ownsEditorClaim(stopped)).toBe(false);
	expect(env.capture).toHaveBeenCalledOnce();
	expect(destroy).toHaveBeenCalledTimes(3);
});

it.each(
	['capture receipt', 'checkpoint receipt'].flatMap((boundary) =>
		[false, true].map((committed) => ({ boundary, committed })),
	),
)(
	'resumes without destruction after failed $boundary write (committed=$committed)',
	async ({ boundary, committed }) => {
		const env = await preparedStopFixture();
		const put = env.bucket.put.bind(env.bucket);
		const key = paths.session(env.project.id, env.session.session_id);
		let injected = false;
		const write = vi.spyOn(env.bucket, 'put').mockImplementation(async (path, body, options) => {
			if (path === key && typeof body === 'string' && !injected) {
				const value = SessionSchema.parse(JSON.parse(body));
				if (
					boundary === 'capture receipt'
						? value.last_durable_capture && value.stop?.outcome === 'capturing'
						: value.stop?.outcome === 'durable'
				) {
					injected = true;
					if (committed) await put(path, body, options);
					throw new Error('Receipt write acknowledgement failed');
				}
			}
			return put(path, body, options);
		});
		try {
			const retained = await env.retirer.stop(env.requested);
			expect(injected).toBe(true);
			expect(retained).toMatchObject({
				status: 'running',
				stop: {
					outcome: 'uncertain',
					runtime_state: 'running',
					failure: { code: 'CAPTURE_RECEIPT_FAILED' },
				},
			});
			expect(env.resume).toHaveBeenCalledOnce();
			expect(env.commitStop).not.toHaveBeenCalled();
			expect(env.calls.destroy).toBe(0);
			expect(await env.sessions.ownsEditorClaim(retained)).toBe(true);
			const worker = env.freshWorker();
			await worker.retirer.stop(retained);
			expect(env.prepare).toHaveBeenCalledOnce();
			const retry = await worker.sessions.requestStop(env.project.id, env.session.session_id, {
				key: 'repaired',
				previousId: retained.stop!.id,
			});
			expect((await worker.retirer.stop(retry)).stop?.outcome).toBe('stopped');
			expect(env.calls.destroy).toBe(1);
		} finally {
			write.mockRestore();
		}
	},
);

it.each(
	['fence', 'reclaim marker', 'stopping receipt'].flatMap((boundary) =>
		[false, true].map((committed) => ({ boundary, committed })),
	),
)(
	'retries failed $boundary after confirmed absence (committed=$committed)',
	async ({ boundary, committed }) => {
		const env = await preparedStopFixture();
		env.compute.connectExisting = () => {
			throw new NotFoundError('Provider confirms sandbox absent');
		};
		const create = vi.spyOn(env.compute, 'create');
		const key = paths.session(env.project.id, env.session.session_id);
		const source = paths.project(env.project.id).notebook(env.notebook.id).source;
		const put = env.bucket.put.bind(env.bucket);
		let injected = false;
		vi.spyOn(env.bucket, 'put').mockImplementation(async (path, body, options) => {
			if (typeof body === 'string' && !injected) {
				const session = path === key ? SessionSchema.parse(JSON.parse(body)) : undefined;
				const matches =
					boundary === 'fence'
						? path === source
						: boundary === 'reclaim marker'
							? !!session?.sandbox_reclaimed_at
							: session?.stop?.outcome === 'stopping';
				if (matches) {
					injected = true;
					if (committed) await put(path, body, options);
					throw new Error('Cleanup acknowledgement failed');
				}
			}
			return put(path, body, options);
		});
		const first = env.freshWorker();
		const pending = await first.retirer.stop(env.requested);
		expect(injected).toBe(true);
		expect(pending.stop?.outcome).toBe(
			boundary === 'stopping receipt' && !committed ? 'pending' : 'stopping',
		);
		expect(await first.sessions.ownsEditorClaim(pending)).toBe(true);
		const second = env.freshWorker();
		const stopped = await second.retirer.stop(pending);
		expect(stopped).toMatchObject({
			status: 'terminated',
			stop: { outcome: 'stopped', finalized_at: expect.any(String) },
			sandbox_reclaimed_at: expect.any(String),
		});
		expect(await second.sessions.ownsEditorClaim(stopped)).toBe(false);
		expect(env.capture).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(env.calls.destroy).toBe(0);
	},
);
