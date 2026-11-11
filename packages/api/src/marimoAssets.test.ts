import { expect, it } from 'vitest';
import { publicMarimoAssetUrl } from './marimoAssets';

it('exposes HTTPS asset templates without resolving an unknown runtime version', () => {
	const url = 'https://cdn.example/frontend@{version}/dist';
	expect(publicMarimoAssetUrl(url)).toBe(url);
});

it.each([
	undefined,
	'hub',
	'http://cdn.example/dist',
	'/assets',
	'https://user:secret@cdn.example/dist',
	'https://cdn.example/dist?token=secret',
	'https://cdn.example/dist#secret',
	'javascript:alert(1)',
])('omits private, relative, or unsafe asset locations: %s', (url) => {
	expect(publicMarimoAssetUrl(url)).toBeUndefined();
});
