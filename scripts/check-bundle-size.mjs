import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Intentional growth should update these measured thresholds with a justification;
// accidental growth should be fixed at the import or dependency that caused it.
const BUDGETS_KIB = {
	js: 2458,
	css: 13,
};

const dist = fileURLToPath(new URL('../packages/web/dist/', import.meta.url));

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

let files;
try {
	files = walk(dist);
} catch {
	process.stderr.write(
		'packages/web/dist not found — run `vp run --filter @marimo-hub/web build` first.\n',
	);
	process.exit(1);
}

const sized = files
	.filter((path) => path.endsWith('.js') || path.endsWith('.css'))
	.map((path) => ({
		path: path.slice(dist.length),
		kind: path.endsWith('.js') ? 'js' : 'css',
		gzipKib: gzipSync(readFileSync(path)).length / 1024,
	}))
	.sort((a, b) => b.gzipKib - a.gzipKib);

if (sized.length === 0) {
	process.stderr.write('no .js/.css files under packages/web/dist — build layout changed?\n');
	process.exit(1);
}

let failed = false;
for (const kind of ['js', 'css']) {
	const total = sized
		.filter((file) => file.kind === kind)
		.reduce((sum, file) => sum + file.gzipKib, 0);
	const budget = BUDGETS_KIB[kind];
	const line = `${kind}: ${total.toFixed(1)} KiB gzipped (budget ${budget} KiB)\n`;
	if (total > budget) {
		failed = true;
		process.stderr.write(`OVER BUDGET ${line}`);
	} else {
		process.stdout.write(line);
	}
}

if (failed) {
	process.stderr.write('Largest files:\n');
	for (const file of sized.slice(0, 10)) {
		process.stderr.write(`  ${file.gzipKib.toFixed(1).padStart(8)} KiB  ${file.path}\n`);
	}
	process.exit(1);
}
