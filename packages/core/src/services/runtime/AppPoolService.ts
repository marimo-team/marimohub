import { APP_PRESENCE_PERSIST_INTERVAL_MS, BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { logOperationalError } from '../../operationalLog';
import { ConflictError, NotFoundError, ResourceExhaustedError } from '../../errors';
import { createSandboxId, createSessionId } from '../../ids';
import type { NotebookId, ProjectId, SessionId, UserId, VersionId } from '../../ids';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { readStored, SourceSchema } from '../../schema';
import type { Session } from '../../schema';
import { paths } from '../../paths';
import { logEvent } from '../../logs';
import { AppPoolStore } from './AppPoolStore';
import {
	DEFAULT_APP_POOL_POLICY,
	expireAppPresence,
	renewAppVisit,
	routeApp,
	reserveAppReplacement,
	routeAppRetirement,
} from './AppPoolRouter';
import type { AppPool, AppPoolMember, AppPoolPolicy, AppVisit } from './AppPoolRouter';
import type { SessionService } from './SessionService';
import { isTerminal, sessionMode } from './sessionState';

interface AppPoolRequest {
	projectId: ProjectId;
	notebookId: NotebookId;
	userId: UserId;
	versionId: VersionId;
	startupMs: number;
}

export class AppPoolService {
	readonly store: AppPoolStore;
	readonly policy: AppPoolPolicy;

	constructor(
		private bucket: Bucket,
		private sessions: SessionService,
		policy: AppPoolPolicy = DEFAULT_APP_POOL_POLICY,
		private metrics: Metrics = noopMetrics,
		private now: () => number = Date.now,
	) {
		this.store = new AppPoolStore(bucket, metrics);
		this.policy = policy;
	}

	admit(input: AppPoolRequest & { visitId?: string }) {
		const generation = crypto.randomUUID();
		return this.route(input, 'admit', (pool, reservation, now) =>
			routeApp(pool, this.policy, {
				...input,
				visitId: input.visitId ?? 'api',
				generation,
				reservation,
				now,
			}),
		);
	}

	async replace(input: AppPoolRequest & { replacesSessionId: SessionId }) {
		const decision = await this.route(input, 'replace', (pool, reservation, now) =>
			reserveAppReplacement(pool, this.policy, { ...input, reservation, now }),
		);
		return { ...decision, assignment: undefined };
	}

	private async route<T extends { kind: 'reuse' | 'reserve'; member: AppPoolMember }>(
		input: AppPoolRequest,
		operation: 'admit' | 'replace',
		decide: (
			pool: AppPool,
			reservation: AppPoolMember,
			now: number,
		) => {
			pool: AppPool;
			decision: T | { kind: 'busy' };
		},
	): Promise<T> {
		await this.synchronize(input.projectId, input.notebookId);
		const now = this.now();
		const reservation: AppPoolMember = {
			session_id: createSessionId(),
			sandbox_id: createSandboxId(),
			user_id: input.userId,
			source_version_id: input.versionId,
			state: 'starting',
			created_at: now,
			operation_token: crypto.randomUUID(),
			operation_expires_at: now + input.startupMs,
		};
		const decision = await this.store.mutate(input.projectId, input.notebookId, async (pool) => {
			if (pool.deleted_at !== undefined) throw new NotFoundError('App pool was deleted');
			// Reading the head after the pool snapshot fences stale requests on CAS retries.
			await this.assertCommittedVersion(input);
			const routed = decide(pool, reservation, this.now());
			return { pool: routed.pool, value: routed.decision };
		});
		this.metrics.increment('app_pool.admission', 1, { decision: decision.kind, operation });
		logEvent({
			level: 'info',
			event: 'app_pool_admission',
			project_id: input.projectId,
			notebook_id: input.notebookId,
			operation,
			decision: decision.kind,
		});
		if (decision.kind === 'busy') throw new ResourceExhaustedError('App is busy. Retry shortly.');
		return decision;
	}

	private async assertCommittedVersion(
		input: Pick<AppPoolRequest, 'projectId' | 'notebookId' | 'versionId'>,
	) {
		const key = paths.project(input.projectId).notebook(input.notebookId).source;
		const object = await this.bucket.get(key);
		if (!object) throw new NotFoundError('Notebook source not found');
		const source = await readStored(SourceSchema, object, key);
		if (source.current_version_id !== input.versionId)
			throw new ConflictError('The app version changed. Retry shortly.');
	}

	async complete(
		projectId: ProjectId,
		notebookId: NotebookId,
		sessionId: SessionId,
		token: string,
	): Promise<void> {
		const completed = await this.store.mutate(projectId, notebookId, (pool) => {
			const member = pool.members.find((item) => item.session_id === sessionId);
			const valid =
				member?.state === 'starting' &&
				member.operation_token === token &&
				member.operation_expires_at > this.now();
			if (valid) {
				member.state = member.source_version_id === pool.latest_version_id ? 'ready' : 'draining';
				for (const assignment of pool.assignments.filter((item) => item.session_id === sessionId)) {
					for (const visit of assignment.visits)
						visit.expires_at = Math.min(visit.expires_at, this.now() + this.policy.userLeaseMs);
				}
			}
			return { pool, value: valid };
		});
		if (!completed) throw new ConflictError('The app startup reservation expired. Retry shortly.');
		this.metrics.increment('app_pool.provisioned');
		logEvent({
			level: 'info',
			event: 'app_pool_provisioned',
			project_id: projectId,
			notebook_id: notebookId,
			session_id: sessionId,
		});
	}

	async invalidate(
		projectId: ProjectId,
		notebookId: NotebookId,
		sessionId: SessionId,
	): Promise<void> {
		await this.store.mutate(projectId, notebookId, (pool) => {
			const member = pool.members.find((item) => item.session_id === sessionId);
			if (member) member.state = 'retiring';
			pool.assignments = pool.assignments.filter((item) => item.session_id !== sessionId);
			return { pool, value: undefined };
		});
	}

	async heartbeat(
		projectId: ProjectId,
		notebookId: NotebookId,
		userId: UserId,
		sessionId: SessionId,
		visit?: AppVisit,
	): Promise<boolean> {
		return this.store.mutate(projectId, notebookId, (pool) => {
			const now = this.now();
			expireAppPresence(pool, now);
			const member = pool.members.find(
				(item) => item.session_id === sessionId && item.state !== 'retiring',
			);
			if (!member) return { pool, value: false };
			let assignment = pool.assignments.find((item) => item.user_id === userId);
			// Old pages have no visit token. They can register only with an adopted legacy member.
			const legacyVisit = member.legacy && !visit;
			if (!assignment && legacyVisit) {
				assignment = {
					user_id: userId,
					session_id: sessionId,
					generation: crypto.randomUUID(),
					visits: [],
				};
				pool.assignments.push(assignment);
			}
			if (
				!assignment ||
				assignment.session_id !== sessionId ||
				(visit && assignment.generation !== visit.generation)
			) {
				return { pool, value: false };
			}
			const visitId = visit?.visit_id ?? 'api';
			const currentVisit = assignment.visits.find((item) => item.visit_id === visitId);
			if (!currentVisit && !legacyVisit) return { pool, value: false };
			// Keep at least half a lease durable; no process-local renewal buffer is needed.
			const persistInterval = Math.min(
				APP_PRESENCE_PERSIST_INTERVAL_MS,
				this.policy.userLeaseMs / 2,
			);
			if (
				!currentVisit ||
				currentVisit.expires_at - now <= this.policy.userLeaseMs - persistInterval
			)
				renewAppVisit(assignment, visitId, now + this.policy.userLeaseMs);
			delete member.idle_since;
			return { pool, value: true };
		});
	}

	async leave(
		projectId: ProjectId,
		notebookId: NotebookId,
		userId: UserId,
		sessionId: SessionId,
		visit: AppVisit,
	): Promise<void> {
		await this.store.mutate(projectId, notebookId, (pool) => {
			const now = this.now();
			expireAppPresence(pool, now);
			const assignment = pool.assignments.find(
				(item) =>
					item.user_id === userId &&
					item.session_id === sessionId &&
					item.generation === visit.generation,
			);
			if (assignment?.visits.some((item) => item.visit_id === visit.visit_id)) {
				assignment.visits = assignment.visits.filter((item) => item.visit_id !== visit.visit_id);
				if (assignment.visits.length === 0)
					assignment.grace_until = now + this.policy.reconnectGraceMs;
			}
			return { pool, value: undefined };
		});
	}

	async canAccess(
		projectId: ProjectId,
		notebookId: NotebookId,
		userId: UserId,
		sessionId: SessionId,
		legacy = false,
	): Promise<boolean> {
		return (await this.view(projectId, notebookId)).canAccess(userId, sessionId, legacy);
	}

	async inspect(projectId: ProjectId, notebookId: NotebookId) {
		return [...(await this.view(projectId, notebookId)).members.values()];
	}

	async view(projectId: ProjectId, notebookId: NotebookId) {
		const pool = await this.store.read(projectId, notebookId);
		if (pool) expireAppPresence(pool, this.now());
		const assignments = new Map(pool?.assignments.map((item) => [item.user_id, item.session_id]));
		const counts = new Map<SessionId, number>();
		for (const sessionId of assignments.values())
			counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		const members = new Map(
			pool?.members.map((member) => [
				member.session_id,
				{
					session_id: member.session_id,
					state: member.state,
					users: counts.get(member.session_id) ?? 0,
					max_users: this.policy.maxUsersPerSession ?? null,
				},
			]),
		);
		const legacyMembers = new Set(
			pool?.members
				.filter((member) => member.legacy && member.state !== 'retiring')
				.map((member) => member.session_id),
		);
		return {
			members,
			canAccess: (userId: UserId, sessionId: SessionId, legacy = false) =>
				pool
					? pool.deleted_at === undefined &&
						(legacyMembers.has(sessionId) ||
							assignments.get(userId) === sessionId ||
							(legacy && !members.has(sessionId)))
					: legacy,
		};
	}

	async synchronize(
		projectId: ProjectId,
		notebookId: NotebookId,
		observedSessions?: readonly Session[],
	) {
		const snapshot = await this.store.read(projectId, notebookId);
		if (
			snapshot?.deleted_at !== undefined &&
			snapshot.members.length === 0 &&
			(observedSessions?.length ?? 0) === 0
		)
			return snapshot;
		const missing = new Set<SessionId>();
		// Legacy writers are stopped before rollout, so discovery is needed only before a pool exists.
		const candidates =
			observedSessions ??
			(snapshot
				? await mapWithConcurrency(snapshot.members, BUCKET_SCAN_CONCURRENCY, async (member) => {
						try {
							return await this.sessions.getSession(projectId, member.session_id);
						} catch (error) {
							if (error instanceof NotFoundError) {
								// A live reservation may precede its session record; readiness may not.
								if (member.state !== 'starting') missing.add(member.session_id);
								return null;
							}
							throw error;
						}
					})
				: await this.sessions.listActiveByProject(projectId));
		const sessions = candidates.filter(
			(session): session is Session =>
				!!session &&
				session.project_id === projectId &&
				session.notebook_id === notebookId &&
				sessionMode(session) === 'app',
		);
		return this.store.mutate(projectId, notebookId, (pool) => {
			for (const member of pool.members) {
				if (
					missing.has(member.session_id) ||
					(member.state === 'starting' && member.operation_expires_at <= this.now())
				)
					member.state = 'retiring';
			}
			for (const session of sessions) {
				const member = pool.members.find((item) => item.session_id === session.session_id);
				if (member) {
					if (
						isTerminal(session.status) ||
						session.status === 'terminating' ||
						(session.authorization_expires_at &&
							Date.parse(session.authorization_expires_at) <= this.now())
					)
						member.state = 'retiring';
				} else if (
					(session.status === 'running' || session.status === 'starting') &&
					session.sandbox_id &&
					!session.app_pool
				) {
					pool.members.push({
						session_id: session.session_id,
						sandbox_id: session.sandbox_id,
						user_id: session.user_id,
						source_version_id: session.source_version_id,
						state: pool.deleted_at === undefined ? 'draining' : 'retiring',
						legacy: true,
						created_at: Date.parse(session.started_at),
						operation_token: 'legacy',
						operation_expires_at: 0,
					});
				}
			}
			expireAppPresence(pool, this.now());
			return { pool, value: pool };
		});
	}

	async reconcile(
		projectId: ProjectId,
		notebookId: NotebookId,
		effects: {
			probe: (member: AppPoolMember) => Promise<number | null>;
			retire: (member: AppPoolMember, session: Session | null) => Promise<boolean>;
		},
	): Promise<void> {
		const snapshot = await this.synchronize(projectId, notebookId);
		let changed = false;
		for (const candidate of snapshot.members) {
			try {
				const now = this.now();
				const decision = routeAppRetirement(snapshot, candidate, this.policy, now);
				if (decision === 'retain') continue;
				if (decision === 'probe' && (await effects.probe(candidate)) !== 0) continue;
				const retire = await this.store.mutate(projectId, notebookId, (pool) => {
					expireAppPresence(pool, this.now());
					const member = pool.members.find((item) => item.session_id === candidate.session_id);
					if (!member) return { pool, value: false };
					if (routeAppRetirement(pool, member, this.policy, this.now()) === 'retain')
						return { pool, value: false };
					member.state = 'retiring';
					expireAppPresence(pool, this.now());
					return { pool, value: true };
				});
				if (!retire) continue;
				changed = true;
				let session: Session | null;
				try {
					session = await this.sessions.getSession(projectId, candidate.session_id);
				} catch (error) {
					if (error instanceof NotFoundError) session = null;
					else throw error;
				}
				if (await effects.retire(candidate, session)) {
					await this.store.mutate(projectId, notebookId, (pool) => {
						pool.members = pool.members.filter(
							(member) => member.session_id !== candidate.session_id,
						);
						expireAppPresence(pool, this.now());
						return { pool, value: undefined };
					});
					this.metrics.increment('app_pool.drained');
					logEvent({
						level: 'info',
						event: 'app_pool_drained',
						project_id: projectId,
						notebook_id: notebookId,
						session_id: candidate.session_id,
					});
				}
			} catch (error) {
				logOperationalError(
					'app_pool_cleanup_failed',
					{
						operation: 'app_pool.reconcile',
						project_id: projectId,
						notebook_id: notebookId,
						session_id: candidate.session_id,
					},
					error,
				);
			}
		}

		const pool = changed ? await this.store.read(projectId, notebookId) : snapshot;
		this.metrics.gauge('app_pool.users', pool?.assignments.length ?? 0, {
			project_id: projectId,
			notebook_id: notebookId,
		});
	}
}
