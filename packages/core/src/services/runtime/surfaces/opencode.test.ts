import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../../../ports/auth';
import { makeFakeSandbox } from '../../../testing/fakes';
import { opencodeSurface } from './opencode';
import type { SurfaceContext } from './types';

const context: SurfaceContext = {
	sessionId: 'sess_test',
	projectId: 'proj_test',
	notebookId: 'nb_test',
	workspaceDir: '/workspace',
	processWorkspaceDir: '/workspace',
	notebookFile: 'notebook.py',
	user: { id: 'user_test', email: 'user@example.com' } as AuthUser,
	editIntent: 'persistent',
	exposure: 'subdomain',
	userDataDir: '/tmp/.marimohub/surfaces/sess_test/opencode',
};

describe('opencodeSurface', () => {
	it('uses sandbox-local state and starts the web server', async () => {
		const { instance, calls } = makeFakeSandbox();
		const surface = opencodeSurface();

		await surface.prepare?.(instance, context);

		expect(surface.supportedExposures).toEqual(['subdomain']);
		expect(surface.readiness.path).toBe('/global/health');
		expect(calls.writeFile[0].path).toBe(`${context.userDataDir}/config/opencode/opencode.json`);
		expect(JSON.parse(String(calls.writeFile[0].content))).toEqual({
			$schema: 'https://opencode.ai/config.json',
		});
		expect(surface.command(context, 4096)).toEqual({
			cmd: [
				'env',
				`XDG_CONFIG_HOME=${context.userDataDir}/config`,
				`XDG_DATA_HOME=${context.userDataDir}/data`,
				`XDG_CACHE_HOME=${context.userDataDir}/cache`,
				`XDG_STATE_HOME=${context.userDataDir}/state`,
				`OPENCODE_CONFIG=${context.userDataDir}/config/opencode/opencode.json`,
				'OPENCODE_DISABLE_AUTOUPDATE=true',
				'opencode',
				'web',
				'--hostname',
				'0.0.0.0',
				'--port',
				'4096',
			],
		});
		expect(surface.openUrl(new URL('https://surface.example/'), context, {})).toEqual(
			new URL('https://surface.example/L3dvcmtzcGFjZQ/session'),
		);
	});

	it('reports the installed version', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async () => ({
			success: true,
			stdout: '1.18.17\n',
			stderr: '',
		});
		const surface = opencodeSurface();

		await expect(surface.probe(instance)).resolves.toEqual({
			available: true,
			version: '1.18.17',
		});
	});

	it('writes managed AI as an overridable custom provider', async () => {
		const { instance, calls } = makeFakeSandbox();
		const surface = opencodeSurface({
			managedAi: {
				baseUrl: 'https://hub.example/api/ai/v1',
				apiKey: 'session-token',
				model: 'gpt-test',
			},
		});

		await surface.prepare?.(instance, context);

		expect(JSON.parse(String(calls.writeFile[0].content))).toMatchObject({
			model: 'marimohub/gpt-test',
			small_model: 'marimohub/gpt-test',
			provider: {
				marimohub: {
					name: 'marimo Hub',
					npm: '@ai-sdk/openai-compatible',
					options: {
						baseURL: 'https://hub.example/api/ai/v1',
						apiKey: 'session-token',
					},
					models: { 'gpt-test': { name: 'gpt-test' } },
				},
			},
		});
	});

	it('opens the most recent workspace chat session', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (cmd) => {
			calls.exec.push(cmd);
			return { success: true, stdout: 'ses_existing123\n', stderr: '' };
		};
		const surface = opencodeSurface();

		const url = await surface.resolveOpenUrl?.(
			instance,
			new URL('https://surface.example/'),
			context,
			{ port: 4096 },
		);

		expect(url).toEqual(new URL('https://surface.example/L3dvcmtzcGFjZQ/session/ses_existing123'));
		expect(calls.exec[0]).toContain('127.0.0.1:4096');
		expect(calls.exec[0]).toContain("'/workspace'");
	});

	it('falls back to the workspace composer when chat bootstrap fails', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async () => ({
			success: false,
			stdout: '',
			stderr: 'private failure',
			error: { code: 'COMMAND_FAILED' },
		});
		const surface = opencodeSurface();

		await expect(
			surface.resolveOpenUrl?.(instance, new URL('https://surface.example/'), context, {
				port: 4096,
			}),
		).resolves.toEqual(new URL('https://surface.example/L3dvcmtzcGFjZQ/session'));
	});

	it('reports a missing binary without exposing command output', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async () => ({
			success: false,
			stdout: '',
			stderr: 'private shell output',
			error: { code: 'COMMAND_FAILED' },
		});

		await expect(opencodeSurface().probe(instance)).resolves.toEqual({
			available: false,
			reason: 'The sandbox image does not include opencode',
		});
	});

	it('does not persist an empty version when the probe has no output', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async () => ({
			success: true,
			stdout: '  \n',
			stderr: '',
		});

		await expect(opencodeSurface().probe(instance)).resolves.toEqual({ available: true });
	});

	it('escapes managed provider values when it writes JSON', async () => {
		const { instance, calls } = makeFakeSandbox();
		const model = 'vendor/model"quoted';
		const surface = opencodeSurface({
			managedAi: {
				baseUrl: 'https://hub.example/api/ai/v1?tenant="one"',
				apiKey: 'token-with-"-quote',
				model,
			},
		});

		await surface.prepare?.(instance, context);
		const config = JSON.parse(String(calls.writeFile[0].content));

		expect(config).toEqual({
			$schema: 'https://opencode.ai/config.json',
			model: `marimohub/${model}`,
			small_model: `marimohub/${model}`,
			provider: {
				marimohub: {
					npm: '@ai-sdk/openai-compatible',
					name: 'marimo Hub',
					models: { [model]: { name: model } },
					options: {
						baseURL: 'https://hub.example/api/ai/v1?tenant="one"',
						apiKey: 'token-with-"-quote',
					},
				},
			},
		});
	});
});
