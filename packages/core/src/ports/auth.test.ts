import { isAuthGroupId, normalizeAuthGroups, MAX_AUTH_GROUPS_JSON_BYTES } from './auth';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AuthEntitlement, AuthUser } from './auth';

describe('AuthUser', () => {
	it('exposes resolved entitlements as readonly authorization data', () => {
		expectTypeOf<AuthUser['entitlements']>().toEqualTypeOf<
			readonly AuthEntitlement[] | undefined
		>();
	});
});

describe('bounded authentication groups', () => {
	it.each([
		'2a4c6e80-1234-1234-1234-123456789abc',
		'Engineering team',
		'/eng/data-platform',
		'team@corp.com',
		'a'.repeat(128),
	])('accepts %s', (group) => {
		expect(isAuthGroupId(group)).toBe(true);
	});
	it.each(['', 'a,b', 'bad\n', 'a\u0085b', ' a', 'a ', 'a'.repeat(129), 1, null])(
		'rejects %j',
		(group) => {
			expect(normalizeAuthGroups([group])).toEqual({ ok: false, problem: 'invalid_group' });
		},
	);
	it('deduplicates before bounding and sorts by code unit', () => {
		expect(normalizeAuthGroups(['z', 'A', 'a', 'z'])).toEqual({
			ok: true,
			groups: ['A', 'a', 'z'],
		});
		expect(normalizeAuthGroups(Array(100).fill('a'))).toEqual({ ok: true, groups: ['a'] });
		const groups = Array.from({ length: 32 }, (_, i) => `group-${i}`);
		expect(normalizeAuthGroups(groups).ok).toBe(true);
		expect(normalizeAuthGroups([...groups, 'extra'])).toEqual({
			ok: false,
			problem: 'too_many_groups',
		});
	});
	it.each(['x', 'é', '"', '\\'])('bounds serialized UTF-8 bytes including %s', (character) => {
		const groups = Array.from({ length: 10 }, (_, i) => `${i}${character.repeat(60)}`);
		let remaining =
			MAX_AUTH_GROUPS_JSON_BYTES - new TextEncoder().encode(JSON.stringify(groups)).byteLength;
		for (let i = 0; i < groups.length && remaining > 0; i += 1) {
			const padding = Math.min(128 - groups[i].length, remaining);
			groups[i] += 'x'.repeat(padding);
			remaining -= padding;
		}
		expect(new TextEncoder().encode(JSON.stringify(groups)).byteLength).toBe(1280);
		expect(normalizeAuthGroups(groups).ok).toBe(true);
		groups[groups.findIndex((group) => group.length < 128)] += 'x';
		expect(normalizeAuthGroups(groups)).toEqual({ ok: false, problem: 'too_many_groups' });
	});
	it('is total for non-arrays, throwing proxies, and revoked proxies', () => {
		const revoked = Proxy.revocable([], {});
		revoked.revoke();
		for (const value of [
			undefined,
			null,
			'group',
			{},
			new Proxy([], {
				get() {
					throw new Error('trap');
				},
			}),
			revoked.proxy,
		]) {
			expect(normalizeAuthGroups(value)).toEqual({ ok: false, problem: 'groups_not_an_array' });
		}
	});
});

describe('authentication group normalization edge cases', () => {
	it('counts Unicode code points and preserves case and Unicode spelling', () => {
		expect(isAuthGroupId('😀'.repeat(128))).toBe(true);
		expect(isAuthGroupId('😀'.repeat(129))).toBe(false);
		expect(normalizeAuthGroups(['é', 'e\u0301', 'Team', 'team'])).toEqual({
			ok: true,
			groups: ['Team', 'e\u0301', 'team', 'é'],
		});
	});

	it.each(['\u0000', '\u001f', '\u007f', '\u009f', '\u00a0', '\u2003', '\ufeff'])(
		'rejects control or whitespace characters at either edge: %j',
		(character) => {
			expect(isAuthGroupId(`${character}team`)).toBe(false);
			expect(isAuthGroupId(`team${character}`)).toBe(false);
		},
	);

	it('rejects sparse arrays and invalid entries even when the count also exceeds the cap', () => {
		const sparse: unknown[] = [];
		sparse.length = 2;
		expect(normalizeAuthGroups(sparse)).toEqual({ ok: false, problem: 'invalid_group' });
		expect(
			normalizeAuthGroups([...Array.from({ length: 33 }, (_, i) => `team-${i}`), null]),
		).toEqual({
			ok: false,
			problem: 'invalid_group',
		});
	});

	it('deduplicates before measuring bytes and does not mutate or retain the input array', () => {
		const input = Object.freeze(Array(32).fill('x'.repeat(128)) as string[]);
		expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(1280);
		expect(normalizeAuthGroups(input)).toEqual({ ok: true, groups: ['x'.repeat(128)] });
		const mutable = ['z', 'a', 'z'];
		const result = normalizeAuthGroups(mutable);
		expect(mutable).toEqual(['z', 'a', 'z']);
		mutable[0] = 'injected';
		expect(result).toEqual({ ok: true, groups: ['a', 'z'] });
	});
});
