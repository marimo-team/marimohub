import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../../../ports/auth';
import { makeFakeSandbox } from '../../../testing/fakes';
import { marimoSurface } from './marimo';
import { SurfaceRegistry } from './registry';
import type { SurfaceContext } from './types';
import { vscodeSurface } from './vscode';

const context: SurfaceContext = {
	sessionId: 'sess_test',
	projectId: 'proj_test',
	notebookId: 'nb_test',
	workspaceDir: '/workspace',
	processWorkspaceDir: '/workspace',
	notebookFile: 'notebook.py',
	user: { id: 'user_test', email: 'user@example.com' } as AuthUser,
	editIntent: 'persistent',
	exposure: 'proxy',
	basePath: '/surface-proxy/token/vscode',
	userDataDir: '/tmp/.marimohub/surfaces/sess_test/vscode',
};

describe('vscodeSurface', () => {
	it('prepares settings outside the workspace and launches under the proxy base path', async () => {
		const { instance, calls } = makeFakeSandbox();
		const surface = vscodeSurface({ settings: { 'editor.fontSize': 14 } });
		expect(surface.proxyPath).toBe('strip-prefix');
		await surface.prepare?.(instance, context);

		expect(calls.writeFile[0].path).toBe(`${context.userDataDir}/User/settings.json`);
		expect(JSON.parse(String(calls.writeFile[0].content))).toMatchObject({
			'files.autoSave': 'afterDelay',
			'editor.fontSize': 14,
			'python.defaultInterpreterPath': '/workspace/.venv/bin/python',
		});
		expect(surface.command(context, 8443).cmd).toEqual(
			expect.arrayContaining([
				'--bind-addr',
				'0.0.0.0:8443',
				'--user-data-dir',
				context.userDataDir,
			]),
		);
		expect(surface.command(context, 8443).cmd).not.toContain('--abs-proxy-base-path');
	});

	it('uses OpenVSCode machine settings and its supported server base path', async () => {
		const { instance, calls } = makeFakeSandbox();
		const surface = vscodeSurface({
			flavor: 'openvscode',
			settings: { 'editor.fontSize': 14 },
		});
		expect(surface.proxyPath).toBe('preserve-prefix');
		await surface.prepare?.(instance, context);

		expect(calls.writeFile[0].path).toBe(`${context.userDataDir}/data/Machine/settings.json`);
		expect(JSON.parse(String(calls.writeFile[0].content))).toMatchObject({
			'files.autoSave': 'afterDelay',
			'editor.fontSize': 14,
			'python.defaultInterpreterPath': '/workspace/.venv/bin/python',
		});
		expect(surface.command(context, 8443).cmd).toEqual(
			expect.arrayContaining([
				'--disable-workspace-trust',
				'--user-data-dir',
				context.userDataDir,
				'--extensions-dir',
				'/opt/marimohub/vscode-extensions',
				'--server-base-path',
				context.basePath,
			]),
		);
	});

	it('uses the configured project environment for the Python interpreter', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async () => ({ success: true, stdout: '/opt/project-env', stderr: '' });

		await vscodeSurface().prepare?.(instance, context);

		expect(JSON.parse(String(calls.writeFile[0].content))).toMatchObject({
			'python.defaultInterpreterPath': '/opt/project-env/bin/python',
		});
	});

	it('reports the selected flavor as unavailable when its binary is absent', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async () => ({
			success: false,
			stdout: '',
			stderr: 'not found',
			error: { code: 'COMMAND_FAILED' },
		});

		await expect(vscodeSurface({ flavor: 'openvscode' }).probe(instance)).resolves.toEqual({
			available: false,
			reason: 'The sandbox image does not include openvscode-server',
		});
	});

	it('does not pass an empty base path to OpenVSCode', () => {
		const command = vscodeSurface({ flavor: 'openvscode' }).command(
			{ ...context, basePath: undefined },
			8443,
		).cmd;

		expect(command).not.toContain('--server-base-path');
	});

	it.each(['code-server', 'openvscode'] as const)(
		'builds a workspace-contained open URL for %s',
		(flavor) => {
			const url = vscodeSurface({ flavor }).openUrl(
				new URL('https://hub.example/surface-proxy/token/vscode/'),
				{ ...context, processWorkspaceDir: '/tmp/local sandbox/workspace' },
				{ open: 'reports/weekly report.qmd' },
			);
			expect(url.pathname).toBe('/surface-proxy/token/vscode/');
			expect(url.searchParams.get('folder')).toBe('/tmp/local sandbox/workspace');
			expect(url.searchParams.has('file')).toBe(false);
			expect(JSON.parse(url.searchParams.get('payload')!)).toEqual([
				[
					'openFile',
					'vscode-remote://hub.example/tmp/local%20sandbox/workspace/reports/weekly%20report.qmd',
				],
			]);
		},
	);

	it('can disable the extension gallery for air-gapped sandboxes', () => {
		const launch = vscodeSurface({ extensionGallery: 'none' }).command(context, 8443);
		expect(JSON.parse(launch.env!.EXTENSIONS_GALLERY)).toEqual({ serviceUrl: '' });
	});
});

describe('SurfaceRegistry', () => {
	it('requires one primary and resolves registered surfaces', () => {
		const vscode = vscodeSurface();
		const registry = new SurfaceRegistry([marimoSurface, vscode]);
		expect(registry.get('vscode')).toBe(vscode);
		expect(() => new SurfaceRegistry([vscode])).toThrow(/exactly one primary/);
	});
});
