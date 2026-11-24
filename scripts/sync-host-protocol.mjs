import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: node scripts/sync-host-protocol.mjs <marimo-checkout>');
const root = resolve(checkout);
const destination = new URL('../internal/host-protocol/vendor/', import.meta.url);
const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const spec = execFileSync('node', [resolve(root, 'packages/host-protocol/scripts/openapi.ts')], {
	maxBuffer: 16 * 1024 * 1024,
});
JSON.parse(spec.toString());
const fixtures = ['edit-response.json', 'notebook-events.sse', 'problems/precondition-failed.json'];
const files = [
	['REVISION', revision],
	['openapi.json', spec],
	['LICENSE', readFileSync(resolve(root, 'LICENSE'))],
	...fixtures.map((name) => [
		`fixtures/${name}`,
		readFileSync(resolve(root, 'protocols/host/fixtures', name)),
	]),
];

rmSync(destination, { recursive: true, force: true });
for (const [name, content] of files) {
	const target = new URL(name, destination);
	mkdirSync(new URL('.', target), { recursive: true });
	writeFileSync(target, content);
}
