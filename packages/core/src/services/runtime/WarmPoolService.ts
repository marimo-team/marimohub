import { withDeadline } from '../../async';
import { mapWithConcurrency } from '../../concurrency';
import { ConflictError, NotFoundError } from '../../errors';
import { createSandboxId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { logEvent } from '../../logs';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import type { ComputeResources, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { SessionService } from './SessionService';
import type { AppPoolStore } from './AppPoolStore';
import { getOrCreateWarmPool } from './WarmPoolStore';
import type { WarmPoolStore, WarmPoolMember } from './WarmPoolStore';

export const WARM_POOL_MAX_IDLE_MS = 30 * 60_000;
const CLAIM_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;
const HEALTH_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_CREATIONS = 2;

export interface WarmPoolProfile {
	key: string;
	name?: string;
	image?: string;
	resources: ComputeResources;
}
export interface WarmPoolConfig {
	enabled: boolean;
	size: number;
	profiles: readonly WarmPoolProfile[];
	creationTimeoutMs: number;
	minimumRemainingMs: number;
	providerLifetimeMs?: number;
}
export interface WarmPoolClaim {
	member: WarmPoolMember;
	sandbox: SandboxInstance;
}
export class WarmPoolClaimExpiredError extends ConflictError {
	constructor() {
		super('The warm sandbox claim expired. Retry shortly.');
		this.name = 'WarmPoolClaimExpiredError';
	}
}
interface ClaimRequest {
	profile?: string;
	image?: string;
	userHome?: unknown;
	restoreSnapshotId?: string;
	destination: NonNullable<WarmPoolMember['destination']>;
}

export class WarmPoolService {
	constructor(
		readonly store: WarmPoolStore,
		private readonly compute: SandboxProvider,
		private readonly sessions: Pick<SessionService, 'getSession' | 'markSandboxReclaimed'>,
		readonly config: WarmPoolConfig,
		private readonly metrics: Metrics = noopMetrics,
		private readonly now: () => number = Date.now,
		private readonly appPools?: Pick<AppPoolStore, 'read'>,
	) {}

	async claim(request: ClaimRequest): Promise<WarmPoolClaim | undefined> {
		if (!this.config.enabled) return;
		const started = this.now();
		const profile = this.config.profiles.find(
			(item) => item.name === request.profile && item.image === request.image,
		);
		const bypass = request.userHome
			? 'user_home'
			: request.restoreSnapshotId
				? 'snapshot'
				: !profile
					? 'profile_or_image'
					: undefined;
		if (bypass || !this.compute.connectExisting) {
			this.metrics.increment('warm_pool.bypass', 1, { reason: bypass ?? 'unsupported' });
			return;
		}
		let claimed: WarmPoolMember | undefined;
		try {
			claimed = await this.store.mutate((record) => {
				const member = record.pools
					.find((pool) => pool.key === profile!.key)
					?.members.find((item) => item.state === 'ready' && item.ready_until > this.now());
				if (!member) return;
				member.state = 'claimed';
				member.token = crypto.randomUUID();
				member.operation_until = this.now() + CLAIM_TIMEOUT_MS;
				member.destination = request.destination;
				return member;
			});
			if (claimed) {
				const sandbox = this.compute.connectExisting(claimed.sandbox_id, profile);
				await this.probe(sandbox);
				if (this.isExpired(claimed))
					throw new Error('Warm sandbox claim expired during readiness check');
				this.metrics.increment('warm_pool.hit', 1, { profile: profile!.name ?? 'default' });
				return { member: claimed, sandbox };
			}
		} catch (error) {
			this.report('claim_failed', error);
			if (claimed) await this.retire(claimed).catch((cause) => this.report('retire_failed', cause));
		} finally {
			this.metrics.histogram?.('warm_pool.claim_ms', this.now() - started);
		}
		this.metrics.increment('warm_pool.miss');
	}

	async handoff(claim: WarmPoolClaim): Promise<void> {
		const destination = claim.member.destination!;
		const session = await this.sessions.getSession(destination.project_id, destination.session_id);
		if (session.sandbox_id !== claim.member.sandbox_id || session.status !== 'starting') {
			throw new ConflictError('The warm sandbox session is no longer starting');
		}
		const assigned = await this.store.updateMember(claim.member, 'claimed', (member) => {
			if (this.isExpired(member)) return false;
			member.assigned = true;
		});
		if (!assigned) throw new WarmPoolClaimExpiredError();
	}

	async abandon(claim: WarmPoolClaim): Promise<void> {
		await this.retire(claim.member, true);
		await this.cleanup(claim.member);
	}

	async sweep(): Promise<void> {
		const desired = new Set(
			this.config.enabled ? this.config.profiles.map((profile) => profile.key) : [],
		);
		await this.store.mutate((record) => {
			for (const pool of record.pools) {
				const target = desired.has(pool.key) ? this.config.size : 0;
				let excess =
					pool.members.filter((member) => member.state === 'ready' || member.state === 'creating')
						.length - target;
				for (const member of pool.members) {
					if (excess > 0 && (member.state === 'ready' || member.state === 'creating')) {
						member.state = 'retiring';
						excess--;
					}
				}
			}
		});
		const snapshot = await this.store.read();
		for (const pool of snapshot.pools) {
			for (const member of pool.members) {
				try {
					if (member.state === 'claimed') {
						const destination = member.destination!;
						const session = await this.sessions
							.getSession(destination.project_id, destination.session_id)
							.catch((error) => {
								if (error instanceof NotFoundError) return;
								throw error;
							});
						if (session?.sandbox_id === member.sandbox_id) {
							if (session.sandbox_reclaimed_at) await this.store.removeMember(member);
							// A visible session owns teardown, even when the publisher died before handoff.
							continue;
						}
						const app = await this.appPools?.read(destination.project_id, destination.notebook_id);
						if (
							app?.members.some(
								(reservation) =>
									reservation.sandbox_id === member.sandbox_id &&
									reservation.session_id === destination.session_id &&
									reservation.state === 'starting' &&
									reservation.operation_expires_at > this.now(),
							)
						)
							continue;
						if (member.operation_until > this.now()) continue;
						await this.retire(member);
					} else if (member.state === 'creating') {
						if (member.operation_until > this.now()) continue;
						await this.retire(member);
					} else if (member.state === 'ready') {
						if (!desired.has(pool.key) || member.ready_until <= this.now()) {
							await this.retire(member);
						} else if (this.now() - member.checked_at >= HEALTH_INTERVAL_MS) {
							try {
								await this.probe(this.compute.connectExisting!(member.sandbox_id));
								await this.store.updateMember(member, 'ready', (current) => {
									current.checked_at = this.now();
								});
								continue;
							} catch (error) {
								this.report('health_failed', error);
								await this.retire(member);
							}
						} else continue;
					}
					await this.cleanup(member);
				} catch (error) {
					this.report('cleanup_failed', error);
				}
			}
		}
		if (this.config.enabled) {
			const reservations = await this.reserve();
			await mapWithConcurrency(reservations, MAX_CONCURRENT_CREATIONS, ({ profile, member }) =>
				this.fill(profile, member),
			);
		}
		const current = await this.store.read();
		for (const profile of this.config.profiles) {
			const members = current.pools.find((pool) => pool.key === profile.key)?.members ?? [];
			if (!this.config.enabled && members.length === 0) continue;
			logEvent({
				event: 'warm_pool_capacity',
				profile: profile.name ?? 'default',
				ready: members.filter((member) => member.state === 'ready').length,
				creating: members.filter((member) => member.state === 'creating').length,
				target: this.config.enabled ? this.config.size : 0,
			});
		}
		for (const state of ['ready', 'creating'] as const) {
			this.metrics.gauge(
				`warm_pool.${state}`,
				current.pools.flatMap((pool) => pool.members).filter((member) => member.state === state)
					.length,
			);
		}
	}

	private reserve() {
		return this.store.mutate((record) => {
			const reservations: { profile: WarmPoolProfile; member: WarmPoolMember }[] = [];
			for (const profile of this.config.profiles) {
				const pool = getOrCreateWarmPool(record, profile.key);
				if (pool.retry_at > this.now()) continue;
				const available = pool.members.filter(
					(member) => member.state === 'creating' || member.state === 'ready',
				).length;
				for (
					let index = available;
					index < this.config.size && reservations.length < MAX_CONCURRENT_CREATIONS;
					index++
				) {
					const now = this.now();
					const member: WarmPoolMember = {
						sandbox_id: createSandboxId(),
						state: 'creating',
						token: crypto.randomUUID(),
						created_at: now,
						checked_at: 0,
						assigned: false,
						operation_until: now + this.config.creationTimeoutMs,
						ready_until:
							now +
							Math.min(
								WARM_POOL_MAX_IDLE_MS,
								this.config.providerLifetimeMs === undefined
									? Infinity
									: this.config.providerLifetimeMs - this.config.minimumRemainingMs,
							),
					};
					pool.members.push(member);
					reservations.push({ profile, member });
				}
			}
			return reservations;
		});
	}

	private async fill(profile: WarmPoolProfile, member: WarmPoolMember): Promise<void> {
		let abandoned = false;
		let booted = false;
		let sandbox: SandboxInstance | undefined;
		try {
			sandbox = this.compute.create(member.sandbox_id, {
				image: profile.image,
				resources: profile.resources,
				reuse: false,
			});
			const instance = sandbox;
			const boot = (async () => {
				try {
					await instance.ready?.();
					await this.probe(instance);
				} finally {
					// A provider create may finish after our local deadline; reclaim its late result.
					if (abandoned)
						await this.reclaimCreation(profile, member, instance).catch((error) =>
							this.report('cleanup_failed', error),
						);
				}
			})();
			await withDeadline(boot, {
				timeoutMs: this.config.creationTimeoutMs,
				timeoutError: () => new Error('Warm sandbox creation timed out'),
			});
			booted = true;
			const published = await this.store.updateMember(member, 'creating', (current) => {
				if (this.isExpired(current)) return false;
				current.state = 'ready';
				current.checked_at = this.now();
			});
			if (!published) {
				this.metrics.increment('warm_pool.creation_discarded');
				await this.reclaimCreation(profile, member, sandbox).catch((error) =>
					this.report('cleanup_failed', error),
				);
				return;
			}
			await this.store.mutate((record) => {
				const pool = getOrCreateWarmPool(record, profile.key);
				pool.failures = 0;
				pool.retry_at = 0;
			});
			this.metrics.increment('warm_pool.created');
		} catch (error) {
			abandoned = true;
			this.report(booted ? 'publish_failed' : 'create_failed', error);
			if (!booted) {
				await this.store
					.mutate((record) => {
						const pool = getOrCreateWarmPool(record, profile.key);
						pool.failures = Math.min(pool.failures + 1, 10);
						pool.retry_at = this.now() + Math.min(300_000, 5_000 * 2 ** (pool.failures - 1));
					})
					.catch((cause) => this.report('backoff_failed', cause));
			}
			await this.reclaimCreation(profile, member, sandbox).catch((cause) =>
				this.report('cleanup_failed', cause),
			);
		}
	}

	private async reclaimCreation(
		profile: WarmPoolProfile,
		member: WarmPoolMember,
		sandbox?: SandboxInstance,
	): Promise<void> {
		await this.store.mutate((record) => {
			const pool = getOrCreateWarmPool(record, profile.key);
			const current = pool.members.find((item) => item.sandbox_id === member.sandbox_id);
			if (!current) pool.members.push({ ...member, state: 'retiring' });
			else if (current.token === member.token && current.state !== 'claimed')
				current.state = 'retiring';
		});
		await this.cleanup(member, sandbox);
	}

	private isExpired(member: WarmPoolMember): boolean {
		return this.now() >= Math.min(member.operation_until, member.ready_until);
	}

	private async probe(sandbox: SandboxInstance): Promise<void> {
		await withDeadline(
			async () => {
				const result = await sandbox.exec('true', { timeout: PROBE_TIMEOUT_MS });
				if (!result.success) throw new Error('Warm sandbox command probe failed');
			},
			{
				timeoutMs: PROBE_TIMEOUT_MS,
				timeoutError: () => new Error('Warm sandbox probe timed out'),
			},
		);
	}

	private retire(member: WarmPoolMember, abandonAssigned = false): Promise<boolean> {
		return this.store.updateMember(member, member.state, (current) => {
			if (current.assigned && !abandonAssigned) return false;
			current.state = 'retiring';
		});
	}

	private async cleanup(member: WarmPoolMember, sandbox?: SandboxInstance): Promise<void> {
		// Re-read: a health check or old sweep must not delete a concurrently claimed member.
		const current = await this.store.getMember(member.sandbox_id);
		if (current?.state !== 'retiring' || current.token !== member.token) return;
		await (sandbox ?? this.compute.create(member.sandbox_id)).destroy();
		if (current.destination) {
			const { project_id, session_id } = current.destination;
			try {
				const session = await this.sessions.getSession(project_id, session_id);
				if (session.sandbox_id === current.sandbox_id && !session.sandbox_reclaimed_at) {
					await this.sessions.markSandboxReclaimed(
						project_id,
						session_id,
						new Date(this.now()).toISOString(),
						current.sandbox_id,
					);
				}
			} catch (error) {
				if (!(error instanceof NotFoundError)) throw error;
			}
		}
		await this.store.removeMember(current);
	}

	private report(event: string, error: unknown): void {
		this.metrics.increment(`warm_pool.${event}`);
		logOperationalError(`warm_pool_${event}`, { operation: `warm_pool.${event}` }, error);
	}
}
