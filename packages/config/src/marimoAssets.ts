import { normalizeBaseUrl, parseHttpUrl } from '@marimo-hub/core/url';
import { ConfigError } from './errors';
import type { Env } from './env';

export function resolveMarimoAssetUrl(env: Env): string | undefined {
	const value = env.MARIMOHUB_COMPUTE_ASSET_URL?.trim();
	if (!value) return undefined;
	if (value !== 'hub') return value;
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
