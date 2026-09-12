import { expect } from 'vitest';
import type {
	ExecResult,
	ListFilesResult,
	ReadFileResult,
	SandboxLaunchResult,
} from '../ports/sandbox';

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
