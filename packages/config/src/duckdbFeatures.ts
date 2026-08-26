import type { DuckDBHttpAccess, IntegrationQueryGate } from '@marimo-hub/core';
import { parseEnumOr } from './env';
import type { Env } from './env';

export interface DuckDBRolloutFeatures {
	oauth: boolean;
	objectQueries: boolean;
}

export function duckDBRolloutFeatures(env: Env): DuckDBRolloutFeatures {
	return {
		oauth: rolloutFlag(env, 'MARIMOHUB_DUCKDB_OAUTH'),
		objectQueries: rolloutFlag(env, 'MARIMOHUB_DUCKDB_OBJECT_QUERIES'),
	};
}

export function duckDBHttpAccessBlocker(
	access: Readonly<DuckDBHttpAccess>,
	features: Readonly<DuckDBRolloutFeatures>,
): string | undefined {
	if (access.kind === 's3-object-store' && !features.objectQueries) {
		return 'DuckDB S3 object queries are disabled. Ask a deployment administrator to set MARIMOHUB_DUCKDB_OBJECT_QUERIES=on.';
	}
	if (access.kind === 'iceberg-rest' && access.catalog.oauth2 && !features.oauth) {
		return 'DuckDB OAuth2 catalog access is disabled. Ask a deployment administrator to set MARIMOHUB_DUCKDB_OAUTH=on.';
	}
	return undefined;
}

export function duckDBQueryGate(features: Readonly<DuckDBRolloutFeatures>): IntegrationQueryGate {
	return ({ kind, config }) => {
		if (kind === 's3' && !features.objectQueries) {
			return {
				id: 'duckdb-object-queries',
				label: 'Enable DuckDB S3 object queries',
				ready: false,
				field: '',
				reason:
					'DuckDB S3 object queries are disabled on this deployment. Set MARIMOHUB_DUCKDB_OBJECT_QUERIES=on to enable them.',
			};
		}
		if (kind === 'iceberg_rest' && oauthMethod(config) && !features.oauth) {
			return {
				id: 'duckdb-oauth',
				label: 'Enable DuckDB OAuth2 catalog access',
				ready: false,
				field: '',
				reason:
					'DuckDB OAuth2 catalog access is disabled on this deployment. Set MARIMOHUB_DUCKDB_OAUTH=on to enable it.',
			};
		}
		return;
	};
}

function rolloutFlag(env: Env, key: string): boolean {
	return (
		parseEnumOr(env, key, ['on', 'off'] as const, 'off', {
			docs: 'docs/integrations.md',
		}) === 'on'
	);
}

function oauthMethod(config: unknown): boolean {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) return false;
	const auth = (config as Record<string, unknown>).auth;
	return (
		typeof auth === 'object' &&
		auth !== null &&
		!Array.isArray(auth) &&
		(auth as Record<string, unknown>).method === 'oauth2_client_credentials'
	);
}
