import { readFileFailure } from '../../ports/sandbox';
import { AGENT_HOME_FILES_MANIFEST } from '../integrations/agentContext';
import { expect, it, vi } from 'vitest';
import { makeFakeSandbox } from '../../testing/fakes';
import { resolveAgentHomeFiles } from './agentContextFiles';

const files = [{ path: '.claude/CLAUDE.md', content: 'instructions', relativeTo: 'home' as const }];

function restoredSandbox(paths: string[], home = '/home/appuser') {
	return makeFakeSandbox({
		files: { [AGENT_HOME_FILES_MANIFEST]: JSON.stringify({ home, paths }) },
	});
}

it.each(['/home/custom', '/root', ''])(
	'resolves HOME %s without placing files in the workspace',
	async (home) => {
		const { instance } = makeFakeSandbox();
		instance.exec = vi.fn(async () => ({ success: true as const, stdout: home, stderr: '' }));
		expect(await resolveAgentHomeFiles(instance, files, '/workspace')).toContainEqual({
			path: `${home || '/home/appuser'}/.claude/CLAUDE.md`,
			content: 'instructions',
		});
	},
);
it('uses the adapter home in sandbox file coordinates', async () => {
	const { instance } = makeFakeSandbox();
	instance.getHomeDirectory = async () => '/home/isolated';
	instance.exec = vi.fn();
	expect((await resolveAgentHomeFiles(instance, files, '/workspace'))[0].path).toBe(
		'/home/isolated/.claude/CLAUDE.md',
	);
	expect(instance.exec).not.toHaveBeenCalled();
});
it.each(['/workspace', '/workspace/home', 'relative', '/home/../workspace', '/home/user\n'])(
	'rejects unsafe home %s',
	async (home) => {
		const { instance } = makeFakeSandbox();
		instance.getHomeDirectory = async () => home;
		await expect(resolveAgentHomeFiles(instance, files, '/workspace')).rejects.toThrow();
	},
);
it.each(['.ssh/config', '.claude/../other', '.agents/skills/marimo-pair/SKILL.md'])(
	'rejects a home target outside the allowlist: %s',
	async (path) => {
		const { instance } = makeFakeSandbox();
		await expect(
			resolveAgentHomeFiles(instance, [{ ...files[0], path }], '/workspace'),
		).rejects.toThrow(/allowed home paths/);
	},
);
it('does not inspect HOME for ordinary integration files', async () => {
	const { instance, calls } = makeFakeSandbox();
	instance.exec = vi.fn();
	const ordinary = [{ path: '/tmp/marimohub-integrations/file', content: 'config' }];
	expect(await resolveAgentHomeFiles(instance, ordinary, '/workspace')).toEqual(ordinary);
	expect(instance.exec).not.toHaveBeenCalled();
	expect(calls.readFile).toEqual([]);
});

it('reads the snapshot manifest while HOME lookup is pending', async () => {
	const { instance, calls } = restoredSandbox(['.claude/CLAUDE.md']);
	const home = Promise.withResolvers<string>();
	instance.getHomeDirectory = () => home.promise;
	const resolved = resolveAgentHomeFiles(instance, files, '/workspace', true);
	expect(calls.readFile).toEqual([AGENT_HOME_FILES_MANIFEST]);
	home.resolve('/home/appuser');
	await resolved;
	expect(calls.exec).toEqual([]);
});

it('removes only obsolete hub files when restoring a filesystem snapshot', async () => {
	const { instance, calls } = restoredSandbox([
		'.claude/CLAUDE.md',
		'.agents/skills/obsolete/SKILL.md',
		'.claude/skills/obsolete/SKILL.md',
	]);
	instance.getHomeDirectory = async () => '/home/appuser';
	const result = await resolveAgentHomeFiles(instance, files, '/workspace', true);
	expect(calls.exec).toEqual([
		"rm -f -- '/home/appuser/.agents/skills/obsolete/SKILL.md' '/home/appuser/.claude/skills/obsolete/SKILL.md'",
	]);
	expect(JSON.parse(result.find((file) => file.path.endsWith('home-files.json'))!.content)).toEqual(
		{ home: '/home/appuser', paths: ['.claude/CLAUDE.md'] },
	);
});
it('removes previous instructions when the integration is disabled on restore', async () => {
	const { instance, calls } = restoredSandbox(['.claude/CLAUDE.md']);
	expect(await resolveAgentHomeFiles(instance, [], '/workspace', true)).toEqual([]);
	expect(calls.exec).toEqual([
		`rm -f -- '/home/appuser/.claude/CLAUDE.md' '${AGENT_HOME_FILES_MANIFEST}'`,
	]);
});
it('rejects snapshot cleanup paths outside the home allowlist', async () => {
	const { instance, calls } = restoredSandbox(['.agents/skills/marimo-pair/SKILL.md']);
	await expect(resolveAgentHomeFiles(instance, [], '/workspace', true)).rejects.toThrow(
		/allowed home paths/,
	);
	expect(calls.exec).toEqual([]);
});

