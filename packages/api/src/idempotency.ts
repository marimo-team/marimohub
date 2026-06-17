import type { Context } from 'hono';
import type { HonoEnv } from './context';

/**
 * Run a create handler at most once per `(user, route, Idempotency-Key)`.
 *
 * Without the header, `produce` runs unchanged (today's behavior). With it: the
 * first use runs `produce` and records its `data`; a replay (same key) returns the
 * recorded `data` without re-creating. `routeId` scopes the key to one route so the
 * same client key on `POST /projects` and `POST …/notebooks` can't collide.
 *
 * The recorded value is the response envelope's `data`; the caller re-wraps it in
 * the constant `{ success: true, data }` at its declared status, keeping the
 * OpenAPI response types intact.
 */
export async function idempotentCreate<T>(
	c: Context<HonoEnv>,
	routeId: string,
	produce: () => Promise<T>,
): Promise<T> {
	const key = c.req.header('Idempotency-Key');
	if (!key) return produce();

	const { idempotency } = c.get('deps').services;
	const scope = `${c.get('user').id}:${routeId}`;

	const hit = await idempotency.lookup(scope, key);
	if (hit) return hit.data as T;

	const data = await produce();
	await idempotency.record(scope, key, data);
	return data;
}
