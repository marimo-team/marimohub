import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_ENTITLEMENTS, UserId } from '@marimo-hub/core';
import type { OidcLoginPolicy, OidcLoginPolicyInput } from './loginPolicy';
import {
	evaluateLoginPolicy,
	frozenClaimsClone,
	isOidcLoginPolicy,
	parseLoginPolicyDecision,
} from './loginPolicy';

const identity = { id: UserId.parse('user-1'), email: 'user@example.com' };

function policyReturning(result: unknown): OidcLoginPolicy {
	return { evaluate: () => result as never };
}

async function evaluate(policy: OidcLoginPolicy, timeoutMs = 1000) {
	return evaluateLoginPolicy(policy, { identity, idTokenClaims: { sub: 'user-1' } }, { timeoutMs });
}

afterEach(() => {
	vi.useRealTimers();
});

describe('parseLoginPolicyDecision', () => {
	it.each(AUTH_ENTITLEMENTS)('accepts an allow granting %s', (entitlement) => {
		expect(parseLoginPolicyDecision({ decision: 'allow', entitlements: [entitlement] })).toEqual({
			ok: true,
			value: { decision: 'allow', entitlements: [entitlement] },
		});
	});

	it('accepts an allow with no entitlements field as an empty grant', () => {
		expect(parseLoginPolicyDecision({ decision: 'allow' })).toEqual({
			ok: true,
			value: { decision: 'allow', entitlements: [] },
		});
	});

	it('deduplicates entitlements into canonical order', () => {
		expect(
			parseLoginPolicyDecision({
				decision: 'allow',
				entitlements: [
					'default-role:editor',
					'super-admin',
					'default-role:editor',
					'default-role:viewer',
				],
			}),
		).toEqual({
			ok: true,
			value: {
				decision: 'allow',
				entitlements: ['super-admin', 'default-role:viewer', 'default-role:editor'],
			},
		});
	});

	it.each([
		[{ decision: 'allow', entitlements: ['admin'] }, 'unknown_entitlement'],
		[{ decision: 'allow', entitlements: [42] }, 'unknown_entitlement'],
		[{ decision: 'allow', entitlements: 'super-admin' }, 'entitlements_not_an_array'],
		[{ decision: 'allow', entitlements: { 0: 'super-admin' } }, 'entitlements_not_an_array'],
		[{ decision: 'deny', reason: 'ok', entitlements: [] }, 'entitlements_on_deny'],
		[{ decision: 'allow', reason: 'agency' }, 'unknown_result_field'],
		[
			{ decision: 'allow', subjectSecurityContext: { classification: 'SECRET' } },
			'unknown_result_field',
		],
		[{ decision: 'deny', subjectSecurityContext: {} }, 'unknown_result_field'],
		[{ decision: 'deny', reason: 'Agency Policy' }, 'invalid_reason'],
		[{ decision: 'deny', reason: '_leading' }, 'invalid_reason'],
		[{ decision: 'deny', reason: `x${'y'.repeat(64)}` }, 'invalid_reason'],
		[{ decision: 'deny', reason: 42 }, 'invalid_reason'],
		[{ decision: 'maybe' }, 'invalid_decision'],
		[{}, 'invalid_decision'],
		['allow', 'result_not_an_object'],
		[null, 'result_not_an_object'],
		[undefined, 'result_not_an_object'],
		[['allow'], 'result_not_an_object'],
	] as const)('rejects %j with %s', (result, problem) => {
		expect(parseLoginPolicyDecision(result)).toEqual({ ok: false, problem });
	});

	it('accepts a deny with a bounded reason and without one', () => {
		expect(parseLoginPolicyDecision({ decision: 'deny', reason: 'agency_access_policy' })).toEqual({
			ok: true,
			value: { decision: 'deny', reason: 'agency_access_policy' },
		});
		expect(parseLoginPolicyDecision({ decision: 'deny' })).toEqual({
			ok: true,
			value: { decision: 'deny' },
		});
	});
});

