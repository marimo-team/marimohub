import { expect } from 'vitest';
import { NotFoundError } from '../errors';
import type { ExecResult, ListFilesResult, ReadFileResult } from '../ports/sandbox';

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
	for (const key of Object.keys(expected) as (keyof ExecResult)[]) {
		expect(received[key], key).toEqual(expected[key]);
	}
}

/**
 * Assert a `ReadFileResult` envelope ({ success, content, encoding? }) and match
 * the given fields. The provisioner's fallback contract hinges on the failure
 * shape `{ success: false, content: '' }`, so adapters assert this constantly.
 */
export function expectFileResult(
	received: ReadFileResult,
	expected: Partial<ReadFileResult> = {},
): void {
	expect(typeof received.success).toBe('boolean');
	expect(typeof received.content).toBe('string');
	for (const key of Object.keys(expected) as (keyof ReadFileResult)[]) {
		expect(received[key], key).toEqual(expected[key]);
	}
}

export function expectListFilesResult(
	received: ListFilesResult,
	expected: Partial<ListFilesResult> = {},
): void {
	expect(typeof received.success).toBe('boolean');
	expect(Array.isArray(received.files)).toBe(true);
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
