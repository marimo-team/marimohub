import { readFile } from 'node:fs/promises';
const file = process.argv[2];
if (!file) throw new Error('Expected the Wrangler esbuild metafile path');
const { outputs } = JSON.parse(await readFile(file, 'utf8'));
const forbidden = Object.values(outputs).flatMap((output) =>
	Object.entries(output.inputs ?? {})
		.filter(
			([path, info]) =>
				info.bytesInOutput > 0 &&
				/(?:metadata-postgres\/|node_modules\/(?:pg|pg-pool|pg-protocol)\/)/.test(path),
		)
		.map(([path]) => path),
);
if (forbidden.length > 0)
	throw new Error(`Worker bundles PostgreSQL metadata dependencies: ${forbidden.join(', ')}`);
console.log('Worker bundle excludes PostgreSQL metadata dependencies');