describe('frozenClaimsClone', () => {
	it('deep-freezes nested objects and arrays', () => {
		const clone = frozenClaimsClone({
			user_attributes: { compartments: ['element-a', { nested: true }] },
		});
		expect(Object.isFrozen(clone)).toBe(true);
		const attributes = clone.user_attributes as Record<string, unknown>;
		expect(Object.isFrozen(attributes)).toBe(true);
		const compartments = attributes.compartments as unknown[];
		expect(Object.isFrozen(compartments)).toBe(true);
		expect(Object.isFrozen(compartments[1])).toBe(true);
	});

	it('keeps prototype-named claim keys as own properties instead of mutating the prototype', () => {
		// JSON parsing yields an own `__proto__` property; the clone must too, or
		// the assignment would swap the clone's prototype and let hostile claims
		// satisfy policy reads through inheritance.
		const hostile = JSON.parse(
			'{"user_attributes": {"__proto__": {"department": "orgcode1"}, "constructor": "x"}}',
		) as Record<string, unknown>;
		const attributes = frozenClaimsClone(hostile).user_attributes as Record<string, unknown>;
		expect(Object.getPrototypeOf(attributes)).toBeNull();
		expect(Object.hasOwn(attributes, '__proto__')).toBe(true);
		expect(attributes.__proto__).toEqual({ department: 'orgcode1' });
		expect(attributes.constructor).toBe('x');
		expect(attributes.department).toBeUndefined();
	});

	it('drops non-JSON values the way JSON serialization does', () => {
		const clone = frozenClaimsClone({
			ok: 'yes',
			fn: () => 'no',
			missing: undefined,
			items: ['a', undefined, () => 'b'],
		});
		expect(clone).toEqual({ ok: 'yes', items: ['a', null, null] });
	});
});

