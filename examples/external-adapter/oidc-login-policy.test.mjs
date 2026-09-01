// Example test suite for the example login-policy module, using only Node's
// built-in test runner — no framework install needed. Run it with:
//
//   node --test examples/external-adapter/oidc-login-policy.test.mjs
//
// This is the recommended shape for testing your own policy before deploying
// it: import the bundled module, call create() once, and drive evaluate() with
// claim fixtures — happy paths, every individually-missing requirement, and
// hostile or malformed claim values. A login policy is a security boundary:
// claim *values* are provider-controlled data, so the unhappy paths below are
// the tests that matter most. It is not wired into marimohub's CI.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import manifest from './oidc-login-policy.mjs';

// `create()` may be async in general; this example's factory is synchronous.
const policy = manifest.create({ env: {} });

// The host's version-1 result bounds: allow with recognized entitlements, or
// deny with an optional bounded reason. Anything else fails closed server-side,
// so a policy emitting it would silently lock everyone out with `auth_failed`.
const KNOWN_ENTITLEMENTS = new Set([
	'super-admin',
	'project-creator',
	'default-role:viewer',
	'default-role:editor',
	'default-role:manager',
]);
const DENY_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function assertWithinHostContract(result) {
	assert.equal(typeof result, 'object');
	assert.notEqual(result, null);
	if (result.decision === 'allow') {
		assert.deepEqual(
			Object.keys(result).filter((key) => key !== 'decision' && key !== 'entitlements'),
			[],
		);
		for (const entitlement of result.entitlements ?? []) {
			assert.ok(KNOWN_ENTITLEMENTS.has(entitlement), `unknown entitlement: ${entitlement}`);
		}
	} else {
		assert.equal(result.decision, 'deny');
		assert.deepEqual(
			Object.keys(result).filter((key) => key !== 'decision' && key !== 'reason'),
			[],
		);
		if (result.reason !== undefined) {
			assert.match(result.reason, DENY_REASON_PATTERN);
		}
	}
	return result;
}

// Mirrors what the marimohub host passes: a host-owned identity, deep-frozen
// claim objects, and an abort signal tied to the evaluation timeout.
function input(userAttributes, extras = {}) {
	return Object.freeze({
		identity: Object.freeze({ id: 'user-1', email: 'user@example.com' }),
		idTokenClaims: Object.freeze({
			sub: 'user-1',
			email: 'user@example.com',
			...(userAttributes !== undefined ? { user_attributes: userAttributes } : {}),
		}),
		signal: new AbortController().signal,
		...extras,
	});
}

function evaluate(userAttributes, extras) {
	return assertWithinHostContract(policy.evaluate(input(userAttributes, extras)));
}

const satisfied = {
	department: 'orgcode1',
	access_level: 'elevated',
	elements: ['element-a', 'element-b'],
};

describe('manifest', () => {
	test('declares the oidc-login-policy contract', () => {
		assert.equal(manifest.apiVersion, 1);
		assert.equal(manifest.kind, 'oidc-login-policy');
		assert.equal(typeof policy.evaluate, 'function');
	});
});

describe('allow paths', () => {
	test('allows a subject that satisfies every requirement', () => {
		assert.deepEqual(evaluate(satisfied), {
			decision: 'allow',
			entitlements: ['default-role:editor'],
		});
	});

	test('accepts each allowed department', () => {
		for (const department of ['orgcode1', 'orgcode2']) {
			assert.equal(evaluate({ ...satisfied, department }).decision, 'allow');
		}
	});

	test('accepts a level above the minimum', () => {
		assert.equal(evaluate({ ...satisfied, access_level: 'restricted' }).decision, 'allow');
	});

	test('accepts required elements in any order, with duplicates and extras', () => {
		for (const elements of [
			['element-b', 'element-a'],
			['element-a', 'element-a', 'element-b'],
			['element-c', 'element-a', 'element-b'],
		]) {
			assert.equal(evaluate({ ...satisfied, elements }).decision, 'allow');
		}
	});

	test('ignores unrelated extra attributes', () => {
		assert.equal(evaluate({ ...satisfied, favorite_color: 'teal' }).decision, 'allow');
	});
});

