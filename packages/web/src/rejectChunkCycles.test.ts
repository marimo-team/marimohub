import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { rejectChunkCycles } from '../rejectChunkCycles';

it.each(['static cycle', 'dynamic back edge', 'automatic splitting'] as const)(
	'checks emitted chunk imports: %s',
	async (scenario) => {
		const root = await mkdtemp(join(tmpdir(), 'marimohub-chunk-cycles-'));
		try {
			await Promise.all([
				writeFile(join(root, 'main.js'), "import { a } from './a.js'; console.log(a);"),
				writeFile(join(root, 'a.js'), "import { b } from './b.js'; export const a = b;"),
				writeFile(
					join(root, 'b.js'),
					scenario === 'dynamic back edge'
						? "export const b = () => import('./c.js');"
						: "import { c } from './c.js'; export const b = c + 1;",
				),
				writeFile(join(root, 'c.js'), 'export const c = Math.random();'),
			]);
			const result = build({
				configFile: false,
				root,
				logLevel: 'silent',
				plugins: [rejectChunkCycles()],
				build: {
					write: false,
					lib: { entry: join(root, 'main.js'), formats: ['es'] },
					rolldownOptions: {
						preserveEntrySignatures: 'allow-extension',
						output: {
							codeSplitting:
								scenario === 'automatic splitting'
									? true
									: {
											groups: [
												{
													name: 'grouped',
													test: /\/[ac]\.js$/,
													includeDependenciesRecursively: false,
												},
												{
													name: 'dependency',
													test: /\/b\.js$/,
													includeDependenciesRecursively: false,
												},
											],
										},
						},
					},
				},
			});
			if (scenario === 'static cycle') {
				await expect(result).rejects.toThrow(/Static chunk import cycle: .* -> .* -> /);
			} else {
				await expect(result).resolves.toBeDefined();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