describe('evaluateLoginPolicy', () => {
	it('returns validated allow outcomes with normalized entitlements', async () => {
		const outcome = await evaluate(
			policyReturning({
				decision: 'allow',
				entitlements: ['default-role:manager', 'default-role:manager', 'super-admin'],
			}),
		);
		expect(outcome).toMatchObject({
			outcome: 'allow',
			entitlements: ['super-admin', 'default-role:manager'],
		});
	});

	it('returns an allow with an empty grant when the module grants nothing', async () => {
		await expect(evaluate(policyReturning({ decision: 'allow' }))).resolves.toMatchObject({
			outcome: 'allow',
			entitlements: [],
		});
	});

	it('returns deny outcomes with the bounded reason only', async () => {
		await expect(
			evaluate(policyReturning({ decision: 'deny', reason: 'agency_access_policy' })),
		).resolves.toMatchObject({ outcome: 'deny', reason: 'agency_access_policy' });
		const withoutReason = await evaluate(policyReturning({ decision: 'deny' }));
		expect(withoutReason.outcome).toBe('deny');
		expect(withoutReason).not.toHaveProperty('reason');
	});

	it('maps a deny with an invalid reason to an invalid outcome', async () => {
		await expect(
			evaluate(policyReturning({ decision: 'deny', reason: 'Not Bounded!' })),
		).resolves.toMatchObject({ outcome: 'invalid', problem: 'invalid_reason' });
	});

	it('fails closed on a version-1 result carrying subjectSecurityContext', async () => {
		await expect(
			evaluate(
				policyReturning({ decision: 'allow', subjectSecurityContext: { clearance: 'SECRET' } }),
			),
		).resolves.toMatchObject({ outcome: 'invalid', problem: 'unknown_result_field' });
	});

	it('maps synchronous exceptions to a bounded error outcome', async () => {
		await expect(
			evaluate({
				evaluate: () => {
					throw new Error('claims: {"clearance":"SECRET"}');
				},
			}),
		).resolves.toMatchObject({ outcome: 'error' });
	});

	it('maps rejected promises to a bounded error outcome', async () => {
		await expect(
			evaluate({ evaluate: () => Promise.reject(new Error('sensitive detail')) }),
		).resolves.toMatchObject({ outcome: 'error' });
	});

	it('times out a module that ignores the abort signal', async () => {
		vi.useFakeTimers();
		const pending = evaluateLoginPolicy(
			{ evaluate: () => new Promise(() => {}) },
			{ identity, idTokenClaims: {} },
			{ timeoutMs: 5000 },
		);
		await vi.advanceTimersByTimeAsync(5000);
		await expect(pending).resolves.toMatchObject({ outcome: 'timeout', durationMs: 5000 });
	});

	it('discards an over-deadline decision from a synchronous busy-loop', async () => {
		// Real timers: a synchronous block prevents the deadline timer from ever
		// firing, so the host must reject the late result after the fact.
		const outcome = await evaluateLoginPolicy(
			{
				evaluate() {
					const end = Date.now() + 30;
					while (Date.now() < end) {
						// busy-wait past the deadline
					}
					return { decision: 'allow', entitlements: ['super-admin'] };
				},
			},
			{ identity, idTokenClaims: {} },
			{ timeoutMs: 5 },
		);
		expect(outcome.outcome).toBe('timeout');
	});

	it('swallows a rejection that settles after the timeout already won', async () => {
		vi.useFakeTimers();
		const pending = evaluateLoginPolicy(
			{
				evaluate: () =>
					new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 10_000)),
			},
			{ identity, idTokenClaims: {} },
			{ timeoutMs: 1000 },
		);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(pending).resolves.toMatchObject({ outcome: 'timeout' });
		await vi.advanceTimersByTimeAsync(10_000);
	});

	it('delivers an abort signal that fires at the timeout', async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const pending = evaluateLoginPolicy(
			{
				evaluate(input) {
					signal = input.signal;
					return new Promise(() => {});
				},
			},
			{ identity, idTokenClaims: {} },
			{ timeoutMs: 2000 },
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(2000);
		await pending;
		expect(signal?.aborted).toBe(true);
	});

	it('gives the module an isolated deep-frozen clone of each claim object', async () => {
		const idTokenClaims = { sub: 'user-1', user_attributes: { department: 'orgcode1' } };
		const userInfoClaims = { sub: 'user-1', groups: ['a'] };
		let seen: OidcLoginPolicyInput | undefined;
		await evaluateLoginPolicy(
			{
				evaluate(input) {
					seen = input;
					expect(() => {
						(input.idTokenClaims as Record<string, unknown>).sub = 'attacker';
					}).toThrow(TypeError);
					const clonedGroups = input.userInfoClaims!.groups as string[];
					expect(() => {
						clonedGroups.push('injected');
					}).toThrow(TypeError);
					return { decision: 'allow' };
				},
			},
			{ identity, idTokenClaims, userInfoClaims },
		);
		expect(seen?.idTokenClaims).not.toBe(idTokenClaims);
		expect(seen?.userInfoClaims).not.toBe(userInfoClaims);
		expect(Object.isFrozen(seen?.identity)).toBe(true);
		// Host-side mutations after the fact must be invisible to the clone.
		idTokenClaims.user_attributes.department = 'orgcode2';
		expect((seen!.idTokenClaims.user_attributes as Record<string, unknown>).department).toBe(
			'orgcode1',
		);
		expect(idTokenClaims.sub).toBe('user-1');
		expect(userInfoClaims.groups).toEqual(['a']);
	});

	it('omits userInfoClaims when the host has none', async () => {
		let seen: OidcLoginPolicyInput | undefined;
		await evaluateLoginPolicy(
			{
				evaluate(input) {
					seen = input;
					return { decision: 'deny' };
				},
			},
			{ identity, idTokenClaims: { sub: 'user-1' } },
		);
		expect(seen && 'userInfoClaims' in seen).toBe(false);
	});
});

describe('isOidcLoginPolicy', () => {
	it('requires a callable evaluate', () => {
		expect(isOidcLoginPolicy({ evaluate: () => ({ decision: 'deny' }) })).toBe(true);
		expect(isOidcLoginPolicy({ evaluate: 'nope' })).toBe(false);
		expect(isOidcLoginPolicy({})).toBe(false);
		expect(isOidcLoginPolicy(null)).toBe(false);
	});
});
