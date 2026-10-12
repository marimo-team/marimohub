import { describe, expect, it } from 'vitest';
import { storedComputeProfile } from './resolveComputeProfile';

const appComputeProfiles = [{ name: 'app-small', resources: { cpu: 1 } }];

describe('storedComputeProfile', () => {
	it.each([
		['edit', {}, { compute_profile: 'large', app_compute_profile: 'app-small' }, 'large'],
		['edit', { appComputeProfiles }, { app_compute_profile: 'app-small' }, undefined],
		['app', {}, { compute_profile: 'large' }, 'large'],
		['app', {}, { compute_profile: 'large', app_compute_profile: 'small' }, 'small'],
		['app', { appComputeProfiles }, { compute_profile: 'large' }, undefined],
		[
			'app',
			{ appComputeProfiles },
			{ compute_profile: 'large', app_compute_profile: 'app-small' },
			'app-small',
		],
		['app', {}, {}, undefined],
	] as const)('%s with %o and %o selects %s', (mode, config, meta, expected) => {
		expect(storedComputeProfile(meta, config, mode)).toBe(expected);
	});
});
