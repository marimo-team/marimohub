import { PromiseMemo, weakMemo } from '@marimo-hub/core/cache';
import type { WeakMemo } from '@marimo-hub/core/cache';
import type { MiddlewareHandler } from 'hono';
import type { ApiDeps, HonoEnv, ResolvedApiDeps } from './context';

const owners = new WeakMap<ApiDeps, ApiDeps>();

/** Shared budgets and caches retain the dependency bundle's original lifetime. */
function unscopedDeps(deps: ApiDeps): ApiDeps {
	return owners.get(deps) ?? deps;
}

/**
 * Memoize per deployment rather than per request: `withRequestMemo` spreads deps into a
 * fresh object for every request, so a plain `weakMemo` over ApiDeps would reset each time.
 * Key on the request-scoped bundle directly only when the state must capture `readMemo`.
 */
export function deploymentState<T>(create: () => T): WeakMemo<ApiDeps, T> {
	const memo = weakMemo<ApiDeps, T>(create);
	const scoped = ((deps: ApiDeps) => memo(unscopedDeps(deps))) as WeakMemo<ApiDeps, T>;
	scoped.clear = memo.clear;
	return scoped;
}

export function withRequestMemo<D extends ApiDeps>(deps: D): D & { readMemo: PromiseMemo } {
	const scoped = { ...deps, readMemo: new PromiseMemo() };
	owners.set(scoped, unscopedDeps(deps));
	return scoped;
}

export function requestMemoMiddleware(deps: ResolvedApiDeps): MiddlewareHandler<HonoEnv> {
	return async (c, next) => {
		c.set('deps', withRequestMemo(deps));
		await next();
	};
}
