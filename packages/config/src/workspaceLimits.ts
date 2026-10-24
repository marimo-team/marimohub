import { WORKSPACE_FILE_BYTES_CEILING, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import type { WorkspaceLimits } from '@marimo-hub/core/remote-workspace';
import { parseIntEnv } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

export function parseWorkspaceLimits(env: Env): WorkspaceLimits {
	const positive = (key: string, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
		const value = parseIntEnv(env, key) ?? fallback;
		if (!Number.isSafeInteger(value) || value < 1 || value > max) {
			throw new ConfigError(`${key} must be an integer between 1 and ${max}`, { variable: key });
		}
		return value;
	};
	return {
		maxFileBytes: positive(
			'MARIMOHUB_WORKSPACE_MAX_FILE_BYTES',
			WORKSPACE_LIMITS.maxFileBytes,
			WORKSPACE_FILE_BYTES_CEILING,
		),
		maxTotalBytes: positive('MARIMOHUB_WORKSPACE_MAX_BYTES', WORKSPACE_LIMITS.maxTotalBytes),
		maxFiles: positive('MARIMOHUB_WORKSPACE_MAX_FILES', WORKSPACE_LIMITS.maxFiles),
	};
}
