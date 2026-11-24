import { z } from 'zod';
import { DeepLinkSlugSchema } from '../../deepLinkSlug';
import { NotebookIdSchema, ProjectIdSchema, SessionIdSchema } from '../../schema';
import { ulidString } from '../../stringFormats';
import { fromBase64Url, toBase64Url } from '../../internal/base64url';

const TOKEN_VERSION = 'v1';
const KEY_DOMAIN = 'marimohub:public-app-visit-key:v1:';
const AAD = new TextEncoder().encode('marimohub:public-app-visit:v1');
const IV_BYTES = 12;

export const PublicAppVisitTokenClaimsSchema = z.strictObject({
	slug: DeepLinkSlugSchema,
	reg: ulidString(),
	grant: ulidString(),
	pid: ProjectIdSchema,
	nid: NotebookIdSchema,
	sid: SessionIdSchema,
	vid: z.string().min(1).max(128),
	gen: z.string().min(1).max(128),
	exp: z.number().int().positive(),
});

export type PublicAppVisitTokenClaims = z.infer<typeof PublicAppVisitTokenClaimsSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveAesKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${KEY_DOMAIN}${secret}`));
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt visit claims into an opaque AEAD token so internal IDs are never readable by browsers. */
export async function sealPublicAppVisitToken(
	claims: PublicAppVisitTokenClaims,
	secret: string,
): Promise<string> {
	const parsed = PublicAppVisitTokenClaimsSchema.parse(claims);
	const key = await deriveAesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const plaintext = encoder.encode(JSON.stringify(parsed));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plaintext),
	);
	const combined = new Uint8Array(IV_BYTES + ciphertext.length);
	combined.set(iv, 0);
	combined.set(ciphertext, IV_BYTES);
	return `${TOKEN_VERSION}.${toBase64Url(combined)}`;
}

/** Decrypt and verify an opaque visit token, returning null when invalid, tampered, or expired. */
export async function openPublicAppVisitToken(
	token: string,
	secret: string,
	nowMs = Date.now(),
): Promise<PublicAppVisitTokenClaims | null> {
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	if (token.slice(0, dot) !== TOKEN_VERSION) return null;
	let combined: Uint8Array;
	try {
		combined = fromBase64Url(token.slice(dot + 1));
	} catch {
		return null;
	}
	if (combined.length <= IV_BYTES + 16) return null;
	const iv = combined.slice(0, IV_BYTES);
	const ciphertext = combined.slice(IV_BYTES);
	try {
		const key = await deriveAesKey(secret);
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv, additionalData: AAD },
			key,
			ciphertext,
		);
		const parsed = PublicAppVisitTokenClaimsSchema.safeParse(JSON.parse(decoder.decode(plaintext)));
		if (!parsed.success) return null;
		if (parsed.data.exp * 1000 <= nowMs) return null;
		return parsed.data;
	} catch {
		return null;
	}
}
