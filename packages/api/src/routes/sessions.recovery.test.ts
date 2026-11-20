import { afterEach, expect, it, vi } from 'vitest';
import {
	createServices,
	ReconciliationService,
	createSandboxId,
	UnavailableError,
	NotFoundError,
	paths,
} from '@marimo-hub/core';
import type { Session } from '@marimo-hub/core';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeSandbox,
	uid,
	localResourceSecurity,
	makeSubjectContext,
} from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk, expectError } from '../testing';
import type { TestApiOptions } from '../testing';
import { isSandboxContextCommand } from '../testing/sandboxContext';

afterEach(() => vi.restoreAllMocks());

async function fixture(options: TestApiOptions = {}) {
	const bucket = await createInitializedBucket();
	const { instance, calls } = makeFakeSandbox();
	const compute = fakeComputeFrom(instance);
	const api = createTestApi({ bucket, compute, ...options });
	const project = await api.deps.services.projects.createProject(
		{ name: 'Recovery', description: '' },
		ACTOR,
	);
	const notebook = await api.deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo' },
		ACTOR,
	);
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	const create = vi.spyOn(compute, 'create');
	const replica = (opts: TestApiOptions = {}) =>
		createTestApi({
			bucket,
			compute,
			...options,
			...opts,
			deps: { ...options.deps, services: createServices(bucket), ...opts.deps },
		});
	const prepare = async () => {
		vi.spyOn(api.deps.services.sessions, 'completeStartup').mockRejectedValueOnce(
			new UnavailableError('Replica unavailable'),
		);
		await expectError(await api.request('POST', path), 503);
		const [session] = await api.deps.services.sessions.listSessions();
		expect(session.status).toBe('starting');
		expect(session.startup_completion).toBeDefined();
		return session;
	};
	return {
		api,
		bucket,
		compute,
		instance,
		calls,
		create,
		replica,
		project,
		notebook,
		path,
		prepare,
	};
}

it('recovers a prepared runtime through a fresh authenticated replica without creating compute', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const other = env.replica();
	const recovered = await expectOk<Session>(await other.request('POST', env.path));
	expect(recovered).toMatchObject({ session_id: original.session_id, status: 'running' });
	expect(env.create).toHaveBeenCalledTimes(1);
	expect(env.calls.destroy).toBe(0);
	expect(
		await other.deps.services.sessions.getEditorClaim(env.project.id, env.notebook.id),
	).toMatchObject({ session_id: original.session_id });
	for (const response of [
		recovered,
		await expectOk(await other.request('GET', `${env.path}/${original.session_id}`)),
		await other.deps.services.sessions.getStartupStatus(env.project.id, original.session_id),
	]) {
		expect(response).not.toHaveProperty('startup_completion');
		expect(response).not.toHaveProperty('sandbox_origin_url');
		expect(response).not.toHaveProperty('reconnect_reference');
	}
});

it('recovers a receipt whose successful write lost its acknowledgement', async () => {
	const env = await fixture();
	const sessions = env.api.deps.services.sessions;
	const record = sessions.recordStartupCompletion.bind(sessions);
	vi.spyOn(sessions, 'recordStartupCompletion').mockImplementationOnce(async (...args) => {
		await record(...args);
		throw new UnavailableError('Write acknowledgement lost');
	});
	await expectError(await env.api.request('POST', env.path), 503);
	const [original] = await sessions.listSessions();
	expect(original.startup_completion).toBeDefined();
	const recovered = await expectOk<Session>(await env.replica().request('POST', env.path));
	expect(recovered.session_id).toBe(original.session_id);
	expect(recovered.status).toBe('running');
	expect(env.create).toHaveBeenCalledTimes(1);
	expect(env.calls.destroy).toBe(0);
});

