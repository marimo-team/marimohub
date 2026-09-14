import { createRemoteJWKSet, jwtVerify } from 'jose';
import { bearerToken } from '@marimo-hub/core/bearer-token';
import { logEvent } from '@marimo-hub/core/logs';
import type { Authenticator } from '@marimo-hub/core/ports/auth';
import { createAdmissionPolicy } from './admission';
import type { OidcAdmissionConfig } from './admission';
import { createOidcDiscovery, oidcIssuerUrl } from './discovery';
import { principalFromVerifiedAccessToken } from './accessTokenClaims';
import type { AccessTokenRejection } from './accessTokenClaims';

const MAX_TOKEN_LENGTH = 32768;
const SIGNING_ALGORITHMS = [
	'RS256',
	'RS384',
	'RS512',
	'PS256',
	'PS384',
	'PS512',
	'ES256',
	'ES384',
	'ES512',
	'EdDSA',
];
const REQUIRED_CLAIMS = ['sub', 'email', 'client_id', 'iat', 'exp', 'scope'];

export interface OidcAccessTokenConfig extends OidcAdmissionConfig {
	issuer: string;
	audience: string;
	clientId: string;
	jwksUrl?: string;
	maxLifetimeSeconds?: number;
}

function jwksUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
		throw new Error('OIDC access-token URLs must use HTTPS without credentials or fragments');
	}
	return url;
}

function reject(reason: AccessTokenRejection): null {
	logEvent({ level: 'debug', event: 'oidc_access_token_rejected', reason });
	return null;
}

export function createOidcAccessTokenAuthenticator(config: OidcAccessTokenConfig): Authenticator {
	const issuer = oidcIssuerUrl(config.issuer);
	if (!config.audience.trim() || config.audience === config.clientId) {
		throw new Error('OIDC access-token audience must differ from the browser client ID');
	}
	const maxLifetimeSeconds = config.maxLifetimeSeconds ?? 3600;
	if (
		!Number.isInteger(maxLifetimeSeconds) ||
		maxLifetimeSeconds < 1 ||
		maxLifetimeSeconds > 3600
	) {
		throw new Error('OIDC access-token lifetime must be between 1 and 3600 seconds');
	}
	const policy = {
		audience: config.audience,
		browserClientId: config.clientId,
		maxLifetimeSeconds,
		admission: createAdmissionPolicy(config),
	};
	const explicitKeys =
		config.jwksUrl === undefined ? undefined : createRemoteJWKSet(jwksUrl(config.jwksUrl));
	const discoverKeys = createOidcDiscovery(issuer, (metadata) => {
		if (metadata.issuer !== config.issuer || typeof metadata.jwks_uri !== 'string') {
			throw new Error('Invalid OIDC access-token discovery');
		}
		return createRemoteJWKSet(jwksUrl(metadata.jwks_uri));
	});

	return {
		async authenticate(request) {
			const token = bearerToken(request);
			if (!token || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3)
				return reject('invalid_token');
			let verified: Awaited<ReturnType<typeof jwtVerify>>;
			try {
				verified = await jwtVerify(
					token,
					async (...args) => {
						const keys = explicitKeys ?? (await discoverKeys());
						return keys(...args);
					},
					{
						issuer: config.issuer,
						audience: config.audience,
						algorithms: SIGNING_ALGORITHMS,
						requiredClaims: REQUIRED_CLAIMS,
					},
				);
			} catch {
				return reject('verification_failed');
			}
			const result = principalFromVerifiedAccessToken(
				verified.payload,
				verified.protectedHeader.typ,
				policy,
				Math.floor(Date.now() / 1000),
			);
			return 'error' in result ? reject(result.error) : result.principal;
		},
	};
}
