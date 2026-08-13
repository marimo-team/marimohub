export type RasterImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export const OBJECT_PREVIEW_FORMATS = [
	'csv',
	'tsv',
	'json',
	'jsonl',
	'parquet',
	'text',
	'png',
	'jpeg',
	'gif',
	'webp',
] as const;

export function detectRasterImage(bytes: Uint8Array): RasterImageFormat | undefined {
	if (hasPrefix(bytes, PNG)) return 'png';
	if (hasPrefix(bytes, JPEG)) return 'jpeg';
	const firstSix = decodeAscii(bytes.subarray(0, 6));
	if (firstSix === 'GIF87a' || firstSix === 'GIF89a') return 'gif';
	if (
		decodeAscii(bytes.subarray(0, 4)) === 'RIFF' &&
		decodeAscii(bytes.subarray(8, 12)) === 'WEBP'
	) {
		return 'webp';
	}
	return undefined;
}

export function rasterContentType(format: RasterImageFormat): string {
	return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

export function decodeAscii(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
	return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);
