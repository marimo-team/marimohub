import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bucket } from '@marimo-hub/core/ports/bucket';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { logEvent } from './log';

const operations = ['get', 'head', 'list', 'put', 'delete'] as const;
type Operation = (typeof operations)[number];
type Counts = Record<Operation, number>;

export class RequestStorage {
	private readonly current = new AsyncLocalStorage<{ counts: Counts; closed: boolean }>();

	wrap = (bucket: Bucket): Bucket => {
		const methods = new Map<PropertyKey, unknown>();
		return new Proxy(bucket, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target);
				if (typeof value !== 'function') return value;
				if (!methods.has(property))
					methods.set(property, (...args: unknown[]) => {
						const request = this.current.getStore();
						if (request && !request.closed && operations.includes(property as Operation))
							request.counts[property as Operation]++;
						return value.apply(target, args);
					});
				return methods.get(property);
			},
		});
	};

	middleware: MiddlewareHandler = async (c, next) => {
		const started = performance.now();
		const request = { counts: { get: 0, head: 0, list: 0, put: 0, delete: 0 }, closed: false };
		await this.current.run(request, async () => {
			try {
				await next();
			} finally {
				request.closed = true;
				logEvent({
					level: 'info',
					event: 'request',
					method: c.req.method,
					route: routePath(c, -1) || 'unmatched',
					status: c.res.status,
					duration_ms: Math.round(performance.now() - started),
					storage_ops: { ...request.counts },
				});
			}
		});
	};
}
