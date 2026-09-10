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

fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

// Reject a symlinked cacheRoot outright: in a sticky directory another user
// could have planted it before the mkdir and can re-point it afterwards.
if (fs.lstatSync(cacheRoot).isSymbolicLink()) {
	console.error(`${cacheRoot} is a symlink; refusing to use it`);
	process.exit(1);
}

// The unpacked bundle is executed, so every directory on the path to it must
// be one that no other user can rename or replace: owned by the current user
// or root, and not group/world-writable. Checking only cacheRoot is not
// enough, because whoever can write an ancestor can swap cacheRoot for a
// symlink to a prepared tree between this check and the import below. Sticky
// ancestors such as /tmp are tolerated: there, only the owner of an entry can
// rename or unlink it. The resolved path is checked, and used from here on, so
// an ancestor symlink maintained by root (/home -> /var/home) is allowed while
// the import path itself contains no symlink component.
const resolvedRoot = fs.realpathSync(cacheRoot);
const payloadDir = path.join(resolvedRoot, manifest.buildId);
const readyMarker = path.join(payloadDir, '.ready');
const rootStat = fs.lstatSync(resolvedRoot);
if (uid !== null && rootStat.uid !== uid) {
	console.error(`${cacheRoot} is not owned by the current user; set MARIMOHUB_SEA_CACHE_DIR`);
	process.exit(1);
}
for (let dir = resolvedRoot; ; dir = path.dirname(dir)) {
	const st = dir === resolvedRoot ? rootStat : fs.lstatSync(dir);
	if (st.isSymbolicLink()) {
		console.error(`${dir} is a symlink; refusing to use cache at ${cacheRoot}`);
		process.exit(1);
	}
	if (uid !== null && st.uid !== uid && st.uid !== 0) {
		console.error(
			`${dir} is owned by uid ${st.uid}, not the current user or root; set MARIMOHUB_SEA_CACHE_DIR`,
		);
		process.exit(1);
	}
	const sticky = dir !== resolvedRoot && st.mode & 0o1000;
	if (st.mode & 0o022 && !sticky) {
		console.error(
			`${dir} is group or world-writable (mode ${(st.mode & 0o777).toString(8)}); refusing to use cache at ${cacheRoot}`,
		);
		process.exit(1);
	}
	if (path.dirname(dir) === dir) break;
}

if (!fs.existsSync(readyMarker)) {
	// Unpack into a sibling temp dir and rename so a crash mid-extract, or two
	// instances starting at once, never leave a half-written payload behind.
	const staging = fs.mkdtempSync(path.join(resolvedRoot, 'unpack-'));
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
