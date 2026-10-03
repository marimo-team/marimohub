import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_POOL_POLICY } from '@marimo-hub/core';
import { previewAppPoolPolicy, previewIdleTimeout } from './previewPolicy';

describe('preview resource policy', () => {
	it.each([
		{ configured: undefined, expected: 300_000 },
		{ configured: 1_800_000, expected: 300_000 },
		{ configured: 60_000, expected: 60_000 },
		{ configured: 300_000, expected: 300_000 },
	])('bounds idle timeout $configured to $expected', ({ configured, expected }) => {
		expect(previewIdleTimeout(configured)).toBe(expected);
	});

	it('defaults to five minutes idle and two replicas per version', () => {
		expect(previewAppPoolPolicy()).toEqual({
			...DEFAULT_APP_POOL_POLICY,
			idleMs: 300_000,
			maxSessionsPerVersion: 2,
		});
	});

	it.each([1, 2, 10])('caps configured replicas at two: %s', (replicas) => {
		const configured = {
			...DEFAULT_APP_POOL_POLICY,
			idleMs: 900_000,
			maxSessionsPerVersion: replicas,
			maxVisitsPerSession: 7,
		};
		expect(previewAppPoolPolicy(configured)).toEqual({
			...configured,
			idleMs: 300_000,
			maxSessionsPerVersion: Math.min(replicas, 2),
		});
		expect(configured.idleMs).toBe(900_000);
	});

	it('preserves a stricter configured idle timeout', () => {
		expect(previewAppPoolPolicy({ ...DEFAULT_APP_POOL_POLICY, idleMs: 60_000 }).idleMs).toBe(
			60_000,
		);
	});
});
