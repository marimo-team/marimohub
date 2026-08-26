import { expect } from 'vitest';
import { NotFoundError } from '../errors';
import { paths } from '../paths';
import { AppClaimSchema } from '../schema';
import type { NotebookId, ProjectId, SessionId } from '../ids';
import type { Bucket } from '../ports/bucket';
import type {
	ExecResult,
	ListFilesResult,
	ReadFileResult,
	SandboxLaunchResult,
} from '../ports/sandbox';

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

/**
 * Assert an `ExecResult` has the right envelope ({ success, stdout, stderr })
 * and matches the given fields. Omitted fields aren't checked, so
 * `expectExecResult(res, { success: false, stderr: 'boom' })` ignores stdout.
 * Replaces the per-adapter hand-rolled `expect(res.success).toBe(...)` triplets.
 */
export function expectExecResult(received: ExecResult, expected: Partial<ExecResult> = {}): void {
	expect(typeof received.success).toBe('boolean');
	expect(typeof received.stdout).toBe('string');
	expect(typeof received.stderr).toBe('string');
	if (!received.success) {
		expect(['COMMAND_FAILED', 'SPAWN_FAILED', 'BACKEND_ERROR']).toContain(received.error.code);
	}
	for (const key of Object.keys(expected) as (keyof ExecResult)[]) {
		expect(received[key], key).toEqual(expected[key]);
	}
}

/**
 * Assert a `ReadFileResult` envelope ({ success, content, encoding? }) and match
 * the given fields. The provisioner's fallback contract hinges on an empty
 * failure result with a typed error code, so adapters assert this constantly.
 */
export function expectFileResult(
	received: ReadFileResult,
	expected: Partial<ReadFileResult> = {},
): void {
	expect(typeof received.success).toBe('boolean');
	expect(typeof received.content).toBe('string');
	if (!received.success) {
		expect(['NOT_FOUND', 'READ_FAILED', 'BACKEND_ERROR']).toContain(received.error.code);
	}
	for (const key of Object.keys(expected) as (keyof ReadFileResult)[]) {
		expect(received[key], key).toEqual(expected[key]);
	}
}

/**
 * Assert a `SandboxLaunchResult` envelope and match the given fields. Both arms
 * carry timings; the failure arm additionally carries a typed reason and the
 * captured output strings. Omitted fields aren't checked, so
 * `expectLaunchResult(res, { success: false })` only pins the envelope shape.
 */
export function expectLaunchResult(
	received: SandboxLaunchResult,
	expected: Partial<SandboxLaunchResult> = {},
): void {
	expect(typeof received.success).toBe('boolean');
	expect(typeof received.timings.setup).toBe('number');
	expect(typeof received.timings.start).toBe('number');
	expect(typeof received.timings.waitport).toBe('number');
	if (!received.success) {
		expect([
			'setup_exit',
			'setup_timeout',
			'kernel_exit',
			'readiness_timeout',
			'transport_failure',
		]).toContain(received.reason);
		expect(typeof received.stdout).toBe('string');
		expect(typeof received.stderr).toBe('string');
		if (received.exitCode !== undefined) expect(typeof received.exitCode).toBe('number');
	}
	for (const key of Object.keys(expected) as (keyof SandboxLaunchResult)[]) {
		expect(received[key], key).toEqual(expected[key]);
	}
}

export function expectListFilesResult(
	received: ListFilesResult,
	expected: Partial<ListFilesResult> = {},
): void {
	expect(typeof received.success).toBe('boolean');
	expect(Array.isArray(received.files)).toBe(true);
	if (!received.success) {
		expect(['NOT_A_DIRECTORY', 'LIST_FAILED', 'BACKEND_ERROR']).toContain(received.error.code);
	}
	for (const file of received.files) {
		expect(typeof file.name).toBe('string');
		expect(typeof file.absolutePath).toBe('string');
		expect(typeof file.relativePath).toBe('string');
		expect(['file', 'directory', 'symlink', 'other']).toContain(file.type);
		expect(typeof file.size).toBe('number');
	}
	for (const key of Object.keys(expected) as (keyof ListFilesResult)[]) {
		expect(received[key], key).toEqual(expected[key]);
	}
}
