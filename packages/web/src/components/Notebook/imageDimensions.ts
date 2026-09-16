export function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (offset: number, size: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + size));
	if (bytes.length >= 24 && text(0, 8) === '\x89PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
		let dimensions: { width: number; height: number } | undefined;
		const uint24 = (offset: number) =>
			bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
		for (let offset = 12; offset + 8 <= bytes.length; ) {
			const kind = text(offset, 4);
			const size = view.getUint32(offset + 4, true);
			const start = offset + 8;
			if (start + size > bytes.length) break;
			if (kind === 'VP8X' && size >= 10) {
				if (bytes[start] & 2) throw new Error('Choose a still image for your thumbnail.');
				dimensions = { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
			}
			if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
				const bits = view.getUint32(start + 1, true);
				return {
					width: Math.max(dimensions?.width ?? 0, (bits & 0x3fff) + 1),
					height: Math.max(dimensions?.height ?? 0, ((bits >>> 14) & 0x3fff) + 1),
				};
			}
			if (kind === 'VP8 ' && size >= 10 && text(start + 3, 3) === '\x9d\x01\x2a') {
				return {
					width: Math.max(dimensions?.width ?? 0, view.getUint16(start + 6, true) & 0x3fff),
					height: Math.max(dimensions?.height ?? 0, view.getUint16(start + 8, true) & 0x3fff),
				};
			}
			offset = start + size + (size % 2);
		}
		if (dimensions) return dimensions;
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
			while (bytes[offset] === 0xff) offset++;
			const marker = bytes[offset++];
			if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			const size = view.getUint16(offset);
			if (size < 2 || offset + size > bytes.length) break;
			if (size >= 8 && marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
			}
			offset += size;
		}
	}
	throw new Error('This image could not be opened. Try another screenshot.');
}
