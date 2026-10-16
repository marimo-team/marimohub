import { ValidationError } from '../../errors';
import { Millis, Seconds } from '../../duration';
import { toBase64Url } from '../../internal/base64url';
import { signHs256Token, verifyHs256Token } from '../../internal/hs256';
import { hmacSha256 } from '../../internal/hmac';
import type { TempS3Creds } from '../../ports/credentialBroker';

const TOKEN_USE = 'wif-container-credentials';
const SECRET_DERIVATION_LABEL = 'marimohub/wif-container-credentials-token/v1';

const DEFAULT_TOKEN_TTL_SECONDS = Seconds.hours(24 * 7);

export function wifCredentialsDeadline(now = Date.now()): string {
	return new Date((Math.floor(now / 1000) + DEFAULT_TOKEN_TTL_SECONDS) * 1000).toISOString();
}

export function validateWifCredentialsUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ValidationError('WIF endpoint delivery requires an absolute HTTPS URL');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
		throw new ValidationError(
			'WIF endpoint delivery requires an HTTPS URL without credentials, query, or fragment',
		);
	}
}

export interface WifCredentialsTokenClaims {
	sessionId: string;
	projectId: string;
	userId: string;
}

// Domain-separated so the token can't be confused with any other HMAC over the signing key.
async function deriveSecret(keyMaterial: string): Promise<string> {
	return toBase64Url(await hmacSha256(keyMaterial, SECRET_DERIVATION_LABEL));
}

export async function mintWifCredentialsToken(
	keyMaterial: string,
	claims: WifCredentialsTokenClaims,
	opts: { ttlSeconds?: Seconds; expiresAt?: string; now?: () => number } = {},
): Promise<string> {
	const now = opts.now ?? (() => Date.now());
	const iat = Millis.toSeconds(Millis.of(now()));
	const payload = {
		use: TOKEN_USE,
		sub: claims.sessionId,
		project_id: claims.projectId,
		user_id: claims.userId,
		iat,
		exp: Math.min(
			iat + (opts.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
			opts.expiresAt ? Date.parse(opts.expiresAt) / 1000 : Infinity,
		),
	};
	return signHs256Token(await deriveSecret(keyMaterial), payload);
}

export async function verifyWifCredentialsToken(
	keyMaterial: string,
	token: string,
	now: () => number = () => Date.now(),
): Promise<WifCredentialsTokenClaims | null> {
	const payload = await verifyHs256Token(await deriveSecret(keyMaterial), token);
	if (!payload) return null;
	if (payload.use !== TOKEN_USE) return null;
	if (
		typeof payload.exp !== 'number' ||
		!Number.isFinite(payload.exp) ||
		payload.exp <= Millis.toSeconds(Millis.of(now()))
	) {
		return null;
	}
	const { sub, project_id, user_id } = payload;
	if (typeof sub !== 'string' || typeof project_id !== 'string' || typeof user_id !== 'string') {
		return null;
	}
	return { sessionId: sub, projectId: project_id, userId: user_id };
}

// No static keys: env credentials take precedence over the container provider in SDK chains.
export function containerCredentialsEnv(
	credentialsUrl: string,
	token: string,
	endpoint?: string,
	region?: string,
): Record<string, string> {
	validateWifCredentialsUrl(credentialsUrl);
	const env: Record<string, string> = {
		AWS_CONTAINER_CREDENTIALS_FULL_URI: credentialsUrl,
		AWS_CONTAINER_AUTHORIZATION_TOKEN: token,
	};
	if (endpoint) env.AWS_ENDPOINT_URL_S3 = endpoint;
	if (region) env.AWS_REGION = region;
	return env;
}

// botocore and the JS v3 SDK require every field, `Token` included (empty is valid).
export function toContainerCredentialsResponse(
	creds: TempS3Creds & { expiration: string },
): Record<string, string> {
	return {
		AccessKeyId: creds.accessKeyId,
		SecretAccessKey: creds.secretAccessKey,
		Token: creds.sessionToken ?? '',
		Expiration: creds.expiration,
	};
}
