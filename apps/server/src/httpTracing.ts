import { httpInstrumentationMiddleware } from '@hono/otel';
import type { MiddlewareHandler } from 'hono';

export function safeHttpInstrumentation(
	options: Parameters<typeof httpInstrumentationMiddleware>[0],
): MiddlewareHandler {
	const traced = httpInstrumentationMiddleware(options);
	const metricsOnly = httpInstrumentationMiddleware({ ...options, disableTracing: true });
	// The instrumentation records full URLs at span start, before a hook could redact OAuth codes.
	return (c, next) =>
		c.req.path.endsWith('/me/github/callback') ? metricsOnly(c, next) : traced(c, next);
}
