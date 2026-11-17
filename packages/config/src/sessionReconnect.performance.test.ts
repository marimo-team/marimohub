import { afterEach, expect, it, vi } from 'vitest';
import { CoreWeaveCompute } from '@marimo-hub/compute-coreweave';
import {
	NotFoundError,
	paths,
	SandboxId,
	SessionRetirer,
	UnavailableError,
	UserId,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { callRuntime } from '../../api/src/host/runtime';
import { getEditorSessionState } from '../../api/src/routes/sessionStart';
import { fakeProcess, makeWorld, procResult } from '../../compute-coreweave/src/testWorld';

afterEach(() => vi.restoreAllMocks());

async function setup(savedReference = true) {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const reply = { status: 200, notebook: { id: 'local', operations: [] }, events: [] };
	const world = makeWorld({
		startImpl: async () => ({
			...fakeProcess({ exitCode: 0 }),
			stdout: (async function* () {
				yield JSON.stringify(reply);
			})(),
		}),
		runImpl: async (command) =>
			procResult({
				stdout: command.join(' ').includes('/api/status/connections') ? '2' : JSON.stringify(reply),
			}),
	});
	const provider = () => new CoreWeaveCompute({ apiKey: 'test', image: 'test' }, world.client);
	const principal: AuthenticatedPrincipal = {
		id: UserId.parse('owner'),
		email: 'owner@example.com',
		credential: { kind: 'personal-access-token', id: 'test-token' },
	};
	const bucket = await createInitializedBucket();
	const replica = () => {
		const next = makeTestDeps(bucket, { compute: provider() });
		next.policy.editorSandboxSharing = 'exclusive';
		next.policy.defaultRole = 'editor';
		return next;
	};
	const deps = replica();
	const project = await deps.services.projects.createProject(
		{ name: 'Reconnect', description: '' },
		principal.id,
	);
	const created = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo' },
		principal.id,
	);
	const notebook = await deps.services.notebooks.getNotebook(project.id, created.id);
	const sandboxId = SandboxId.create();
	const sandbox = deps.compute.create(sandboxId, { reuse: false });
	await sandbox.ready!();
	const starting = await deps.services.sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.meta.id,
		user_id: principal.id,
		sandbox_id: sandboxId,
		editor_sandbox_sharing: 'exclusive',
	});
	await deps.services.sessions.claimEditor(
		project.id,
		notebook.meta.id,
		starting.session_id,
		'exclusive',
		principal.id,
	);
	const saveReference = (reference?: string) =>
		deps.services.sessions.setRunning(
			project.id,
			starting.session_id,
			'https://sandbox.example',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			reference,
		);
	const session = await saveReference(savedReference ? sandbox.reconnectReference : undefined);
	const lists = vi.spyOn(world.client, 'list');
	const originalGet = world.client.fromId.bind(world.client);
	const gets = vi.spyOn(world.client, 'fromId');
	const activity = () =>
		getEditorSessionState(
			replica(),
			{ ...principal, id: UserId.parse('other-editor') },
			project.id,
			notebook.meta.id,
		);
	const runtime = async (keepAlive: boolean) => {
		const next = replica();
		const current = await next.services.sessions.getSession(project.id, session.session_id);
		return callRuntime(
			next,
			principal,
			project,
			notebook,
			current,
			{ method: 'GET', path: '/catalog' },
			undefined,
			keepAlive,
		);
	};
	return {
		world,
		gets,
		lists,
		reply,
		activity,
		runtime,
		deps,
		session,
		originalGet,
		saveReference,
	};
}

it.each([true, false])(
	'counts provider lookups on fresh replicas (saved reference=%s)',
	async (savedReference) => {
		const { world, gets, lists, reply, activity, runtime } = await setup(savedReference);
		expect((await activity()).holder?.activity).toMatchObject({
			state: 'active',
			active_connections: 2,
		});
		expect(lists).toHaveBeenCalledTimes(savedReference ? 0 : 1);
		expect(gets).toHaveBeenCalledExactlyOnceWith('cw-1');
		for (const keepAlive of [true, false]) {
			lists.mockClear();
			gets.mockClear();
			expect(await runtime(keepAlive)).toEqual(reply);
			expect(lists).toHaveBeenCalledTimes(savedReference ? 0 : 1);
			expect(gets).toHaveBeenCalledExactlyOnceWith('cw-1');
		}
		expect(world.created).toHaveLength(1);
	},
);

