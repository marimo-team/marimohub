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
// ship marimohub-linux-x64; macOS is for local testing. Windows is refused
// below.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'postject';
import { collectPayload } from './sea/payload.mjs';

// The launcher guards the directory it unpacks executable code into with POSIX
// ownership and mode bits. Windows only synthesises those: an ordinary
// directory reports 0o777, so the binary refuses to start. Until that guard has
// a Windows equivalent, do not produce an executable that cannot run.
if (process.platform === 'win32') {
	console.error(
		'build-sea.mjs does not support Windows; see the cache checks in scripts/sea/launcher.cjs',
	);
	process.exit(1);
}

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

if (build) {
	// The release runner has vite-plus but no package manager, and on Windows a
	// `node_modules/.bin` entry is a `.cmd` shim that execFileSync cannot spawn.
	// vite-plus ships its bin as a plain Node script, so run that.
	const vpPackage = createRequire(import.meta.url).resolve('vite-plus/package.json');
	const vp = join(dirname(vpPackage), JSON.parse(readFileSync(vpPackage, 'utf8')).bin.vp);
	run(nodeBinary, [
		vp,
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

const launcherSource = join(repoRoot, 'scripts/sea/launcher.cjs');
const { assets, buildId } = collectPayload({
	serverDist,
	webDist,
	shim: join(repoRoot, 'scripts/sea/importShim.cjs'),
	launcher: launcherSource,
});
mkdirSync(outDir, { recursive: true });

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const manifest = { version, buildId, files: Object.keys(assets) };
const manifestPath = join(outDir, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest));
assets['manifest.json'] = manifestPath;

const launcher = join(outDir, 'launcher.cjs');
cpSync(launcherSource, launcher);

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

const exe = join(outDir, `marimohub-${process.platform}-${process.arch}`);
cpSync(nodeBinary, exe);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);

// postject's own CLI would have to be reached through a package manager, and
// the release runner has none; its library API resolves from the frozen
// workspace lock just the same.
console.log(`$ postject ${exe} NODE_SEA_BLOB ${blob}`);
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
	sentinelFuse: SEA_FUSE,
	...(process.platform === 'darwin' && { machoSegmentName: 'NODE_SEA' }),
});

if (process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(
	`\nbuilt ${exe} (${mb} MB, ${manifest.files.length} embedded files, build ${manifest.buildId})`,
);
