import { describe, expect, it } from 'vitest';
import { effectiveFederation, federationFor } from './federation';
import { makeTestWif } from './testing';

const overrides = [undefined, { enabled: true }, { enabled: false }] as const;

describe('effectiveFederation', () => {
	it.each(overrides)('is unavailable without WIF (override=%o)', (federation) => {
		expect(effectiveFederation({ federation }, undefined)).toEqual({
			enabled: false,
			source: 'unavailable',
		});
	});

	it.each([
		// default, override, enabled, source
		[false, undefined, false, 'deployment'],
		[false, { enabled: true }, true, 'project'],
		[false, { enabled: false }, false, 'project'],
		[true, undefined, true, 'deployment'],
		[true, { enabled: true }, true, 'project'],
		[true, { enabled: false }, false, 'project'],
	] as const)(
		'default=%s override=%o → enabled=%s source=%s',
		(defaultEnabled, federation, enabled, source) => {
			expect(effectiveFederation({ federation }, makeTestWif({ defaultEnabled }))).toEqual({
				enabled,
				source,
			});
		},
	);
});

describe('federationFor', () => {
	it.each(
		overrides.flatMap((federation) =>
			[false, true].map((restricted) => [federation, restricted] as const),
		),
	)('returns undefined without WIF (override=%o restricted=%s)', (federation, restricted) => {
		expect(federationFor({ federation }, undefined, { restricted })).toBeUndefined();
	});

	it.each([
		// default, override, restricted, federates
		[false, undefined, false, false],
		[false, { enabled: true }, false, true],
		[false, { enabled: false }, false, false],
		[true, undefined, false, true],
		[true, { enabled: true }, false, true],
		[true, { enabled: false }, false, false],
		[false, undefined, true, false],
		[false, { enabled: true }, true, false],
		[false, { enabled: false }, true, false],
		[true, undefined, true, false],
		[true, { enabled: true }, true, false],
		[true, { enabled: false }, true, false],
	] as const)(
		'default=%s override=%o restricted=%s → federates=%s',
		(defaultEnabled, federation, restricted, federates) => {
			const wif = makeTestWif({ defaultEnabled });
			expect(federationFor({ federation }, wif, { restricted })).toBe(federates ? wif : undefined);
		},
	);

	it('treats an omitted restricted option as unrestricted', () => {
		const wif = makeTestWif({ defaultEnabled: true });
		expect(federationFor({ federation: undefined }, wif)).toBe(wif);
	});
});