it('a stale original saga cannot destroy or fail a runtime completed by racing retries', async () => {
	const env = await fixture();
	const gate = Promise.withResolvers<Session>();
	const entered = Promise.withResolvers<void>();
	vi.spyOn(env.api.deps.services.sessions, 'completeStartup').mockImplementationOnce(() => {
		entered.resolve();
		return gate.promise;
	});
	const original = env.api.request('POST', env.path);
	await entered.promise;
	const results = await Promise.all([
		env.replica().request('POST', env.path),
		env.replica().request('POST', env.path),
	]);
	const sessions = await Promise.all(results.map((response) => expectOk<Session>(response)));
	expect(sessions[0].session_id).toBe(sessions[1].session_id);
	gate.reject(new UnavailableError('Old replica lost storage'));
	await expectError(await original, 503);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, sessions[0].session_id))
			.status,
	).toBe('running');
	expect(env.create).toHaveBeenCalledTimes(1);
	expect(env.calls.destroy).toBe(0);
});

it.each(['dead'] as const)('retains the receipt when readiness is %s', async (readiness) => {
	const env = await fixture();
	const original = await env.prepare();
	await expectError(
		await env.replica({ deps: { kernelProbe: async () => readiness } }).request('POST', env.path),
		503,
	);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('starting');
	expect(env.create).toHaveBeenCalledTimes(1);
	expect(env.calls.destroy).toBe(0);
});

it('does not publish a prepared runtime when stop wins during its readiness probe', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				await env.api.deps.services.sessions.beginTerminating(env.project.id, original.session_id);
				return 'alive';
			},
		},
	});
	await expectError(await replica.request('POST', env.path), 409);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('terminating');
	expect(env.create).toHaveBeenCalledTimes(1);
});

it('does not publish stale receipt details after sandbox replacement during the readiness probe', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replacement = createSandboxId();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				await env.api.deps.services.sessions.replaceStartingSandbox(
					env.project.id,
					original.session_id,
					original.sandbox_id!,
					replacement,
				);
				return 'alive';
			},
		},
	});
	await expectError(await replica.request('POST', env.path), 409);
	expect(
		await env.api.deps.services.sessions.getSession(env.project.id, original.session_id),
	).toMatchObject({ status: 'starting', sandbox_id: replacement });
	expect(env.calls.destroy).toBe(0);
});

it.each(['project', 'notebook'] as const)('rejects recovery after %s deletion', async (target) => {
	const env = await fixture();
	await env.prepare();
	if (target === 'project')
		await env.api.deps.services.projects.deleteProject(env.project.id, ACTOR);
	else await env.api.deps.services.notebooks.deleteNotebook(env.project.id, env.notebook.id, ACTOR);
	await expectError(await env.replica().request('POST', env.path), 404);
	expect(env.create).toHaveBeenCalledTimes(1);
});

it("does not promote another owner's shared starting editor", async () => {
	const env = await fixture();
	const original = await env.prepare();
	const other = env.replica({
		userId: uid('another-editor'),
		deps: { policy: { defaultRole: 'editor' } },
	});
	const response = await expectOk<Session>(await other.request('POST', env.path));
	expect(response).toMatchObject({ session_id: original.session_id, status: 'starting' });
	expect(env.create).toHaveBeenCalledTimes(1);
});

it.each(['app', 'temporary'] as const)(
	'leaves %s startup on its existing lifecycle',
	async (mode) => {
		const env = await fixture(
			mode === 'temporary' ? { deps: { policy: { editorSandboxSharing: 'exclusive' } } } : {},
		);
		const response = await expectOk<Session>(
			await env.api.request(
				'POST',
				env.path,
				mode === 'app' ? { mode } : { edit_intent: 'temporary' },
			),
		);
		expect(response.status).toBe('running');
		expect(
			(await env.api.deps.services.sessions.getSession(env.project.id, response.session_id))
				.startup_completion,
		).toBeUndefined();
	},
);

it('reclaims the runtime when the receipt write definitely did not commit', async () => {
	const env = await fixture();
	vi.spyOn(env.api.deps.services.sessions, 'recordStartupCompletion').mockRejectedValueOnce(
		new UnavailableError('Receipt storage failed'),
	);
	await expectError(await env.api.request('POST', env.path), 503);
	const [session] = await env.api.deps.services.sessions.listSessions();
	expect(session).toMatchObject({ status: 'failed', sandbox_reclaimed_at: expect.any(String) });
	expect(session.startup_completion).toBeUndefined();
	expect(env.calls.destroy).toBe(1);
});

