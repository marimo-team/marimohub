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

const uid = process.getuid ? process.getuid() : null;
// The bundle still `require()`s optional packages it does not ship (ws's
// bufferutil, node-fetch's encoding), and Node resolves those through every
// ancestor node_modules directory up to /. Under a shared tmpdir any local
// user could plant /tmp/node_modules, so the default cache lives beneath the
// user's own cache directory, whose ancestors only the user and root can write.
let homeDir = null;
try {
	homeDir = os.homedir();
} catch {
	homeDir = null;
}
const cacheBase =
	process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME)
		? process.env.XDG_CACHE_HOME
		: homeDir && path.join(homeDir, '.cache');
const cacheRoot =
	process.env.MARIMOHUB_SEA_CACHE_DIR ?? (cacheBase ? path.join(cacheBase, 'marimohub-sea') : null);
if (!cacheRoot) {
	console.error('Cannot determine a cache directory; set MARIMOHUB_SEA_CACHE_DIR');
	process.exit(1);
}
const payloadDir = path.join(cacheRoot, manifest.buildId);
const readyMarker = path.join(payloadDir, '.ready');

fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

// Reject symlinks: an attacker in /tmp could plant one before the mkdir.
const rootStat = fs.lstatSync(cacheRoot);
if (rootStat.isSymbolicLink()) {
	console.error(`${cacheRoot} is a symlink; refusing to use it`);
	process.exit(1);
}
if (uid !== null && rootStat.uid !== uid) {
	console.error(`${cacheRoot} is not owned by the current user; set MARIMOHUB_SEA_CACHE_DIR`);
	process.exit(1);
}
// Reject group/world-writable directories: another user could swap files
// between the permission check and import.
if (rootStat.mode & 0o022) {
	console.error(
		`${cacheRoot} is group or world-writable (mode ${(rootStat.mode & 0o777).toString(8)}); refusing to use it`,
	);
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
