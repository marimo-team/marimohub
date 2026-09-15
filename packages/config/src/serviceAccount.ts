import { ServiceAccountsConfigSchema, ServiceAccountCredentials } from '@marimo-hub/core';
import type { Env } from './env';
import { ConfigError } from './errors';

const VARIABLE = 'MARIMOHUB_SERVICE_ACCOUNTS';
const MAX_CONFIG_BYTES = 65536;

function invalidConfiguration(detail: string): ConfigError {
	return new ConfigError(`Invalid ${VARIABLE}: ${detail}`, {
		variable: VARIABLE,
		remediation:
			'Use a JSON array of accounts with unique IDs, explicit actions, and credential hashes. See the service accounts guide for an example.',
		docs: 'docs/service-accounts.md',
	});
}

export function parseServiceAccountsConfig(raw: string) {
	if (new TextEncoder().encode(raw).byteLength > MAX_CONFIG_BYTES)
		throw invalidConfiguration('configuration exceeds 64 KiB');
	let input: unknown;
	try {
		input = JSON.parse(raw);
	} catch {
		// JSON parser errors can contain the input, including accidentally pasted secrets.
		throw invalidConfiguration('expected valid JSON; use [] to disable service accounts');
	}
	const result = ServiceAccountsConfigSchema.safeParse(input);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join('.') : 'accounts';
		const message =
			issue.code === 'unrecognized_keys'
				? 'unknown fields; check the documented schema'
				: issue.message;
		throw invalidConfiguration(`${path}: ${message}`);
	}
	return result.data;
}

export function serviceAccountsFromEnv(env: Env): ServiceAccountCredentials | undefined {
	const raw = env[VARIABLE];
	if (raw === undefined) return undefined;
	const accounts = parseServiceAccountsConfig(raw);
	return accounts.length === 0 ? undefined : new ServiceAccountCredentials(accounts);
}
