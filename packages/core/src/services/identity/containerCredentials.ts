import { z } from 'zod';
import { ValidationError } from '../../errors';
import { Millis, Seconds } from '../../duration';
import { toBase64Url } from '../../internal/base64url';
import { signHs256Token, verifyHs256Token } from '../../internal/hs256';
import { hmacSha256 } from '../../internal/hmac';
import { AUTH_ENTITLEMENTS, CREDENTIAL_KINDS, MAX_AUTH_GROUPS } from '../../ports/auth';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import type { TempS3Creds } from '../../ports/credentialBroker';
import { TokenGrantSchema } from '../../tokenGrants';
import type { AWS_CONTAINER_CREDENTIAL_ENV } from '../integrations/environmentName';
import { s3TargetEnv } from './s3CredsEnv';

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

/**
 * The launch principal's authorization inputs that storage cannot reproduce.
 * Project membership is re-read on every fetch; group-derived access is
 * already bounded by the session's authorization deadline.
 */
const WifCredentialsSubjectSchema = z.object({
	email: z.string(),
	groups: z.array(z.string()).max(MAX_AUTH_GROUPS).optional(),
	entitlements: z.array(z.enum(AUTH_ENTITLEMENTS)).optional(),
	credential: z.object({
		kind: z.enum(CREDENTIAL_KINDS),
		id: z.string().optional(),
		grant: TokenGrantSchema.optional(),
		subjectContextRef: z.string().optional(),
	}),
});

export type WifCredentialsSubject = z.infer<typeof WifCredentialsSubjectSchema>;

export function wifCredentialsSubject(principal: AuthenticatedPrincipal): WifCredentialsSubject {
	const { kind, id, grant, subjectContextRef } = principal.credential;
	return {
		email: principal.email,
		...(principal.groups?.length ? { groups: [...principal.groups] } : {}),
		...(principal.entitlements?.length ? { entitlements: [...principal.entitlements] } : {}),
		credential: {
			kind,
			...(id !== undefined ? { id } : {}),
			...(grant ? { grant } : {}),
			...(subjectContextRef !== undefined ? { subjectContextRef } : {}),
		},
	};
}

export interface WifCredentialsTokenClaims {
	sessionId: string;
	projectId: string;
	userId: string;
	subject: WifCredentialsSubject;
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
		subject: claims.subject,
		iat,
		exp: Math.min(
			iat + (opts.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
			opts.expiresAt ? Math.floor(Date.parse(opts.expiresAt) / 1000) : Infinity,
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
	// RFC 7519: a token must not be accepted on or after `exp`.
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
	const subject = WifCredentialsSubjectSchema.safeParse(payload.subject);
	if (!subject.success) return null;
	return { sessionId: sub, projectId: project_id, userId: user_id, subject: subject.data };
}

// No static keys: env credentials take precedence over the container provider in SDK chains.
export function containerCredentialsEnv(
	credentialsUrl: string,
	token: string,
	endpoint?: string,
	region?: string,
): Record<string, string> {
	validateWifCredentialsUrl(credentialsUrl);
	const env: Partial<Record<(typeof AWS_CONTAINER_CREDENTIAL_ENV)[number], string>> = {
		AWS_CONTAINER_CREDENTIALS_FULL_URI: credentialsUrl,
		AWS_CONTAINER_AUTHORIZATION_TOKEN: token,
	};
	return { ...env, ...s3TargetEnv(endpoint, region) };
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
