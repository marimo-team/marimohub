import type { SagaObserver } from '@marimo-hub/core';
import { describeError, logEvent } from './log';

/**
 * Saga observer for the API layer. Accumulates step outcomes into one fields
 * object and emits a single wide-event `logEvent({ ...base, ...fields })` when
 * `flush()` is called (typically in the route's `finally`). Compensation
 * failures emit their own structured error line immediately, with the error
 * chain expanded via `describeError`. Stays dependency-free for the Workers build.
 */
export function logObserver(base: Record<string, unknown>): SagaObserver & { flush: () => void } {
	const fields: Record<string, unknown> = {};
	return {
		tag(field, value) {
			fields[field] = value;
		},
		error(message, ctx) {
			logEvent({
				level: 'error',
				...base,
				message,
				step: ctx.step,
				error: describeError(ctx.compensation_error),
				original_error: describeError(ctx.original_error),
			});
		},
		flush() {
			logEvent({ ...base, ...fields });
		},
	};
}
