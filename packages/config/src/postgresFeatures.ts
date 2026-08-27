import type { IntegrationQueryGate, QueryReadinessCheck } from '@marimo-hub/core';
import type { Env } from './env';
import { ConfigError } from './errors';

export interface PostgresDataAccessFeatures {
	allowInsecureTransport: boolean;
}

export function postgresDataAccessFeatures(env: Env): PostgresDataAccessFeatures {
	// Security decision, not a rollout gate: stays off by default.
	return {
		allowInsecureTransport: featureSwitch(env, 'MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT'),
	};
}

export function postgresDataAccessGate(
	features: Readonly<PostgresDataAccessFeatures>,
): IntegrationQueryGate {
	return ({ kind, config }) => {
		if (kind !== 'postgres') return;
		const mode = (config as { ssl?: { mode?: unknown } } | null)?.ssl?.mode;
		if (
			(mode === 'disable' || mode === 'prefer' || mode === 'require') &&
			!features.allowInsecureTransport
		) {
			return blocked(
				'postgres-insecure-transport',
				'Allow the selected PostgreSQL transport mode',
				'MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT is not on',
				'ssl.mode',
			);
		}
		return;
	};
}

function featureSwitch(env: Env, key: string): boolean {
	const value = env[key]?.trim().toLowerCase();
	if (value === undefined || value === '' || value === 'off') return false;
	if (value === 'on') return true;
	throw new ConfigError(`Unknown ${key}: ${env[key]} (supported: on, off).`, {
		variable: key,
		docs: 'docs/integrations.md',
	});
}

function blocked(id: string, label: string, reason: string, field = ''): QueryReadinessCheck {
	return { id, label, ready: false, field, reason };
}
