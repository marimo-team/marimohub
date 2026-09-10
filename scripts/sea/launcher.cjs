// SEA entrypoint. Node's single-executable loader only runs CommonJS and its
// `require` resolves built-ins only, so the real (ESM) server bundle is shipped
// as assets, unpacked to a per-build cache directory on first start, and then
// loaded with a dynamic import. Once on disk, `import.meta.url` inside the
// bundle resolves the worker scripts and DuckDB wasm files exactly as it does
// in the container image.
const sea = require('node:sea');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));

const cacheRoot = process.env.MARIMOHUB_SEA_CACHE_DIR ?? path.join(os.tmpdir(), 'marimohub-sea');
const payloadDir = path.join(cacheRoot, manifest.buildId);
const readyMarker = path.join(payloadDir, '.ready');

// The unpacked bundle is executed, so never load it from a directory another
// user could have pre-populated (the default lives under the shared tmpdir).
fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
if (process.getuid && fs.statSync(cacheRoot).uid !== process.getuid()) {
	console.error(`${cacheRoot} is not owned by the current user; set MARIMOHUB_SEA_CACHE_DIR`);
	process.exit(1);
}

if (!fs.existsSync(readyMarker)) {
	// Unpack into a sibling temp dir and rename so a crash mid-extract, or two
	// instances starting at once, never leave a half-written payload behind.
	const staging = fs.mkdtempSync(path.join(cacheRoot, 'unpack-'));
	for (const file of manifest.files) {
		const target = path.join(staging, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, Buffer.from(sea.getRawAsset(file)));
	}
	fs.writeFileSync(path.join(staging, '.ready'), '');
	try {
		fs.renameSync(staging, payloadDir);
	} catch (error) {
		if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

process.env.MARIMOHUB_STATIC_ROOT ??= path.join(payloadDir, 'public');
process.env.MARIMOHUB_VERSION ??= manifest.version;

import(pathToFileURL(path.join(payloadDir, 'dist', 'index.mjs')).href).catch((error) => {
	console.error(error);
	process.exit(1);
});
