import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
// @ts-expect-error Build-time generator uses Node ESM.
import { generate } from '../scripts/generate.mjs';

function formatted(source: string, path: URL): string {
	return execFileSync('pnpm', ['exec', 'vp', 'fmt', '--stdin-filepath', fileURLToPath(path)], {
		input: source,
		encoding: 'utf8',
		maxBuffer: 4 * 1024 * 1024,
	});
}
it('keeps generated inputs and all kind samples synchronized', async () => {
	const expected = await generate();
	const types = new URL('./generated.ts', import.meta.url);
	const samples = new URL('./samples.ts', import.meta.url);
	expect(await readFile(types, 'utf8')).toBe(formatted(expected.types, types));
	expect(await readFile(samples, 'utf8')).toBe(formatted(expected.samples, samples));
});
