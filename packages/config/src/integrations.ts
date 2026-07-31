import { defaultRegistry, ProjectIntegrationsStore } from '@marimo-hub/core';
import type { Bucket, IntegrationProbe, Metrics } from '@marimo-hub/core';
import type { ApiDeps } from '@marimo-hub/api';
import type { Env } from './env';
import { ConfigError } from './errors';
import { createGuardedProbe } from './integrationProbe';
import { makeManagedCodec } from './secrets';

/**
 * Wires the bucket-backed integration provider when explicitly enabled. Opt-in
 * for now, per the two-phase rollout policy (development_docs/migrations.md):
 * this release ships the tolerant session reader (loose SessionSchema); turning
 * the writer on before every replica preserves unknown session fields would let
 * an old replica's heartbeat strip the audit pin. Flip the default once the
 * reader has rolled out everywhere.
 */
export function makeIntegrations(
	env: Env,
	bucket: Bucket,
	metrics?: Metrics,
): Pick<ApiDeps, 'integrations'> {
	const setting = env.MARIMOHUB_INTEGRATIONS?.trim().toLowerCase();
	if (setting === undefined || setting === '' || setting === 'off' || setting === 'none') {
		return {};
	}
	if (setting !== 'on' && setting !== 'true') {
		throw new ConfigError(
			`Unknown MARIMOHUB_INTEGRATIONS: ${env.MARIMOHUB_INTEGRATIONS} (supported: on, off).`,
			{ variable: 'MARIMOHUB_INTEGRATIONS', docs: 'docs/integrations.md' },
		);
	}
	return {
		integrations: new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec: makeManagedCodec(env),
			probe: makeProbe(env),
			metrics,
		}),
	};
}

function makeProbe(env: Env): IntegrationProbe | undefined {
	const setting = env.MARIMOHUB_INTEGRATIONS_PROBE?.trim().toLowerCase();
	switch (setting) {
		case undefined:
		case '':
		case 'guarded':
			return createGuardedProbe();
		case 'private':
			return createGuardedProbe({ allowPrivate: true });
		case 'off':
			return undefined;
		default:
			throw new ConfigError(
				`Unknown MARIMOHUB_INTEGRATIONS_PROBE: ${env.MARIMOHUB_INTEGRATIONS_PROBE} ` +
					'(supported: guarded, private, off).',
				{ variable: 'MARIMOHUB_INTEGRATIONS_PROBE', docs: 'docs/integrations.md' },
			);
	}
}