it.each(['missing', 'stopped', 'unavailable', 'malformed', 'mismatched'] as const)(
	'never discovers or creates a replacement for a %s referenced sandbox',
	async (scenario) => {
		const {
			world,
			gets,
			lists,
			activity,
			runtime,
			deps,
			session,
			reply,
			originalGet,
			saveReference,
		} = await setup();
		const failure = new Error('Provider unavailable');
		if (scenario === 'missing') gets.mockRejectedValue(new NotFoundError('Sandbox gone'));
		if (scenario === 'stopped') world.registry.get('cw-1')!.fake.status = 'terminated';
		if (scenario === 'unavailable') gets.mockRejectedValue(failure);
		if (scenario === 'malformed' || scenario === 'mismatched') {
			const reference =
				scenario === 'malformed'
					? 'not-json'
					: JSON.stringify({
							kind: 'coreweave-v1',
							hubId: SandboxId.create(),
							sandboxId: 'cw-1',
						});
			await saveReference(reference);
		}
		const before = await deps.services.sessions.getSession(session.project_id, session.session_id);
		expect((await activity()).holder?.activity.state).toBe('unknown');
		for (const keepAlive of [true, false]) {
			await expect(runtime(keepAlive)).rejects.toBeInstanceOf(UnavailableError);
		}
		expect(lists).not.toHaveBeenCalled();
		expect(world.created).toHaveLength(1);
		expect(world.registry.get('cw-1')!.fake.runCalls).toEqual([]);
		expect(world.registry.get('cw-1')!.fake.startCalls).toEqual([]);
		expect(gets).toHaveBeenCalledTimes(
			scenario === 'malformed' || scenario === 'mismatched' ? 0 : 3,
		);
		const stored = await deps.services.sessions.getSession(session.project_id, session.session_id);
		expect(stored).toMatchObject({
			status: 'running',
			reconnect_reference: before.reconnect_reference,
		});
		expect(stored.connections_checked_at).toBeUndefined();
		if (scenario === 'unavailable') {
			gets.mockReset();
			gets.mockImplementation(originalGet);
			expect(await runtime(true)).toEqual(reply);
			expect(lists).not.toHaveBeenCalled();
			expect(gets).toHaveBeenCalledExactlyOnceWith('cw-1');
			expect(world.created).toHaveLength(1);
		}
	},
);

it.each(
	['malformed', 'provider-mismatched'].flatMap((reference) => [
		{ reference, mode: 'save', options: { save: true }, reason: 'destroy_failed' },
		{ reference, mode: 'destroy-only', options: { save: false }, reason: 'destroy_failed' },
		{
			reference,
			mode: 'idle probe',
			options: { save: true, requireIdle: true },
			reason: 'kernel_unreachable',
		},
	]),
)(
	'retains ownership when $mode reclaim rejects a $reference reference',
	async ({ reference, options, reason }) => {
		const { world, gets, lists, deps, session } = await setup();
		const expired = {
			...session,
			status: 'expired' as const,
			reconnect_reference:
				reference === 'malformed'
					? 'not-json'
					: JSON.stringify({
							kind: 'other-provider-v1',
							hubId: session.sandbox_id,
							sandboxId: 'cw-1',
						}),
		};
		await deps.bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify(expired),
		);
		const claim = await deps.services.sessions.getEditorClaim(
			session.project_id,
			session.notebook_id,
		);
		const remove = vi.spyOn(world.client, 'delete');
		const create = vi.spyOn(world.client, 'create');
		const retirer = new SessionRetirer({
			sessions: deps.services.sessions,
			notebooks: deps.services.notebooks,
			compute: new CoreWeaveCompute({ apiKey: 'test', image: 'test' }, world.client),
			bucket: deps.bucket,
			persistWorkspace: 'source',
		});

		expect(await retirer.reclaim(expired, options)).toEqual({ reclaimed: false, reason });
		expect(lists).not.toHaveBeenCalled();
		expect(gets).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(world.created).toHaveLength(1);
		const retained = await deps.services.sessions.getSession(
			session.project_id,
			session.session_id,
		);
		expect(retained).toMatchObject({
			status: 'expired',
			session_id: session.session_id,
			sandbox_id: session.sandbox_id,
			reconnect_reference: expired.reconnect_reference,
		});
		expect(retained.sandbox_reclaimed_at).toBeUndefined();
		if (options.save && !('requireIdle' in options)) {
			expect(retained.stop).toMatchObject({
				outcome: 'retained',
				runtime_state: 'unknown',
				force: false,
				failure: { code: 'RUNTIME_CAPTURE_UNAVAILABLE' },
			});
		}
		expect(
			await deps.services.sessions.getEditorClaim(session.project_id, session.notebook_id),
		).toEqual(claim);
		expect(claim?.session_id).toBe(session.session_id);
	},
);
