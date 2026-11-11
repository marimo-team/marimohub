import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it as base } from 'vitest';
import { AGENT_HOME_FILES_MANIFEST } from '../integrations/agentContext';
import { runPythonCases } from '../../testing/pythonCases';
import { INSTALL_AGENT_CONTEXT } from './agentContextInstall';

const instruction = '.claude/CLAUDE.md';
const skill = '.agents/skills/analytics/SKILL.md';
const home = '/home/appuser';

interface InstallOptions {
	root?: string;
	home?: string;
	workdir?: string;
	files?: { path: string; content: string }[];
	restored?: boolean;
}

interface Fixtures {
	root: string;
	write: (path: string, content: string) => void;
	read: (path: string) => string;
	manifest: (paths: string[], previousHome?: string) => void;
	run: (
		arguments_: string[],
		environmentHome?: string,
		prefix?: string,
		input?: string,
	) => Promise<{ status: number; stdout: string }>;
	install: (
		options?: InstallOptions,
		environmentHome?: string,
		prefix?: string,
	) => Promise<{ status: number; stdout: string }>;
}

const it = base.extend<Fixtures>({
	// oxlint-disable-next-line no-empty-pattern -- vitest requires a destructuring pattern here
	root: async ({}, provide) => {
		const root = mkdtempSync(join(tmpdir(), 'agent-context-'));
		mkdirSync(join(root, 'workspace'));
		await provide(root);
		rmSync(root, { recursive: true, force: true });
	},
	write: async ({ root }, provide) => {
		await provide((path, content) => {
			const destination = join(root, path);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, content);
		});
	},
	read: async ({ root }, provide) => {
		await provide((path) => readFileSync(join(root, path), 'utf8'));
	},
	manifest: async ({ write }, provide) => {
		await provide((paths, previousHome = home) => {
			write(AGENT_HOME_FILES_MANIFEST, JSON.stringify({ home: previousHome, paths }));
		});
	},
	run: async ({ root }, provide) => {
		await provide(async (arguments_, environmentHome = home, prefix = '', input) => {
			const [result] = await runPythonCases(prefix + INSTALL_AGENT_CONTEXT, [
				{ argv: arguments_, stdin: input, env: { HOME: environmentHome }, cwd: root },
			]);
			expect(result.stderr).toBe('');
			return { status: result.status, stdout: result.stdout };
		});
	},
	install: async ({ root, write, run }, provide) => {
		await provide(async (options = {}, environmentHome = '/home/appuser', prefix = '') => {
			const payload = '/tmp/.marimohub-agent-test.json';
			write(
				payload,
				JSON.stringify({
					root,
					workdir: '/workspace',
					files: [{ path: instruction, content: 'Use polars.\nUnicode: 🐻' }],
					restored: false,
					...options,
				}),
			);
			const result = await run([join(root, payload)], environmentHome, prefix);
			expect(existsSync(join(root, payload))).toBe(false);
			return result;
		});
	},
});

