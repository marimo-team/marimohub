import { describe, expect, it } from 'vitest';
import { createTestApi } from './testing';

/**
 * CSRF defense-in-depth: state-changing requests carrying a cross-origin
 * `Origin` are rejected; same-origin and Origin-less (non-browser) requests pass.
 * The guard runs ahead of auth, so a foreign Origin is rejected regardless of
 * credentials or body.
 */
describe('CSRF / Origin guard', () => {
	const post = (init: RequestInit) =>
		createTestApi().app.request('/api/v1/projects', { method: 'POST', ...init });

	it('rejects a cross-origin state-changing request with 403', async () => {
		const res = await post({
			headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
			body: JSON.stringify({ name: 'x', description: 'y' }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
	});

	it('allows a same-origin state-changing request', async () => {
		const res = await post({
			headers: {
				'Content-Type': 'application/json',
				Origin: 'http://localhost',
				Host: 'localhost',
			},
			body: JSON.stringify({ name: 'P', description: 'd' }),
		});
		expect(res.status).not.toBe(403);
	});

	it('rejects the same host on a different scheme', async () => {
		const res = await post({
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://localhost',
				Host: 'localhost',
			},
			body: JSON.stringify({ name: 'P', description: 'd' }),
		});
		expect(res.status).toBe(403);
	});

	it('uses the forwarded protocol when checking the request origin', async () => {
		const res = await post({
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://localhost',
				Host: 'localhost',
				'X-Forwarded-Proto': 'https',
			},
			body: JSON.stringify({ name: 'P', description: 'd' }),
		});
		expect(res.status).not.toBe(403);
	});

	it('allows a request with no Origin (non-browser client)', async () => {
		const res = await post({
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'P', description: 'd' }),
		});
		expect(res.status).not.toBe(403);
	});

	it('does not block safe (GET) cross-origin requests', async () => {
		const res = await createTestApi().app.request('/api/v1/projects', {
			method: 'GET',
			headers: { Origin: 'https://evil.example.com' },
		});
		expect(res.status).not.toBe(403);
	});

	it('rejects a cross-site request flagged by Sec-Fetch-Site (Origin stripped)', async () => {
		const res = await post({
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
			body: JSON.stringify({ name: 'x', description: 'y' }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
	});

	it('rejects a same-site (sibling subdomain) request via Sec-Fetch-Site', async () => {
		const res = await post({
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' },
			body: JSON.stringify({ name: 'x', description: 'y' }),
		});
		expect(res.status).toBe(403);
	});

	it('allows a same-origin request flagged by Sec-Fetch-Site', async () => {
		const res = await post({
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
			body: JSON.stringify({ name: 'P', description: 'd' }),
		});
		expect(res.status).not.toBe(403);
	});

	it('allows a cross-origin request from a policy.allowedOrigins origin (both signals)', async () => {
		const allowedApp = createTestApi({
			deps: { policy: { allowedOrigins: ['https://trusted.example.com'] } },
		}).app;
		const res = await allowedApp.request('/api/v1/projects', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://trusted.example.com',
				// Both the Sec-Fetch-Site branch and the exact-origin branch
				// must clear via the allowlist.
				'Sec-Fetch-Site': 'cross-site',
				Host: 'hub.example.com',
			},
			body: JSON.stringify({ name: 'P', description: 'd' }),
		});
		expect(res.status).not.toBe(403);
	});

	it('rejects a state-changing request with a malformed/unparseable Origin (403)', async () => {
		// `garbage` is not a parseable URL → no host derived → not same-origin, not
		// allowlisted → rejected.
		const res = await post({
			headers: { 'Content-Type': 'application/json', Origin: 'garbage', Host: 'localhost' },
			body: JSON.stringify({ name: 'x', description: 'y' }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
	});
});
