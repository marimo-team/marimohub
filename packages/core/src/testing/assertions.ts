import { expect } from 'vitest';
import { NotFoundError } from '../errors';
import { paths } from '../paths';
import { AppClaimSchema } from '../schema';
import type { NotebookId, ProjectId, SessionId } from '../ids';
import type { Bucket } from '../ports/bucket';
export {
	expectExecResult,
	expectFileResult,
	expectLaunchResult,
	expectListFilesResult,
} from './resultAssertions';

/** Assert that an async operation rejects with `NotFoundError`. */
export async function expectNotFound(fn: () => Promise<unknown>): Promise<void> {
	await expect(fn()).rejects.toThrow(NotFoundError);
}

/**
 * The session holding a notebook's app singleton, or null when free. A released
 * claim is CAS'd to a free marker rather than deleted, so "no holder" is not the
 * same as "no object" — assert on this, not on the object.
 */
export async function appClaimHolder(
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<SessionId | null> {
	const obj = await bucket.get(paths.appClaim(projectId, notebookId));
	if (!obj) return null;
	return AppClaimSchema.parse(await obj.json()).session_id;
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
