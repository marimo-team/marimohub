import { describe, expect, it } from 'vitest';
import { MARIMO_PORT } from '../../constants';
import { resolveBridgeLauncher, sandboxKernelPort } from './notebookBridgePaths';

describe('resolveBridgeLauncher', () => {
	it('maps the sandbox-scoped launcher into the process namespace', () => {
		const bridge = { sandboxId: 'sb-1', launcher: 'marimo-bridge.py' };
		expect(resolveBridgeLauncher({}, bridge)).toBe('/tmp/marimohub-bridge/sb-1/marimo-bridge.py');
		expect(resolveBridgeLauncher({ resolveProcessPath: (path) => `/host${path}` }, bridge)).toBe(
			'/host/tmp/marimohub-bridge/sb-1/marimo-bridge.py',
		);
		expect(resolveBridgeLauncher({ resolveProcessPath: (path) => `/host${path}` })).toBeUndefined();
	});
});

describe('sandboxKernelPort', () => {
	it('uses the mapped port, or the scheme default when the mapping omits one', () => {
		expect(sandboxKernelPort({})).toBe(MARIMO_PORT);
		expect(sandboxKernelPort({ resolveProcessUrl: () => 'http://127.0.0.1:43128' })).toBe(43128);
		expect(sandboxKernelPort({ resolveProcessUrl: () => 'https://127.0.0.1' })).toBe(443);
		expect(sandboxKernelPort({ resolveProcessUrl: () => 'http://127.0.0.1' })).toBe(80);
	});

	it('falls back to the default port for an unusable mapped port', () => {
		expect(sandboxKernelPort({ resolveProcessUrl: () => 'http://127.0.0.1:0' })).toBe(MARIMO_PORT);
	});

	it('rejects a malformed mapped URL instead of sending NaN to the sandbox', () => {
		expect(() => sandboxKernelPort({ resolveProcessUrl: () => 'not a url' })).toThrow(TypeError);
	});
});
