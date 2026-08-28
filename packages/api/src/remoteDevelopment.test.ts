import { describe, expect, it, vi } from 'vitest';
import { createNotebookId, createSandboxId, createServices } from '@marimo-hub/core';
import type { SandboxPortConnector } from '@marimo-hub/core';
import { ACTOR, makeSession, MemoryBucket, noopCompute, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, makeTestDeps } from './testing';
import { authorizeRemoteDevelopmentRequest, sshAvailability } from './remoteDevelopment';

const STRANGER = uid('user_stranger');

describe('sshAvailability', () => {
	it('reports each configuration and session compatibility state', () => {
		const deps = makeTestDeps(new MemoryBucket());
		expect(sshAvailability(deps, makeSession())).toEqual({
			available: false,
			reason: 'disabled',
		});

		deps.sandbox.remoteDevelopment = { mode: 'ssh', images: ['remote-image'], port: 2222 };
		expect(
			sshAvailability(
				deps,
				makeSession({ sandbox_image: 'remote-image', sandbox_brokered_ports: [2222] }),
			),
		).toEqual({
			available: false,
			reason: 'unsupported_backend',
		});

		deps.compute = {
			...noopCompute,
			brokeredPortConnectionsEnabled: true,
			connectPort: async () => {
				throw new Error('not used');
			},
		} as typeof noopCompute & SandboxPortConnector;
		expect(sshAvailability(deps, makeSession())).toEqual({
			available: false,
			reason: 'restart_required',
		});
		expect(sshAvailability(deps, makeSession({ sandbox_image: 'other-image' }))).toEqual({
			available: false,
			reason: 'unsupported_image',
		});
		expect(sshAvailability(deps, makeSession({ sandbox_image: 'remote-image' }))).toEqual({
			available: false,
			reason: 'restart_required',
		});
		expect(
			sshAvailability(
				deps,
				makeSession({ sandbox_image: 'remote-image', sandbox_brokered_ports: [2223] }),
			),
		).toEqual({
			available: false,
			reason: 'restart_required',
		});
		expect(
			sshAvailability(
				deps,
				makeSession({ sandbox_image: 'remote-image', sandbox_brokered_ports: [2222] }),
			),
		).toEqual({
			available: true,
		});
	});
});

async function createAuthorizationWorld(userId = ACTOR, authorizationExpiresAt?: string) {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'Owned', description: 'd' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: 'd', code: 'import marimo as mo' },
		ACTOR,
	);
	const session = await services.sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
		sandbox_image: 'remote-image',
		sandbox_brokered_ports: [2222],
		editor_sandbox_sharing: 'exclusive',
		authorization_expires_at: authorizationExpiresAt,
	});
	await services.sessions.setRunning(project.id, session.session_id, 'https://sandbox.invalid');
	const deps = makeTestDeps(bucket, {
		authenticator: {
			authenticate: async () => ({ id: userId, email: `${userId}@example.com` }),
		},
		compute: {
			...noopCompute,
			brokeredPortConnectionsEnabled: true,
			connectPort: async () => {
				throw new Error('not used');
			},
		} as typeof noopCompute & SandboxPortConnector,
		policy: { editorSandboxSharing: 'exclusive' },
		sandbox: {
			...makeTestDeps(bucket).sandbox,
			remoteDevelopment: { mode: 'ssh', images: ['remote-image'], port: 2222 },
		},
	});
	const url = (notebookId = notebook.id) =>
		`https://hub.example/api/v1/projects/${project.id}/notebooks/${notebookId}/sessions/${session.session_id}/remote-development/ssh/relay`;
	const request = (notebookId = notebook.id, authorization = 'Bearer test') =>
		new Request(url(notebookId), { headers: { authorization } });
	return { deps, notebook, project, request, services, session };
}

