import { describe, expect, it } from 'vitest';
import { imageDimensions } from './imageDimensions';
import { pngHeader } from '@/test/imageFixtures';

describe('image dimensions', () => {
	it('reads PNG and progressive JPEG dimensions', () => {
		expect(imageDimensions(pngHeader())).toEqual({ width: 1200, height: 900 });
		const jpeg = new Uint8Array([255, 216, 255, 226, 0, 2, 255, 194, 0, 8, 8, 3, 132, 4, 176, 3]);
		expect(imageDimensions(jpeg)).toEqual({ width: 1200, height: 900 });
	});
	it.each(['VP8X', 'VP8L', 'VP8 '])('reads %s WebP dimensions', (kind) => {
		const bytes = new Uint8Array(30);
		bytes.set(new TextEncoder().encode('RIFF'), 0);
		bytes.set(new TextEncoder().encode('WEBP'), 8);
		bytes.set(new TextEncoder().encode(kind), 12);
		const view = new DataView(bytes.buffer);
		view.setUint32(16, 10, true);
		if (kind === 'VP8X') {
			bytes.set([175, 4, 0, 131, 3, 0], 24);
		} else if (kind === 'VP8L') {
			bytes[20] = 0x2f;
			view.setUint32(21, 1199 | (899 << 14), true);
		} else {
			bytes.set([0x9d, 1, 0x2a], 23);
			view.setUint16(26, 1200, true);
			view.setUint16(28, 900, true);
		}
		expect(imageDimensions(bytes)).toEqual({ width: 1200, height: 900 });
	});

	it('checks the encoded WebP dimensions even when its canvas claims a smaller image', () => {
		const bytes = new Uint8Array(48);
		bytes.set(new TextEncoder().encode('RIFF'), 0);
		bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
		const view = new DataView(bytes.buffer);
		view.setUint32(16, 10, true);
		bytes.set(new TextEncoder().encode('VP8 '), 30);
		view.setUint32(34, 10, true);
		bytes.set([0x9d, 1, 0x2a], 41);
		view.setUint16(44, 16000, true);
		view.setUint16(46, 16000, true);
		expect(imageDimensions(bytes)).toEqual({ width: 16000, height: 16000 });
		bytes[20] = 2;
		expect(() => imageDimensions(bytes)).toThrow('Choose a still image');
	});
	it.each(
		[[], [255, 216, 255, 224, 255, 255], [255, 216, 255, 194, 0, 0]].map((bytes) => ({ bytes })),
	)('rejects truncated or invalid headers', ({ bytes }) => {
		expect(() => imageDimensions(new Uint8Array(bytes))).toThrow('could not be opened');
	});
});