it.each(['project', 'notebook', 'suspension', 'claim'] as const)(
	'rejects and reclaims the exact runtime when %s changes after running publication',
	async (change) => {
		const env = await fixture();
		const original = await env.prepare();
		const replica = env.replica();
		const sessions = replica.deps.services.sessions;
		const complete = sessions.completeStartup.bind(sessions);
		vi.spyOn(sessions, 'completeStartup').mockImplementationOnce(async (...args) => {
			const result = await complete(...args);
			if (change === 'project')
				await replica.deps.services.projects.deleteProject(env.project.id, ACTOR);
			if (change === 'notebook')
				await replica.deps.services.notebooks.deleteNotebook(
					env.project.id,
					env.notebook.id,
					ACTOR,
				);
			if (change === 'suspension')
				await replica.deps.services.identities.setSuspension(ACTOR, true);
			if (change === 'claim') await sessions.releaseEditorFor(result);
			return result;
		});
		await expectError(
			await replica.request('POST', env.path),
			change === 'suspension' ? 403 : change === 'claim' || change === 'notebook' ? 409 : 404,
		);
		expect(await sessions.getSession(env.project.id, original.session_id)).toMatchObject({
			status: 'failed',
			sandbox_reclaimed_at: expect.any(String),
		});
		expect(env.calls.destroy).toBe(1);
		expect(env.create).toHaveBeenCalledTimes(1);
	},
);

it('does not reclaim a replacement when a stale runtime completion loses authorization', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replacement = createSandboxId();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				await env.api.deps.services.sessions.replaceStartingSandbox(
					env.project.id,
					original.session_id,
					original.sandbox_id!,
					replacement,
				);
				await env.api.deps.services.projects.deleteProject(env.project.id, ACTOR);
				return 'alive';
			},
		},
	});
	await expectError(await replica.request('POST', env.path), 404);
	expect(env.calls.destroy).toBe(0);
	expect(
		await replica.deps.services.sessions.getSession(env.project.id, original.session_id),
	).toMatchObject({ status: 'starting', sandbox_id: replacement });
});

it('reclaims after a fresh permission check rejects the launching owner', async () => {
	const member = uid('temporary-member');
	const env = await fixture({ userId: member });
	await env.api.deps.services.projects.addMember(
		env.project.id,
		{ user_id: member },
		'editor',
		ACTOR,
	);
	const original = await env.prepare();
	const replica = env.replica();
	const complete = replica.deps.services.sessions.completeStartup.bind(
		replica.deps.services.sessions,
	);
	vi.spyOn(replica.deps.services.sessions, 'completeStartup').mockImplementationOnce(
		async (...args) => {
			const result = await complete(...args);
			await replica.deps.services.projects.removeMember(env.project.id, member, ACTOR);
			return result;
		},
	);
	await expectError(await replica.request('POST', env.path), 403);
	expect(
		(await replica.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('failed');
	expect(env.calls.destroy).toBe(1);
});

it('leaves providers without strict reconnect on their existing startup path', async () => {
	const env = await fixture();
	delete env.compute.connectExisting;
	const session = await expectOk<Session>(await env.api.request('POST', env.path));
	expect(session.status).toBe('running');
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, session.session_id))
			.startup_completion,
	).toBeUndefined();
});

it.each(['missing', 'transport'] as const)(
	'does not create compute when runtime reconnect reports %s',
	async (failure) => {
		const env = await fixture();
		const original = await env.prepare();
		vi.spyOn(env.compute, 'connectExisting').mockImplementation(() => {
			throw failure === 'missing'
				? new NotFoundError('Runtime missing')
				: new UnavailableError('Provider unavailable');
		});
		await expectError(
			await env.replica().request('POST', env.path),
			failure === 'missing' ? 404 : 503,
		);
		expect(
			(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
		).toBe(failure === 'missing' ? 'failed' : 'starting');
		expect(env.create).toHaveBeenCalledTimes(1);
		expect(env.calls.destroy).toBe(0);
	},
);

it('retains the receipt when metadata becomes unavailable during recovery', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				vi.spyOn(replica.deps.services.projects, 'getProject').mockRejectedValueOnce(
					new UnavailableError('Metadata unavailable'),
				);
				return 'alive';
			},
		},
	});
	await expectError(await replica.request('POST', env.path), 503);
	expect(
		await env.api.deps.services.sessions.getSession(env.project.id, original.session_id),
	).toMatchObject({ status: 'starting', startup_completion: original.startup_completion });
	expect(env.calls.destroy).toBe(0);
	expect((await expectOk<Session>(await env.replica().request('POST', env.path))).session_id).toBe(
		original.session_id,
	);
});

