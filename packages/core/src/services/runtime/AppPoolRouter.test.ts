import { describe, expect, it } from 'vitest';
import {
	APP_HEARTBEAT_INTERVAL_MS,
	APP_USER_LEASE_MS,
	APP_RECONNECT_GRACE_MS,
} from '../../constants';
import { createSandboxId, createSessionId, createVersionId, SessionId, UserId } from '../../ids';
import {
	DEFAULT_APP_POOL_POLICY,
	emptyAppPool,
	routeApp,
	routeAppRetirement,
	reserveAppReplacement,
} from './AppPoolRouter';
import type { AppPool, AppPoolMember } from './AppPoolRouter';

const version = createVersionId();
const now = 100_000;
const policy = { ...DEFAULT_APP_POOL_POLICY, maxUsersPerSession: 4 };
const member = (overrides: Partial<AppPoolMember> = {}): AppPoolMember => ({
	session_id: createSessionId(),
	sandbox_id: createSandboxId(),
	user_id: UserId.parse('starter'),
	source_version_id: version,
	state: 'ready',
	created_at: 1,
	operation_token: 'operation',
	operation_expires_at: now + 900_000,
	...overrides,
});
const arrive = (pool: AppPool) =>
	routeApp(pool, policy, {
		userId: UserId.parse('arrival'),
		visitId: 'tab',
		versionId: version,
		generation: 'new-assignment',
		reservation: member({ state: 'starting' }),
		now,
	});

describe('pure app routing', () => {
	it('keeps presence constants compatible with heartbeat cadence', () => {
		expect(APP_HEARTBEAT_INTERVAL_MS).toBe(30_000);
		expect(APP_USER_LEASE_MS).toBe(4 * APP_HEARTBEAT_INTERVAL_MS);
		expect(APP_RECONNECT_GRACE_MS).toBe(15_000);
		expect(APP_RECONNECT_GRACE_MS).toBeLessThan(APP_USER_LEASE_MS);
	});

	it('packs the fullest ready member before an emptier older member', () => {
		const older = member();
		const fuller = member({ created_at: 2 });
		const pool = emptyAppPool();
		pool.members = [older, fuller];
		pool.assignments = [0, 1, 2].map((i) => ({
			user_id: UserId.parse(`user-${i}`),
			session_id: fuller.session_id,
			generation: `${i}`,
			visits: [{ visit_id: 'tab', expires_at: now + 1000 }],
		}));
		const before = structuredClone(pool);
		const result = arrive(pool);
		expect(result.decision).toMatchObject({
			kind: 'reuse',
			member: { session_id: fuller.session_id },
		});
		expect(pool).toEqual(before);
	});

	it('breaks occupancy ties by oldest creation time, then session ID', () => {
		const first = member({ session_id: SessionId.parse('sess-0000000000000001') });
		const second = member({ session_id: SessionId.parse('sess-0000000000000002') });
		const pool = { ...emptyAppPool(), members: [second, first] };
		expect(arrive(pool).decision).toMatchObject({ member: { session_id: first.session_id } });
		first.created_at = 2;
		expect(arrive(pool).decision).toMatchObject({ member: { session_id: second.session_id } });
	});

	it('never admits new accounts to draining or retiring members', () => {
		const pool = {
			...emptyAppPool(),
			members: [member({ state: 'draining' }), member({ state: 'retiring' })],
		};
		expect(arrive(pool).decision.kind).toBe('reserve');
	});

	it.each(['admission', 'replacement'] as const)(
		'%s excludes expired startup reservations at the exact deadline',
		(operation) => {
			const expired = member({ state: 'starting', operation_expires_at: now });
			const pool = { ...emptyAppPool(), members: [expired] };
			const before = structuredClone(pool);
			const input = {
				userId: UserId.parse('arrival'),
				visitId: 'tab',
				versionId: version,
				generation: 'new',
				reservation: member({ state: 'starting' }),
				now,
				replacesSessionId: expired.session_id,
			};
			const limited = { ...policy, maxSessionsPerVersion: 1 };
			const result =
				operation === 'admission'
					? routeApp(pool, limited, input)
					: reserveAppReplacement(pool, limited, input);
			expect(result.decision.kind).toBe('reserve');
			expect(result.pool.members).toHaveLength(2);
			expect(pool).toEqual(before);
		},
	);

	it.each(['ready', 'draining', 'starting', 'expired', 'retiring'] as const)(
		'retries a replacement whose prior reservation is %s',
		(state) => {
			const target = member({ state: 'retiring' });
			const previous = member({
				state: state === 'expired' ? 'starting' : state,
				replaces_session_id: target.session_id,
				operation_expires_at: state === 'expired' ? now : now + 1,
			});
			const pool = { ...emptyAppPool(), members: [target, previous] };
			const result = reserveAppReplacement(
				pool,
				{ ...policy, maxSessionsPerVersion: 1 },
				{
					versionId: version,
					reservation: member({ state: 'starting' }),
					now,
					replacesSessionId: target.session_id,
				},
			);
			const reuse = state !== 'expired' && state !== 'retiring';
			expect(result.decision.kind).toBe(reuse ? 'reuse' : 'reserve');
			if (result.decision.kind !== 'busy')
				expect(result.decision.member.session_id === previous.session_id).toBe(reuse);
			expect(result.pool.assignments).toEqual([]);
		},
	);

	it('re-admits an account whose startup token expired before its visit lease', () => {
		const expired = member({ state: 'starting', operation_expires_at: now });
		const pool = {
			...emptyAppPool(),
			members: [expired],
			assignments: [
				{
					user_id: UserId.parse('arrival'),
					session_id: expired.session_id,
					generation: 'old',
					visits: [{ visit_id: 'tab', expires_at: now + 1000 }],
				},
			],
		};
		const result = arrive(pool);
		expect(result.decision.kind).toBe('reserve');
		expect(result.pool.assignments).toHaveLength(1);
		expect(result.pool.assignments[0].generation).toBe('new-assignment');
		expect(result.pool.assignments[0].session_id).not.toBe(expired.session_id);
	});

	it.each([
		{ state: 'starting', operation_expires_at: now + 1, expected: 'retain' },
		{ state: 'starting', operation_expires_at: now, expected: 'retire' },
		{ state: 'retiring', expected: 'retire' },
		{ state: 'draining', idle_since: now - policy.idleMs + 1, expected: 'retain' },
		{ state: 'draining', idle_since: now - policy.idleMs, expected: 'probe' },
	] as const)('decides $expected for $state lifecycle state', ({ expected, ...overrides }) => {
		const candidate = member(overrides);
		expect(
			routeAppRetirement({ ...emptyAppPool(), members: [candidate] }, candidate, policy, now),
		).toBe(expected);
	});
});
