import { z } from 'zod';
import { APP_USER_LEASE_MS, APP_RECONNECT_GRACE_MS } from '../../constants';
import { SandboxId, SessionId, UserId, VersionId } from '../../ids';

export interface AppPoolPolicy {
	maxUsersPerSession?: number;
	maxSessionsPerVersion?: number;
	userLeaseMs: number;
	reconnectGraceMs: number;
	idleMs: number;
}

export const DEFAULT_APP_POOL_POLICY: AppPoolPolicy = {
	userLeaseMs: APP_USER_LEASE_MS,
	reconnectGraceMs: APP_RECONNECT_GRACE_MS,
	idleMs: 1_800_000,
};

export const AppVisitSchema = z.object({
	visit_id: z.string().min(1).max(128),
	generation: z.string().min(1).max(128),
});

export const AppPoolMemberSchema = z.object({
	session_id: z.string().refine(SessionId.is),
	sandbox_id: z.string().refine(SandboxId.is),
	user_id: z.string().refine(UserId.is),
	source_version_id: z.string().refine(VersionId.is).optional(),
	state: z.enum(['starting', 'ready', 'draining', 'retiring']),
	created_at: z.number(),
	operation_token: z.string(),
	operation_expires_at: z.number(),
	idle_since: z.number().optional(),
	legacy: z.boolean().optional(),
	replaces_session_id: z.string().refine(SessionId.is).optional(),
});

export const AppPoolAssignmentSchema = z.object({
	user_id: z.string().refine(UserId.is),
	session_id: z.string().refine(SessionId.is),
	generation: z.string(),
	visits: z.array(z.object({ visit_id: z.string(), expires_at: z.number() })),
	grace_until: z.number().optional(),
});

export const AppPoolSchema = z.object({
	schema_version: z.literal(1),
	latest_version_id: z.string().refine(VersionId.is).optional(),
	members: z.array(AppPoolMemberSchema),
	assignments: z.array(AppPoolAssignmentSchema),
});

export type AppPool = z.infer<typeof AppPoolSchema>;
export type AppPoolMember = z.infer<typeof AppPoolMemberSchema>;
export type AppPoolAssignment = z.infer<typeof AppPoolAssignmentSchema>;
export type AppVisit = z.infer<typeof AppVisitSchema>;

export const emptyAppPool = (): AppPool => ({ schema_version: 1, members: [], assignments: [] });

export function appOccupancy(pool: AppPool, sessionId: SessionId): number {
	return pool.assignments.filter((assignment) => assignment.session_id === sessionId).length;
}

/** Expiry is evaluated inside the same CAS as admission or retirement. */
export function expireAppPresence(pool: AppPool, now: number): void {
	const lastPresence = new Map<SessionId, number>();
	const liveMembers = new Set(
		pool.members.filter((member) => member.state !== 'retiring').map((member) => member.session_id),
	);
	for (const assignment of pool.assignments) {
		const expiresAt = Math.max(
			assignment.grace_until ?? 0,
			...assignment.visits.map((visit) => visit.expires_at),
		);
		lastPresence.set(
			assignment.session_id,
			Math.max(lastPresence.get(assignment.session_id) ?? 0, expiresAt),
		);
		assignment.visits = assignment.visits.filter((visit) => visit.expires_at > now);
	}
	pool.assignments = pool.assignments.filter(
		(assignment) =>
			(assignment.visits.length > 0 || (assignment.grace_until ?? 0) > now) &&
			liveMembers.has(assignment.session_id),
	);
	const occupied = new Set(pool.assignments.map((assignment) => assignment.session_id));
	for (const member of pool.members) {
		if (occupied.has(member.session_id)) delete member.idle_since;
		// A delayed sweep must use the lease deadline, not restart the idle clock.
		else member.idle_since ??= lastPresence.get(member.session_id) ?? now;
	}
}

export type AppPoolDecision =
	| { kind: 'reuse' | 'reserve'; member: AppPoolMember; assignment: AppPoolAssignment }
	| { kind: 'busy' };

export interface AppAdmission {
	userId: UserId;
	visitId: string;
	versionId: VersionId;
	generation: string;
	reservation: AppPoolMember;
	now: number;
}

function isReusableMember(member: AppPoolMember, now: number): boolean {
	return (
		member.state !== 'retiring' &&
		(member.state !== 'starting' || member.operation_expires_at > now)
	);
}

function observeVersion(pool: AppPool, versionId: VersionId): void {
	pool.latest_version_id = versionId;
	for (const member of pool.members) {
		if (member.state === 'ready' && member.source_version_id !== versionId)
			member.state = 'draining';
	}
}

function currentVersionMembers(pool: AppPool, versionId: VersionId, now: number): AppPoolMember[] {
	return pool.members.filter(
		(member) =>
			!member.legacy &&
			member.source_version_id === versionId &&
			member.state !== 'draining' &&
			isReusableMember(member, now),
	);
}

