/**
 * HMAC-SHA256 helpers shared by the token services (`proxyToken.ts` routing
 * tokens and `aiSessionConfig.ts` session JWTs) so the two never drift.
 *
 * Uses Web Crypto (`crypto.subtle`) rather than `node:crypto`, keeping `core`
 * vendor- and runtime-agnostic (runs identically on Node and Workers).
 */

const encoder = new TextEncoder();

/** Sign `payload` with `secret` under HMAC-SHA256, returning the raw digest. */
export async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
	return new Uint8Array(sig);
}

/** Constant-time comparison so token verification can't be timing-probed. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