it('never destroys before the rejection is durable', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				await replica.deps.services.projects.deleteProject(env.project.id, ACTOR);
				return 'alive';
			},
		},
	});
	vi.spyOn(replica.deps.services.sessions, 'rejectStartupCompletion').mockRejectedValueOnce(
		new UnavailableError('Metadata unavailable'),
	);
	await expectError(await replica.request('POST', env.path), 503);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('starting');
	expect(env.calls.destroy).toBe(0);
});

it('reclaims a lost receipt after storage recovers and the starting heartbeat expires', async () => {
	const env = await fixture();
	vi.spyOn(env.api.deps.services.sessions, 'recordStartupCompletion').mockRejectedValueOnce(
		new UnavailableError('Metadata unavailable'),
	);
	vi.spyOn(env.api.deps.services.sessions, 'rejectStartupCompletion').mockRejectedValueOnce(
		new UnavailableError('Metadata unavailable'),
	);
	await expectError(await env.api.request('POST', env.path), 503);
	const [original] = await env.api.deps.services.sessions.listSessions();
	expect(original.status).toBe('starting');
	expect(env.calls.destroy).toBe(0);
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.last_heartbeat) + 5 * 60_000 + 1);
	expect(await env.api.deps.services.sessions.expireStale()).toBe(1);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('expired');
	vi.mocked(Date.now).mockReturnValue(Date.parse(original.last_heartbeat) + 15 * 60_000 + 1);
	vi.spyOn(env.instance, 'exec').mockResolvedValue({ success: true, stdout: '0', stderr: '' });
	const reconciler = new ReconciliationService(
		env.api.deps.services.sessions,
		env.api.deps.services.notebooks,
		env.compute,
		env.bucket,
		'source',
	);
	expect((await reconciler.reconcile()).reclaimed).toBe(1);
	expect(env.calls.destroy).toBe(1);
	expect(env.create).toHaveBeenCalledTimes(1);
});

it.each(['expires_at', 'sandbox_deadline_at'] as const)(
	'does not extend the original %s on retry',
	async (field) => {
		const env = await fixture();
		const original = await env.prepare();
		const key = paths.session(env.project.id, original.session_id);
		const deadline = new Date(Date.now() + 60_000).toISOString();
		await env.bucket.put(
			key,
			JSON.stringify({
				...original,
				startup_completion: { ...original.startup_completion, [field]: deadline },
			}),
		);
		const replica = env.replica({
			deps: {
				kernelProbe: async () => {
					vi.spyOn(Date, 'now').mockReturnValue(Date.parse(deadline));
					return 'alive';
				},
			},
		});
		await expectError(await replica.request('POST', env.path), 409);
		expect(
			(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
		).toBe('failed');
		expect(env.calls.destroy).toBe(1);
	},
);

it('rechecks notebook security labels before publishing a prepared runtime', async () => {
	const security = localResourceSecurity(
		['PUBLIC', 'SECRET'],
		makeSubjectContext({ classification: 'PUBLIC' }),
	);
	const env = await fixture({ deps: { resourceSecurity: security } });
	const original = await env.prepare();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				await replica.deps.services.notebooks.setSecurityLabels(
					env.project.id,
					env.notebook.id,
					{ classification: 'SECRET', compartments: [] },
					ACTOR,
				);
				return 'alive';
			},
		},
	});
	await expectError(await replica.request('POST', env.path), 404);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('failed');
	expect(env.calls.destroy).toBe(1);
});

it.each([false, true])(
	'recovers without waiting for optional context publication (fails: %s)',
	async (fails) => {
		const env = await fixture();
		const gate = Promise.withResolvers<void>();
		const exec = env.instance.exec.bind(env.instance);
		vi.spyOn(env.instance, 'exec').mockImplementation(async (...args) => {
			if (isSandboxContextCommand(args[0])) {
				await gate.promise;
				if (fails) throw new Error('Optional context write failed');
			}
			return exec(...args);
		});
		try {
			const original = await env.prepare();
			const recovered = await expectOk<Session>(await env.replica().request('POST', env.path));
			expect(recovered).toMatchObject({ session_id: original.session_id, status: 'running' });
			expect(env.calls.destroy).toBe(0);
			gate.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(
				(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id))
					.status,
			).toBe('running');
			expect(env.create).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
		}
	},
);