function hasSessionCapacity(policy: AppPoolPolicy, current: readonly AppPoolMember[]): boolean {
	return (
		policy.maxSessionsPerVersion === undefined || current.length < policy.maxSessionsPerVersion
	);
}

export function routeApp(
	pool: AppPool,
	policy: AppPoolPolicy,
	input: AppAdmission,
): {
	pool: AppPool;
	decision: AppPoolDecision;
} {
	const next = structuredClone(pool);
	expireAppPresence(next, input.now);
	const existing = next.assignments.find((assignment) => assignment.user_id === input.userId);
	if (existing) {
		const member = next.members.find((item) => item.session_id === existing.session_id)!;
		if (isReusableMember(member, input.now)) {
			renewAppVisit(existing, input.visitId, input.now + policy.userLeaseMs);
			delete member.idle_since;
			return { pool: next, decision: { kind: 'reuse', member, assignment: existing } };
		}
		next.assignments = next.assignments.filter((assignment) => assignment !== existing);
	}
	observeVersion(next, input.versionId);
	const counts = new Map<SessionId, number>();
	for (const assignment of next.assignments)
		counts.set(assignment.session_id, (counts.get(assignment.session_id) ?? 0) + 1);
	const occupancy = (member: AppPoolMember) => counts.get(member.session_id) ?? 0;
	const eligible = currentVersionMembers(next, input.versionId, input.now);
	const available = eligible
		.filter(
			(member) =>
				policy.maxUsersPerSession === undefined || occupancy(member) < policy.maxUsersPerSession,
		)
		.sort(
			(a, b) =>
				Number(b.state === 'ready') - Number(a.state === 'ready') ||
				occupancy(b) - occupancy(a) ||
				a.created_at - b.created_at ||
				a.session_id.localeCompare(b.session_id),
		);
	let member = available[0];
	const kind = member ? 'reuse' : 'reserve';
	if (!member) {
		if (!hasSessionCapacity(policy, eligible)) {
			return { pool: next, decision: { kind: 'busy' } };
		}
		member = structuredClone(input.reservation);
		next.members.push(member);
	}
	const assignment: AppPoolAssignment = {
		user_id: input.userId,
		session_id: member.session_id,
		generation: input.generation,
		visits: [
			{
				visit_id: input.visitId,
				expires_at:
					member.state === 'starting'
						? Math.max(member.operation_expires_at, input.now + policy.userLeaseMs)
						: input.now + policy.userLeaseMs,
			},
		],
	};
	next.assignments.push(assignment);
	delete member.idle_since;
	return { pool: next, decision: { kind, member, assignment } };
}

export function reserveAppReplacement(
	pool: AppPool,
	policy: AppPoolPolicy,
	input: Pick<AppAdmission, 'versionId' | 'reservation' | 'now'> & { replacesSessionId: SessionId },
): {
	pool: AppPool;
	decision: { kind: 'reuse' | 'reserve'; member: AppPoolMember } | { kind: 'busy' };
} {
	const next = structuredClone(pool);
	expireAppPresence(next, input.now);
	const previous = next.members.find(
		(member) =>
			member.replaces_session_id === input.replacesSessionId && isReusableMember(member, input.now),
	);
	if (previous) return { pool: next, decision: { kind: 'reuse', member: previous } };
	observeVersion(next, input.versionId);
	const current = currentVersionMembers(next, input.versionId, input.now);
	if (!hasSessionCapacity(policy, current)) return { pool: next, decision: { kind: 'busy' } };
	const member = { ...input.reservation, replaces_session_id: input.replacesSessionId };
	next.members.push(member);
	return { pool: next, decision: { kind: 'reserve', member } };
}

export function renewAppVisit(
	assignment: AppPoolAssignment,
	visitId: string,
	expiresAt: number,
): void {
	const visit = assignment.visits.find((item) => item.visit_id === visitId);
	if (visit) visit.expires_at = Math.max(visit.expires_at, expiresAt);
	else assignment.visits.push({ visit_id: visitId, expires_at: expiresAt });
	delete assignment.grace_until;
}

export type AppRetirementDecision = 'retain' | 'probe' | 'retire';

export function routeAppRetirement(
	pool: AppPool,
	member: AppPoolMember,
	policy: AppPoolPolicy,
	now: number,
): AppRetirementDecision {
	if (member.state === 'retiring') return 'retire';
	if (member.state === 'starting') return member.operation_expires_at <= now ? 'retire' : 'retain';
	return appOccupancy(pool, member.session_id) === 0 &&
		member.idle_since !== undefined &&
		now - member.idle_since >= policy.idleMs
		? 'probe'
		: 'retain';
}