it('supports a root HOME without producing double slashes', async () => {
	const { instance } = makeFakeSandbox();
	instance.getHomeDirectory = async () => '/';
	expect(await resolveAgentHomeFiles(instance, files, '/workspace')).toContainEqual({
		path: '/.claude/CLAUDE.md',
		content: 'instructions',
	});
});

it.each(['failure', 'truncated', 'truncated trailing separator', 'rejected'] as const)(
	'stops when HOME lookup is %s',
	async (mode) => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async () => {
			if (mode === 'rejected') throw new Error('sandbox offline');
			if (mode === 'failure')
				return {
					success: false,
					stdout: '',
					stderr: 'private details',
					error: { code: 'COMMAND_FAILED' },
				};
			return {
				success: true,
				stdout:
					mode === 'truncated trailing separator'
						? `/${'x'.repeat(4094)}/`
						: `/${'x'.repeat(4095)}`,
				stderr: '',
			};
		};
		await expect(resolveAgentHomeFiles(instance, files, '/workspace')).rejects.toThrow();
		expect(calls.writeFiles).toEqual([]);
	},
);

it.each([
	'{broken-private-content',
	'null',
	'[]',
	'{"home":"/root","paths":[123]}',
	'{"home":"/root","paths":[],"private-extra":true}',
])('rejects corrupt snapshot manifests without exposing their content', async (content) => {
	const { instance, calls } = makeFakeSandbox({
		files: { [AGENT_HOME_FILES_MANIFEST]: content },
	});
	await expect(resolveAgentHomeFiles(instance, [], '/workspace', true)).rejects.toThrow(
		'Invalid previous agent context file list.',
	);
	expect(calls.exec).toEqual([]);
});

it('tolerates snapshots created before agent context existed', async () => {
	const { instance, calls } = makeFakeSandbox();
	expect(await resolveAgentHomeFiles(instance, [], '/workspace', true)).toEqual([]);
	expect(calls.exec).toEqual([]);
});

it('fails closed on snapshot manifest read errors', async () => {
	const { instance } = makeFakeSandbox();
	instance.readFile = async () => readFileFailure();
	await expect(resolveAgentHomeFiles(instance, [], '/workspace', true)).rejects.toThrow(
		'Could not read the previous agent context file list.',
	);
});

it('fails closed when obsolete files cannot be removed', async () => {
	const { instance } = restoredSandbox(['.claude/CLAUDE.md'], '/root');
	instance.exec = async () => ({
		success: false,
		stdout: '',
		stderr: 'private details',
		error: { code: 'COMMAND_FAILED' },
	});
	await expect(resolveAgentHomeFiles(instance, [], '/workspace', true)).rejects.toThrow(
		'Could not remove previous agent context files.',
	);
});

it('validates the complete cleanup list before deleting any file', async () => {
	const { instance, calls } = restoredSandbox(
		['.claude/CLAUDE.md', '../workspace/notebook.py'],
		'/root',
	);
	await expect(resolveAgentHomeFiles(instance, [], '/workspace', true)).rejects.toThrow(
		/allowed home paths/,
	);
	expect(calls.exec).toEqual([]);
});

it('cleans the old home when a restored sandbox reports a different home', async () => {
	const { instance, calls } = restoredSandbox(['.claude/CLAUDE.md'], '/home/old');
	instance.getHomeDirectory = async () => '/home/new';
	const result = await resolveAgentHomeFiles(instance, files, '/workspace', true);
	expect(calls.exec).toEqual(["rm -f -- '/home/old/.claude/CLAUDE.md'"]);
	expect(result).toContainEqual({ path: '/home/new/.claude/CLAUDE.md', content: 'instructions' });
});
