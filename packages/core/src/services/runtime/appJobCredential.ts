import type { AuthenticatedPrincipal } from '../../ports/auth';
import { fromBase64Url, toBase64Url } from '../../internal/base64url';

export const APP_JOB_CREDENTIAL_TTL_MS = 5 * 60_000;
export const APP_JOB_CREDENTIAL_REFRESH_WINDOW_MS = 60 * 60_000;
export const APP_JOB_CREDENTIAL_PREFIX = 'mhub_app_';
const AUDIENCE = 'marimohub:app-jobs:v1';
const IV_BYTES = 12;
const encoder = new TextEncoder();

export interface AppJobCredentialClaims {
	audience: typeof AUDIENCE;
	principal: AuthenticatedPrincipal;
	routingToken: string;
	assignmentGenerations: string[];
	endpoint: string;
	expiresAt: number;
	refreshUntil: number;
}

// Notebook code can read this credential, so the visitor's identity is encrypted, not only signed.
// AES-GCM authenticates the ciphertext, and the audience is bound as additional data.
async function credentialKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${AUDIENCE}:${secret}`));
	return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function signAppJobCredential(
	input: Omit<AppJobCredentialClaims, 'audience' | 'expiresAt'>,
	secret: string,
	now = Date.now(),
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const plaintext = encoder.encode(
		JSON.stringify({
			...input,
			audience: AUDIENCE,
			expiresAt: Math.min(now + APP_JOB_CREDENTIAL_TTL_MS, input.refreshUntil),
		}),
	);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(AUDIENCE) },
		await credentialKey(secret),
		plaintext,
	);
	return `${APP_JOB_CREDENTIAL_PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
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
		const iv = new Uint8Array(fromBase64Url(parts[0]));
		if (iv.length !== IV_BYTES) return null;
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv, additionalData: encoder.encode(AUDIENCE) },
			await credentialKey(secret),
			new Uint8Array(fromBase64Url(parts[1])),
		);
		const claims = JSON.parse(new TextDecoder().decode(plaintext)) as AppJobCredentialClaims;
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
