import { BadRequestError } from '@marimo-hub/core';
import type { EditorSandboxSharing } from '@marimo-hub/core';
import type { SandboxUserHomeResolver } from '@marimo-hub/api';
import { computeBackend } from './compute';
import { parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

export const COREWEAVE_USER_HOME_RUNNERS = 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_RUNNER_IDS';
/** Pre-Sandbox-v1 selector; rejected with a pointer at the runner-based replacement. */
export const COREWEAVE_USER_HOME_PROFILE = 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_PROFILE';

function canonicalEmail(email: string): string {
	const value = email.trim().toLowerCase();
	let unsafe = false;
	for (let i = 0; i < value.length; i++) {
		const codepoint = value.charCodeAt(i);
		if (value[i] === '/' || codepoint < 32 || codepoint === 127) unsafe = true;
	}
	if (!value || value === '.' || value === '..' || value.length > 240 || unsafe) {
		throw new BadRequestError(
			'Your authenticated email cannot be used for personal storage; contact an administrator to correct the identity-provider email claim',
		);
	}
	return value;
}

/**
 * Personal homes are composed behind a resolver so a future identity mapping can
 * replace email without changing session provisioning or compute adapters.
 *
 * CoreWeave Sandbox v1 removed per-create profile selection, so the feature now
 * rides a dedicated runner: editor sandboxes are pinned to the runner(s) named
 * here, whose default policy mounts the per-user PVC.
 */
export function makeSandboxUserHome(
	env: Env,
	sharing: EditorSandboxSharing,
): SandboxUserHomeResolver | undefined {
	if (env[COREWEAVE_USER_HOME_PROFILE] !== undefined) {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_PROFILE} is no longer supported: CoreWeave Sandbox v1 removed per-create profile selection`,
			{
				variable: COREWEAVE_USER_HOME_PROFILE,
				remediation: `Give a dedicated runner a default policy with the user-home mounts and set ${COREWEAVE_USER_HOME_RUNNERS} to that runner's id.`,
				docs: 'docs/deploying/cks.md',
			},
		);
	}
	const runners = parseList(env[COREWEAVE_USER_HOME_RUNNERS]);
	if (!runners) return undefined;
	if (computeBackend(env) !== 'coreweave') {
		throw new ConfigError(`${COREWEAVE_USER_HOME_RUNNERS} requires the coreweave backend`, {
			variable: COREWEAVE_USER_HOME_RUNNERS,
			remediation: 'Set MARIMOHUB_COMPUTE_BACKEND=coreweave or remove the user-home runners.',
			docs: 'docs/deploying/cks.md',
		});
	}
	if (sharing !== 'exclusive') {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_RUNNERS} requires MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive`,
			{
				variable: 'MARIMOHUB_EDITOR_SANDBOX_SHARING',
				remediation: 'Set MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive.',
				docs: 'docs/editor-sessions.md',
			},
		);
	}
	const normalRunners = parseList(env.MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_IDS) ?? [];
	const overlap = runners.filter((runner) => normalRunners.includes(runner));
	if (overlap.length > 0) {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_RUNNERS} must not overlap MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_IDS: ${overlap.join(', ')}`,
			{
				variable: COREWEAVE_USER_HOME_RUNNERS,
				remediation:
					'Use a dedicated runner for editor personal storage; apps and viewer sandboxes must not schedule on it.',
				docs: 'docs/deploying/cks.md',
			},
		);
	}
	return {
		resolve(user) {
			const email = canonicalEmail(user.email);
			return { key: email, path: `/mnt/${email}` };
		},
	};
}
