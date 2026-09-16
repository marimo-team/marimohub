import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { thumbnailPng } from '../../testing/thumbnail';
import { THUMBNAIL_MAX_BYTES, validateThumbnailPng } from './thumbnailPng';

function chunk(type: string, data: Uint8Array) {
	const output = new Uint8Array(12 + data.length);
	const view = new DataView(output.buffer);
	view.setUint32(0, data.length);
	output.set(new TextEncoder().encode(type), 4);
	output.set(data, 8);
	let crc = 0xffffffff;
	for (const byte of output.subarray(4, -4)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0);
	return output;
}
function png(
	options: {
		width?: number;
		height?: number;
		channels?: number;
		pixels?: Uint8Array;
		chunks?: Uint8Array[];
	} = {},
) {
	const { width = 960, height = 540, channels = 3 } = options;
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, channels === 3 ? 2 : 6], 8);
	return Buffer.concat([
		thumbnailPng().subarray(0, 8),
		chunk('IHDR', header),
		...(options.chunks ?? [
			chunk('IDAT', deflateSync(options.pixels ?? new Uint8Array((width * channels + 1) * height))),
		]),
		chunk('IEND', new Uint8Array()),
	]);
}

describe('thumbnail PNG validation', () => {
	it.each([3, 4])('accepts %i-channel PNGs and typed-array slices', (channels) => {
		const bytes = png({ channels });
		const padded = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)]);
		expect(() => validateThumbnailPng(padded.subarray(7, -3))).not.toThrow();
	});
	it.each([{ width: 959 }, { height: 541 }])('rejects incorrect dimensions: %j', (options) => {
		expect(() => validateThumbnailPng(png(options))).toThrow();
	});
	it('rejects invalid row filters, truncated pixels, and excess decompressed pixels', () => {
		const pixels = new Uint8Array((960 * 3 + 1) * 540);
		pixels[960 * 3 + 1] = 5;
		for (const bytes of [pixels, pixels.subarray(1), new Uint8Array(pixels.length * 8)]) {
			expect(() => validateThumbnailPng(png({ pixels: bytes }))).toThrow();
		}
	});
	it('rejects invalid ancillary chunk lengths and noncontiguous image data', () => {
		const compressed = deflateSync(new Uint8Array((960 * 3 + 1) * 540));
		for (const chunks of [
			[chunk('sRGB', new Uint8Array(2)), chunk('IDAT', compressed)],
			[
				chunk('IDAT', compressed.subarray(0, 8)),
				chunk('pHYs', new Uint8Array(9)),
				chunk('IDAT', compressed.subarray(8)),
			],
		])
			expect(() => validateThumbnailPng(png({ chunks }))).toThrow();
	});
	it('rejects a bad zlib checksum even with valid PNG chunk checksums', () => {
		const compressed = deflateSync(new Uint8Array((960 * 3 + 1) * 540));
		compressed[compressed.length - 1] ^= 1;
		expect(() => validateThumbnailPng(png({ chunks: [chunk('IDAT', compressed)] }))).toThrow();
	});

	it('rejects bad checksums, missing IEND, trailing bytes, and oversized files', () => {
		const corrupt = thumbnailPng();
		corrupt[60] ^= 1;
		for (const bytes of [
			corrupt,
			thumbnailPng().slice(0, -12),
			Buffer.concat([thumbnailPng(), Buffer.of(0)]),
			new Uint8Array(THUMBNAIL_MAX_BYTES + 1),
		]) {
			expect(() => validateThumbnailPng(bytes)).toThrow();
		}
	});
});
