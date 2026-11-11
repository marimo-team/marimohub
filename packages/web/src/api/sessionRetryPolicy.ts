import { ApiRequestError } from '@marimo-hub/client';
import { MAX_TIMER_DELAY_MS } from '@marimo-hub/core/async';

const backoff = (attempt: number) => 500 * 2 ** attempt;

export function admissionRetryDelay(error: unknown, attempt: number): number | null {
	if (
		attempt >= 2 ||
		!(error instanceof ApiRequestError) ||
		error.code === 'RESOURCE_EXHAUSTED' ||
		(error.status !== 429 && (error.status !== 503 || error.code !== 'SERVICE_UNAVAILABLE'))
	)
		return null;
	const delay = error.retryAfterMs ?? backoff(attempt);
	return delay > 30_000 ? null : Math.ceil(delay);
}

export function heartbeatRetryDelay(
	failures: number,
	intervalMs: number,
	retryAfterMs: number,
	jitter: number,
): number {
	const delay =
		failures > 0 && failures <= 3
			? backoff(failures) * (0.5 + jitter * 0.5)
			: failures > 3
				? Math.max(intervalMs, 30_000)
				: intervalMs;
	return Math.min(MAX_TIMER_DELAY_MS, Math.floor(Math.max(retryAfterMs, delay)));
}
