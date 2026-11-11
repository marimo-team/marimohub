/**
 * base64 helpers for both RFC 4648 alphabets. base64url (§5) is padding-free — safe in a URL path
 * segment and in a JWS/JWT. Shared by `proxyToken.ts` (HMAC routing tokens) and
 * `WorkloadIdentityIssuer.ts` (RS256 JWTs) so the two never drift. Standard base64 (§4) is padded.
 *
 * Uses `btoa`/`atob` (available on Node and Workers) rather than `Buffer`, to
 * keep `core` runtime-agnostic.
 */

/** Encode bytes as padded standard base64. */
export function toBase64(bytes: Uint8Array): string {
	let bin = '';
	// Chunked to stay below the engine's argument-count limit on large payloads.
	for (let i = 0; i < bytes.length; i += 8192)
		bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(bin);
}

/** Encode bytes as padding-free base64url. */
export function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
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
