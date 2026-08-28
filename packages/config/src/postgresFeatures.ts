import type { IntegrationQueryGate, QueryReadinessCheck } from '@marimo-hub/core';
import { parseOnOff } from './env';
import type { Env } from './env';

export interface PostgresDataAccessFeatures {
	enabled: boolean;
	allowInsecureTransport: boolean;
}

export function postgresDataAccessFeatures(env: Env): PostgresDataAccessFeatures {
	return {
		enabled: parseOnOff(env, 'MARIMOHUB_POSTGRES_DATA_ACCESS', {
			fallback: false,
			docs: 'docs/integrations.md',
		}),
		allowInsecureTransport: parseOnOff(env, 'MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT', {
			fallback: false,
			docs: 'docs/integrations.md',
		}),
	};
}

export function postgresDataAccessGate(
	features: Readonly<PostgresDataAccessFeatures>,
): IntegrationQueryGate {
	const transportGate = postgresTransportGate(features);
	return (input) => {
		const { kind } = input;
		if (kind !== 'postgres') return;
		if (!features.enabled) {
			return blocked(
				'postgres-data-access',
				'Enable PostgreSQL data access',
				'MARIMOHUB_POSTGRES_DATA_ACCESS is not on',
			);
		}
		return transportGate(input);
	};
}

export function postgresTransportGate(
	features: Pick<PostgresDataAccessFeatures, 'allowInsecureTransport'>,
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

function blocked(id: string, label: string, reason: string, field = ''): QueryReadinessCheck {
	return { id, label, ready: false, field, reason };
}