describe('deny paths — one missing requirement at a time', () => {
	test('denies a subject outside the allowed departments, with a bounded reason', () => {
		assert.deepEqual(evaluate({ ...satisfied, department: 'orgcode9' }), {
			decision: 'deny',
			reason: 'example_access_policy',
		});
	});

	test('denies a subject below the minimum level', () => {
		assert.equal(evaluate({ ...satisfied, access_level: 'baseline' }).decision, 'deny');
	});

	test('denies a subject missing any required element', () => {
		for (const elements of [['element-a'], ['element-b'], [], ['element-c']]) {
			assert.equal(evaluate({ ...satisfied, elements }).decision, 'deny');
		}
	});

	test('denies when any single requirement is absent', () => {
		for (const requirement of ['department', 'access_level', 'elements']) {
			const attributes = { ...satisfied };
			delete attributes[requirement];
			assert.equal(evaluate(attributes).decision, 'deny');
		}
	});
});

describe('unhappy paths — malformed and hostile claims', () => {
	test('fails closed when user_attributes is missing or not an object', () => {
		for (const attributes of [undefined, null, 'elevated', 42, true, [], ['orgcode1']]) {
			assert.equal(evaluate(attributes).decision, 'deny');
		}
	});

	test('fails closed on type-confused departments', () => {
		for (const department of [null, 1, ['orgcode1'], { name: 'orgcode1' }, true]) {
			assert.equal(evaluate({ ...satisfied, department }).decision, 'deny');
		}
	});

	test('level comparison is exact — no case folding, coercion, or lookup tricks', () => {
		for (const access_level of [
			'ELEVATED',
			' elevated',
			'',
			2,
			['restricted'],
			null,
			// Prototype-chain names must not resolve to a rank.
			'toString',
			'constructor',
			'__proto__',
			'hasOwnProperty',
		]) {
			assert.equal(evaluate({ ...satisfied, access_level }).decision, 'deny');
		}
	});

	test('fails closed on non-string-array elements', () => {
		for (const elements of [
			'element-a,element-b',
			['element-a', 42],
			['element-a', ['element-b']],
			[null, 'element-a', 'element-b'],
			{ 0: 'element-a', 1: 'element-b' },
			new Set(['element-a', 'element-b']),
		]) {
			assert.equal(evaluate({ ...satisfied, elements }).decision, 'deny');
		}
	});

	test('survives claims that shadow Object.prototype names', () => {
		// JSON.parse produces own properties even for `__proto__`, matching how
		// hostile provider claims actually arrive.
		const hostile = JSON.parse(
			'{"__proto__": {"department": "orgcode1"}, "constructor": "x", "toString": "y"}',
		);
		assert.equal(evaluate(hostile).decision, 'deny');
		assert.equal(
			evaluate(
				JSON.parse(`{"__proto__": {"polluted": true}, ${JSON.stringify(satisfied).slice(1)}`),
			).decision,
			'allow',
		);
		assert.equal({}.polluted, undefined);
	});

	test('does not throw on any garbage input — a throw would deny ALL logins as auth_failed', () => {
		for (const attributes of [
			undefined,
			null,
			0,
			Number.NaN,
			'',
			Symbol('attrs'),
			() => satisfied,
			Object.create(null),
			{ department: Symbol('d'), access_level: () => 'elevated', elements: 9n },
		]) {
			assert.doesNotThrow(() => assertWithinHostContract(policy.evaluate(input(attributes))));
		}
	});
});

describe('host-contract details', () => {
	test('reads only ID-token claims — satisfying UserInfo claims do not grant access', () => {
		// The host passes ID-token and UserInfo claims as separate objects and
		// never merges them; this policy deliberately keys off the ID token only.
		const result = evaluate(undefined, {
			userInfoClaims: Object.freeze({ sub: 'user-1', user_attributes: satisfied }),
		});
		assert.equal(result.decision, 'deny');
	});

	test('is deterministic and side-effect free on a frozen fixture', () => {
		// The host deep-freezes every claim object; a policy that mutates its
		// input throws in strict-mode ESM. Repeat evaluations must agree.
		const fixture = input(
			Object.freeze({ ...satisfied, elements: Object.freeze([...satisfied.elements]) }),
		);
		assert.deepEqual(policy.evaluate(fixture), policy.evaluate(fixture));
		assert.equal(policy.evaluate(fixture).decision, 'allow');
	});

	test('never leaks claim values through the deny reason', () => {
		const marker = 'zz_secret_department_value';
		const result = evaluate({ ...satisfied, department: marker });
		assert.equal(result.decision, 'deny');
		assert.ok(!JSON.stringify(result).includes(marker));
	});
});
