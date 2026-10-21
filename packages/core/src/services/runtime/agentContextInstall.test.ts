import { spawnSync } from 'node:child_process';
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
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AGENT_HOME_FILES_MANIFEST } from '../integrations/agentContext';
import { INSTALL_AGENT_CONTEXT } from './agentContextInstall';

let root: string;
const instruction = '.claude/CLAUDE.md';
const skill = '.agents/skills/analytics/SKILL.md';
const home = '/home/appuser';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'agent-context-'));
	mkdirSync(join(root, 'workspace'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, content: string) {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}

function manifest(paths: string[], previousHome = home) {
	write(AGENT_HOME_FILES_MANIFEST, JSON.stringify({ home: previousHome, paths }));
}

function read(path: string) {
	return readFileSync(join(root, path), 'utf8');
}

function run(arguments_: string[], environmentHome = home, prefix = '') {
	const result = spawnSync('python3', ['-I', '-c', prefix + INSTALL_AGENT_CONTEXT, ...arguments_], {
		encoding: 'utf8',
		cwd: root,
		env: { ...process.env, HOME: environmentHome },
	});
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe('');
	return { status: result.status, stdout: result.stdout };
}

function install(
	options: {
		home?: string;
		workdir?: string;
		files?: { path: string; content: string }[];
		restored?: boolean;
	} = {},
	environmentHome = '/home/appuser',
	prefix = '',
) {
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
	const result = run([join(root, payload)], environmentHome, prefix);
	expect(existsSync(join(root, payload))).toBe(false);
	return result;
}

it('installs home files and records the logical HOME under a mapped filesystem root', () => {
	expect(install()).toEqual({ status: 0, stdout: '' });
	expect(read(`${home}/${instruction}`)).toBe('Use polars.\nUnicode: 🐻');
	expect(JSON.parse(read(AGENT_HOME_FILES_MANIFEST))).toEqual({ home, paths: [instruction] });
});

it('uses an adapter HOME override and creates nested skill directories', () => {
	expect(
		install({ home: '/custom/', files: [{ path: skill, content: 'skill' }] }, '/unused'),
	).toEqual({ status: 0, stdout: '' });
	expect(read(`/custom/${skill}`)).toBe('skill');
	expect(JSON.parse(read(AGENT_HOME_FILES_MANIFEST))).toEqual({ home: '/custom', paths: [skill] });
});

it('installs a skill at the 64 KiB UTF-8 limit without command-line content', () => {
	const content = '🐻'.repeat((64 * 1024) / 4);
	expect(install({ files: [{ path: skill, content }] })).toEqual({ status: 0, stdout: '' });
	expect(read(`${home}/${skill}`)).toBe(content);
});

it('defaults an empty environment HOME and accepts a root HOME', () => {
	expect(install({}, '')).toEqual({ status: 0, stdout: '' });
	expect(read(`${home}/${instruction}`)).toContain('Use polars.');
	expect(install({ home: '/' })).toEqual({ status: 0, stdout: '' });
	expect(read(`/${instruction}`)).toContain('Use polars.');
});

it.each([
	'relative',
	'/home/../workspace',
	'/home//user',
	'/home/user\n',
	'/home\\user',
	`/${'a'.repeat(4095)}`,
])('rejects invalid HOME %j without exposing it in errors', (invalidHome) => {
	expect(install({ home: invalidHome })).toEqual({ status: 1, stdout: 'invalid_home\n' });
});

it('rejects a root workspace explicitly', () => {
	expect(install({ workdir: '/' })).toEqual({ status: 1, stdout: 'root_workspace\n' });
});

it('rejects HOME contained in the workspace', () => {
	expect(install({ home: '/workspace/home' })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
});

it.each([
	'.ssh/config',
	'.claude/../settings.json',
	'.agents/skills/marimo-pair/SKILL.md',
	'.claude/skills/../SKILL.md',
])('rejects an unapproved home destination %s', (path) => {
	expect(install({ files: [{ path, content: 'secret' }] })).toEqual({
		status: 1,
		stdout: 'unsafe_path\n',
	});
});

it.each(['home', 'parent', 'leaf'])(
	'rejects a symlink at the %s without changing its workspace target',
	(level) => {
		write('/workspace/CLAUDE.md', 'workspace');
		const source =
			level === 'home' ? home : level === 'parent' ? `${home}/.claude` : `${home}/${instruction}`;
		const target = level === 'leaf' ? '/workspace/CLAUDE.md' : '/workspace';
		mkdirSync(dirname(join(root, source)), { recursive: true });
		symlinkSync(join(root, target), join(root, source));
		expect(install()).toEqual({ status: 1, stdout: 'unsafe_path\n' });
		expect(read('/workspace/CLAUDE.md')).toBe('workspace');
	},
);

it('rejects a workspace alias pointing at HOME', () => {
	mkdirSync(join(root, home), { recursive: true });
	symlinkSync(join(root, home), join(root, 'alias'));
	expect(install({ workdir: '/alias' })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
});

it('accepts the trusted root through a host symlink', () => {
	const actualRoot = root;
	const alias = `${root}-alias`;
	symlinkSync(realpathSync(root), alias);
	try {
		root = alias;
		expect(install()).toEqual({ status: 0, stdout: '' });
	} finally {
		root = actualRoot;
		rmSync(alias);
	}
});

it('replaces hard-linked files without changing the other link', () => {
	write('/workspace/CLAUDE.md', 'workspace');
	mkdirSync(join(root, home, '.claude'), { recursive: true });
	linkSync(join(root, '/workspace/CLAUDE.md'), join(root, home, instruction));
	expect(install()).toEqual({ status: 0, stdout: '' });
	expect(read('/workspace/CLAUDE.md')).toBe('workspace');
	expect(read(`${home}/${instruction}`)).toContain('Use polars.');
});

it('atomically replaces a destination swapped for a symlink after validation', () => {
	write('/workspace/CLAUDE.md', 'workspace');
	write(`${home}/${instruction}`, 'old');
	const prefix = `import os\noriginal_replace = os.replace\ndef racing_replace(src, dst, **kwargs):\n    if dst == 'CLAUDE.md':\n        os.unlink(dst, dir_fd=kwargs['dst_dir_fd'])\n        os.symlink(${JSON.stringify(join(root, '/workspace/CLAUDE.md'))}, dst, dir_fd=kwargs['dst_dir_fd'])\n    return original_replace(src, dst, **kwargs)\nos.replace = racing_replace\n`;
	expect(install({}, home, prefix)).toEqual({ status: 0, stdout: '' });
	expect(read('/workspace/CLAUDE.md')).toBe('workspace');
	expect(read(`${home}/${instruction}`)).toContain('Use polars.');
});

it('keeps writes on the opened directory when its name is replaced by a symlink', () => {
	write('/workspace/CLAUDE.md', 'workspace');
	write(`${home}/${instruction}`, 'old');
	const prefix = `import os\noriginal_open = os.open\nswapped = False\ndef racing_open(path, flags, *args, **kwargs):\n    global swapped\n    fd = original_open(path, flags, *args, **kwargs)\n    if path == '.claude' and not swapped:\n        swapped = True\n        parent = kwargs['dir_fd']\n        os.rename(path, '.held', src_dir_fd=parent, dst_dir_fd=parent)\n        os.symlink(${JSON.stringify(join(root, '/workspace'))}, path, dir_fd=parent)\n    return fd\nos.open = racing_open\n`;
	expect(install({}, home, prefix)).toEqual({ status: 0, stdout: '' });
	expect(read('/workspace/CLAUDE.md')).toBe('workspace');
	expect(read(`${home}/.held/CLAUDE.md`)).toContain('Use polars.');
});

it('reports write failures without diagnostics and removes its temporary file', () => {
	write(`${home}/${instruction}`, 'old');
	const prefix = `import os\ndef denied_replace(*args, **kwargs):\n    raise PermissionError(13, 'private diagnostics')\nos.replace = denied_replace\n`;
	expect(install({}, home, prefix)).toEqual({ status: 1, stdout: 'io_error\n' });
	expect(read(`${home}/${instruction}`)).toBe('old');
	expect(readdirSync(join(root, home, '.claude'))).toEqual(['CLAUDE.md']);
});

it('removes obsolete restored files and preserves unrelated files', () => {
	manifest([instruction, skill]);
	write(`${home}/${instruction}`, 'old');
	write(`${home}/${skill}`, 'obsolete');
	write(`${home}/.agents/skills/marimo-pair/SKILL.md`, 'built in');
	expect(install({ restored: true })).toEqual({ status: 0, stdout: '' });
	expect(existsSync(join(root, home, skill))).toBe(false);
	expect(read(`${home}/.agents/skills/marimo-pair/SKILL.md`)).toBe('built in');
});

it('cleans up the previous HOME when the adapter HOME changes', () => {
	manifest([instruction]);
	write(`${home}/${instruction}`, 'old');
	expect(install({ restored: true, home: '/newhome' })).toEqual({ status: 0, stdout: '' });
	expect(existsSync(join(root, home, instruction))).toBe(false);
	expect(read(`/newhome/${instruction}`)).toContain('Use polars.');
});

it('removes the manifest and all old files when context is removed', () => {
	manifest([instruction, skill]);
	write(`${home}/${instruction}`, 'old');
	expect(install({ restored: true, files: [] })).toEqual({ status: 0, stdout: '' });
	expect(existsSync(join(root, home, instruction))).toBe(false);
	expect(existsSync(join(root, AGENT_HOME_FILES_MANIFEST))).toBe(false);
});

it('allows a restored sandbox without a previous manifest', () => {
	expect(install({ restored: true, files: [] }, 'invalid unused HOME')).toEqual({
		status: 0,
		stdout: '',
	});
});

it('cleans up restored files from an inline payload without deleting its argument marker', () => {
	manifest([instruction]);
	write(`${home}/${instruction}`, 'old');
	write('--inline', 'unrelated');
	const payload = { root, workdir: '/workspace', files: [], restored: true };
	expect(run(['--inline', JSON.stringify(payload)])).toEqual({ status: 0, stdout: '' });
	expect(existsSync(join(root, home, instruction))).toBe(false);
	expect(existsSync(join(root, AGENT_HOME_FILES_MANIFEST))).toBe(false);
	expect(read('--inline')).toBe('unrelated');
});

it('accepts inline cleanup without a previous manifest or a payload upload', () => {
	const payload = { root, workdir: '/workspace', files: [], restored: true };
	expect(run(['--inline', JSON.stringify(payload).replaceAll('/', '\\u002f')])).toEqual({
		status: 0,
		stdout: '',
	});
	expect(readdirSync(root)).toEqual(['workspace']);
});

it.each(['{private', 'null', '{}'])(
	'reports malformed inline data %s with a fixed error code',
	(payload) => {
		write('--inline', 'unrelated');
		const result = run(['--inline', payload]);
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/^(io_error|unsafe_path)\n$/);
		expect(read('--inline')).toBe('unrelated');
	},
);

it('rejects file content in inline cleanup mode', () => {
	const payload = {
		root,
		workdir: '/workspace',
		files: [{ path: instruction, content: 'use a file payload' }],
		restored: true,
	};
	expect(run(['--inline', JSON.stringify(payload)])).toEqual({
		status: 1,
		stdout: 'unsafe_path\n',
	});
});

it.each([
	'{private',
	'null',
	'[]',
	'{}',
	'{"home":"/root","paths":[123]}',
	'{"home":"/root","paths":[],"private":true}',
])('rejects malformed snapshot metadata %s without changing old files', (content) => {
	write(AGENT_HOME_FILES_MANIFEST, content);
	write(`${home}/${instruction}`, 'old');
	const result = install({ restored: true });
	expect(result.status).toBe(1);
	expect(result.stdout).toMatch(/^(invalid_manifest|unsafe_path)\n$/);
	expect(read(`${home}/${instruction}`)).toBe('old');
});

it('validates all cleanup paths before removing any old file', () => {
	manifest([instruction, skill]);
	write(`${home}/${instruction}`, 'keep until all paths are checked');
	mkdirSync(dirname(join(root, home, skill)), { recursive: true });
	write('/workspace/SKILL.md', 'workspace');
	symlinkSync(join(root, '/workspace/SKILL.md'), join(root, home, skill));
	expect(install({ restored: true, files: [] })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
	expect(read(`${home}/${instruction}`)).toBe('keep until all paths are checked');
	expect(read('/workspace/SKILL.md')).toBe('workspace');
});

it('does not remove old files when a later manifest path escapes the allowlist', () => {
	manifest([instruction, '../workspace/CLAUDE.md']);
	write(`${home}/${instruction}`, 'old');
	expect(install({ restored: true, files: [] })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
	expect(read(`${home}/${instruction}`)).toBe('old');
});

it('rejects a symlinked snapshot manifest', () => {
	write('/workspace/manifest.json', JSON.stringify({ home, paths: [] }));
	mkdirSync(dirname(join(root, AGENT_HOME_FILES_MANIFEST)), { recursive: true });
	symlinkSync(join(root, '/workspace/manifest.json'), join(root, AGENT_HOME_FILES_MANIFEST));
	expect(install({ restored: true })).toEqual({ status: 1, stdout: 'unsafe_path\n' });
});

it('rejects a symlinked manifest directory before writing home files', () => {
	mkdirSync(join(root, '/tmp/marimohub-integrations'), { recursive: true });
	symlinkSync(join(root, '/workspace'), join(root, '/tmp/marimohub-integrations/agent-context'));
	expect(install()).toEqual({ status: 1, stdout: 'unsafe_path\n' });
	expect(existsSync(join(root, home, instruction))).toBe(false);
});
