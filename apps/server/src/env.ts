import { isIP } from 'node:net';
import { z } from 'zod';
import { ConfigError } from '@marimo-hub/config';
import { parseHttpUrl } from '@marimo-hub/core';

export type ServerEnv = Record<string, string | undefined>;

const port = z
	.string()
	.refine(
		(value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535,
		'expected an integer from 1 to 65535',
	);

const appBaseUrl = z
	.string()
	.refine((value) => !value.trim() || parseHttpUrl(value).ok, 'expected an HTTP(S) URL');

const HOSTNAME =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

// Node's listen() takes a bare IPv6 address, so `[::1]` is rejected rather than failing at bind.
const bindHost = z
	.string()
	.refine(
		(value) => value === '' || isIP(value) !== 0 || HOSTNAME.test(value),
		'expected an IP address or hostname',
	);

export const ServerEnvSchema = z.looseObject({
	PORT: port.optional(),
	MARIMOHUB_BIND_HOST: bindHost.optional(),
	MARIMOHUB_APP_BASE_URL: appBaseUrl.optional(),
	MARIMOHUB_STATIC_ROOT: z
		.string()
		.refine((value) => value.trim().length > 0, 'expected a non-empty path')
		.optional(),
	MARIMOHUB_RUN_MAINTENANCE: z
		.string()
		.refine((value) => value === 'true' || value === 'false', 'expected true or false')
		.optional(),
});

export function validateServerEnv(env: ServerEnv): ServerEnv {
	const result = ServerEnvSchema.safeParse(env);
	if (result.success) return env;

	const issue = result.error.issues[0];
	const variable = String(issue?.path[0] ?? 'server environment');
	throw new ConfigError(`Invalid ${variable}: ${env[variable]} (${issue?.message})`, { variable });
}
