import { afterEach, expect, it, vi } from 'vitest';
import { SessionCaptureCoordinator, createSandboxId } from '@marimo-hub/core';
import type { Session } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk, expectError } from '../testing';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
	const bucket = await createInitializedBucket();
	const fake = makeFakeSandbox();
	const api = createTestApi({ bucket, compute: fakeComputeFrom(fake.instance) });
	const { projects, notebooks, sessions } = api.deps.services;
	const project = await projects.createProject({ name: 'Stop', description: '' }, ACTOR);
	const notebook = await notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: 'durable' },
		ACTOR,
	);
	const session = await sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
	});
	await sessions.claimEditor(project.id, notebook.id, session.session_id, 'shared');
	await sessions.setRunning(project.id, session.session_id, 'https://kernel.example');
	const capture = vi.spyOn(SessionCaptureCoordinator.prototype, 'capture').mockResolvedValue({
		critical: {
			status: 'failed',
			code: 'SOURCE_UNAVAILABLE',
			retryable: true,
			cause: new Error('private endpoint secret'),
		},
		workspace: { status: 'skipped' },
		runtimeState: 'running',
	});
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions/${session.session_id}`;
	const stop = (key: string, query = '') =>
		api.request('DELETE', `${path}?wait=true${query}`, undefined, { 'Idempotency-Key': key });
	return {
		bucket,
		api,
		sessions,
		projects,
		project,
		notebook,
		session,
		path,
		stop,
		capture,
		...fake,
	};
}

it('returns a sanitized retained outcome, replays the header key, and requires a deliberate predecessor for force', async () => {
	const env = await fixture();
	await expectError(await env.stop('first'), 409, 'SESSION_PERSISTENCE_REQUIRED');
	const retained = await expectOk<Session>(await env.api.request('GET', env.path));
	expect(retained).toMatchObject({
		status: 'running',
		stop: {
			outcome: 'retained',
			trigger: 'interactive',
			force: false,
			runtime_state: 'running',
			failure: { code: 'SOURCE_UNAVAILABLE', retryable: true },
		},
	});
	expect(JSON.stringify(retained)).not.toMatch(
		/private endpoint|request_key|lease_id|runtime_directory|requested_by/,
	);
	await expectError(await env.stop('first'), 409, 'SESSION_PERSISTENCE_REQUIRED');
	expect(env.capture).toHaveBeenCalledOnce();
	await expectError(await env.stop('force', '&force=true'), 409, 'CONFLICT');
	expect(env.calls.destroy).toBe(0);
	await expectOk(await env.stop('force', `&force=true&previous_attempt_id=${retained.stop!.id}`));
	expect(env.capture).toHaveBeenCalledOnce();
	expect(env.calls.destroy).toBe(1);
	await expectOk(await env.stop('force', `&force=true&previous_attempt_id=${retained.stop!.id}`));
	expect(env.calls.destroy).toBe(1);
	const stored = await env.sessions.getSession(env.project.id, env.session.session_id);
	expect(stored.stop?.requested_by).toBe(ACTOR);
});

it('returns 202 for an owned attempt and rejects a force upgrade while it is running', async () => {
	const env = await fixture();
	const pending = await env.sessions.requestStop(env.project.id, env.session.session_id, {
		key: 'pending',
	});
	await env.sessions.claimStop(pending, crypto.randomUUID());
	await expectOk(await env.stop('pending'), 202);
	await expectError(
		await env.stop('force', `&force=true&previous_attempt_id=${pending.stop!.id}`),
		409,
		'CONFLICT',
	);
	expect(env.capture).not.toHaveBeenCalled();
	expect(env.calls.destroy).toBe(0);
});

it('rejects conflicting request identities before recording stop intent', async () => {
	const env = await fixture();
	await expectError(await env.stop('header', '&request_key=query'), 400, 'BAD_REQUEST');
	expect(
		(await env.sessions.getSession(env.project.id, env.session.session_id)).stop,
	).toBeUndefined();
});

it('requires the same stop permission for forced deletion', async () => {
	const env = await fixture();
	const viewer = uid('viewer');
	await env.projects.addMember(env.project.id, { user_id: viewer }, 'viewer', ACTOR);
	const client = createTestApi({
		bucket: env.bucket,
		userId: viewer,
		compute: fakeComputeFrom(env.instance),
	});
	await expectError(
		await client.request('DELETE', `${env.path}?wait=true&force=true`),
		403,
		'FORBIDDEN',
	);
	expect(env.calls.destroy).toBe(0);
	expect(
		(await env.sessions.getSession(env.project.id, env.session.session_id)).stop,
	).toBeUndefined();
});
