import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_ARTIFACT_BYTES } from '../../constants';
import { sha256Hex } from '../../internal/sha256';
import { execResult } from '../../ports/sandbox';
import { makeFakeSandbox } from '../../testing';
import { probeSessionArtifacts } from './sessionArtifactCache';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'artifact-probe-'));
	directories.push(root);
	const { instance } = makeFakeSandbox();
	vi.spyOn(instance, 'exec').mockImplementation(async (command) => {
		try {
			const { stdout, stderr } = await execute('sh', ['-c', command], {
				cwd: root,
				timeout: 10_000,
				maxBuffer: 4096,
			});
			return execResult(true, stdout, stderr);
		} catch {
			return execResult(false, '', 'probe failed');
		}
	});
	return { root, instance };
}

it('hashes bounded files without importing workspace Python modules or interpreting quoted paths', async () => {
	const { root, instance } = await fixture();
	await writeFile(join(root, 'hashlib.py'), 'raise RuntimeError("workspace module executed")');
	const name = "quoted'notebook.py";
	await writeFile(join(root, name), 'hello');
	expect(await probeSessionArtifacts(instance, root, name)).toEqual({
		code: { size: 5, sha256: await sha256Hex('hello') },
		deps: null,
		html: null,
		session: null,
	});
});

it.each(['symlink', 'oversize'] as const)(
	'rejects a %s source before returning reusable hashes',
	async (kind) => {
		const { root, instance } = await fixture();
		const source = join(root, 'notebook.py');
		await writeFile(join(root, 'target.py'), 'private');
		if (kind === 'symlink') await symlink('target.py', source);
		else {
			await writeFile(source, '');
			await truncate(source, MAX_ARTIFACT_BYTES + 1);
		}
		expect(await probeSessionArtifacts(instance, root, 'notebook.py')).toBeUndefined();
	},
);
