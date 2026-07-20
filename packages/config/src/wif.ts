import { WorkloadIdentityIssuer } from '@marimo-hub/core';
import type { CredentialBroker, FederationTarget } from '@marimo-hub/core';
import { AwsStsWifBroker } from '@marimo-hub/credentials-aws';
import { CoreWeaveWifBroker } from '@marimo-hub/credentials-coreweave';
import type { ApiDeps } from '@marimo-hub/api';
import { usesSandboxNativeObjectStorage } from './compute';
import { required } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

/**
 * Build the credential broker named by `MARIMOHUB_WIF_BROKER` (required — no
 * default, so the federated cloud is always explicit).
 */
function makeWifBroker(env: Env): CredentialBroker {
	const broker = required(env, 'MARIMOHUB_WIF_BROKER');
	switch (broker) {
		case 'coreweave':
			return new CoreWeaveWifBroker({
				exchangeUrl: required(env, 'MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL'),
			});
		case 'aws':
			return new AwsStsWifBroker({
				roleArn: required(env, 'MARIMOHUB_WIF_AWS_ROLE_ARN'),
				stsUrl: env.MARIMOHUB_WIF_AWS_STS_URL,
			});
		default:
			throw new ConfigError(
				`Unknown MARIMOHUB_WIF_BROKER: ${broker} (supported: coreweave, aws). ` +
					'Add an adapter implementing @marimo-hub/core CredentialBroker to support more.',
				{ variable: 'MARIMOHUB_WIF_BROKER', docs: 'docs/configuration.md' },
			);
	}
}

/**
 * Wire the hub-as-OIDC-issuer + its federation target. All-or-nothing: set the
 * required vars to enable, or none to disable (a half-config throws). The broker
 * is selected by `MARIMOHUB_WIF_BROKER`; a project opts in per `federation`.
 */
export function makeWif(env: Env): Pick<ApiDeps, 'wif'> {
	const requiredKeys = [
		'MARIMOHUB_WIF_SIGNING_KEY',
		'MARIMOHUB_WIF_KID',
		'MARIMOHUB_WIF_ISSUER_URL',
		'MARIMOHUB_WIF_AUDIENCE',
		'MARIMOHUB_WIF_BROKER',
	] as const;
	if (!requiredKeys.some((k) => env[k])) return {}; // WIF disabled.

	// Sandbox-native CAIOS auth wins over hub-minted WIF: the hub's static
	// `AWS_ACCESS_KEY_ID` env would shadow the sidecar's auto-refreshing creds in
	// the AWS credential chain, so injecting both silently breaks refresh.
	if (usesSandboxNativeObjectStorage(env)) {
		console.warn(
			JSON.stringify({
				ts: new Date().toISOString(),
				event: 'wif_disabled_sandbox_native_storage',
				message:
					'MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS is set; hub-minted WIF is disabled ' +
					'so its static AWS_* env cannot shadow the sandbox credential-vending sidecar. ' +
					'Unset the WIF env vars (or the bucket list) to silence this warning.',
			}),
		);
		return {};
	}

	const missing = requiredKeys.filter((k) => !env[k]);
	if (missing.length > 0) {
		throw new ConfigError(
			`Workload Identity Federation is partially configured; missing: ${missing.join(', ')}.`,
			{
				variable: missing[0],
				remediation: 'Set all of the WIF vars to enable WIF, or none to disable it.',
				docs: 'docs/workload-identity-federation.md',
			},
		);
	}

	let signingKey = required(env, 'MARIMOHUB_WIF_SIGNING_KEY');
	// Accept a base64-encoded PEM (single line) in addition to a raw PEM, for secret
	// stores that transit config as an env-file and can't carry the PEM's newlines
	// (e.g. Doppler → k8s Secret via `--from-env-file`). Decode it back to PEM.
	if (!signingKey.includes('PRIVATE KEY')) {
		try {
			signingKey = atob(signingKey.trim());
		} catch {
			// fall through to the format error below
		}
	}
	if (!signingKey.includes('PRIVATE KEY')) {
		throw new ConfigError(
			'MARIMOHUB_WIF_SIGNING_KEY must be an RSA private key in PKCS8 PEM format ' +
				'(-----BEGIN PRIVATE KEY-----), or its single-line base64 encoding.',
			{ variable: 'MARIMOHUB_WIF_SIGNING_KEY', docs: 'docs/workload-identity-federation.md' },
		);
	}
	// The federated bucket's S3 store — explicit, NO fallback to the deployment's
	// storage endpoint/region (which may differ). Both optional: set `endpoint` for
	// a non-AWS store (e.g. CoreWeave `cwobject.com`), omit for AWS S3.
	const target: FederationTarget = {
		broker: makeWifBroker(env),
		audience: required(env, 'MARIMOHUB_WIF_AUDIENCE'),
		storage: {
			endpoint: env.MARIMOHUB_WIF_STORAGE_ENDPOINT,
			region: env.MARIMOHUB_WIF_STORAGE_REGION,
		},
	};

	return {
		wif: {
			issuer: new WorkloadIdentityIssuer(signingKey, required(env, 'MARIMOHUB_WIF_KID')),
			// Strip any trailing slash so the token `iss` and the derived `jwks_uri`
			// are canonical (`<url>/.well-known/...`, never `<url>//.well-known/...`).
			issuerUrl: required(env, 'MARIMOHUB_WIF_ISSUER_URL').replace(/\/+$/, ''),
			target,
		},
	};
}
