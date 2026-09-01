import type { SurfaceSpec } from './types';

export const marimoSurface: SurfaceSpec = {
	id: 'marimo',
	primary: true,
	defaultPort: 2718,
	supportedExposures: ['proxy', 'subdomain'],
	proxyPath: 'preserve-prefix',
	async probe() {
		return { available: true };
	},
	command() {
		throw new Error('The primary marimo surface is launched by SandboxProvisioner');
	},
	readiness: { path: '/', timeoutMs: 120_000 },
	openUrl(base) {
		return base;
	},
};
