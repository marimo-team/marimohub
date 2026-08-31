import { shellQuote } from '../shell';
import type { SurfaceSpec } from './types';

export interface VscodeSurfaceOptions {
	flavor?: 'code-server' | 'openvscode';
	port?: number;
	settings?: Record<string, unknown>;
	extensionGallery?: string;
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
	'files.autoSave': 'afterDelay',
	'files.autoSaveDelay': 1000,
	'workbench.startupEditor': 'none',
	'telemetry.telemetryLevel': 'off',
	'extensions.autoUpdate': false,
	'update.mode': 'none',
	'security.workspace.trust.enabled': false,
	'files.watcherExclude': {
		'**/__marimo__/**': true,
		'**/.venv/**': true,
		'**/__pycache__/**': true,
	},
	'search.exclude': {
		'**/__marimo__': true,
		'**/.venv': true,
	},
	'marimo.enableAutoStart': false,
};

function executable(flavor: NonNullable<VscodeSurfaceOptions['flavor']>): string {
	return flavor === 'openvscode' ? 'openvscode-server' : 'code-server';
}

function workspaceFile(workspaceDir: string, relativePath: string): string {
	return `${workspaceDir.replace(/\/+$/, '')}/${relativePath}`;
}

export function vscodeSurface(options: VscodeSurfaceOptions = {}): SurfaceSpec {
	const flavor = options.flavor ?? 'code-server';
	const binary = executable(flavor);
	return {
		id: 'vscode',
		primary: false,
		defaultPort: options.port ?? 8443,
		supportedExposures: ['proxy', 'subdomain'],
		supportsOpenPath: true,
		proxyPath: flavor === 'code-server' ? 'strip-prefix' : 'preserve-prefix',
		async probe(instance) {
			const result = await instance.exec(
				`command -v ${shellQuote(binary)} >/dev/null 2>&1 && ${shellQuote(binary)} --version`,
				{ timeout: 10_000 },
			);
			if (!result.success) {
				return {
					available: false,
					reason: `The sandbox image does not include ${binary}`,
				};
			}
			return { available: true, version: result.stdout.trim().split(/\s+/)[0] };
		},
		async prepare(instance, ctx) {
			const environment = await instance.exec(`printf '%s' "\${UV_PROJECT_ENVIRONMENT:-}"`, {
				timeout: 10_000,
			});
			const environmentPath = environment.success ? environment.stdout.trim() : '';
			const pythonPath = `${environmentPath || `${ctx.processWorkspaceDir}/.venv`}/bin/python`;
			const settings = JSON.stringify(
				{
					...DEFAULT_SETTINGS,
					'python.defaultInterpreterPath': pythonPath,
					...options.settings,
				},
				null,
				2,
			);
			await instance.writeFiles([
				{
					path:
						flavor === 'openvscode'
							? `${ctx.userDataDir}/data/Machine/settings.json`
							: `${ctx.userDataDir}/User/settings.json`,
					content: settings,
				},
			]);
		},
		command(ctx, port) {
			const common = [
				binary,
				flavor === 'openvscode' ? '--host' : '--bind-addr',
				flavor === 'openvscode' ? '0.0.0.0' : `0.0.0.0:${port}`,
			];
			if (flavor === 'openvscode') {
				common.push(
					'--port',
					String(port),
					'--without-connection-token',
					'--disable-telemetry',
					'--disable-workspace-trust',
					'--user-data-dir',
					ctx.userDataDir,
					'--extensions-dir',
					'/opt/marimohub/vscode-extensions',
				);
				if (ctx.basePath) common.push('--server-base-path', ctx.basePath);
			} else {
				common.push(
					'--auth',
					'none',
					'--disable-telemetry',
					'--disable-update-check',
					'--disable-workspace-trust',
					'--disable-getting-started-override',
					'--user-data-dir',
					ctx.userDataDir,
					'--extensions-dir',
					'/opt/marimohub/vscode-extensions',
				);
			}
			common.push(ctx.workspaceDir);
			const gallery = options.extensionGallery ?? 'openvsx';
			return {
				cmd: common,
				...(gallery === 'openvsx'
					? {}
					: {
							env: {
								EXTENSIONS_GALLERY: JSON.stringify({
									serviceUrl: gallery === 'none' ? '' : gallery,
								}),
							},
						}),
			};
		},
		readiness: {
			path: flavor === 'code-server' ? '/healthz' : '/',
			timeoutMs: 120_000,
		},
		openUrl(base, ctx, open) {
			const url = new URL(base);
			url.searchParams.set('folder', ctx.processWorkspaceDir);
			if (open.open) {
				const remote = new URL(`vscode-remote://${url.host}`);
				remote.pathname = workspaceFile(ctx.processWorkspaceDir, open.open);
				url.searchParams.set('payload', JSON.stringify([['openFile', remote.toString()]]));
			}
			return url;
		},
	};
}
