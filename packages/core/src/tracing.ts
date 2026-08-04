/**
 * OTEL span wrapper for services and ports. `@opentelemetry/api` is a pure,
 * isomorphic facade: without a registered global provider every span is a
 * non-recording no-op, so this file is safe in any entrypoint (Node, Workers).
 *
 * Attributes are allowlist-only: a method gets attributes only via an explicit
 * extractor, because raw arguments can carry secrets (bearer tokens, emails,
 * notebook content). Extractors must emit identifiers and storage keys only.
 */
import type { Attributes } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';

export type AttrExtractors<T> = {
	[K in keyof T]?: T[K] extends (...args: infer A) => unknown ? (...args: A) => Attributes : never;
};

/**
 * Wrap every method of `target` in a span named `{name}.{method}`. `name` is
 * explicit (not `constructor.name`) so span names survive minification. Sync
 * methods stay sync; async rejections mark the span as an error and rethrow.
 */
export function traced<T extends object>(
	name: string,
	target: T,
	attrs: AttrExtractors<T> = {},
): T {
	const tracer = trace.getTracer('@marimo-hub/core');
	// Param tuples are erased for the dynamic per-property lookup; each extractor
	// still only ever receives its own method's arguments.
	const extractors = attrs as Partial<Record<string, (...args: unknown[]) => Attributes>>;
	// Cache wrappers so repeated property access returns the same function.
	const wrapped = new Map<string, (...args: unknown[]) => unknown>();

	return new Proxy(target, {
		get(obj, prop, receiver) {
			const value: unknown = Reflect.get(obj, prop, receiver);
			if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'constructor') {
				return value;
			}
			let fn = wrapped.get(prop);
			if (!fn) {
				fn = (...args) =>
					tracer.startActiveSpan(
						`${name}.${prop}`,
						{ attributes: extractors[prop]?.(...args) },
						(span) => {
							const fail = (err: unknown) => {
								span.recordException(err instanceof Error ? err : String(err));
								span.setStatus({ code: SpanStatusCode.ERROR });
							};
							try {
								// `obj` (not the proxy) as `this` so private-field access is unaffected.
								const result: unknown = value.apply(obj, args);
								if (result instanceof Promise) {
									return result
										.catch((err: unknown) => {
											fail(err);
											throw err;
										})
										.finally(() => span.end());
								}
								span.end();
								return result;
							} catch (err) {
								fail(err);
								span.end();
								throw err;
							}
						},
					);
				wrapped.set(prop, fn);
			}
			return fn;
		},
	});
}
