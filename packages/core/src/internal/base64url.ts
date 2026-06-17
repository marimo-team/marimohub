/**
 * base64url (RFC 4648 §5) helpers, padding-free — safe in a URL path segment and
 * in a JWS/JWT. Shared by `proxyToken.ts` (HMAC routing tokens) and
 * `WorkloadIdentityIssuer.ts` (RS256 JWTs) so the two never drift.
 *
 * Uses `btoa`/`atob` (available on Node and Workers) rather than `Buffer`, to
 * keep `core` runtime-agnostic.
 */

/** Encode bytes as padding-free base64url. */
export function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Decode padding-free base64url back to bytes. Throws on invalid input. */
export function fromBase64Url(s: string): Uint8Array {
	const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Encode a UTF-8 string as padding-free base64url (e.g. a JWT header/payload). */
export function utf8ToBase64Url(s: string): string {
	return toBase64Url(new TextEncoder().encode(s));
}
