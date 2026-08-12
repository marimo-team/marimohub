import { defaultRegistry, OrgIntegrationsStore, ProjectIntegrationsStore } from '@marimo-hub/core';
import type { Bucket, DataPreview, IntegrationProbe, Metrics } from '@marimo-hub/core';
import type { ApiDeps } from '@marimo-hub/api';
import type { Env } from './env';
import { ConfigError } from './errors';
import { createGuardedProbe } from './integrationProbe';
import { makeSecretSources } from './secrets';

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
	sandboxPreview?: DataPreview,
): Pick<ApiDeps, 'integrations' | 'orgIntegrations' | 'dataBrowser'> {
	const setting = env.MARIMOHUB_INTEGRATIONS?.trim().toLowerCase();
	const dataBrowser = dataBrowserSetting(env);
	if (setting === undefined || setting === '' || setting === 'off' || setting === 'none') {
		if (dataBrowser !== 'off') {
			throw new ConfigError('MARIMOHUB_DATA_BROWSER requires MARIMOHUB_INTEGRATIONS=on.', {
				variable: 'MARIMOHUB_DATA_BROWSER',
				docs: 'docs/integrations.md',
			});
		}
		return {};
	}
	if (setting !== 'on' && setting !== 'true') {
		throw new ConfigError(
			`Unknown MARIMOHUB_INTEGRATIONS: ${env.MARIMOHUB_INTEGRATIONS} (supported: on, off).`,
			{ variable: 'MARIMOHUB_INTEGRATIONS', docs: 'docs/integrations.md' },
		);
	}
	const secretSources = makeSecretSources(env);
	// Parsed once so both probes interpret the same validated policy — neither
	// depends on the other having rejected an invalid value first.
	const policy = probePolicy(env);
	const options = {
		bucket,
		registry: defaultRegistry(),
		codec: secretSources.codec,
		resolvers: secretSources.resolvers,
		probe: makeProbe(policy),
		browseProbe: makeBrowseProbe(policy, dataBrowser),
		metrics,
	};
	return {
		integrations: new ProjectIntegrationsStore(options),
		// Org-wide instances are managed by super admins (MARIMOHUB_SUPER_ADMINS);
		// with none configured the routes are unreachable and the tier stays empty.
		orgIntegrations: new OrgIntegrationsStore(options),
		...(dataBrowser === 'off'
			? {}
			: {
					dataBrowser: {
						preview: dataBrowser === 'full',
						...(dataBrowser === 'full' && sandboxPreview ? { sandboxPreview } : {}),
					},
				}),
	};
}

function dataBrowserSetting(env: Env): 'off' | 'metadata' | 'full' {
	const setting = env.MARIMOHUB_DATA_BROWSER?.trim().toLowerCase();
	switch (setting) {
		case undefined:
		case '':
		case 'off':
			return 'off';
		case 'metadata':
		case 'full':
			return setting;
		default:
			throw new ConfigError(
				`Unknown MARIMOHUB_DATA_BROWSER: ${env.MARIMOHUB_DATA_BROWSER} (supported: off, metadata, full).`,
				{ variable: 'MARIMOHUB_DATA_BROWSER', docs: 'docs/integrations.md' },
			);
	}
}

/**
 * Browse traffic gets its own probe instance: a tree expansion spends several
 * calls, so sharing the test probe's 30/min budget would let browsing starve
 * connection tests (and vice versa). Catalog pages are also larger than probe
 * responses, hence the 1 MiB cap; kinds always request upstream pagination.
 *
 * The 360/min cap pairs with the API's 20 ops/min/user budget: Trino bounds one
 * statement at 12 requests, so one editor can spend at most 240 of the shared
 * allowance. Other kinds use fewer requests per operation.
 */
function makeBrowseProbe(
	policy: ProbePolicy,
	dataBrowser: 'off' | 'metadata' | 'full',
): IntegrationProbe | undefined {
	if (dataBrowser === 'off') return undefined;
	if (policy === 'off') {
		throw new ConfigError(
			'MARIMOHUB_DATA_BROWSER requires a probe: set MARIMOHUB_INTEGRATIONS_PROBE to guarded or private.',
			{ variable: 'MARIMOHUB_DATA_BROWSER', docs: 'docs/integrations.md' },
		);
	}
	return createGuardedProbe({
		allowPrivate: policy === 'private',
		maxResponseBytes: 1024 * 1024,
		maxProbesPerMinute: 360,
	});
}

type ProbePolicy = 'guarded' | 'private' | 'off';

function probePolicy(env: Env): ProbePolicy {
	const setting = env.MARIMOHUB_INTEGRATIONS_PROBE?.trim().toLowerCase();
	switch (setting) {
		case undefined:
		case '':
		case 'guarded':
			return 'guarded';
		case 'private':
		case 'off':
			return setting;
		default:
			throw new ConfigError(
				`Unknown MARIMOHUB_INTEGRATIONS_PROBE: ${env.MARIMOHUB_INTEGRATIONS_PROBE} ` +
					'(supported: guarded, private, off).',
				{ variable: 'MARIMOHUB_INTEGRATIONS_PROBE', docs: 'docs/integrations.md' },
			);
	}
}

function makeProbe(policy: ProbePolicy): IntegrationProbe | undefined {
	if (policy === 'off') return undefined;
	return createGuardedProbe({ allowPrivate: policy === 'private' });
}
