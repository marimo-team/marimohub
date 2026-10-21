import { expect, it, vi } from 'vitest';
import { makeFakeSandbox } from '../../testing/fakes';
import { AGENT_CONTEXT_DIR } from '../integrations/agentContext';
import { prepareAgentHomeFiles } from './agentContextFiles';

const files = [{ path: '.claude/CLAUDE.md', content: 'instructions', relativeTo: 'home' as const }];

it('batches home content into an upload without querying HOME first', async () => {
	const { instance, calls } = makeFakeSandbox();
	const prepared = await prepareAgentHomeFiles(instance, files, '/workspace');
	expect(calls.exec).toEqual([]);
	expect(calls.readFile).toEqual([]);
	expect(prepared.files).toHaveLength(1);
	expect(JSON.parse(prepared.files[0].content)).toEqual({
		root: '/',
		workdir: '/workspace',
		restored: false,
		files: [{ path: '.claude/CLAUDE.md', content: 'instructions' }],
	});
	await instance.writeFiles(prepared.files);
	await prepared.install!();
	expect(calls.writeFiles).toHaveLength(1);
	expect(calls.exec).toHaveLength(1);
	expect(calls.exec[0]).toContain('python3 -I -c');
	expect(calls.exec[0]).not.toContain('instructions');
});

it('uses adapter file coordinates and maps the installer payload to process coordinates', async () => {
	const { instance, calls } = makeFakeSandbox();
	instance.getHomeDirectory = async () => '/home/isolated';
	instance.resolveProcessPath = (path) => `/sandbox${path}`;
	const prepared = await prepareAgentHomeFiles(instance, files, '/workspace');
	expect(JSON.parse(prepared.files[0].content)).toMatchObject({
		root: '/sandbox/',
		home: '/home/isolated',
		workdir: '/workspace',
	});
	await prepared.install!();
	expect(calls.exec[0]).toContain(`'/sandbox${prepared.files[0].path}'`);
});

it.each(['.ssh/config', '.claude/../other', '.agents/skills/marimo-pair/SKILL.md'])(
	'rejects a target outside the home allowlist: %s',
	async (path) => {
		const { instance, calls } = makeFakeSandbox();
		await expect(
			prepareAgentHomeFiles(instance, [{ ...files[0], path }], '/workspace'),
		).rejects.toThrow(/allowed home paths/);
		expect(calls.exec).toEqual([]);
		expect(calls.writeFiles).toEqual([]);
	},
);

it('does not add requests or uploads for ordinary integration files', async () => {
	const { instance, calls } = makeFakeSandbox();
	instance.getHomeDirectory = vi.fn();
	const ordinary = [{ path: '/tmp/marimohub-integrations/file', content: 'config' }];
	expect(await prepareAgentHomeFiles(instance, ordinary, '/workspace')).toEqual({
		files: ordinary,
	});
	expect(instance.getHomeDirectory).not.toHaveBeenCalled();
	expect(calls.exec).toEqual([]);
	expect(calls.readFile).toEqual([]);
});

it('keeps ordinary files in the same batch as the home payload', async () => {
	const { instance } = makeFakeSandbox();
	const ordinary = { path: '/tmp/marimohub-integrations/file', content: 'config' };
	const prepared = await prepareAgentHomeFiles(instance, [ordinary, ...files], '/workspace');
	expect(prepared.files).toHaveLength(2);
	expect(prepared.files[0]).toEqual(ordinary);
});

it('requests restore cleanup even after the integration was removed', async () => {
	const { instance, calls } = makeFakeSandbox();
	const prepared = await prepareAgentHomeFiles(instance, [], '/workspace', true);
	expect(prepared.files).toEqual([]);
	await prepared.install!();
	expect(calls.exec).toHaveLength(1);
	expect(calls.exec[0]).toContain('--inline');
	expect(calls.exec[0]).toContain('\\u002fworkspace');
	expect(calls.exec[0]).toContain('"files":[],"restored":true');
	expect(calls.readFile).toEqual([]);
});

it.each([{ files }, { files: [{ path: `${AGENT_CONTEXT_DIR}/opencode.json`, content: '{}' }] }])(
	'rejects agent context with a root workspace before any sandbox requests',
	async ({ files }) => {
		const { instance, calls } = makeFakeSandbox();
		await expect(prepareAgentHomeFiles(instance, files, '/')).rejects.toThrow(
			'Agent context requires a workspace directory other than /.',
		);
		expect(calls.exec).toEqual([]);
		expect(calls.writeFiles).toEqual([]);
	},
);

it.each([
	['invalid_home', 'Invalid sandbox home directory.'],
	['invalid_manifest', 'Invalid previous agent context file list.'],
	['unsafe_path', 'Agent context paths must not contain symlinks or enter the workspace.'],
	['root_workspace', 'Agent context requires a workspace directory other than /.'],
	['private raw output', 'Could not install agent context files.'],
])('reports installer failure %s without exposing command output', async (stdout, message) => {
	const { instance } = makeFakeSandbox();
	instance.exec = async () => ({
		success: false,
		stdout,
		stderr: 'private error',
		error: { code: 'COMMAND_FAILED' },
	});
	const prepared = await prepareAgentHomeFiles(instance, files, '/workspace');
	await expect(prepared.install!()).rejects.toThrow(message);
});

it('propagates adapter HOME lookup failures before preparing uploads', async () => {
	const { instance, calls } = makeFakeSandbox();
	instance.getHomeDirectory = async () => {
		throw new Error('sandbox offline');
	};
	await expect(prepareAgentHomeFiles(instance, files, '/workspace')).rejects.toThrow(
		'sandbox offline',
	);
	expect(calls.exec).toEqual([]);
	expect(calls.writeFiles).toEqual([]);
});
