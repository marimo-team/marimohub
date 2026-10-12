import { BadRequestError, ForbiddenError } from '@marimo-hub/core';
import type { SandboxConfig } from './context';

/**
 * Validates a stored profile choice and returns the value to persist; `null` clears it.
 * Edit mode, and app mode with a separate app list: `default` and the list's first name
 * both clear, so notebooks follow the operator's list order.
 * App mode with a shared list: `default` clears, which means "inherit the editing
 * profile"; the first name is stored, because it then overrides that inheritance.
 */
export function checkComputeProfile(
	sandbox: SandboxConfig,
	value: string | null | undefined,
	mode?: 'edit' | 'app',
): string | null | undefined {
	if (value === undefined) return value;
	const profiles =
		(mode === 'app' ? sandbox.appComputeProfiles : undefined) ?? sandbox.computeProfiles ?? [];
	if (sandbox.computeProfileOverride !== 'editors') {
		throw new ForbiddenError('This deployment does not allow compute profile selection');
	}
	if (value === null) return value;
	const known = profiles.some((profile) => profile.name === value);
	const sharedAppList = mode === 'app' && sandbox.appComputeProfiles === undefined;
	// A configured profile named `default` takes precedence over the clear sentinel.
	if ((!sharedAppList && value === profiles[0]?.name) || (value === 'default' && !known))
		return null;
	if (!known) {
		throw new BadRequestError(
			profiles.length > 0
				? `Unknown compute profile "${value}"; valid options: default, ${profiles.map((profile) => profile.name).join(', ')}`
				: 'This deployment does not offer compute profile selection',
		);
	}
	return value;
}
