import { DEFAULT_APP_POOL_POLICY } from '@marimo-hub/core';
import type { AppPoolPolicy } from '@marimo-hub/core';
import { parseIntEnv } from './env';
import { ConfigError } from './errors';
import { parseSessionIdleTimeouts } from './sessionDefaults';

type AppPoolEnv = Partial<
	Record<
		| 'MARIMOHUB_APP_MAX_USERS_PER_SESSION'
		| 'MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION'
		| 'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS'
		| 'MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS',
		string
	>
>;

export function parseAppPoolPolicy(env: AppPoolEnv): AppPoolPolicy {
	const cap = (key: string) => {
		const value = parseIntEnv(env, key);
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
			throw new ConfigError(`${key} must be a positive integer`, { variable: key });
		}
		return value;
	};
	return {
		...DEFAULT_APP_POOL_POLICY,
		maxUsersPerSession: cap('MARIMOHUB_APP_MAX_USERS_PER_SESSION'),
		maxSessionsPerVersion: cap('MARIMOHUB_APP_MAX_SESSIONS_PER_VERSION'),
		idleMs: parseSessionIdleTimeouts(env).app,
	};
}
