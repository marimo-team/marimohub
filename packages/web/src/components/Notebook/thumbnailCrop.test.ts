import { pngFile } from '@/test/imageFixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropCoordinates, cropThumbnail, isValidCrop, readThumbnailImage } from './thumbnailCrop';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('thumbnail crop', () => {
	it.each([
		[100000, 100000],
		[16000, 3000],
		[0, 100],
		[20000, 10],
	])(
		'rejects excessive or empty dimensions %j before allocating a bitmap',
		async (width, height) => {
			const decode = vi.fn();
			vi.stubGlobal('createImageBitmap', decode);
			await expect(readThumbnailImage(pngFile(width, height))).rejects.toThrow(
				'Choose an image up to',
			);
			expect(decode).not.toHaveBeenCalled();
		},
	);
	it('maps a crop to original pixels independently of display size', () => {
		expect(cropCoordinates({ unit: '%', x: 25, y: 10, width: 50, height: 60 }, 2400, 1600)).toEqual(
			{ x: 600, y: 160, width: 1200, height: 960 },
		);
	});
	it.each([
		{ x: -1 },
		{ y: -1 },
		{ width: 0 },
		{ height: 0 },
		{ width: Number.NaN },
		{ height: Infinity },
		{ x: 99, width: 2 },
		{ y: 99, height: 2 },
	])('rejects invalid crop coordinates %j', async (invalid) => {
		const crop = { unit: '%' as const, x: 0, y: 0, width: 100, height: 100, ...invalid };
		expect(isValidCrop(crop)).toBe(false);
		await expect(cropThumbnail(document.createElement('img'), crop)).rejects.toThrow(
			'Select an image area',
		);
	});
	it('releases the decoded bitmap when the canvas fails', async () => {
		const close = vi.fn();
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn().mockResolvedValue({ width: 960, height: 540, close }),
		);
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			drawImage: () => {
				throw new Error('Canvas failed');
			},
		} as never);
		await expect(readThumbnailImage(pngFile())).rejects.toThrow('Canvas failed');
		expect(close).toHaveBeenCalledOnce();
	});
	it('rejects a failed PNG encode', async () => {
		const image = document.createElement('img');
		Object.defineProperties(image, { naturalWidth: { value: 960 }, naturalHeight: { value: 540 } });
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			drawImage: vi.fn(),
			fillRect: vi.fn(),
		} as never);
		vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
			callback(null),
		);
		await expect(
			cropThumbnail(image, { unit: '%', x: 0, y: 0, width: 100, height: 100 }),
		).rejects.toThrow('Could not save this image');
	});
});