describe.concurrent('agent context install', () => {
	it('installs home files and records the logical HOME under a mapped filesystem root', async ({
		install,
		read,
	}) => {
		expect(await install()).toEqual({ status: 0, stdout: '' });
		expect(read(`${home}/${instruction}`)).toBe('Use polars.\nUnicode: 🐻');
		expect(JSON.parse(read(AGENT_HOME_FILES_MANIFEST))).toEqual({ home, paths: [instruction] });
	});

	it('uses an adapter HOME override and creates nested skill directories', async ({
		install,
		read,
	}) => {
		expect(
			await install({ home: '/custom/', files: [{ path: skill, content: 'skill' }] }, '/unused'),
		).toEqual({ status: 0, stdout: '' });
		expect(read(`/custom/${skill}`)).toBe('skill');
		expect(JSON.parse(read(AGENT_HOME_FILES_MANIFEST))).toEqual({
			home: '/custom',
			paths: [skill],
		});
	});

	it('installs a skill at the 64 KiB UTF-8 limit without command-line content', async ({
		install,
		read,
	}) => {
		const content = '🐻'.repeat((64 * 1024) / 4);
		expect(await install({ files: [{ path: skill, content }] })).toEqual({
			status: 0,
			stdout: '',
		});
		expect(read(`${home}/${skill}`)).toBe(content);
	});

	it('defaults an empty environment HOME and accepts a root HOME', async ({ install, read }) => {
		expect(await install({}, '')).toEqual({ status: 0, stdout: '' });
		expect(read(`${home}/${instruction}`)).toContain('Use polars.');
		expect(await install({ home: '/' })).toEqual({ status: 0, stdout: '' });
		expect(read(`/${instruction}`)).toContain('Use polars.');
	});

	it.for([
		'relative',
		'/home/../workspace',
		'/home//user',
		'/home/user\n',
		'/home\\user',
		`/${'a'.repeat(4095)}`,
	])('rejects invalid HOME %j without exposing it in errors', async (invalidHome, { install }) => {
		expect(await install({ home: invalidHome })).toEqual({ status: 1, stdout: 'invalid_home\n' });
	});

	it('rejects a root workspace explicitly', async ({ install }) => {
		expect(await install({ workdir: '/' })).toEqual({ status: 1, stdout: 'root_workspace\n' });
	});

	it('rejects HOME contained in the workspace', async ({ install }) => {
		expect(await install({ home: '/workspace/home' })).toEqual({
			status: 1,
			stdout: 'unsafe_path\n',
		});
	});

	it.for([
		'.ssh/config',
		'.claude/../settings.json',
		'.agents/skills/marimo-pair/SKILL.md',
		'.claude/skills/../SKILL.md',
	])('rejects an unapproved home destination %s', async (path, { install }) => {
		expect(await install({ files: [{ path, content: 'secret' }] })).toEqual({
			status: 1,
			stdout: 'unsafe_path\n',
		});
	});

	it.for(['home', 'parent', 'leaf'])(
		'rejects a symlink at the %s without changing its workspace target',
		async (level, { root, write, read, install }) => {
			write('/workspace/CLAUDE.md', 'workspace');
			const source =
				level === 'home' ? home : level === 'parent' ? `${home}/.claude` : `${home}/${instruction}`;
			const target = level === 'leaf' ? '/workspace/CLAUDE.md' : '/workspace';
			mkdirSync(dirname(join(root, source)), { recursive: true });
			symlinkSync(join(root, target), join(root, source));
			expect(await install()).toEqual({ status: 1, stdout: 'unsafe_path\n' });
			expect(read('/workspace/CLAUDE.md')).toBe('workspace');
		},
	);

	it('rejects a workspace alias pointing at HOME', async ({ root, install }) => {
		mkdirSync(join(root, home), { recursive: true });
		symlinkSync(join(root, home), join(root, 'alias'));
		expect(await install({ workdir: '/alias' })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
	});

	it('accepts the trusted root through a host symlink', async ({ root, install }) => {
		const alias = `${root}-alias`;
		symlinkSync(realpathSync(root), alias);
		try {
			expect(await install({ root: alias })).toEqual({ status: 0, stdout: '' });
		} finally {
			rmSync(alias);
		}
	});

	it('replaces hard-linked files without changing the other link', async ({
		root,
		write,
		read,
		install,
	}) => {
		write('/workspace/CLAUDE.md', 'workspace');
		mkdirSync(join(root, home, '.claude'), { recursive: true });
		linkSync(join(root, '/workspace/CLAUDE.md'), join(root, home, instruction));
		expect(await install()).toEqual({ status: 0, stdout: '' });
		expect(read('/workspace/CLAUDE.md')).toBe('workspace');
		expect(read(`${home}/${instruction}`)).toContain('Use polars.');
	});

	it('atomically replaces a destination swapped for a symlink after validation', async ({
		root,
		write,
		read,
		install,
	}) => {
		write('/workspace/CLAUDE.md', 'workspace');
		write(`${home}/${instruction}`, 'old');
		const prefix = `import os\noriginal_replace = os.replace\ndef racing_replace(src, dst, **kwargs):\n    if dst == 'CLAUDE.md':\n        os.unlink(dst, dir_fd=kwargs['dst_dir_fd'])\n        os.symlink(${JSON.stringify(join(root, '/workspace/CLAUDE.md'))}, dst, dir_fd=kwargs['dst_dir_fd'])\n    return original_replace(src, dst, **kwargs)\nos.replace = racing_replace\n`;
		expect(await install({}, home, prefix)).toEqual({ status: 0, stdout: '' });
		expect(read('/workspace/CLAUDE.md')).toBe('workspace');
		expect(read(`${home}/${instruction}`)).toContain('Use polars.');
	});

	it('keeps writes on the opened directory when its name is replaced by a symlink', async ({
		root,
		write,
		read,
		install,
	}) => {
		write('/workspace/CLAUDE.md', 'workspace');
		write(`${home}/${instruction}`, 'old');
		const prefix = `import os\noriginal_open = os.open\nswapped = False\ndef racing_open(path, flags, *args, **kwargs):\n    global swapped\n    fd = original_open(path, flags, *args, **kwargs)\n    if path == '.claude' and not swapped:\n        swapped = True\n        parent = kwargs['dir_fd']\n        os.rename(path, '.held', src_dir_fd=parent, dst_dir_fd=parent)\n        os.symlink(${JSON.stringify(join(root, '/workspace'))}, path, dir_fd=parent)\n    return fd\nos.open = racing_open\n`;
		expect(await install({}, home, prefix)).toEqual({ status: 0, stdout: '' });
		expect(read('/workspace/CLAUDE.md')).toBe('workspace');
		expect(read(`${home}/.held/CLAUDE.md`)).toContain('Use polars.');
	});

	it('reports write failures without diagnostics and removes its temporary file', async ({
		root,
		write,
		read,
		install,
	}) => {
		write(`${home}/${instruction}`, 'old');
		const prefix = `import os\ndef denied_replace(*args, **kwargs):\n    raise PermissionError(13, 'private diagnostics')\nos.replace = denied_replace\n`;
		expect(await install({}, home, prefix)).toEqual({ status: 1, stdout: 'io_error\n' });
		expect(read(`${home}/${instruction}`)).toBe('old');
		expect(readdirSync(join(root, home, '.claude'))).toEqual(['CLAUDE.md']);
	});

	it('removes obsolete restored files and preserves unrelated files', async ({
		root,
		write,
		read,
		manifest,
		install,
	}) => {
		manifest([instruction, skill]);
		write(`${home}/${instruction}`, 'old');
		write(`${home}/${skill}`, 'obsolete');
		write(`${home}/.agents/skills/marimo-pair/SKILL.md`, 'built in');
		expect(await install({ restored: true })).toEqual({ status: 0, stdout: '' });
		expect(existsSync(join(root, home, skill))).toBe(false);
		expect(read(`${home}/.agents/skills/marimo-pair/SKILL.md`)).toBe('built in');
	});

	it('cleans up the previous HOME when the adapter HOME changes', async ({
		root,
		write,
		read,
		manifest,
		install,
	}) => {
		manifest([instruction]);
		write(`${home}/${instruction}`, 'old');
		expect(await install({ restored: true, home: '/newhome' })).toEqual({
			status: 0,
			stdout: '',
		});
		expect(existsSync(join(root, home, instruction))).toBe(false);
		expect(read(`/newhome/${instruction}`)).toContain('Use polars.');
	});

	it('removes the manifest and all old files when context is removed', async ({
		root,
		write,
		manifest,
		install,
	}) => {
		manifest([instruction, skill]);
		write(`${home}/${instruction}`, 'old');
		expect(await install({ restored: true, files: [] })).toEqual({ status: 0, stdout: '' });
		expect(existsSync(join(root, home, instruction))).toBe(false);
		expect(existsSync(join(root, AGENT_HOME_FILES_MANIFEST))).toBe(false);
	});

	it('allows a restored sandbox without a previous manifest', async ({ install }) => {
		expect(await install({ restored: true, files: [] }, 'invalid unused HOME')).toEqual({
			status: 0,
			stdout: '',
		});
	});

	it('cleans up restored files from an stdin payload without deleting its argument marker', async ({
		root,
		write,
		read,
		manifest,
		run,
	}) => {
		manifest([instruction]);
		write(`${home}/${instruction}`, 'old');
		write('-', 'unrelated');
		const payload = { root, workdir: '/workspace', files: [], restored: true };
		expect(await run(['-'], home, '', JSON.stringify(payload))).toEqual({ status: 0, stdout: '' });
		expect(existsSync(join(root, home, instruction))).toBe(false);
		expect(existsSync(join(root, AGENT_HOME_FILES_MANIFEST))).toBe(false);
		expect(read('-')).toBe('unrelated');
	});

	it('accepts stdin cleanup without a previous manifest or a payload upload', async ({
		root,
		run,
	}) => {
		const payload = { root, workdir: '/workspace', files: [], restored: true };
		expect(await run(['-'], home, '', JSON.stringify(payload))).toEqual({
			status: 0,
			stdout: '',
		});
		expect(readdirSync(root)).toEqual(['workspace']);
	});

	it.for(['{private', 'null', '{}'])(
		'reports malformed stdin data %s with a fixed error code',
		async (payload, { write, read, run }) => {
			write('-', 'unrelated');
			const result = await run(['-'], home, '', payload);
			expect(result.status).toBe(1);
			expect(result.stdout).toMatch(/^(io_error|unsafe_path)\n$/);
			expect(read('-')).toBe('unrelated');
		},
	);

	it('installs file content from stdin', async ({ root, run }) => {
		const payload = {
			root,
			workdir: '/workspace',
			files: [{ path: instruction, content: 'use a file payload' }],
			restored: true,
		};
		expect(await run(['-'], home, '', JSON.stringify(payload))).toEqual({
			status: 0,
			stdout: '',
		});
	});

	it.for([
		'{private',
		'null',
		'[]',
		'{}',
		'{"home":"/root","paths":[123]}',
		'{"home":"/root","paths":[],"private":true}',
	])(
		'rejects malformed snapshot metadata %s without changing old files',
		async (content, { write, read, install }) => {
			write(AGENT_HOME_FILES_MANIFEST, content);
			write(`${home}/${instruction}`, 'old');
			const result = await install({ restored: true });
			expect(result.status).toBe(1);
			expect(result.stdout).toMatch(/^(invalid_manifest|unsafe_path)\n$/);
			expect(read(`${home}/${instruction}`)).toBe('old');
		},
	);

	it('validates all cleanup paths before removing any old file', async ({
		root,
		write,
		read,
		manifest,
		install,
	}) => {
		manifest([instruction, skill]);
		write(`${home}/${instruction}`, 'keep until all paths are checked');
		mkdirSync(dirname(join(root, home, skill)), { recursive: true });
		write('/workspace/SKILL.md', 'workspace');
		symlinkSync(join(root, '/workspace/SKILL.md'), join(root, home, skill));
		expect(await install({ restored: true, files: [] })).toEqual({
			status: 1,
			stdout: 'unsafe_path\n',
		});
		expect(read(`${home}/${instruction}`)).toBe('keep until all paths are checked');
		expect(read('/workspace/SKILL.md')).toBe('workspace');
	});

	it('does not remove old files when a later manifest path escapes the allowlist', async ({
		write,
		read,
		manifest,
		install,
	}) => {
		manifest([instruction, '../workspace/CLAUDE.md']);
		write(`${home}/${instruction}`, 'old');
		expect(await install({ restored: true, files: [] })).toEqual({
			status: 1,
			stdout: 'unsafe_path\n',
		});
		expect(read(`${home}/${instruction}`)).toBe('old');
	});

	it('rejects a symlinked snapshot manifest', async ({ root, write, install }) => {
		write('/workspace/manifest.json', JSON.stringify({ home, paths: [] }));
		mkdirSync(dirname(join(root, AGENT_HOME_FILES_MANIFEST)), { recursive: true });
		symlinkSync(join(root, '/workspace/manifest.json'), join(root, AGENT_HOME_FILES_MANIFEST));
		expect(await install({ restored: true })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
	});

	it('rejects a symlinked manifest directory before writing home files', async ({
		root,
		install,
	}) => {
		mkdirSync(join(root, '/tmp/marimohub-integrations'), { recursive: true });
		symlinkSync(join(root, '/workspace'), join(root, '/tmp/marimohub-integrations/agent-context'));
		expect(await install()).toEqual({ status: 1, stdout: 'unsafe_path\n' });
		expect(existsSync(join(root, home, instruction))).toBe(false);
	});

	it('decodes stdin as UTF-8 when the text stream uses an ASCII locale', async ({
		root,
		read,
		run,
	}) => {
		const content = 'Unicode: 🐻 café';
		const payload = {
			root,
			workdir: '/workspace',
			files: [{ path: instruction, content }],
			restored: false,
		};
		expect(
			await run(
				['-'],
				home,
				"import sys\nsys.stdin.reconfigure(encoding='ascii', errors='strict')\n",
				JSON.stringify(payload),
			),
		).toEqual({ status: 0, stdout: '' });
		expect(read(`${home}/${instruction}`)).toBe(content);
	});
});
