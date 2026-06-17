/** Lowercase hex encoding of raw bytes (e.g. a SHA-256 digest → 64 hex chars). */
export function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}
