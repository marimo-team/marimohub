import { describe, it, expect } from 'vitest';
import { createTestApi } from './testing';

describe('conditional GET (ETag)', () => {
	it('stamps an ETag + Cache-Control on reads and 304s a matching If-None-Match', async () => {
		const { app } = createTestApi();
		const res = await app.request('/api/v1/projects');
		expect(res.status).toBe(200);
		const etag = res.headers.get('etag');
		expect(etag).toBeTruthy();
		expect(res.headers.get('cache-control')).toBe('no-cache');

		const revalidated = await app.request('/api/v1/projects', {
			headers: { 'if-none-match': etag! },
		});
		expect(revalidated.status).toBe(304);
		expect(await revalidated.text()).toBe('');
		expect(revalidated.headers.get('etag')).toBe(etag);
	});

	it('returns 200 with a fresh body when the ETag is stale', async () => {
		const { app } = createTestApi();
		const res = await app.request('/api/v1/projects', {
			headers: { 'if-none-match': 'W/"deadbeef-0"' },
		});
		expect(res.status).toBe(200);
	});

	it('changes the ETag when the underlying data changes', async () => {
		const { app, request } = createTestApi();
		const before = (await app.request('/api/v1/projects')).headers.get('etag');
		await request('POST', '/projects', { name: 'New', description: 'd' });
		const after = (await app.request('/api/v1/projects')).headers.get('etag');
		expect(after).not.toBe(before);
	});
});
