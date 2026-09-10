#!/usr/bin/env node
// Build a single-executable marimohub server with Node SEA.
//
//   node scripts/build-sea.mjs            # builds web + server first
//   node scripts/build-sea.mjs --no-build # reuse existing dist/ output
//
// Output: apps/server/dist/sea/marimohub-<platform>-<arch> (plus the
// intermediate blob/config). Always targets the host: the executable is a copy
// of the running `node` with the SEA blob injected, and there is no
// cross-building, so run this on the target OS and architecture. Releases only
// ship marimohub-linux-x64; other platforms are for local testing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverDist = join(repoRoot, 'apps/server/dist');
const webDist = join(repoRoot, 'packages/web/dist');
const outDir = join(serverDist, 'sea');
const build = !process.argv.includes('--no-build');
const nodeBinary = process.execPath;

const run = (cmd, args, opts = {}) => {
	console.log(`$ ${cmd} ${args.join(' ')}`);
	execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
};

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});

if (build) {
	run('pnpm', [
		'exec',
		'vp',
		'run',
		'--filter',
		'@marimo-hub/web',
		'--filter',
		'@marimo-hub/server',
		'build',
	]);
}
for (const file of [join(serverDist, 'index.mjs'), join(webDist, 'index.html')]) {
	if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
		console.error(`missing ${file}; run without --no-build`);
		process.exit(1);
	}
}

rmSync(outDir, { recursive: true, force: true });

// Every payload file becomes a named SEA asset; the launcher unpacks them by
// the names listed in manifest.json. Keys are POSIX-style relative paths.
const assets = {};
const hash = createHash('sha256');
const addTree = (root, prefix) => {
	for (const file of walk(root).sort()) {
		const key = `${prefix}/${relative(root, file).split('\\').join('/')}`;
		assets[key] = file;
		hash.update(key).update(readFileSync(file));
	}
};
addTree(serverDist, 'dist');
addTree(webDist, 'public');
mkdirSync(outDir, { recursive: true });

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const manifest = { version, buildId: hash.digest('hex').slice(0, 16), files: Object.keys(assets) };
const manifestPath = join(outDir, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest));
assets['manifest.json'] = manifestPath;

const launcher = join(outDir, 'launcher.cjs');
cpSync(join(repoRoot, 'scripts/sea/launcher.cjs'), launcher);

const seaConfig = join(outDir, 'sea-config.json');
const blob = join(outDir, 'sea.blob');
writeFileSync(
	seaConfig,
	JSON.stringify(
		{
			main: launcher,
			output: blob,
			disableExperimentalSEAWarning: true,
			assets,
		},
		null,
		2,
	),
);

run(nodeBinary, ['--experimental-sea-config', seaConfig]);

const exe = join(
	outDir,
	`marimohub-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
);
cpSync(nodeBinary, exe);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);

const postjectArgs = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('pnpm', ['exec', 'postject', ...postjectArgs]);

if (process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(
	`\nbuilt ${exe} (${mb} MB, ${manifest.files.length} embedded files, build ${manifest.buildId})`,
);