describe('authorizeRemoteDevelopmentRequest', () => {
	it('passes requests that are not for the SSH relay', async () => {
		const deps = makeTestDeps(new MemoryBucket());

		await expect(
			authorizeRemoteDevelopmentRequest(
				new Request('https://hub.example/api/v1/capabilities'),
				deps,
			),
		).resolves.toEqual({ kind: 'pass' });
	});

	it('rejects malformed identifiers without attempting authentication', async () => {
		const authenticate = vi.fn(async () => ({ id: ACTOR, email: 'actor@example.com' }));
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: { authenticate } });

		await expect(
			authorizeRemoteDevelopmentRequest(
				new Request(
					'https://hub.example/api/v1/projects/bad/notebooks/bad/sessions/bad/remote-development/ssh/relay',
					{ headers: { authorization: 'Bearer test' } },
				),
				deps,
			),
		).resolves.toEqual({ kind: 'reject', status: 404, message: 'Session not found' });
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('requires a well-formed bearer credential and an authenticated user', async () => {
		const world = await createAuthorizationWorld();
		world.deps.authenticator = { authenticate: async () => null };

		await expect(
			authorizeRemoteDevelopmentRequest(
				new Request(world.request().url, { headers: { authorization: 'Basic test' } }),
				world.deps,
			),
		).resolves.toMatchObject({ kind: 'reject', status: 401 });
		await expect(
			authorizeRemoteDevelopmentRequest(world.request(), world.deps),
		).resolves.toMatchObject({ kind: 'reject', status: 401 });
	});

	it('authorizes only the running session owner and returns the brokered port', async () => {
		const world = await createAuthorizationWorld();

		await expect(
			authorizeRemoteDevelopmentRequest(world.request(), world.deps),
		).resolves.toMatchObject({
			kind: 'connect',
			port: 2222,
			user: { id: ACTOR },
			session: { session_id: world.session.session_id },
		});
	});

	it('hides notebook mismatches as a missing session', async () => {
		const world = await createAuthorizationWorld();

		await expect(
			authorizeRemoteDevelopmentRequest(world.request(createNotebookId()), world.deps),
		).resolves.toEqual({ kind: 'reject', status: 404, message: 'Session not found' });
	});

	it('rejects a relay after its session begins terminating', async () => {
		const world = await createAuthorizationWorld();
		await world.services.sessions.beginTerminating(world.project.id, world.session.session_id);

		await expect(authorizeRemoteDevelopmentRequest(world.request(), world.deps)).resolves.toEqual({
			kind: 'reject',
			status: 410,
			message: 'Session is no longer running',
		});
	});

	it('rejects an expired session authorization deadline', async () => {
		const world = await createAuthorizationWorld(ACTOR, new Date(Date.now() - 1000).toISOString());

		await expect(authorizeRemoteDevelopmentRequest(world.request(), world.deps)).resolves.toEqual({
			kind: 'reject',
			status: 410,
			message: 'Session authorization has expired',
		});
	});

	it('rejects an image that is not enabled for remote development', async () => {
		const world = await createAuthorizationWorld();
		world.deps.sandbox.remoteDevelopment!.images = ['different-image'];

		await expect(authorizeRemoteDevelopmentRequest(world.request(), world.deps)).resolves.toEqual({
			kind: 'reject',
			status: 409,
			message: 'SSH access is unavailable: unsupported_image',
		});
	});

	it('rejects users other than the exclusive session owner', async () => {
		const world = await createAuthorizationWorld(STRANGER);

		await expect(
			authorizeRemoteDevelopmentRequest(world.request(), world.deps),
		).resolves.toMatchObject({ kind: 'reject', status: 403 });
	});

	it('rejects suspended users and fails closed when suspension cannot be checked', async () => {
		const suspended = await createAuthorizationWorld();
		vi.spyOn(suspended.deps.services.identities, 'isSuspended').mockResolvedValue(true);
		await expect(
			authorizeRemoteDevelopmentRequest(suspended.request(), suspended.deps),
		).resolves.toEqual({ kind: 'reject', status: 403, message: 'User account is suspended' });

		const unavailable = await createAuthorizationWorld();
		vi.spyOn(unavailable.deps.services.identities, 'isSuspended').mockRejectedValue(
			new Error('storage unavailable'),
		);
		await expect(
			authorizeRemoteDevelopmentRequest(unavailable.request(), unavailable.deps),
		).resolves.toEqual({
			kind: 'reject',
			status: 503,
			message: 'Unable to verify account status',
		});
	});
});
