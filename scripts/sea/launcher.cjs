// SEA entrypoint. Node's single-executable loader only runs CommonJS and its
// `require` resolves built-ins only, so the real (ESM) server bundle is shipped
// as assets, unpacked to a per-build cache directory on first start, and then
// loaded with a dynamic import. Once on disk, `import.meta.url` inside the
// bundle resolves the worker scripts and DuckDB wasm files exactly as it does
// in the container image.
const sea = require('node:sea');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));

const uid = process.getuid ? process.getuid() : null;
// The unpacked bundle is executed, so the cache defaults to the user's own
// cache directory, whose ancestors only the user and root can write. A shared
// tmpdir would let any local user interfere with the path (see the checks below).
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

// Every directory on the path to the unpacked bundle must be one no other user
// can write: owned by the current user or root, and not group/world-writable.
// Checking only cacheRoot is not enough, because whoever can write an ancestor
// can swap cacheRoot for a symlink to a prepared tree between this check and
// the import below. Sticky directories such as /tmp are rejected too: the
// sticky bit stops renames, but a bundled module that still probes for an
// optional package would resolve it through /tmp/node_modules. The resolved
// path is checked, and used from here on, so an ancestor symlink maintained by
// root (/home -> /var/home) is allowed while the import path itself contains
// no symlink component.
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
	if (st.mode & 0o022) {
		console.error(
			`${dir} is group or world-writable (mode ${(st.mode & 0o777).toString(8)}); refusing to use cache at ${cacheRoot}`,
		);
		process.exit(1);
	}
	if (path.dirname(dir) === dir) break;
}

// Replacing a damaged payload directory runs under this lock so concurrent
// starts never remove a payload a peer has just repaired. The lock is held
// only across a marker check and one rename, so one older than a minute, or
// one whose creator is gone, belongs to a crashed process and is broken.
// Breaking a stale lock is an unlink by path, so two starts that observe the
// same stale lock at the same instant could both proceed; that is safe because
// the rename that moves the damaged tree aside succeeds for only one of them.
const repairLock = path.join(resolvedRoot, `${manifest.buildId}.repair.lock`);
const REPAIR_LOCK_STALE_MS = 60_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isStaleRepairLock() {
	let st;
	let pid;
	try {
		st = fs.statSync(repairLock);
		pid = Number(fs.readFileSync(repairLock, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
	if (Date.now() - st.mtimeMs > REPAIR_LOCK_STALE_MS) return true;
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === 'ESRCH';
	}
}

function acquireRepairLock() {
	for (;;) {
		try {
			fs.writeFileSync(repairLock, String(process.pid), { flag: 'wx', mode: 0o600 });
			return;
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}
		if (isStaleRepairLock()) {
			fs.rmSync(repairLock, { force: true });
			continue;
		}
		sleepSync(10);
	}
}

// Moves `staging` into place. Returns false when a peer's identical payload
// won the race, in which case `staging` has been discarded.
function installPayload(staging) {
	try {
		fs.renameSync(staging, payloadDir);
		return true;
	} catch (error) {
		if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
	}
	if (fs.existsSync(readyMarker)) {
		fs.rmSync(staging, { recursive: true, force: true });
		return false;
	}
	// A payload directory without its marker is damaged (the rename is atomic,
	// so only tampering or a partial delete gets here). Replace it rather than
	// importing from it forever after. The damaged tree is moved aside before it
	// is deleted: a recursive rm empties the directory first, and a peer's
	// rename onto an empty directory succeeds, so deleting in place could
	// strip a payload the peer just installed.
	const damaged = `${staging}-damaged`;
	acquireRepairLock();
	try {
		if (!fs.existsSync(readyMarker)) fs.renameSync(payloadDir, damaged);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	} finally {
		fs.rmSync(repairLock, { force: true });
	}
	fs.rmSync(damaged, { recursive: true, force: true });
	return installPayload(staging);
}

if (!fs.existsSync(readyMarker)) {
	// Unpack into a sibling temp dir and rename so a crash mid-extract, or two
	// instances starting at once, never leave a half-written payload behind.
	const staging = fs.mkdtempSync(path.join(resolvedRoot, 'unpack-'));
	try {
		for (const file of manifest.files) {
			const target = path.join(staging, file);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, Buffer.from(sea.getRawAsset(file)));
		}
		fs.writeFileSync(path.join(staging, '.ready'), '');
		installPayload(staging);
	} finally {
		// A failed extract (a full disk, say) would otherwise leave most of a
		// payload behind on every restart. After a successful install the
		// directory has been renamed away, so this is a no-op.
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

process.env.MARIMOHUB_STATIC_ROOT ??= path.join(payloadDir, 'public');
process.env.MARIMOHUB_VERSION ??= manifest.version;

// `import()` here would be resolved by the SEA loader, which only knows
// built-in specifiers (Node 26 rejects a file URL outright), so the dynamic
// import is delegated to a shim unpacked alongside the bundle.
const shim = path.join(payloadDir, 'importShim.cjs');
const dynamicImport = createRequire(shim)(shim);

dynamicImport(pathToFileURL(path.join(payloadDir, 'dist', 'index.mjs')).href).catch((error) => {
	console.error(error);
	process.exit(1);
});
