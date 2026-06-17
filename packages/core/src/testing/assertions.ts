import { expect } from 'vitest';
import { NotFoundError } from '../errors';

/** Assert that an async operation rejects with `NotFoundError`. */
export async function expectNotFound(fn: () => Promise<unknown>): Promise<void> {
	await expect(fn()).rejects.toThrow(NotFoundError);
}

/**
 * Assert a session's `last_heartbeat` did not move backwards. Pass
 * `{ strict: true }` to require it strictly advanced.
 */
export function expectHeartbeatAdvanced(
	after: { last_heartbeat: string },
	before: { last_heartbeat: string },
	{ strict = false }: { strict?: boolean } = {},
): void {
	const a = new Date(after.last_heartbeat).getTime();
	const b = new Date(before.last_heartbeat).getTime();
	if (strict) {
		expect(a).toBeGreaterThan(b);
	} else {
		expect(a).toBeGreaterThanOrEqual(b);
	}
}
