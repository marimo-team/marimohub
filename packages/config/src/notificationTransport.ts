import type { IntegrationProbe, ProbeRequestInit } from '@marimo-hub/core';

const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 60_000;

class NotificationHttpError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs?: number,
	) {
		super(`Notification delivery returned HTTP ${status}`);
		this.name = 'NotificationHttpError';
	}
}

function retryAfterMilliseconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(
			Math.max(DEFAULT_RATE_LIMIT_RETRY_DELAY_MS, Math.ceil(seconds * 1_000)),
			MAX_RATE_LIMIT_RETRY_DELAY_MS,
		);
	}
	const at = Date.parse(value);
	return Number.isNaN(at)
		? undefined
		: Math.min(
				Math.max(DEFAULT_RATE_LIMIT_RETRY_DELAY_MS, at - Date.now()),
				MAX_RATE_LIMIT_RETRY_DELAY_MS,
			);
}

function retryable(error: unknown): boolean {
	return (
		!(error instanceof NotificationHttpError) ||
		error.status === 408 ||
		error.status === 429 ||
		error.status >= 500
	);
}

export async function sendNotificationRequest(
	probe: IntegrationProbe,
	url: string,
	request: ProbeRequestInit,
	options: {
		retries: number;
		delay?: (milliseconds: number) => Promise<void>;
	},
): Promise<void> {
	const delay =
		options.delay ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, milliseconds);
			}));
	let lastError: unknown;
	for (let attempt = 0; attempt <= options.retries; attempt++) {
		try {
			const response = await probe.fetch(url, request);
			if (!response.ok) {
				throw new NotificationHttpError(
					response.status,
					retryAfterMilliseconds(response.headers?.['retry-after']),
				);
			}
			return;
		} catch (error) {
			lastError = error;
			if (attempt === options.retries || !retryable(error)) throw error;
			if (error instanceof NotificationHttpError && error.status === 429) {
				await delay(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS);
			}
		}
	}
	throw lastError;
}
