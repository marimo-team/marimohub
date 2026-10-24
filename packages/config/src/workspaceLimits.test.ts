import { describe, expect, it } from 'vitest';
import { WORKSPACE_FILE_BYTES_CEILING, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import { MAX_UPLOAD_BYTES } from '@marimo-hub/core/uploads';
import { parseWorkspaceLimits } from './workspaceLimits';

describe('workspace limits', () => {
	it('preserves defaults and accepts the maximum per-file limit', () => {
		expect(parseWorkspaceLimits({})).toEqual(WORKSPACE_LIMITS);
		expect(
			parseWorkspaceLimits({
				MARIMOHUB_WORKSPACE_MAX_FILE_BYTES: String(WORKSPACE_FILE_BYTES_CEILING),
				MARIMOHUB_WORKSPACE_MAX_BYTES: '9000000000',
				MARIMOHUB_WORKSPACE_MAX_FILES: '2000',
			}),
		).toEqual({ maxFileBytes: 64 * 1024 ** 2, maxTotalBytes: 9000000000, maxFiles: 2000 });
		expect(WORKSPACE_LIMITS.maxFileBytes).toBe(25 * 1024 * 1024);
		expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 ** 3);
	});
	it.each([
		['MARIMOHUB_WORKSPACE_MAX_FILE_BYTES', 'maxFileBytes'],
		['MARIMOHUB_WORKSPACE_MAX_BYTES', 'maxTotalBytes'],
		['MARIMOHUB_WORKSPACE_MAX_FILES', 'maxFiles'],
	] as const)('keeps other defaults when only %s is configured', (variable, field) => {
		expect(parseWorkspaceLimits({ [variable]: ' 1 ' })).toEqual({
			...WORKSPACE_LIMITS,
			[field]: 1,
		});
		for (const value of ['', ' \t ']) {
			expect(parseWorkspaceLimits({ [variable]: value })).toEqual(WORKSPACE_LIMITS);
		}
	});
	it('accepts safe integer limits for total bytes and file count', () => {
		expect(
			parseWorkspaceLimits({
				MARIMOHUB_WORKSPACE_MAX_BYTES: String(Number.MAX_SAFE_INTEGER),
				MARIMOHUB_WORKSPACE_MAX_FILES: String(Number.MAX_SAFE_INTEGER),
			}),
		).toEqual({
			...WORKSPACE_LIMITS,
			maxTotalBytes: Number.MAX_SAFE_INTEGER,
			maxFiles: Number.MAX_SAFE_INTEGER,
		});
	});
	it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992'])(
		'rejects invalid limits: %s',
		(value) => {
			for (const key of [
				'MARIMOHUB_WORKSPACE_MAX_FILE_BYTES',
				'MARIMOHUB_WORKSPACE_MAX_BYTES',
				'MARIMOHUB_WORKSPACE_MAX_FILES',
			]) {
				expect(() => parseWorkspaceLimits({ [key]: value })).toThrow(key);
			}
		},
	);
	it.each([WORKSPACE_FILE_BYTES_CEILING + 1, MAX_UPLOAD_BYTES])(
		'rejects an unsafe per-file cap: %s',
		(value) => {
			expect(() =>
				parseWorkspaceLimits({ MARIMOHUB_WORKSPACE_MAX_FILE_BYTES: String(value) }),
			).toThrow('MARIMOHUB_WORKSPACE_MAX_FILE_BYTES');
		},
	);
});
