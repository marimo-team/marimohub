import type { ApiDeps } from '@marimo-hub/api';
import { Semaphore, settleAllOrThrow } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core/ids';
import { BackgroundLoops } from './backgroundLoops';
import type { LoopHandle } from './backgroundLoops';
import { logEvent } from './log';

const REFRESH_MS = 30_000;
// Five permission channels per member must leave room in the SDK's 64-idle-channel cache.
const MAX_MEMBERS = 8;

export function startWarmPoolPreconnect(
	deps: ApiDeps,
	loops = new BackgroundLoops(),
): LoopHandle | undefined {
	const pool = deps.warmPool;
	const preconnect = deps.compute.preconnect?.bind(deps.compute);
	if (!pool?.config.enabled || pool.config.preconnect === false || !preconnect) return;
	let profileOffset = 0;
	let nextSelectionAt = Date.now() + REFRESH_MS;
	const cached = new Map<SandboxId, { reference: string; nextAt: number }>();
	return loops.start({
		name: 'warm_pool_preconnect',
		intervalMs: 5_000,
		deadlineMs: 25_000,
		abortOnStop: true,
		run: async ({ signal }) => {
			const record = await pool.store.read();
			signal.throwIfAborted();
			const keys = new Set(pool.config.profiles.map((profile) => profile.key));
			const pools = record.pools
				.filter((item) => keys.has(item.key))
				.map((item) =>
					item.members.filter(
						(member) =>
							member.state === 'ready' &&
							member.ready_until > Date.now() &&
							member.reconnect_reference,
					),
				)
				.filter((members) => members.length > 0);
			// Share the channel budget across profiles instead of filling it from the first pool.
			if (pools.length > MAX_MEMBERS && Date.now() >= nextSelectionAt) {
				profileOffset = (profileOffset + MAX_MEMBERS) % pools.length;
				nextSelectionAt = Date.now() + REFRESH_MS;
			}
			const ordered = [...pools.slice(profileOffset), ...pools.slice(0, profileOffset)];
			const members = [];
			for (let index = 0; members.length < MAX_MEMBERS; index++) {
				const row = ordered.flatMap((pool) => (pool[index] ? [pool[index]] : []));
				if (row.length === 0) break;
				members.push(...row.slice(0, MAX_MEMBERS - members.length));
			}
			const ids = new Set(members.map((member) => member.sandbox_id));
			for (const id of cached.keys()) if (!ids.has(id)) cached.delete(id);
			let prepared = 0;
			let failed = 0;
			const slots = new Semaphore(2);
			await settleAllOrThrow(
				members.map((member) =>
					slots.run(async () => {
						signal.throwIfAborted();
						const reference = member.reconnect_reference!;
						const prior = cached.get(member.sandbox_id);
						if (prior?.reference === reference && prior.nextAt > Date.now()) return;
						const started = Date.now();
						try {
							const connected = await preconnect(member.sandbox_id, {
								reconnectReference: reference,
								timeoutMs: 5_000,
								signal,
							});
							if (connected) prepared++;
							else failed++;
						} catch (error) {
							if (signal.aborted) throw error;
							failed++;
							logEvent({
								level: 'warn',
								event: 'warm_pool_preconnect_unavailable',
								sandbox_id: member.sandbox_id,
								name: error instanceof Error ? error.name : undefined,
							});
						} finally {
							if (!signal.aborted) {
								// Back off unsuccessful attempts too; the SDK preserves its own expiry and fallback policy.
								cached.set(member.sandbox_id, { reference, nextAt: Date.now() + REFRESH_MS });
								deps.metrics?.histogram?.('warm_pool.preconnect_ms', Date.now() - started);
							}
						}
					}, signal),
				),
			);
			return { prepared, failed, eligible: members.length };
		},
		onSuccess: (result) => {
			if (result.prepared || result.failed) {
				logEvent({ event: 'warm_pool_preconnect', ...result });
			}
		},
	});
}
