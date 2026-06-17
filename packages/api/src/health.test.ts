import { describe, it, expect } from 'vitest';
import type { PreflightReport } from '@marimo-hub/core';
import { createTestApi } from './testing';

const report = (overrides: Partial<PreflightReport> = {}): PreflightReport => ({
	ok: true,
	fatal: false,
	checks: [{ name: 'storage', status: 'ok', message: 'reachable' }],
	...overrides,
});

const denyAuth = { authenticate: async () => null };

describe('GET /api/health', () => {
	it('shallow health is public and touches no deps', async () => {
		const { app } = createTestApi({ deps: { authenticator: denyAuth } });
		const res = await app.request('/api/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});

	it('deep health requires auth', async () => {
		const { app } = createTestApi({
			deps: { authenticator: denyAuth, preflight: async () => report() },
		});
		const res = await app.request('/api/health?deep=true');
		expect(res.status).toBe(401);
	});

	it('deep health returns 200 + checks when healthy', async () => {
		const { app } = createTestApi({ deps: { preflight: async () => report() } });
		const res = await app.request('/api/health?deep=true');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; checks: unknown[] };
		expect(body.status).toBe('ok');
		expect(body.checks).toHaveLength(1);
	});

	it('deep health returns 503 when a check fails', async () => {
		const failing = report({
			ok: false,
			checks: [{ name: 'compute', status: 'fail', message: 'unreachable' }],
		});
		const { app } = createTestApi({ deps: { preflight: async () => failing } });
		const res = await app.request('/api/health?deep=true');
		expect(res.status).toBe(503);
		expect(((await res.json()) as { status: string }).status).toBe('degraded');
	});

	it('deep health reports unavailable when preflight is not wired', async () => {
		const { app } = createTestApi();
		const res = await app.request('/api/health?deep=true');
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe('unavailable');
	});
});
