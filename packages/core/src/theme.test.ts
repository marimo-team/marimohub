import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CONFIG, ThemeConfigSchema } from './theme';

describe('shell theme config', () => {
	it('keeps default deployments backward compatible', () => {
		expect(ThemeConfigSchema.parse(DEFAULT_THEME_CONFIG)).toEqual(DEFAULT_THEME_CONFIG);
	});
	it('defaults older theme configurations to no notebook palette', () => {
		const { notebook_palette: _, ...legacy } = DEFAULT_THEME_CONFIG;
		expect(ThemeConfigSchema.parse(legacy).notebook_palette).toBe('off');
	});
	it.each([
		'javascript:alert(1)',
		'//evil.example',
		'/\\evil.example',
		'http://example.com',
		'https://u:p@example.com',
		'/a\nb',
	])('rejects unsafe URLs %s in every shell field', (href) => {
		for (const fields of [
			{ nav_links: [{ label: 'Link', href }] },
			{ announcement: { id: '1', text: 'News', href } },
			{ docs_url: href },
			{ support_url: href },
			{ notebook_css: href },
		]) {
			expect(ThemeConfigSchema.safeParse({ ...DEFAULT_THEME_CONFIG, ...fields }).success).toBe(
				false,
			);
		}
	});
	it.each([
		{ nav_links: Array.from({ length: 13 }, () => ({ label: 'Link', href: '/ok' })) },
		{ nav_links: [{ label: 'x'.repeat(41), href: '/ok' }] },
		{ nav_links: [{ label: ' ', href: '/ok' }] },
		{ nav_links: [{ label: 'OK', href: '/ok', roles: ['owner'] }] },
		{ announcement: { id: 'x', text: 'x'.repeat(281) } },
		{ announcement: { id: '', text: 'News' } },
	])('rejects invalid shell config %j', (fields) => {
		expect(ThemeConfigSchema.safeParse({ ...DEFAULT_THEME_CONFIG, ...fields }).success).toBe(false);
	});
});
