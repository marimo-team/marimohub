import type { EditorSandboxSharing } from '@marimo-hub/core';
import type { SandboxUserHomeResolver } from '@marimo-hub/api';
import { parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

export const COREWEAVE_USER_HOME_PROFILE = 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_PROFILE';

function canonicalEmail(email: string): string {
	const value = email.trim().toLowerCase();
	let unsafe = false;
	for (let i = 0; i < value.length; i++) {
		const codepoint = value.charCodeAt(i);
		if (value[i] === '/' || codepoint < 32 || codepoint === 127) unsafe = true;
	}
	if (!value || value === '.' || value === '..' || value.length > 240 || unsafe) {
		throw new Error('Authenticated email cannot be used as a sandbox home directory');
	}
	return value;
}

/**
 * Personal homes are composed behind a resolver so a future identity mapping can
 * replace email without changing session provisioning or compute adapters.
 */
export function makeSandboxUserHome(
	env: Env,
	sharing: EditorSandboxSharing,
): SandboxUserHomeResolver | undefined {
	const profiles = parseList(env[COREWEAVE_USER_HOME_PROFILE]);
	if (!profiles) return undefined;
	if (env.MARIMOHUB_COMPUTE_BACKEND !== 'coreweave') {
		throw new ConfigError(`${COREWEAVE_USER_HOME_PROFILE} requires the coreweave backend`, {
			variable: COREWEAVE_USER_HOME_PROFILE,
			remediation: 'Set MARIMOHUB_COMPUTE_BACKEND=coreweave or remove the user-home profile.',
			docs: 'docs/deploying/cks.md',
		});
	}
	if (sharing !== 'exclusive') {
		throw new ConfigError(
			`${COREWEAVE_USER_HOME_PROFILE} requires MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive`,
			{
				variable: 'MARIMOHUB_EDITOR_SANDBOX_SHARING',
				remediation: 'Set MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive.',
				docs: 'docs/editor-sessions.md',
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
