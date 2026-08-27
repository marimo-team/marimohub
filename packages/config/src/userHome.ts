import type { EditorSandboxSharing } from '@marimo-hub/core';
import type { SandboxUserHomeResolver } from '@marimo-hub/api';
import type { Env } from './env';
import { ConfigError } from './errors';

export const COREWEAVE_USER_HOME_PROFILE = 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_PROFILE';

/**
 * Personal homes rode CoreWeave per-create profile selection, which Sandbox v1
 * (`@coreweave/cwsandbox` ≥0.2.0-beta.0) removed from the SDK. Until CoreWeave
 * exposes an equivalent (per-runner default profiles + `runnerIds` is the
 * closest v1 mechanism), the feature is unavailable — reject the variable at
 * boot instead of provisioning editors without their personal storage.
 */
export function makeSandboxUserHome(
	env: Env,
	_sharing: EditorSandboxSharing,
): SandboxUserHomeResolver | undefined {
	if (env[COREWEAVE_USER_HOME_PROFILE] !== undefined) {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_PROFILE} is no longer supported: CoreWeave Sandbox v1 removed per-create profile selection, so personal storage is unavailable`,
			{
				variable: COREWEAVE_USER_HOME_PROFILE,
				remediation: 'Remove the variable (editor sandboxes run without a personal home).',
				docs: 'docs/setup/compute/coreweave.md',
			},
		);
	}
	return undefined;
}