it('rechecks suspension persisted by another replica despite a cached active identity', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replica = env.replica({
		deps: {
			kernelProbe: async () => {
				await env.api.deps.services.identities.setSuspension(ACTOR, true);
				return 'alive';
			},
		},
	});
	expect(await replica.deps.services.identities.isSuspended(ACTOR)).toBe(false);
	await expectError(await replica.request('POST', env.path), 403);
	expect(
		(await env.api.deps.services.sessions.getSession(env.project.id, original.session_id)).status,
	).toBe('failed');
	expect(env.calls.destroy).toBe(1);
});

it.each([false, true])(
	'starts eager and requested surfaces after launch (recovery: %s)',
	async (recover) => {
		const env = await fixture({
			deps: {
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					surfaces: {
						opencode: { start: 'eager', port: 4096, embed: 'tab' },
						vscode: {
							flavor: 'code-server',
							start: 'on-demand',
							port: 8443,
							settings: {},
							extensionGallery: 'openvsx',
							embed: 'tab',
						},
					},
				},
			},
		});
		Object.assign(env.compute, { capabilities: { multiPort: true } });
		if (recover) await env.prepare();
		const replica = env.replica();
		const result = await expectOk<Session>(
			await replica.request('POST', env.path, { surfaces: ['vscode'] }),
		);
		await vi.waitFor(async () => {
			const stored = await replica.deps.services.sessions.getSession(
				env.project.id,
				result.session_id,
			);
			expect(stored.surfaces?.opencode?.status).toBe('ready');
			expect(stored.surfaces?.vscode?.status).toBe('ready');
		});
		expect(
			env.calls.startProcess.filter(({ cmd }) => cmd.includes("'opencode' 'web'")),
		).toHaveLength(1);
		expect(env.calls.startProcess.filter(({ cmd }) => cmd.includes('code-server'))).toHaveLength(1);
		expect(new Set(env.create.mock.calls.map(([id]) => id)).size).toBe(1);
	},
);

it('probes once during recovery and still probes ordinary reuse', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const kernelProbe = vi.fn(async () => 'alive' as const);
	const replica = env.replica({ deps: { kernelProbe } });
	const recovered = await expectOk<Session>(await replica.request('POST', env.path));
	expect(recovered.session_id).toBe(original.session_id);
	expect(kernelProbe).toHaveBeenCalledTimes(1);
	await expectOk(await replica.request('POST', env.path));
	expect(kernelProbe).toHaveBeenCalledTimes(2);
});

it('rechecks session state after recovery even when its readiness probe succeeded', async () => {
	const env = await fixture();
	const original = await env.prepare();
	const replica = env.replica();
	const sessions = replica.deps.services.sessions;
	const complete = sessions.completeStartup.bind(sessions);
	vi.spyOn(sessions, 'completeStartup').mockImplementationOnce(async (...args) => {
		const running = await complete(...args);
		await sessions.markFailed(env.project.id, original.session_id);
		return running;
	});
	await expectError(await replica.request('POST', env.path), 409);
	expect((await sessions.getSession(env.project.id, original.session_id)).status).toBe('failed');
});

it('does not start newly configured eager surfaces during ordinary reuse', async () => {
	const env = await fixture();
	Object.assign(env.compute, { capabilities: { multiPort: true } });
	const original = await expectOk<Session>(await env.api.request('POST', env.path));
	const replica = env.replica({
		deps: {
			sandbox: {
				...env.api.deps.sandbox,
				surfaces: { opencode: { start: 'eager', port: 4096, embed: 'tab' } },
			},
		},
	});
	const reused = await expectOk<Session>(await replica.request('POST', env.path));
	expect(reused.session_id).toBe(original.session_id);
	expect(reused.surfaces?.opencode).toBeUndefined();
	expect(env.calls.startProcess.some(({ cmd }) => cmd.includes("'opencode' 'web'"))).toBe(false);
});
