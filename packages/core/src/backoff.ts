export interface JitteredBackoffOptions {
	baseMs: number;
	capMs: number;
	/** Randomized fraction of the delay: 1 is full jitter, 0.5 keeps at least half of it. */
	jitter: number;
}

/** Exponential delay in ms for zero-based `attempt`, capped at `capMs`, then jittered. */
export function jitteredBackoff(
	attempt: number,
	{ baseMs, capMs, jitter }: JitteredBackoffOptions,
): number {
	return Math.floor(Math.min(capMs, baseMs * 2 ** attempt) * (1 - jitter + Math.random() * jitter));
}
