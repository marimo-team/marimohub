import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_POOL_POLICY } from '@marimo-hub/core';
import { parseAppPoolPolicy } from './appPool';

describe('app pool configuration', () => {
	it('leaves capacity limits unset and preserves the 1800-second idle default', () => {
		expect(parseAppPoolPolicy({})).toEqual({
			...DEFAULT_APP_POOL_POLICY,
			idleMs: 1_800_000,
			maxUsersPerSession: undefined,
			maxSessionsPerVersion: undefined,
		});
	});
	it('reads the two independent capacity limits', () => {
		expect(
			parseAppPoolPolicy({
				MARIMOHUB_APP_MAX_USERS_PER_SESSION: '4',
				MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION: '2',
			}),
		).toEqual({ ...DEFAULT_APP_POOL_POLICY, maxUsersPerSession: 4, maxSessionsPerVersion: 2 });
	});
	it('inherits the general idle timeout and allows an app override', () => {
		expect(parseAppPoolPolicy({ MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS: '900' }).idleMs).toBe(
			900_000,
		);
		expect(
			parseAppPoolPolicy({
				MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS: '900',
				MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS: '60',
			}).idleMs,
		).toBe(60_000);
	});
	it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992'])(
		'rejects invalid limits and timeouts: %s',
		(value) => {
			for (const key of [
				'MARIMOHUB_APP_MAX_USERS_PER_SESSION',
				'MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION',
				'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS',
				'MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS',
			] as const)
				expect(() => parseAppPoolPolicy({ [key]: value })).toThrow();
		},
	);
});
