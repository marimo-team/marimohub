import { expect, it } from 'vitest';
import {
	createNotebookId,
	createProjectId,
	createSessionId,
	createServices,
	Millis,
	WarmPoolService,
	WarmPoolStore,
} from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeCompute, resolveSandboxImages } from './compute';
import type { Env } from './env';
import { parseComputeProfiles, profilesForBackend } from './computeProfiles';
import { parseWarmPoolConfig } from './warmPool';
import { DEFAULT_SESSION_MAX_LIFETIME_S } from './sessionDefaults';

it.runIf(process.env.MARIMOHUB_WARM_POOL_LIVE_TEST === 'true')(
	'claims and replenishes real warm sandboxes across provider instances',
	async () => {
		const env: Env = {
			...process.env,
			MARIMOHUB_COMPUTE_WARM_POOL_ENABLED: 'true',
			MARIMOHUB_COMPUTE_WARM_POOL_SIZE: '1',
			MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: 'default',
		};
		const backend = env.MARIMOHUB_COMPUTE_BACKEND ?? '';
		const sessionMaxLifetimeMs = Millis.seconds(DEFAULT_SESSION_MAX_LIFETIME_S);
		const computeOptions = { sessionMaxLifetimeSeconds: Millis.toSeconds(sessionMaxLifetimeMs) };
		const compute = makeCompute(env, computeOptions);
		const otherCompute = makeCompute(env, computeOptions);
		const parsed = parseWarmPoolConfig(env, {
			backend,
			compute,
			images: resolveSandboxImages(env),
			profiles: profilesForBackend(backend, parseComputeProfiles(env.MARIMOHUB_COMPUTE_PROFILES)),
			sessionMaxLifetimeMs,
		})!;
		const bucket = new MemoryBucket();
		const sessions = createServices(bucket).sessions;
		const store = new WarmPoolStore(bucket, parsed.backend);
		const service = new WarmPoolService(store, compute, sessions, parsed.config);
		const other = new WarmPoolService(store, otherCompute, sessions, parsed.config);
		try {
			const start = performance.now();
			await service.sweep();
			const coldMs = performance.now() - start;
			const ready = (await store.read()).pools[0].members[0];
			expect(ready.state).toBe('ready');
			const claimStart = performance.now();
			const claim = await other.claim({
				profile: parsed.config.profiles[0].name,
				image: parsed.config.profiles[0].image,
				destination: {
					project_id: createProjectId(),
					notebook_id: createNotebookId(),
					session_id: createSessionId(),
				},
			});
			const claimMs = performance.now() - claimStart;
			expect(claim?.member.sandbox_id).toBe(ready.sandbox_id);
			await service.sweep();
			expect((await store.read()).pools[0].members.map((member) => member.state).sort()).toEqual([
				'claimed',
				'ready',
			]);
			console.info(
				JSON.stringify({
					event: 'warm_pool_live_smoke',
					backend,
					cold_ms: coldMs,
					claim_ms: claimMs,
				}),
			);
		} finally {
			for (const pool of (await store.read()).pools) {
				for (const member of pool.members) await compute.create(member.sandbox_id).destroy();
			}
			await compute[Symbol.asyncDispose]?.();
			await otherCompute[Symbol.asyncDispose]?.();
		}
	},
	600_000,
);
