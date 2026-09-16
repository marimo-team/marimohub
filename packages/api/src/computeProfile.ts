import { BadRequestError, ForbiddenError } from '@marimo-hub/core';
import type { SandboxConfig } from './context';

export function checkComputeProfile(
	sandbox: SandboxConfig,
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined) return value;
	const profiles = sandbox.computeProfiles ?? [];
	if (sandbox.computeProfileOverride !== 'editors') {
		throw new ForbiddenError('This deployment does not allow compute profile selection');
	}
	if (value === null) return value;
	const known = profiles.some((profile) => profile.name === value);
	// A configured profile named `default` takes precedence over the clear sentinel.
	if (value === profiles[0]?.name || (value === 'default' && !known)) return null;
	if (!known) {
		throw new BadRequestError(
			profiles.length > 0
				? `Unknown compute profile "${value}"; valid options: default, ${profiles.map((profile) => profile.name).join(', ')}`
				: 'This deployment does not offer compute profile selection',
		);
	}
	return value;
}
