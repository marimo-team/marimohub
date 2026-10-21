import { describe, expect, it } from 'vitest';
import { WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import { parseWorkspaceLimits } from './workspaceLimits';

describe('workspace limits', () => {
	it('preserves defaults and parses independent overrides', () => {
		expect(parseWorkspaceLimits({})).toEqual(WORKSPACE_LIMITS);
		expect(
			parseWorkspaceLimits({
				MARIMOHUB_WORKSPACE_MAX_FILE_BYTES: String(5 * 1024 ** 3),
				MARIMOHUB_WORKSPACE_MAX_BYTES: '9000000000',
				MARIMOHUB_WORKSPACE_MAX_FILES: '2000',
			}),
		).toEqual({ maxFileBytes: 5 * 1024 ** 3, maxTotalBytes: 9000000000, maxFiles: 2000 });
		expect(WORKSPACE_LIMITS.maxFileBytes).toBe(25 * 1024 * 1024);
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
	it('rejects a per-file cap over 5 GiB', () => {
		expect(() =>
			parseWorkspaceLimits({ MARIMOHUB_WORKSPACE_MAX_FILE_BYTES: String(5 * 1024 ** 3 + 1) }),
		).toThrow('MARIMOHUB_WORKSPACE_MAX_FILE_BYTES');
	});
});
