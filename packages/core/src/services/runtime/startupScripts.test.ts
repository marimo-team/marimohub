import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMarimoLaunch, MARIMO_LAUNCH_STRATEGIES } from './marimoLaunch';
import type { MarimoLaunchStrategyName } from './marimoLaunch';

const exec = promisify(execFile);
const base = { notebookFile: 'notebook.py', host: '127.0.0.1', port: 2718 };

describe('startup script execution', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'startup-scripts-'));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const run = (command: string, env?: NodeJS.ProcessEnv) =>
		exec('sh', ['-c', command], { cwd: root, env: { ...process.env, ...env }, timeout: 5000 });

	function setupCommand(startupScripts: string[], mode: 'edit' | 'app' | 'job' = 'edit') {
		return buildMarimoLaunch({ ...base, mode, startupScripts }, 'uv-sandbox')
			.setup.map((step) => step.command)
			.join(' && ');
	}

	it.each(['edit', 'app', 'job'] as const)(
		'runs scripts in order with the workspace and injected variables for %s',
		async (mode) => {
			const first = join(root, "first ' script.sh");
			const second = join(root, 'second.sh');
			await writeFile(
				first,
				'printf "%s\\n" "$STARTUP_TEST_VALUE" > result\nexport CHILD_ONLY=yes\n',
			);
			await writeFile(second, 'test -z "$CHILD_ONLY"\nprintf "second\\n" >> result\n');
			await run(setupCommand([first, second], mode), { STARTUP_TEST_VALUE: 'injected' });
			expect(await readFile(join(root, 'result'), 'utf8')).toBe('injected\nsecond\n');
		},
	);

	it('stops at a failed command, skipping subsequent scripts and launch', async () => {
		const script = join(root, 'fail.sh');
		await writeFile(script, 'false\necho should-not-run > after-failure\n');
		await expect(
			run(`${setupCommand([script])} && echo launched > launched`),
		).rejects.toMatchObject({ code: 1 });
		await expect(readFile(join(root, 'after-failure'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readFile(join(root, 'launched'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it.each([
		{ name: 'missing file', content: undefined },
		{ name: 'syntax error', content: 'if then\n' },
		{ name: 'missing command', content: 'marimohub_nonexistent_startup_command\n' },
		{ name: 'explicit exit', content: 'exit 23\n' },
	])('stops later hooks and launch after a $name', async ({ content }) => {
		const failed = join(root, 'failed.sh');
		const later = join(root, 'later.sh');
		if (content !== undefined) await writeFile(failed, content);
		await writeFile(later, 'echo ran > later-ran\n');
		await expect(
			run(`${setupCommand([failed, later])} && echo launched > launched`),
		).rejects.toMatchObject({ code: expect.any(Number) });
		await expect(readFile(join(root, 'later-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readFile(join(root, 'launched'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('treats shell metacharacters in script paths as literal filenames', async () => {
		const path = join(root, "setup ' $(touch injected) `touch backtick` ;.sh");
		await writeFile(path, 'echo safe > result\n');
		await run(setupCommand([path]));
		expect(await readFile(join(root, 'result'), 'utf8')).toBe('safe\n');
		for (const filename of ['injected', 'backtick']) {
			await expect(readFile(join(root, filename))).rejects.toMatchObject({ code: 'ENOENT' });
		}
	});

	it('isolates directory changes and exit zero to the script process', async () => {
		const first = join(root, 'first.sh');
		const second = join(root, 'second.sh');
		await writeFile(first, 'cd /\nexit 0\n');
		await writeFile(second, 'printf "%s" "$PWD" > working-directory\n');
		await run(setupCommand([first, second]));
		expect(await readFile(join(root, 'working-directory'), 'utf8')).toBe(await realpath(root));
	});

	it.each(Object.keys(MARIMO_LAUNCH_STRATEGIES) as MarimoLaunchStrategyName[])(
		'places hooks before dependency setup for %s',
		(strategy) => {
			const baseline = buildMarimoLaunch(base, strategy);
			const plan = buildMarimoLaunch({ ...base, startupScripts: ['/tmp/setup.sh'] }, strategy);
			expect(plan.setup[0]).toMatchObject({ command: "sh -e '/tmp/setup.sh'" });
			expect(plan.setup.slice(1)).toEqual(baseline.setup);
			expect(plan.start).toBe(baseline.start);
		},
	);
});
