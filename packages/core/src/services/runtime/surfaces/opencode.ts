import type { SurfaceSpec } from './types';

export interface OpenCodeManagedAiOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export interface OpenCodeSurfaceOptions {
	port?: number;
	memoryMb?: number;
	managedAi?: OpenCodeManagedAiOptions;
}

function openCodeConfig(managedAi: OpenCodeManagedAiOptions | undefined): string {
	return JSON.stringify(
		{
			$schema: 'https://opencode.ai/config.json',
			...(managedAi
				? {
						provider: {
							marimohub: {
								npm: '@ai-sdk/openai-compatible',
								name: 'marimohub',
								options: {
									baseURL: managedAi.baseUrl,
									apiKey: managedAi.apiKey,
								},
								models: {
									[managedAi.model]: { name: managedAi.model },
								},
							},
						},
						model: `marimohub/${managedAi.model}`,
					}
				: {}),
		},
		null,
		2,
	);
}

export function opencodeSurface(options: OpenCodeSurfaceOptions = {}): SurfaceSpec {
	return {
		id: 'opencode',
		primary: false,
		defaultPort: options.port ?? 4096,
		supportedExposures: ['subdomain'],
		proxyPath: 'strip-prefix',
		resources: { memoryMb: options.memoryMb ?? 1024 },
		async probe(instance) {
			const result = await instance.exec(
				`command -v opencode >/dev/null 2>&1 && opencode --version`,
				{ timeout: 10_000 },
			);
			if (!result.success) {
				return {
					available: false,
					reason: 'The sandbox image does not include opencode',
				};
			}
			const version = result.stdout.trim().split(/\s+/)[0];
			return { available: true, ...(version ? { version } : {}) };
		},
		async prepare(instance, ctx) {
			await instance.writeFiles([
				{
					path: `${ctx.userDataDir}/config/opencode.json`,
					content: openCodeConfig(options.managedAi),
				},
			]);
		},
		command(ctx, port) {
			return {
				cmd: ['opencode', 'web', '--hostname', '0.0.0.0', '--port', String(port)],
				env: {
					XDG_CONFIG_HOME: `${ctx.userDataDir}/config`,
					XDG_DATA_HOME: `${ctx.userDataDir}/data`,
					XDG_CACHE_HOME: `${ctx.userDataDir}/cache`,
					XDG_STATE_HOME: `${ctx.userDataDir}/state`,
					OPENCODE_CONFIG: `${ctx.userDataDir}/config/opencode.json`,
					OPENCODE_DISABLE_AUTOUPDATE: 'true',
				},
			};
		},
		readiness: { path: '/global/health', timeoutMs: 120_000 },
		openUrl(base) {
			return base;
		},
	};
}
