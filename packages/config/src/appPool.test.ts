import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_POOL_POLICY } from '@marimo-hub/core';
import { parseAppPoolPolicy } from './appPool';

describe('app pool configuration', () => {
	beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
	afterEach(() => vi.restoreAllMocks());
	it('leaves capacity limits unset and preserves the 1800-second idle default', () => {
		expect(parseAppPoolPolicy({})).toEqual({
			...DEFAULT_APP_POOL_POLICY,
			idleMs: 1_800_000,
			maxVisitsPerSession: undefined,
			maxSessionsPerVersion: undefined,
		});
	});
	it('reads the two independent capacity limits', () => {
		expect(
			parseAppPoolPolicy({
				MARIMOHUB_APP_MAX_VISITS_PER_SESSION: '4',
				MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION: '2',
			}),
		).toEqual({ ...DEFAULT_APP_POOL_POLICY, maxVisitsPerSession: 4, maxSessionsPerVersion: 2 });
	});
	it.each([undefined, '', ' \t '])(
		'aliases the deprecated name when the canonical value is %j',
		(value) => {
			const env = {
				MARIMOHUB_APP_MAX_USERS_PER_SESSION: '2',
				MARIMOHUB_APP_MAX_VISITS_PER_SESSION: value,
			};
			expect(parseAppPoolPolicy(env).maxVisitsPerSession).toBe(2);
			expect(env.MARIMOHUB_APP_MAX_VISITS_PER_SESSION).toBe(value);
			expect(console.warn).toHaveBeenCalledExactlyOnceWith(
				'[marimohub] MARIMOHUB_APP_MAX_USERS_PER_SESSION is deprecated; use MARIMOHUB_APP_MAX_VISITS_PER_SESSION.',
			);
		},
	);
	it('uses only the canonical setting when both names are set', () => {
		expect(
			parseAppPoolPolicy({
				MARIMOHUB_APP_MAX_USERS_PER_SESSION: 'invalid',
				MARIMOHUB_APP_MAX_VISITS_PER_SESSION: '3',
			}).maxVisitsPerSession,
		).toBe(3);
		expect(console.warn).not.toHaveBeenCalled();
	});
	it('parses padded values identically through canonical and deprecated names', () => {
		const value = ' \t2\n ';
		const aliased = parseAppPoolPolicy({ MARIMOHUB_APP_MAX_USERS_PER_SESSION: value });
		expect(aliased).toEqual(parseAppPoolPolicy({ MARIMOHUB_APP_MAX_VISITS_PER_SESSION: value }));
		expect(aliased.maxVisitsPerSession).toBe(2);
	});
	it.each(['0', 'not-a-number'])(
		'validates an aliased value through the canonical setting: %s',
		(value) => {
			expect(() => parseAppPoolPolicy({ MARIMOHUB_APP_MAX_USERS_PER_SESSION: value })).toThrow(
				expect.objectContaining({ opts: { variable: 'MARIMOHUB_APP_MAX_VISITS_PER_SESSION' } }),
			);
		},
	);
	it('does not fall back when the canonical value is invalid', () => {
		expect(() =>
			parseAppPoolPolicy({
				MARIMOHUB_APP_MAX_VISITS_PER_SESSION: '0',
				MARIMOHUB_APP_MAX_USERS_PER_SESSION: '2',
			}),
		).toThrow(
			expect.objectContaining({ opts: { variable: 'MARIMOHUB_APP_MAX_VISITS_PER_SESSION' } }),
		);
		expect(console.warn).not.toHaveBeenCalled();
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
				'MARIMOHUB_APP_MAX_VISITS_PER_SESSION',
				'MARIMOHUB_APP_MAX_USERS_PER_SESSION',
				'MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION',
				'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS',
				'MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS',
			] as const)
				expect(() => parseAppPoolPolicy({ [key]: value })).toThrow();
		},
	);
});
