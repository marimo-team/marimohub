/**
 * The last `maxBytes` of a string, cut on a UTF-8 code-point boundary so the
 * tail is valid text (a kernel log tail, a captured stderr excerpt).
 */
export function utf8Tail(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let start = encoded.byteLength - maxBytes;
	while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(encoded.slice(start));
}
