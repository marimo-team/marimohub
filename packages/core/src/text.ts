/**
 * The last `maxBytes` of a string, cut on a UTF-8 code-point boundary so the
 * tail is valid text (a kernel log tail, a captured stderr excerpt).
 */
export function utf8Tail(value: string, maxBytes: number): string {
	const budget = byteBudget(maxBytes);
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= budget) return value;
	let start = encoded.byteLength - budget;
	while (start < encoded.byteLength && isContinuationByte(encoded[start])) start++;
	return new TextDecoder().decode(encoded.subarray(start));
}

/** Keep at most maxBytes of content; callers budget any suffix separately. */
export function utf8Head(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	return utf8HeadBytes(encoded, maxBytes);
}

/** Decode a prefix of valid UTF-8 bytes without splitting a code point. */
export function utf8HeadBytes(encoded: Uint8Array, maxBytes: number): string {
	let end = Math.min(encoded.byteLength, byteBudget(maxBytes));
	while (end > 0 && isContinuationByte(encoded[end])) end--;
	return new TextDecoder().decode(encoded.subarray(0, end));
}

function byteBudget(maxBytes: number): number {
	return Number.isNaN(maxBytes) ? 0 : Math.max(0, Math.floor(maxBytes));
}

function isContinuationByte(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}
