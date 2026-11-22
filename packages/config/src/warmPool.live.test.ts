import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { Metrics, NotebookId, SandboxProvider, Session, SessionId } from '@marimo-hub/core';
import {
	createServices,
	executeInActiveKernel,
	KERNEL_AUTH_TOKEN_FILE,
	kernelBaseUrl,
	Millis,
	NotFoundError,
	WarmPoolService,
	WarmPoolStore,
} from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk } from '@marimo-hub/api/testing';
import { makeCompute, resolveSandboxImages } from './compute';
import type { Env } from './env';
import { parseComputeProfiles, profilesForBackend } from './computeProfiles';
import { parseWarmPoolConfig } from './warmPool';
import { DEFAULT_SESSION_MAX_LIFETIME_S } from './sessionDefaults';

const execFileAsync = promisify(execFile);

async function expectDockerContainerRemoved(sandboxId: string): Promise<void> {
	try {
		await execFileAsync('docker', ['inspect', `marimohub-sbx-${sandboxId}`], {
			maxBuffer: 64 * 1024,
			timeout: 30_000,
		});
	} catch (error) {
		const commandError = error as Error & { code?: number | string; stderr?: string };
		if (
			commandError.code === 1 &&
			/no such object|no such container/i.test(commandError.stderr ?? '')
		) {
			return;
		}
		throw new Error(`Could not verify Docker container removal for ${sandboxId}`);
	}
	throw new Error(`Docker container still exists after sandbox cleanup: ${sandboxId}`);
}

