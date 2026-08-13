import {
	defaultRegistry,
	Millis,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
} from '@marimo-hub/core';
import type { Bucket, DataPreviewService, IntegrationProbe, Metrics } from '@marimo-hub/core';
import type { ApiDeps } from '@marimo-hub/api';
import { DEFAULT_S3_OBJECT_BROWSER_LIMITS, S3ObjectBrowser } from '@marimo-hub/object-browser-s3';
import { parseBool, parseIntEnv, parseSecondsEnv } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import { createGuardedHostResolver, createGuardedProbe } from './integrationProbe';
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
	dataPreview?: DataPreviewService,
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
	const objectBrowsers =
		dataBrowser === 'off'
			? undefined
			: (() => {
					const deadlines = objectBrowserDeadlinesFromEnv(env, dataBrowser);
					const limits = objectBrowserLimitsFromEnv(env, dataBrowser);
					return {
						s3: new S3ObjectBrowser({
							mode: dataBrowser,
							resolveHost: createGuardedHostResolver({
								allowPrivate: policy === 'private',
								timeoutMs: deadlines.resolveTimeoutMs,
							}),
							limits: {
								...limits,
								metadataTimeoutMs: deadlines.metadataTimeoutMs,
								previewTimeoutMs: deadlines.previewTimeoutMs,
							},
						}),
					};
				})();
	const options = {
		bucket,
		registry: defaultRegistry(),
		codec: secretSources.codec,
		resolvers: secretSources.resolvers,
		probe: makeProbe(policy),
		browseProbe: makeBrowseProbe(policy, dataBrowser),
		...(objectBrowsers ? { objectBrowsers } : {}),
		metrics,
		dataPreview,
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
						objectBrowser: objectBrowserApiConfigFromEnv(env, dataBrowser),
						...(dataBrowser === 'full' && dataPreview
							? {
									checkPreview: () => dataPreview.check(),
									close: () => dataPreview.close(),
								}
							: {}),
					},
				}),
	};
}

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 16;
const DEFAULT_MAX_CONCURRENT_DOWNLOADS_PER_USER = 2;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 3600;
const MAX_NODE_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

function positiveIntFromEnv(env: Env, key: string, dflt: number): number {
	const value = parseIntEnv(env, key) ?? dflt;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ConfigError(`Invalid ${key}: ${value} (expected a positive safe integer)`, {
			variable: key,
			docs: 'docs/integrations.md',
		});
	}
	return value;
}

function fullModePositiveIntFromEnv(
	env: Env,
	mode: 'metadata' | 'full',
	key: string,
	dflt: number,
): number {
	return mode === 'full' ? positiveIntFromEnv(env, key, dflt) : dflt;
}

function objectBrowserTimeoutFromEnv(env: Env, key: string, dfltMs: number) {
	return parseSecondsEnv(env, key, {
		dflt: dfltMs / 1000,
		max: MAX_NODE_TIMER_SECONDS,
	});
}

export function objectBrowserLimitsFromEnv(
	env: Env,
	mode: 'metadata' | 'full',
): Pick<
	typeof DEFAULT_S3_OBJECT_BROWSER_LIMITS,
	'previewMaxBytes' | 'inlineImageMaxBytes' | 'parquetMaxRangedBytes' | 'searchMaxKeys'
> {
	return {
		previewMaxBytes: fullModePositiveIntFromEnv(
			env,
			mode,
			'MARIMOHUB_OBJECT_BROWSER_PREVIEW_MAX_BYTES',
			DEFAULT_S3_OBJECT_BROWSER_LIMITS.previewMaxBytes,
		),
		inlineImageMaxBytes: fullModePositiveIntFromEnv(
			env,
			mode,
			'MARIMOHUB_OBJECT_BROWSER_INLINE_IMAGE_MAX_BYTES',
			DEFAULT_S3_OBJECT_BROWSER_LIMITS.inlineImageMaxBytes,
		),
		parquetMaxRangedBytes: fullModePositiveIntFromEnv(
			env,
			mode,
			'MARIMOHUB_OBJECT_BROWSER_PARQUET_MAX_RANGED_BYTES',
			DEFAULT_S3_OBJECT_BROWSER_LIMITS.parquetMaxRangedBytes,
		),
		searchMaxKeys: positiveIntFromEnv(
			env,
			'MARIMOHUB_OBJECT_BROWSER_SEARCH_MAX_KEYS',
			DEFAULT_S3_OBJECT_BROWSER_LIMITS.searchMaxKeys,
		),
	};
}

function objectBrowserApiConfigFromEnv(env: Env, mode: 'metadata' | 'full') {
	const maxConcurrentDownloads = fullModePositiveIntFromEnv(
		env,
		mode,
		'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS',
		DEFAULT_MAX_CONCURRENT_DOWNLOADS,
	);
	const maxConcurrentDownloadsPerUser = fullModePositiveIntFromEnv(
		env,
		mode,
		'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS_PER_USER',
		DEFAULT_MAX_CONCURRENT_DOWNLOADS_PER_USER,
	);
	if (maxConcurrentDownloadsPerUser > maxConcurrentDownloads) {
		throw new ConfigError(
			'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS_PER_USER cannot exceed ' +
				'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS.',
			{
				variable: 'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS_PER_USER',
				docs: 'docs/integrations.md',
			},
		);
	}
	return {
		allowServerAmbientCredentials: parseBool(
			env,
			'MARIMOHUB_OBJECT_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS',
		),
		maxConcurrentDownloads,
		maxConcurrentDownloadsPerUser,
		downloadTimeoutMs:
			mode === 'full'
				? objectBrowserTimeoutFromEnv(
						env,
						'MARIMOHUB_OBJECT_BROWSER_DOWNLOAD_TIMEOUT_SECONDS',
						Millis.seconds(DEFAULT_DOWNLOAD_TIMEOUT_SECONDS),
					)
				: Millis.seconds(DEFAULT_DOWNLOAD_TIMEOUT_SECONDS),
	};
}

export function objectBrowserDeadlinesFromEnv(
	env: Env,
	mode: 'metadata' | 'full',
): {
	metadataTimeoutMs: number;
	previewTimeoutMs: number;
	resolveTimeoutMs: number;
} {
	const metadataTimeoutMs = objectBrowserTimeoutFromEnv(
		env,
		'MARIMOHUB_OBJECT_BROWSER_METADATA_TIMEOUT_SECONDS',
		DEFAULT_S3_OBJECT_BROWSER_LIMITS.metadataTimeoutMs,
	);
	const previewTimeoutMs =
		mode === 'full'
			? objectBrowserTimeoutFromEnv(
					env,
					'MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS',
					DEFAULT_S3_OBJECT_BROWSER_LIMITS.previewTimeoutMs,
				)
			: DEFAULT_S3_OBJECT_BROWSER_LIMITS.previewTimeoutMs;
	return {
		metadataTimeoutMs,
		previewTimeoutMs,
		resolveTimeoutMs: Math.max(metadataTimeoutMs, previewTimeoutMs),
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
