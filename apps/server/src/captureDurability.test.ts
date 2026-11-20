import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Snapshot {
	code: string;
	deps: string;
	outputs: { cells: { code_hash: string; outputs: { data: { 'text/plain': string } }[] }[] };
	versionId: string;
	receipt: { at: string; version_id: string };
	dirty: boolean;
}

const children = new Set<ChildProcess>();
const directories: string[] = [];
const worker = fileURLToPath(new URL('./test/captureWorker.ts', import.meta.url));

async function run(
	root: string,
	operation: string,
	unchanged: boolean,
	boundary = '',
	timeoutMs = 20_000,
	execPath = process.execPath,
): Promise<Snapshot | undefined> {
	const child = fork(worker, [root, operation, boundary, String(unchanged)], {
		execArgv: ['--import', import.meta.resolve('tsx')],
		execPath,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});
	children.add(child);
	let diagnostics = '';
	const record = (chunk: Buffer) => {
		diagnostics = (diagnostics + chunk.toString()).slice(-8192);
	};
	child.stdout!.on('data', record);
	child.stderr!.on('data', record);
	return new Promise((resolve, reject) => {
		let reached = false;
		let failure: Error | undefined;
		let snapshot: Snapshot | undefined;
		const timeout = setTimeout(() => {
			failure = new Error('Capture worker timed out');
			child.kill('SIGKILL');
		}, timeoutMs);
		child.on('message', (message: { phase?: string; result?: Snapshot }) => {
			if (message.phase) {
				if (message.phase !== boundary) {
					failure = new Error(`Unexpected crash barrier: ${message.phase}`);
					child.kill('SIGKILL');
					return;
				}
				reached = true;
				child.kill('SIGKILL');
			} else snapshot = message.result;
		});
		child.once('error', (error) => {
			failure = error;
		});
		child.once('close', (code, signal) => {
			clearTimeout(timeout);
			children.delete(child);
			if (failure) reject(new Error(`${failure.message}: ${diagnostics}`));
			else if (boundary ? reached && signal === 'SIGKILL' : code === 0 && snapshot)
				resolve(snapshot);
			else
				reject(
					new Error(
						`Capture worker exited (${code}, ${signal}), barrier=${reached}: ${diagnostics}`,
					),
				);
		});
	});
}

afterEach(async () => {
	await Promise.all(
		[...children].map(
			(child) =>
				new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error('Capture worker did not close after SIGKILL')),
						2_000,
					);
					child.once('close', () => {
						clearTimeout(timeout);
						resolve();
					});
					child.kill('SIGKILL');
				}),
		),
	);
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function directory() {
	const root = await mkdtemp(join(tmpdir(), 'hub-capture-'));
	directories.push(root);
	return root;
}

describe('capture publication across process death', () => {
	it('cleans up when the child cannot spawn', async () => {
		const root = await directory();
		await expect(run(root, 'seed', false, '', 5_000, join(root, 'missing-node'))).rejects.toThrow(
			/ENOENT/,
		);
		expect(children.size).toBe(0);
	});
	it.each(['fail', 'hang', 'unexpected'])(
		'fails closed and reaps the worker after %s',
		async (operation) => {
			const root = await directory();
			const expected = {
				fail: /Requested startup failure/,
				hang: /timed out/,
				unexpected: /Unexpected crash barrier/,
			}[operation]!;
			await expect(
				run(root, operation, false, '', operation === 'hang' ? 5_000 : 20_000),
			).rejects.toThrow(expected);
			expect(children.size).toBe(0);
		},
		30_000,
	);

	it('rejects a stale capture token after restarting the publisher', async () => {
		const root = await directory();
		await run(root, 'seed', false);
		await run(root, 'capture', false, 'publication-after');
		const before = await run(root, 'inspect', false);
		expect(await run(root, 'stale', false)).toEqual(before);
	}, 30_000);

	it('rejects capture by the replaced editor after restarting', async () => {
		const root = await directory();
		const before = (await run(root, 'seed', false))!;
		await run(root, 'replace', false);
		await expect(run(root, 'capture', false)).rejects.toThrow(/no longer owns notebook capture/);
		const after = (await run(root, 'inspect', false))!;
		expect(after).toEqual({ ...before, dirty: true });
	}, 30_000);

	it.each(
		[false, true].flatMap((unchanged) =>
			[
				'artifact-before',
				'artifact-after',
				'publication-before',
				'publication-after',
				'receipt-before',
				'receipt-after',
			].map((boundary) => ({ unchanged, boundary })),
		),
	)(
		'recovers after $boundary with unchanged source=$unchanged',
		async ({ unchanged, boundary }) => {
			const root = await directory();
			const original = (await run(root, 'seed', unchanged))!;
			await run(root, 'capture', unchanged, boundary);
			const recovered = (await run(root, 'inspect', unchanged))!;
			const published = !['artifact-before', 'artifact-after', 'publication-before'].includes(
				boundary,
			);
			const generation = published ? 'latest' : 'durable';
			expect(recovered.code).toBe(unchanged ? '# unchanged' : `# ${generation}`);
			expect(recovered.deps).toBe(original.deps);
			expect(recovered.outputs.cells[0]).toEqual({
				code_hash: generation,
				outputs: [{ data: { 'text/plain': generation } }],
			});
			if (boundary === 'receipt-after') {
				expect(recovered.receipt.version_id).toBe(recovered.versionId);
				expect(recovered.dirty).toBe(false);
			} else {
				expect(recovered.receipt).toEqual(original.receipt);
				expect(recovered.dirty).toBe(true);
			}
			const retried = (await run(root, 'capture', unchanged))!;
			expect(retried.outputs.cells[0].code_hash).toBe('latest');
			expect(retried.receipt.version_id).toBe(retried.versionId);
			expect(retried.dirty).toBe(false);
			if (published) expect(retried.versionId).toBe(recovered.versionId);
		},
		90_000,
	);
});
