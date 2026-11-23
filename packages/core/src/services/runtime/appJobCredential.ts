import type { AuthenticatedPrincipal } from '../../ports/auth';
import { fromBase64Url, toBase64Url, utf8ToBase64Url } from '../../internal/base64url';
import { hmacSha256, timingSafeEqual } from '../../internal/hmac';

export const APP_JOB_CREDENTIAL_TTL_MS = 5 * 60_000;
export const APP_JOB_CREDENTIAL_REFRESH_WINDOW_MS = 60 * 60_000;
export const APP_JOB_CREDENTIAL_PREFIX = 'mhub_app_';
const AUDIENCE = 'marimohub:app-jobs:v1';

export interface AppJobCredentialClaims {
	audience: typeof AUDIENCE;
	principal: AuthenticatedPrincipal;
	routingToken: string;
	assignmentGenerations: string[];
	endpoint: string;
	expiresAt: number;
	refreshUntil: number;
}

export async function signAppJobCredential(
	input: Omit<AppJobCredentialClaims, 'audience' | 'expiresAt'>,
	secret: string,
	now = Date.now(),
): Promise<string> {
	const payload = utf8ToBase64Url(
		JSON.stringify({
			...input,
			audience: AUDIENCE,
			expiresAt: Math.min(now + APP_JOB_CREDENTIAL_TTL_MS, input.refreshUntil),
		}),
	);
	return `${APP_JOB_CREDENTIAL_PREFIX}${payload}.${toBase64Url(await hmacSha256(secret, `${AUDIENCE}:${payload}`))}`;
}

export async function verifyAppJobCredential(
	token: string,
	secret: string,
	endpoint: string,
	{ purpose = 'access', now = Date.now() }: { purpose?: 'access' | 'refresh'; now?: number } = {},
): Promise<AppJobCredentialClaims | null> {
	if (!token.startsWith(APP_JOB_CREDENTIAL_PREFIX) || token.length > 16_384) return null;
	try {
		const parts = token.slice(APP_JOB_CREDENTIAL_PREFIX.length).split('.');
		if (parts.length !== 2) return null;
		const [payload, signature] = parts;
		if (
			!timingSafeEqual(await hmacSha256(secret, `${AUDIENCE}:${payload}`), fromBase64Url(signature))
		)
			return null;
		const claims = JSON.parse(
			new TextDecoder().decode(fromBase64Url(payload)),
		) as AppJobCredentialClaims;
		if (
			claims.audience !== AUDIENCE ||
			claims.endpoint !== endpoint ||
			!Number.isFinite(claims.expiresAt) ||
			!Number.isFinite(claims.refreshUntil) ||
			claims.refreshUntil <= now ||
			(purpose === 'access' && claims.expiresAt <= now)
		)
			return null;
		return claims;
	} catch {
		return null;
	}
}
