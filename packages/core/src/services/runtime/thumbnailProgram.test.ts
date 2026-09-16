import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { THUMBNAIL_PROGRAM } from './thumbnailProgram';

const run = promisify(execFile);
it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin').each([
	{ delay: 60, status: 'timeout' },
	{ delay: 1, status: 'render_failed' },
])(
	'cleans up detached browsers when the worker ends with $status',
	async ({ delay, status }) => {
		const dir = await mkdtemp(join(tmpdir(), 'thumbnail-watchdog-'));
		try {
			await mkdir(join(dir, 'playwright'));
			await mkdir(join(dir, 'marimo'));
			await writeFile(join(dir, 'marimo/__init__.py'), '');
			await writeFile(join(dir, 'playwright/__init__.py'), '');
			await writeFile(
				join(dir, 'playwright/async_api.py'),
				`
import asyncio, os, subprocess, sys
from pathlib import Path
class FakePlaywright:
    async def __aenter__(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        Path(os.environ['THUMBNAIL_TEST_PID_FILE']).write_text(str(child.pid))
        await asyncio.sleep(${delay})
    async def __aexit__(self, *args): pass
def async_playwright(): return FakePlaywright()
`,
			);
			const input = join(dir, 'snapshot.html');
			const pidFile = join(dir, 'child.pid');
			await writeFile(input, '<div>saved</div>');
			const started = Date.now();
			const { stdout } = await run(
				'python3',
				['-c', THUMBNAIL_PROGRAM, input, String(Date.now() / 1000 + 4)],
				{
					timeout: 7000,
					env: { ...process.env, PYTHONPATH: dir, THUMBNAIL_TEST_PID_FILE: pidFile },
				},
			);
			expect(JSON.parse(stdout)).toEqual({ status });
			expect(Date.now() - started).toBeLessThan(6000);
			const pid = Number(await readFile(pidFile, 'utf8'));
			await expect
				.poll(async () => {
					try {
						const { stdout: state } = await run('ps', ['-p', String(pid), '-o', 'stat=']);
						return !state.trim() || state.trim().startsWith('Z');
					} catch {
						return true;
					}
				})
				.toBe(true);
			await expect(readFile(input)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	10_000,
);
