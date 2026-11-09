import { PromiseMemo } from '@marimo-hub/core/async';
import type { MiddlewareHandler } from 'hono';
import type { ApiDeps, HonoEnv } from './context';

const owners = new WeakMap<ApiDeps, ApiDeps>();

/** Shared budgets and caches retain the dependency bundle's original lifetime. */
export function unscopedDeps(deps: ApiDeps): ApiDeps {
	return owners.get(deps) ?? deps;
}

export function withRequestMemo(deps: ApiDeps): ApiDeps & { readMemo: PromiseMemo } {
	const scoped = { ...deps, readMemo: new PromiseMemo() };
	owners.set(scoped, unscopedDeps(deps));
	return scoped;
}

export function requestMemoMiddleware(deps: ApiDeps): MiddlewareHandler<HonoEnv> {
	return async (c, next) => {
		const scoped = withRequestMemo(deps);
		c.set('readMemo', scoped.readMemo);
		c.set('deps', scoped);
		await next();
	};
}
