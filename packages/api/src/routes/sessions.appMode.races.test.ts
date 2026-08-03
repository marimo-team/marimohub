import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServices } from '@marimo-hub/core';
import type { NotebookId, ProjectId } from '@marimo-hub/core';
import {
	ACTOR,
	appClaimHolder,
	fakeComputeFrom,
	makeFakeCompute,
	makeFakeSandbox,
} from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

/** Sentinel that must never reach a response body or a stored session record. */
const SECRET = 'sk-live-DO-NOT-LEAK-9f3a';

describe('Session routes (app mode) — deletion, provisioning and cap races', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
		owner = createTestApi({ bucket, userId: ACTOR, compute: makeFakeCompute() }).request;
	});

	const sessionsPath = (suffix = '', notebookId: NotebookId = nid) =>
		`/projects/${pid}/notebooks/${notebookId}/sessions${suffix}`;

	/**
	 * A compute that blocks inside `startProcess` until released, so a test can act
	 * mid-saga — after the initial app claim, before `mark_running` and the
	 * post-provision rechecks.
	 */
	function pausableCompute() {
		const fake = makeFakeSandbox();
		let onEntered!: () => void;
		const entered = new Promise<void>((resolve) => (onEntered = resolve));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const instance = {
			...fake.instance,
			startProcess: (async (...args: Parameters<typeof fake.instance.startProcess>) => {
				onEntered();
				await gate;
				return fake.instance.startProcess(...args);
			}) as typeof fake.instance.startProcess,
		};
		return { compute: fakeComputeFrom(instance), calls: fake.calls, entered, release };
	}

	it('deleting the notebook during app provisioning cannot resurrect the app or its claim', async () => {
		const { compute, calls, entered, release } = pausableCompute();
		const api = createTestApi({ bucket, userId: ACTOR, compute });

		const pending = api.request('POST', sessionsPath(), { mode: 'app' });
		await entered;

		await expectOk(await owner('DELETE', `/projects/${pid}/notebooks/${nid}`));
		release();
		await pending;

		const services = createServices(bucket);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(0);
		expect(calls.destroy).toBeGreaterThan(0);
		expect(await appClaimHolder(bucket, pid, nid)).toBeNull();
	});

	it('deleting the project during app provisioning cannot resurrect the app or its claim', async () => {
		const { compute, calls, entered, release } = pausableCompute();
		const api = createTestApi({ bucket, userId: ACTOR, compute });

		const pending = api.request('POST', sessionsPath(), { mode: 'app' });
		await entered;

		// The project's retire sweep only sees `running` records, so it misses this
		// still-`starting` one — the saga's own project recheck is what catches it.
		await expectOk(await owner('DELETE', `/projects/${pid}`));
		release();
		await expectError(await pending, 404, 'NOT_FOUND');

		const services = createServices(bucket);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(0);
		expect(calls.destroy).toBeGreaterThan(0);
		expect(await appClaimHolder(bucket, pid, nid)).toBeNull();
	});

	it.each(['app', 'edit'] as const)(
		'a %s session cannot be started on a soft-deleted project',
		async (mode) => {
			const fake = makeFakeSandbox();
			const api = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(fake.instance),
			});
			await expectOk(await owner('DELETE', `/projects/${pid}`));

			await expectError(await api.request('POST', sessionsPath(), { mode }), 404, 'NOT_FOUND');

			// Rejected before any record or sandbox exists — not after the fact.
			expect(fake.calls.startProcess).toEqual([]);
			expect(await createServices(bucket).sessions.listSessions()).toEqual([]);
		},
	);

	it('soft-deleting the project immediately revokes and retires its running apps', async () => {
		const fake = makeFakeSandbox();
		const api = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(fake.instance),
		});
		const app = await expectOk<any>(await api.request('POST', sessionsPath(), { mode: 'app' }));
		expect(app.sandbox_url).toBeTruthy();

		await expectOk(await api.request('DELETE', `/projects/${pid}`));

		// A deleted project reads as gone everywhere, kernel routes included.
		await expectError(await api.request('GET', `/projects/${pid}/sessions`), 404, 'NOT_FOUND');
		await expectError(
			await api.request('GET', sessionsPath(`/${app.session_id}`)),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await api.request('POST', sessionsPath(`/${app.session_id}/heartbeat`)),
			404,
			'NOT_FOUND',
		);

		// The kernel is not just hidden — it is gone, and holds no claim.
		expect(fake.calls.destroy).toBeGreaterThan(0);
		const services = createServices(bucket);
		expect((await services.sessions.getSession(pid, app.session_id)).status).toBe('terminated');
		expect(await appClaimHolder(bucket, pid, nid)).toBeNull();
	});

	it('parallel app creates cannot exceed the per-project cap', async () => {
		const services = createServices(bucket);
		const nb2 = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo' },
			ACTOR,
		);
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: { policy: { maxAppsPerProject: 1 } },
		}).request;

		// Two DIFFERENT notebooks, so neither create can attach to the other's app —
		// both clear the count check before either writes its session record.
		const [a, b] = await Promise.all([
			capped('POST', sessionsPath(), { mode: 'app' }),
			capped('POST', sessionsPath('', nb2.id as NotebookId), { mode: 'app' }),
		]);

		expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 429]);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(1);
	});

	it('parallel app creates cannot exceed the per-user cap', async () => {
		const services = createServices(bucket);
		const p2 = await services.projects.createProject({ name: 'P2', description: 'd' }, ACTOR);
		const nb2 = await services.notebooks.createNotebook(
			p2.id as ProjectId,
			{ title: 'NB2', description: 'd', code: 'import marimo' },
			ACTOR,
		);
		const capped = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			maxConcurrentSessionsPerUser: 1,
		}).request;

		const [a, b] = await Promise.all([
			capped('POST', sessionsPath(), { mode: 'app' }),
			capped('POST', `/projects/${p2.id}/notebooks/${nb2.id}/sessions`, { mode: 'app' }),
		]);

		expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 429]);
		expect(await services.sessions.countActiveForUser(ACTOR, 'project')).toBe(1);
	});

	describe('provision errors never carry secret material', () => {
		/** Every place a failed provision's reason can surface to a caller or to storage. */
		async function assertNoLeak(sessionId: string) {
			const got = await expectOk<any>(await owner('GET', sessionsPath(`/${sessionId}`)));
			expect(JSON.stringify(got)).not.toContain(SECRET);
			const stored = await createServices(bucket).sessions.getSession(pid, sessionId as never);
			expect(JSON.stringify(stored)).not.toContain(SECRET);
		}

		it('a generic compute failure is not persisted verbatim', async () => {
			const fake = makeFakeSandbox();
			const instance = {
				...fake.instance,
				startProcess: (async () => {
					throw new Error(`kernel boot failed: token=${SECRET}`);
				}) as typeof fake.instance.startProcess,
			};
			const api = createTestApi({ bucket, userId: ACTOR, compute: fakeComputeFrom(instance) });

			const res = await api.request('POST', sessionsPath(), { mode: 'app' });
			expect(await res.clone().text()).not.toContain(SECRET);

			const sessions = await createServices(bucket).sessions.listSessions();
			expect(sessions).toHaveLength(1);
			await assertNoLeak(sessions[0].session_id);
		});

		/**
		 * A resolver that fails the way a secret manager does — quoting the value it
		 * choked on — carrying vendor metadata that IS safe to record.
		 */
		function leakySecrets(): never {
			const err = new Error(`vault denied for value ${SECRET}`) as Error & {
				code: string;
				operation: string;
			};
			err.name = 'VaultError';
			err.code = 'AccessDenied';
			err.operation = 'GetSecretValue';
			throw err;
		}

		function integrationDeps() {
			return {
				integrations: {
					resolveForSession: async () => leakySecrets(),
				} as never,
			};
		}

		/** Everything the server writes to stdout/stderr while `run` is in flight. */
		async function captureConsole(
			run: () => Response | Promise<Response>,
		): Promise<[Response, string]> {
			const lines: string[] = [];
			const spies = (['log', 'warn', 'error'] as const).map((level) =>
				vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
					lines.push(args.map(String).join(' '));
				}),
			);
			try {
				return [await run(), lines.join('\n')];
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		}

		it('an integration secret-resolution failure is not echoed or persisted', async () => {
			const api = createTestApi({
				bucket,
				userId: ACTOR,
				compute: makeFakeCompute(),
				deps: integrationDeps(),
			});

			const res = await api.request('POST', sessionsPath(), { mode: 'app' });
			expect(await res.clone().text()).not.toContain(SECRET);

			const sessions = await createServices(bucket).sessions.listSessions();
			expect(sessions).toHaveLength(1);
			await assertNoLeak(sessions[0].session_id);
		});

		it('an integration secret-resolution failure logs no provider message or value', async () => {
			const api = createTestApi({
				bucket,
				userId: ACTOR,
				compute: makeFakeCompute(),
				deps: integrationDeps(),
			});

			const [, logs] = await captureConsole(() =>
				api.request('POST', sessionsPath(), { mode: 'app' }),
			);

			expect(logs).not.toContain(SECRET);
			expect(logs).not.toContain('vault denied');
		});

		it('an integration secret-resolution failure logs sanitized provider metadata', async () => {
			const api = createTestApi({
				bucket,
				userId: ACTOR,
				compute: makeFakeCompute(),
				deps: integrationDeps(),
			});

			const [, logs] = await captureConsole(() =>
				api.request('POST', sessionsPath(), { mode: 'app' }),
			);

			// Enough to triage the failure without the resolver's own text.
			expect(logs).toContain('integration_render_failed');
			expect(logs).toContain('VaultError');
			expect(logs).toContain('AccessDenied');
			expect(logs).toContain('GetSecretValue');
		});
	});
});
