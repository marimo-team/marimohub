import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bucket } from '@marimo-hub/core/ports/bucket';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { logEvent } from './log';

const operations = [
	'get',
	'head',
	'list',
	'put',
	'delete',
	'putStream',
	'multipart_create',
	'multipart_putPart',
	'multipart_complete',
	'multipart_abort',
] as const;
type Operation = (typeof operations)[number];
type Counts = Record<Operation, number>;

export class RequestStorage {
	private readonly current = new AsyncLocalStorage<{ counts: Counts; closed: boolean }>();

	wrap = (bucket: Bucket): Bucket => this.wrapOperations(bucket);

	private wrapOperations<T extends object>(bucket: T, prefix = ''): T {
		const methods = new Map<PropertyKey, unknown>();
		return new Proxy(bucket, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target);
				if (property === 'multipart' && value && !prefix) {
					if (!methods.has(property))
						methods.set(property, this.wrapOperations(value, 'multipart_'));
					return methods.get(property);
				}
				if (typeof value !== 'function') return value;
				if (!methods.has(property))
					methods.set(property, (...args: unknown[]) => {
						const request = this.current.getStore();
						const operation = `${prefix}${String(property)}` as Operation;
						if (request && !request.closed && operations.includes(operation))
							request.counts[operation]++;
						return value.apply(target, args);
					});
				return methods.get(property);
			},
		});
	}

	middleware: MiddlewareHandler = async (c, next) => {
		const started = performance.now();
		const request = {
			counts: Object.fromEntries(operations.map((operation) => [operation, 0])) as Counts,
			closed: false,
		};
		await this.current.run(request, async () => {
			try {
				await next();
			} finally {
				request.closed = true;
				// Static, `/_marimo`, and kernel-proxy traffic would dominate info-level log volume.
				const notable =
					c.req.path.startsWith('/api/') ||
					Object.values(request.counts).some((count) => count > 0);
				logEvent({
					level: notable ? 'info' : 'debug',
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
