import type { PercentCrop } from 'react-image-crop';
import { imageDimensions } from './imageDimensions';

export const THUMBNAIL_ASPECT = 16 / 9;
export const THUMBNAIL_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function readThumbnailImage(file: File): Promise<string> {
	if (!THUMBNAIL_FILE_TYPES.includes(file.type) || file.size > 10 * 1024 * 1024) {
		throw new Error('Choose a PNG, JPEG, or WebP image up to 10 MB.');
	}
	const bytes = await file.arrayBuffer();
	const { width, height } = imageDimensions(new Uint8Array(bytes));
	if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32_000_000) {
		throw new Error('Choose an image up to 32 megapixels and 16,384 pixels per side.');
	}
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		// Keep the editing canvas smaller than the decoded screenshot.
		const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Your browser could not open this image');
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/png');
	} finally {
		bitmap.close();
	}
}

export function isValidCrop(crop: PercentCrop): boolean {
	// Percentage conversions can round slightly past the image edge.
	const edge = 100 + 1e-6;
	return (
		[crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) &&
		crop.x >= 0 &&
		crop.y >= 0 &&
		crop.width > 0 &&
		crop.height > 0 &&
		crop.x + crop.width <= edge &&
		crop.y + crop.height <= edge
	);
}

export function cropCoordinates(crop: PercentCrop, width: number, height: number) {
	return {
		x: (width * crop.x) / 100,
		y: (height * crop.y) / 100,
		width: (width * crop.width) / 100,
		height: (height * crop.height) / 100,
	};
}

export async function cropThumbnail(image: HTMLImageElement, crop: PercentCrop): Promise<Blob> {
	if (!isValidCrop(crop)) throw new Error('Select an image area first');
	const source = cropCoordinates(crop, image.naturalWidth, image.naturalHeight);
	if (source.width <= 0 || source.height <= 0) throw new Error('Select an image area first');
	const canvas = document.createElement('canvas');
	canvas.width = 960;
	canvas.height = 540;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Your browser could not crop this image');
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, 960, 540);
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('Could not save this image'))),
			'image/png',
		);
	});
}
