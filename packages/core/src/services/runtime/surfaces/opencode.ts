import { utf8ToBase64Url } from '../../../internal/base64url';
import type { SandboxInstance } from '../../../ports/sandbox';
import { shellQuote } from '../shell';
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
	const model = managedAi ? `marimohub/${managedAi.model}` : undefined;
	return JSON.stringify(
		{
			$schema: 'https://opencode.ai/config.json',
			...(managedAi
				? {
						provider: {
							marimohub: {
								npm: '@ai-sdk/openai-compatible',
								name: 'marimo Hub',
								options: {
									baseURL: managedAi.baseUrl,
									apiKey: managedAi.apiKey,
								},
								models: {
									[managedAi.model]: { name: managedAi.model },
								},
							},
						},
						model,
						small_model: model,
					}
				: {}),
		},
		null,
		2,
	);
}

function workspaceSessionUrl(base: URL, workspaceDir: string, sessionId?: string): URL {
	const url = new URL(base);
	const workspace = utf8ToBase64Url(workspaceDir);
	url.pathname = `/${workspace}/session${sessionId ? `/${sessionId}` : ''}`;
	return url;
}

async function findOrCreateSession(
	instance: SandboxInstance,
	port: number,
	workspaceDir: string,
): Promise<string | undefined> {
	const script = [
		'import json,sys,urllib.parse,urllib.request',
		'base=sys.argv[1]+"/session"',
		'headers={"x-opencode-directory":urllib.parse.quote(sys.argv[2], safe="")}',
		'list_request=urllib.request.Request(base+"?limit=1", headers=headers)',
		'with urllib.request.urlopen(list_request, timeout=10) as response: sessions=json.load(response)',
		'if sessions: print(sessions[0]["id"])',
		'else:',
		' headers["content-type"]="application/json"',
		' request=urllib.request.Request(base, data=b"{}", headers=headers, method="POST")',
		' with urllib.request.urlopen(request, timeout=10) as response: print(json.load(response)["id"])',
	].join('\n');
	const result = await instance.exec(
		`python3 -c ${shellQuote(script)} ${shellQuote(`http://127.0.0.1:${port}`)} ${shellQuote(workspaceDir)}`,
		{ timeout: 15_000 },
	);
	if (!result.success) return undefined;
	const sessionId = result.stdout.trim();
	return /^ses_[A-Za-z0-9]+$/.test(sessionId) ? sessionId : undefined;
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
			const configPath = `${ctx.userDataDir}/config/opencode/opencode.json`;
			await instance.writeFiles([
				{
					path: configPath,
					content: openCodeConfig(options.managedAi),
				},
			]);
		},
		command(ctx, port) {
			const configPath = `${ctx.userDataDir}/config/opencode/opencode.json`;
			return {
				cmd: ['opencode', 'web', '--hostname', '0.0.0.0', '--port', String(port)],
				env: {
					XDG_CONFIG_HOME: `${ctx.userDataDir}/config`,
					XDG_DATA_HOME: `${ctx.userDataDir}/data`,
					XDG_CACHE_HOME: `${ctx.userDataDir}/cache`,
					XDG_STATE_HOME: `${ctx.userDataDir}/state`,
					OPENCODE_CONFIG: configPath,
					OPENCODE_DISABLE_AUTOUPDATE: 'true',
				},
			};
		},
		readiness: { path: '/global/health', timeoutMs: 120_000 },
		openUrl(base, ctx) {
			return workspaceSessionUrl(base, ctx.processWorkspaceDir);
		},
		async resolveOpenUrl(instance, base, ctx, { port }) {
			const sessionId = await findOrCreateSession(instance, port, ctx.processWorkspaceDir);
			return workspaceSessionUrl(base, ctx.processWorkspaceDir, sessionId);
		},
	};
}
