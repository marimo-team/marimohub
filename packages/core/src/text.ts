/**
 * The last `maxBytes` of a string, cut on a UTF-8 code-point boundary so the
 * tail is valid text (a kernel log tail, a captured stderr excerpt).
 */
export function utf8Tail(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let start = encoded.byteLength - maxBytes;
	while (start < encoded.byteLength && isContinuationByte(encoded[start])) start++;
	return new TextDecoder().decode(encoded.slice(start));
}

/** Keep at most maxBytes of content; callers budget any suffix separately. */
export function utf8Head(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let end = Math.max(0, maxBytes);
	while (end > 0 && isContinuationByte(encoded[end])) end--;
	return new TextDecoder().decode(encoded.subarray(0, end));
}

function isContinuationByte(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}
