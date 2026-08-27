import { BadRequestError } from '@marimo-hub/core';
import type { EditorSandboxSharing } from '@marimo-hub/core';
import type { SandboxUserHomeResolver } from '@marimo-hub/api';
import { computeBackend } from './compute';
import type { Env } from './env';
import { ConfigError } from './errors';

export const COREWEAVE_USER_HOME_TEMPLATE = 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_TEMPLATE_ID';
/** Pre-Sandbox-v1 selector; rejected with a pointer at the template-based replacement. */
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
 * CoreWeave Sandbox v1 replaced per-create profile selection with org-scoped
 * sandbox templates: editor sandboxes are created from the template named
 * here, which mounts the per-user volume.
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
				remediation: `Create a sandbox template with the user-home mounts and set ${COREWEAVE_USER_HOME_TEMPLATE} to its id.`,
				docs: 'docs/deploying/cks.md',
			},
		);
	}
	const template = env[COREWEAVE_USER_HOME_TEMPLATE]?.trim();
	if (!template) return undefined;
	if (computeBackend(env) !== 'coreweave') {
		throw new ConfigError(`${COREWEAVE_USER_HOME_TEMPLATE} requires the coreweave backend`, {
			variable: COREWEAVE_USER_HOME_TEMPLATE,
			remediation: 'Set MARIMOHUB_COMPUTE_BACKEND=coreweave or remove the user-home template.',
			docs: 'docs/deploying/cks.md',
		});
	}
	if (sharing !== 'exclusive') {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_TEMPLATE} requires MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive`,
			{
				variable: 'MARIMOHUB_EDITOR_SANDBOX_SHARING',
				remediation: 'Set MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive.',
				docs: 'docs/editor-sessions.md',
			},
		);
	}
	if (template === env.MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID?.trim()) {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_TEMPLATE} must differ from MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID: ${template}`,
			{
				variable: COREWEAVE_USER_HOME_TEMPLATE,
				remediation:
					'Use a dedicated template for editor personal storage; apps and viewer sandboxes must not receive the mount.',
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
