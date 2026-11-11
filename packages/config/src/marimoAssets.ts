import { normalizeBaseUrl, parseHttpUrl, parseAssetBaseUrl } from '@marimo-hub/core/url';
import { ConfigError } from './errors';
import { readFolded } from './env';
import type { Env } from './env';

export function resolveMarimoAssetUrl(env: Env): string | undefined {
	const key = 'MARIMOHUB_COMPUTE_ASSET_URL';
	const folded = readFolded(env, key);
	if (!folded || folded === 'false') return undefined;
	const value = env[key]!.trim();
	if (folded !== 'hub') {
		if (!parseAssetBaseUrl(value)) {
			throw new ConfigError(
				'Invalid MARIMOHUB_COMPUTE_ASSET_URL: expected a credential-free HTTPS URL without a query or fragment',
				{ variable: key },
			);
		}
		return value;
	}
	const base = parseHttpUrl(env.MARIMOHUB_APP_BASE_URL ?? '');
	if (!base.ok || base.url.search || base.url.hash) {
		throw new ConfigError(
			'Hub assets require a credential-free MARIMOHUB_APP_BASE_URL without a query or fragment',
			{
				variable: 'MARIMOHUB_APP_BASE_URL',
				remediation: 'Set the public HTTP(S) hub URL, including its deployment prefix.',
			},
		);
	}
	return `${normalizeBaseUrl(base.url)}/_marimo/{version}`;
}
