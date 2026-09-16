import { Unzlib } from 'fflate';
import { updateCrc32 } from '../../internal/crc32';
import { ValidationError } from '../../errors';

export const THUMBNAIL_MAX_BYTES = 3 * 1024 * 1024;
export const THUMBNAIL_WIDTH = 960;
export const THUMBNAIL_HEIGHT = 540;

export function validateThumbnailPng(bytes: Uint8Array): void {
	const invalid = () => new ValidationError('Upload a valid 960×540 PNG smaller than 3 MB');
	if (bytes.length > THUMBNAIL_MAX_BYTES || bytes.length < 57) throw invalid();
	if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw invalid();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: Uint8Array[] = [];
	let channels = 0;
	let ended = false;
	const metadata = new Set<string>();
	let compressedSize = 0;
	for (let offset = 8; offset < bytes.length; ) {
		if (offset + 12 > bytes.length) throw invalid();
		const size = view.getUint32(offset);
		const end = offset + 12 + size;
		if (end > bytes.length) throw invalid();
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		if (
			(updateCrc32(0xffffffff, bytes.subarray(offset + 4, end - 4)) ^ 0xffffffff) >>> 0 !==
			view.getUint32(end - 4)
		)
			throw invalid();
		if (offset === 8) {
			if (
				type !== 'IHDR' ||
				size !== 13 ||
				view.getUint32(16) !== THUMBNAIL_WIDTH ||
				view.getUint32(20) !== THUMBNAIL_HEIGHT ||
				bytes[24] !== 8 ||
				![2, 6].includes(bytes[25]) ||
				bytes[26] !== 0 ||
				bytes[27] !== 0 ||
				bytes[28] !== 0
			)
				throw invalid();
			channels = bytes[25] === 6 ? 4 : 3;
		} else if (type === 'IDAT') {
			const chunk = bytes.subarray(offset + 8, end - 4);
			chunks.push(chunk);
			compressedSize += chunk.length;
		} else if (type === 'IEND') {
			if (size !== 0 || end !== bytes.length || chunks.length === 0) throw invalid();
			ended = true;
		} else {
			// Limit metadata to the color and resolution chunks emitted by canvas and Chromium.
			const lengths: Record<string, number> = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };
			if (metadata.has(type) || chunks.length > 0 || size !== lengths[type]) throw invalid();
			if (type === 'sRGB' && bytes[offset + 8] > 3) throw invalid();
			if (type === 'pHYs' && bytes[offset + 16] > 1) throw invalid();
			metadata.add(type);
		}
		offset = end;
	}
	if (!ended) throw invalid();
	const compressed = new Uint8Array(compressedSize);
	let offset = 0;
	for (const chunk of chunks) {
		compressed.set(chunk, offset);
		offset += chunk.length;
	}
	const stride = THUMBNAIL_WIDTH * channels + 1;
	try {
		let size = 0;
		let finished = false;
		let adlerA = 1;
		let adlerB = 0;
		const inflater = new Unzlib((chunk, final) => {
			if (size + chunk.length > stride * THUMBNAIL_HEIGHT) throw invalid();
			for (let i = (stride - (size % stride)) % stride; i < chunk.length; i += stride) {
				if (chunk[i] > 4) throw invalid();
			}
			for (const byte of chunk) {
				adlerA = (adlerA + byte) % 65521;
				adlerB = (adlerB + adlerA) % 65521;
			}
			size += chunk.length;
			finished = final;
		});
		// Small input slices let us reject a decompression bomb before expanding the whole stream.
		for (let offset = 0; offset < compressed.length; offset += 1024) {
			const end = Math.min(offset + 1024, compressed.length);
			inflater.push(compressed.subarray(offset, end), end === compressed.length);
		}
		const checksum = new DataView(compressed.buffer).getUint32(compressed.length - 4);
		if (
			!finished ||
			size !== stride * THUMBNAIL_HEIGHT ||
			((adlerB << 16) | adlerA) >>> 0 !== checksum
		)
			throw invalid();
	} catch {
		throw invalid();
	}
}
