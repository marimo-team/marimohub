import { randomBytes } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { precompress } from '../precompress';

it('compresses the final Vite output, including rewritten dynamic imports', async () => {
	const root = await mkdtemp(join(tmpdir(), 'marimohub-precompress-'));
	try {
		await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
		await writeFile(
			join(root, 'main.js'),
			`window.load = () => import('./lazy.js'); console.log(${JSON.stringify('entry '.repeat(300))});`,
		);
		await writeFile(
			join(root, 'lazy.js'),
			`import './style.css'; console.log(${JSON.stringify('lazy '.repeat(300))});`,
		);
		await writeFile(join(root, 'style.css'), '.lazy { color: red; }');
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [
				{
					name: 'edge-case-assets',
					generateBundle() {
						this.emitFile({ type: 'asset', fileName: 'assets/tiny.js', source: 'x'.repeat(1023) });
						this.emitFile({
							type: 'asset',
							fileName: 'assets/incompressible.wasm',
							source: randomBytes(4096),
						});
						this.emitFile({
							type: 'asset',
							fileName: 'assets/font.woff2',
							source: randomBytes(4096),
						});
					},
				},
				precompress(),
			],
		});
		const assets = join(root, 'dist', 'assets');
		const files = await readdir(assets);
		const brotliFiles = files.filter((file) => file.endsWith('.br'));
		for (const name of ['tiny.js', 'incompressible.wasm', 'font.woff2']) {
			expect(files).toContain(name);
			expect(files).not.toContain(`${name}.br`);
			expect(files).not.toContain(`${name}.gz`);
		}
		expect(brotliFiles.length).toBeGreaterThanOrEqual(2);
		for (const file of brotliFiles) {
			const original = join(assets, file.slice(0, -3));
			const bytes = await readFile(original);
			expect(brotliDecompressSync(await readFile(`${original}.br`))).toEqual(bytes);
			expect(gunzipSync(await readFile(`${original}.gz`))).toEqual(bytes);
		}
		expect(await readdir(join(root, 'dist'))).not.toContain('index.html.br');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it.each(['missing-source', 'unwritable-output'] as const)(
	'fails the build when precompression cannot finish: %s',
	async (failure) => {
		const root = await mkdtemp(join(tmpdir(), 'marimohub-precompress-failure-'));
		try {
			await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
			await writeFile(
				join(root, 'main.js'),
				`console.log(${JSON.stringify('asset '.repeat(500))});`,
			);
			await expect(
				build({
					configFile: false,
					root,
					logLevel: 'silent',
					plugins: [
						{
							name: 'break-output',
							writeBundle({ dir }, bundle) {
								const file = Object.values(bundle).find((entry) => entry.type === 'chunk')!;
								const path = join(dir!, file.fileName);
								if (failure === 'missing-source') unlinkSync(path);
								else mkdirSync(`${path}.br`);
							},
						},
						precompress(),
					],
				}),
			).rejects.toThrow(failure === 'missing-source' ? /ENOENT/ : /EISDIR/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