it.runIf(process.env.MARIMOHUB_WARM_POOL_LIVE_TEST === 'true')(
	'uses prepared Docker sandboxes for Hub sessions and reclaims them on session end',
	async () => {
		if (
			process.env.GITHUB_ACTIONS !== 'true' ||
			process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
		) {
			throw new Error('Docker warm-pool live smoke requires an isolated GitHub-hosted runner');
		}
		const ownerTag = `mhwarm-${randomUUID()}`;
		const env: Env = {
			...process.env,
			MARIMOHUB_COMPUTE_DOCKER_OWNER_TAG: ownerTag,
			MARIMOHUB_COMPUTE_WARM_POOL_ENABLED: 'true',
			MARIMOHUB_COMPUTE_WARM_POOL_SIZE: '1',
			MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: 'default',
		};
		const backend = env.MARIMOHUB_COMPUTE_BACKEND ?? '';
		const sessionMaxLifetimeMs = Millis.seconds(DEFAULT_SESSION_MAX_LIFETIME_S);
		const sessionMaxLifetimeSeconds = Millis.toSeconds(sessionMaxLifetimeMs);
		const computeOptions = { sessionMaxLifetimeSeconds };
		const compute = makeCompute(env, computeOptions);
		if (backend !== 'docker') throw new Error('The live lifecycle job must use Docker');
		const images = resolveSandboxImages(env);
		const profiles = profilesForBackend(
			backend,
			parseComputeProfiles(env.MARIMOHUB_COMPUTE_PROFILES),
		);
		const parsed = parseWarmPoolConfig(env, {
			backend,
			compute,
			images,
			profiles,
			sessionMaxLifetimeMs,
		})!;
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const store = new WarmPoolStore(bucket, parsed.backend);
		const claimDurations: number[] = [];
		const metrics: Metrics = {
			increment() {},
			gauge() {},
			histogram(name, value) {
				if (name === 'warm_pool.claim_ms') claimDurations.push(value);
			},
		};
		const service = new WarmPoolService(store, compute, services.sessions, parsed.config, metrics);
		const controlTag = `control-${env.MARIMOHUB_COMPUTE_DOCKER_OWNER_TAG}`.slice(0, 63);
		const controlCompute = makeCompute(
			{ ...env, MARIMOHUB_COMPUTE_DOCKER_OWNER_TAG: controlTag },
			computeOptions,
		);
		const sandboxConfig = {
			bucket: { name: 'test', endpoint: '' },
			hostname: env.MARIMOHUB_COMPUTE_DOCKER_HOST || 'localhost',
			workdir: env.MARIMOHUB_COMPUTE_WORKDIR || '/workspace',
			auth: 'on' as const,
			persistWorkspace: 'source' as const,
			images,
			computeProfiles: profiles.profiles.map(({ name, resources }) => ({ name, resources })),
		};
		const api = createTestApi({
			bucket,
			compute,
			deps: { services, warmPool: service, sandbox: sandboxConfig },
		});
		const controlApi = createTestApi({
			bucket,
			compute: controlCompute,
			deps: { services, sandbox: sandboxConfig },
		});
		const liveSessions: { session: Session; api: ReturnType<typeof createTestApi> }[] = [];
		const project = await services.projects.createProject(
			{ name: 'Docker warm-pool live smoke', description: 'Disposable integration test' },
			ACTOR,
		);
		const createNotebook = (title: string, marker: string) =>
			services.notebooks.createNotebook(
				project.id,
				{
					title,
					description: 'Disposable warm-pool lifecycle notebook',
					code: [
						'import marimo',
						'app = marimo.App()',
						'@app.cell',
						'def _():',
						`    print('${marker}')`,
						'    return',
						'',
					].join('\n'),
				},
				ACTOR,
			);
		const executeInSessionKernel = async (
			session: Session,
			code: string,
			provider: SandboxProvider = compute,
		) => {
			const active = await executeInActiveKernel(
				kernelBaseUrl(session),
				{ code },
				{
					fetchImpl: async (input, init) => {
						const request = new Request(input, init);
						return (await provider.proxy(request)) ?? globalThis.fetch(request);
					},
					kernelAuthToken: session.kernel_auth_token,
					deadlineAt: Date.now() + 120_000,
				},
			);
			if (!active) throw new Error('Hub session has no active notebook kernel');
			expect(active.executed).toMatchObject({ completed: true, success: true, timedOut: false });
			return active.executed.stdout;
		};
		const stopSession = async (
			session: Session,
			targetApi: ReturnType<typeof createTestApi> = api,
		) => {
			const response = await targetApi.request(
				'DELETE',
				`/projects/${project.id}/notebooks/${session.notebook_id}/sessions/${session.session_id}?wait=true`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ success: true });
			const stopped = await services.sessions.getSession(project.id, session.session_id);
			expect(stopped).toMatchObject({ status: 'terminated' });
			expect(stopped.sandbox_reclaimed_at).toBeTruthy();
			return stopped;
		};
		const startSession = async (
			notebookId: NotebookId,
			targetApi: ReturnType<typeof createTestApi> = api,
		) => {
			const path = `/projects/${project.id}/notebooks/${notebookId}/sessions`;
			const response = await expectOk<{ session_id: SessionId; status: string }>(
				await targetApi.request('POST', path, { mode: 'edit' }),
			);
			expect(response.status).toBe('running');
			const session = await services.sessions.getSession(project.id, response.session_id);
			liveSessions.push({ session, api: targetApi });
			if (!session.sandbox_id) throw new Error('Started Hub session has no sandbox id');
			return { response, session };
		};
		const cleanupErrors: unknown[] = [];
		let smokeFailed = false;
		let smokeFailure: unknown;
		try {
			const controlNotebook = await createNotebook('Control kernel', 'control-session-marker');
			const { session: controlSession } = await startSession(controlNotebook.id, controlApi);
			const controlSandbox = controlCompute.connectExisting!(controlSession.sandbox_id!);
			expect((await controlSandbox.exec('true')).success).toBe(true);
			expect(
				await executeInSessionKernel(
					controlSession,
					"print('control-kernel-alive')",
					controlCompute,
				),
			).toContain('control-kernel-alive');

			const coldNotebook = await createNotebook('Cold start', 'cold-session-marker');
			const coldStart = performance.now();
			const { session: coldSession } = await startSession(coldNotebook.id);
			const coldSessionStartMs = performance.now() - coldStart;
			const coldSandboxId = coldSession.sandbox_id!;
			const coldNotebookStart = performance.now();
			const coldOutput = await executeInSessionKernel(
				coldSession,
				"COLD_ONLY_SENTINEL = 'disposable-cold-session-state'\nprint('cold-session-marker')",
			);
			expect(coldOutput).toContain('cold-session-marker');
			const coldNotebookMs = performance.now() - coldNotebookStart;
			await stopSession(coldSession);
			await expect(compute.connectExisting!(coldSandboxId).exec('true')).rejects.toThrow();

			const poolPrepareStart = performance.now();
			await service.sweep();
			const poolPrepareMs = performance.now() - poolPrepareStart;
			const prepared = (await store.read()).pools[0]?.members.find(
				(member) => member.state === 'ready',
			);
			if (!prepared) throw new Error('Warm pool did not publish a prepared sandbox');
			const preparedSandbox = compute.connectExisting!(prepared.sandbox_id);
			expect((await preparedSandbox.exec('test ! -e /workspace/notebook.py')).success).toBe(true);
			expect((await preparedSandbox.exec(`test ! -e ${KERNEL_AUTH_TOKEN_FILE}`)).success).toBe(
				true,
			);

			const warmNotebook = await createNotebook('Warm start', 'warm-session-marker');
			claimDurations.length = 0;
			const warmStart = performance.now();
			const { session: warmSession } = await startSession(warmNotebook.id);
			const warmSessionStartMs = performance.now() - warmStart;
			const warmSandboxId = warmSession.sandbox_id!;
			expect(warmSandboxId).toBe(prepared.sandbox_id);
			const assigned = (await store.read()).pools[0]?.members.find(
				(member) => member.destination?.session_id === warmSession.session_id,
			);
			expect(assigned).toMatchObject({ state: 'claimed', assigned: true });
			const warmSandbox = compute.connectExisting!(warmSandboxId);
			const warmSource = await warmSandbox.readFile('/workspace/notebook.py');
			if (!warmSource.success) throw new Error('Warm session notebook source was not provisioned');
			expect(warmSource.content).toContain('warm-session-marker');
			expect(warmSource.content).not.toContain('cold-session-marker');
			const warmKernelTokenFile = await warmSandbox.readFile(KERNEL_AUTH_TOKEN_FILE);
			expect(
				warmKernelTokenFile.success &&
					warmKernelTokenFile.content === warmSession.kernel_auth_token &&
					warmSession.kernel_auth_token !== coldSession.kernel_auth_token &&
					warmSession.kernel_auth_token !== controlSession.kernel_auth_token,
			).toBe(true);
			await expect(
				executeInActiveKernel(
					kernelBaseUrl(controlSession),
					{ code: "print('unauthorized-cross-session-execution')" },
					{
						kernelAuthToken: warmSession.kernel_auth_token,
						deadlineAt: Date.now() + 30_000,
					},
				),
			).rejects.toMatchObject({ name: 'KernelHttpError', status: 401 });
			const warmNotebookStart = performance.now();
			const warmOutput = await executeInSessionKernel(
				warmSession,
				"print('COLD_ONLY_SENTINEL' in globals())\nprint('warm-session-marker')",
			);
			expect(warmOutput).toContain('False');
			expect(warmOutput).toContain('warm-session-marker');
			const warmNotebookMs = performance.now() - warmNotebookStart;
			await stopSession(warmSession);
			await expect(compute.connectExisting!(warmSandboxId).exec('true')).rejects.toThrow();
			await service.sweep();
			const replacement = (await store.read()).pools[0]?.members.find(
				(member) => member.state === 'ready',
			);
			if (!replacement) throw new Error('Warm pool did not replenish after session teardown');
			expect(replacement.sandbox_id).not.toBe(warmSandboxId);
			const replacementSandbox = compute.connectExisting!(replacement.sandbox_id);
			expect((await replacementSandbox.exec('test ! -e /workspace/notebook.py')).success).toBe(
				true,
			);
			expect((await controlSandbox.exec('true')).success).toBe(true);
			expect(
				await executeInSessionKernel(
					controlSession,
					"print('control-kernel-alive')",
					controlCompute,
				),
			).toContain('control-kernel-alive');
			const controlStillRunning = await services.sessions.getSession(
				project.id,
				controlSession.session_id,
			);
			expect(controlStillRunning.status).toBe('running');
			expect(controlStillRunning.sandbox_reclaimed_at).toBeUndefined();
			await stopSession(controlSession, controlApi);
			await expect(
				controlCompute.connectExisting!(controlSession.sandbox_id!).exec('true'),
			).rejects.toThrow();
			expect(claimDurations.length).toBeGreaterThan(0);

			console.info(
				JSON.stringify({
					event: 'warm_pool_live_smoke',
					backend,
					cold_session_start_ms: coldSessionStartMs,
					warm_session_start_ms: warmSessionStartMs,
					pool_prepare_ms: poolPrepareMs,
					cold_notebook_ms: coldNotebookMs,
					warm_notebook_ms: warmNotebookMs,
					warm_claim_ms: claimDurations.at(-1),
					warm_reused_prepared_sandbox: warmSandboxId === prepared.sandbox_id,
					warm_container_reclaimed: true,
					pool_replenished: true,
					existing_kernel_preserved: true,
				} satisfies Record<string, unknown>),
			);
		} catch (error) {
			smokeFailed = true;
			smokeFailure = error;
		} finally {
			for (const { session, api: targetApi } of [...liveSessions].reverse()) {
				let current: Session | undefined;
				try {
					current = await services.sessions.getSession(project.id, session.session_id);
				} catch (error) {
					if (!(error instanceof NotFoundError)) cleanupErrors.push(error);
				}
				const sandboxId = current?.sandbox_id ?? session.sandbox_id;
				if (!sandboxId || current?.sandbox_reclaimed_at) continue;
				try {
					const response = await targetApi.request(
						'DELETE',
						`/projects/${project.id}/notebooks/${session.notebook_id}/sessions/${session.session_id}?wait=true`,
					);
					if (response.status !== 200 && response.status !== 404) {
						cleanupErrors.push(new Error(`Session cleanup returned HTTP ${response.status}`));
					}
				} catch (error) {
					cleanupErrors.push(error);
				}
				let reclaimed = false;
				try {
					reclaimed = !!(await services.sessions.getSession(project.id, session.session_id))
						.sandbox_reclaimed_at;
				} catch (error) {
					if (!(error instanceof NotFoundError)) cleanupErrors.push(error);
				}
				if (!reclaimed) {
					const provider = targetApi === controlApi ? controlCompute : compute;
					try {
						await provider.create(sandboxId).destroy();
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
			}
			let poolMembers: Awaited<ReturnType<typeof store.read>>['pools'][number]['members'] = [];
			try {
				poolMembers = (await store.read()).pools.flatMap((pool) => pool.members);
			} catch (error) {
				cleanupErrors.push(error);
			}
			const ownedIds = new Set(poolMembers.map((member) => member.sandbox_id));
			for (const provider of [compute, controlCompute]) {
				try {
					for (const active of (await provider.listActive?.()) ?? []) ownedIds.add(active.id);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			for (const sandboxId of ownedIds) {
				try {
					await compute.create(sandboxId).destroy();
				} catch (error) {
					cleanupErrors.push(error);
				}
				const member = poolMembers.find((candidate) => candidate.sandbox_id === sandboxId);
				if (member) {
					try {
						await store.removeMember(member);
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				try {
					await expectDockerContainerRemoved(sandboxId);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			for (const provider of [compute, controlCompute]) {
				try {
					await provider[Symbol.asyncDispose]?.();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
		}
		if (smokeFailed) {
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[smokeFailure, ...cleanupErrors],
					'Warm-pool smoke and cleanup failed',
				);
			}
			throw smokeFailure;
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'Warm-pool smoke resource cleanup failed');
		}
	},
	600_000,
);
