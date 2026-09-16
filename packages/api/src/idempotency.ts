import type { Context } from 'hono';
import type { ApiDeps, HonoEnv } from './context';

export async function idempotentCreate<T>(
	c: Context<HonoEnv>,
	routeId: string,
	produce: () => Promise<T>,
): Promise<T> {
	const key = c.req.header('Idempotency-Key');
	return idempotentOperation(c.get('deps'), `${c.get('user').id}:${routeId}`, key, produce);
}

// Authorize before replay lookup. Concurrent first requests can both execute.
export async function idempotentOperation<T>(
	deps: ApiDeps,
	scope: string,
	key: string | undefined,
	produce: () => Promise<T>,
): Promise<T> {
	if (!key) return produce();
	const { idempotency } = deps.services;

	const hit = await idempotency.lookup(scope, key);
	if (hit) return hit.data as T;

	const data = await produce();
	await idempotency.record(scope, key, data);
	return data;
}
