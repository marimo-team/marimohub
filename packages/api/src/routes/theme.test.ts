import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createTestApi, expectError, expectOk } from '../testing';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';

describe('GET /api/v1/theme', () => {
	it('serves defaults without authenticating or accessing the catalog', async () => {
		const bucket = new MemoryBucket();
		const get = vi.spyOn(bucket, 'get').mockRejectedValue(new Error('Storage unavailable'));
		const authenticate = vi.fn(async () => null);
		const { request } = createTestApi({ bucket, deps: { authenticator: { authenticate } } });
		const response = await request('GET', '/theme');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await expectOk(response)).toEqual(DEFAULT_THEME_CONFIG);
		expect(authenticate).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		await expectError(await request('GET', '/me'), 401, 'UNAUTHORIZED');
		await expectError(await request('GET', '/capabilities'), 401, 'UNAUTHORIZED');
	});

	it('only exposes the six public theme fields', async () => {
		const theme = {
			...DEFAULT_THEME_CONFIG,
			name: 'Research Hub',
			logo: '/brand.svg',
			secret: 'not-public',
		};
		const { request } = createTestApi({ deps: { theme } });
		expect(await expectOk(await request('GET', '/theme'))).toEqual({
			...DEFAULT_THEME_CONFIG,
			name: 'Research Hub',
			logo: '/brand.svg',
		});
	});
	it('remains available when the identity provider is unavailable', async () => {
		const authenticate = vi.fn().mockRejectedValue(new Error('Identity provider unavailable'));
		const { request } = createTestApi({ deps: { authenticator: { authenticate } } });
		expect(await expectOk(await request('GET', '/theme'))).toEqual(DEFAULT_THEME_CONFIG);
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('isolates branding between API instances serving concurrent requests', async () => {
		const first = createTestApi({
			deps: { theme: { ...DEFAULT_THEME_CONFIG, name: 'First hub', primary_color: '#f00' } },
		});
		const second = createTestApi({
			deps: { theme: { ...DEFAULT_THEME_CONFIG, name: 'Second hub', primary_color: '#00f' } },
		});
		const [a, b, c] = await Promise.all([
			first.request('GET', '/theme'),
			second.request('GET', '/theme'),
			first.request('GET', '/theme'),
		]);
		expect(await expectOk(a)).toMatchObject({ name: 'First hub', primary_color: '#f00' });
		expect(await expectOk(b)).toMatchObject({ name: 'Second hub', primary_color: '#00f' });
		expect(await expectOk(c)).toMatchObject({ name: 'First hub', primary_color: '#f00' });
	});

	it('does not return invalid branding or its raw values to unauthenticated callers', async () => {
		const { request } = createTestApi({
			deps: {
				authenticator: { authenticate: async () => null },
				theme: { ...DEFAULT_THEME_CONFIG, logo: 'https://private:secret@example.com/logo.svg' },
			},
		});
		const response = await request('GET', '/theme');
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
		expect(body).not.toHaveProperty('data');
		expect(JSON.stringify(body)).not.toContain('private:secret');
	});
});
