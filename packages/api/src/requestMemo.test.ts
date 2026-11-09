import { consumeIntegrationBudget } from './integrations/browse';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ApiDeps, HonoEnv } from './context';
import { requestMemoMiddleware, withRequestMemo } from './requestMemo';
import { makeTestDeps } from './testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';

describe('request memo middleware', () => {
	it('shares across middleware and handlers but isolates concurrent and later requests', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const app = new Hono<HonoEnv>();
		const load = vi.fn(async () => 42);
		app.use('*', requestMemoMiddleware(deps));
		const memo = (c: { get(key: 'deps'): ApiDeps }) => c.get('deps').readMemo!;
		app.use('*', async (c, next) => {
			await memo(c).read(['value'], load);
			await next();
		});
		app.get('/', async (c) => c.json(await memo(c).read(['value'], load)));
		const responses = await Promise.all([app.request('/'), app.request('/')]);
		for (const response of responses) expect(await response.json()).toBe(42);
		expect(load).toHaveBeenCalledTimes(2);
		expect(await (await app.request('/')).json()).toBe(42);
		expect(load).toHaveBeenCalledTimes(3);
		expect(deps.readMemo).toBeUndefined();
	});

	it('preserves shared rate limits across requests and nested operation scopes', () => {
		const deps = makeTestDeps(new MemoryBucket());
		for (let i = 0; i < 5; i++) {
			const scoped = withRequestMemo(withRequestMemo(deps));
			expect(consumeIntegrationBudget(scoped, 'objectSearch', 'user')).toBe(true);
		}
		expect(consumeIntegrationBudget(withRequestMemo(deps), 'objectSearch', 'user')).toBe(false);
		expect(consumeIntegrationBudget(makeTestDeps(new MemoryBucket()), 'objectSearch', 'user')).toBe(
			true,
		);
	});

	it('explicit operation refreshes replace an existing scope without changing shared services', async () => {
		const deps = withRequestMemo(makeTestDeps(new MemoryBucket()));
		await deps.readMemo.read(['value'], () => 1);
		const refreshed = withRequestMemo(deps);
		expect(refreshed.services).toBe(deps.services);
		expect(refreshed.readMemo).not.toBe(deps.readMemo);
		expect(await refreshed.readMemo.read(['value'], () => 2)).toBe(2);
		expect(await deps.readMemo.read(['value'], () => 3)).toBe(1);
	});
});
