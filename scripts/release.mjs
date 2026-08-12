// Cut a release PR: bump the root package.json version on a fresh branch off
// origin/main and open a PR titled "release: X.Y.Z". Merging that PR triggers
// the tag + publish workflows — see development_docs/releasing.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

const arg = process.argv[2];
if (!arg) {
	console.error('usage: pnpm release <X.Y.Z | patch | minor | major>');
	process.exit(1);
}

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cargoPath = new URL('../apps/cli/Cargo.toml', import.meta.url);
const cargoLockPath = new URL('../apps/cli/Cargo.lock', import.meta.url);

let version = arg;
if (arg === 'patch' || arg === 'minor' || arg === 'major') {
	const [major, minor, patch] = pkg.version.split('.').map(Number);
	version =
		arg === 'major'
			? `${major + 1}.0.0`
			: arg === 'minor'
				? `${major}.${minor + 1}.0`
				: `${major}.${minor}.${patch + 1}`;
} else if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`invalid version "${version}" — expected X.Y.Z, patch, minor, or major`);
	process.exit(1);
}

if (run('git', 'status', '--porcelain') !== '') {
	console.error('working tree is not clean — commit or stash first');
	process.exit(1);
}

run('git', 'fetch', 'origin', 'main');
run('git', 'checkout', '-b', `release/${version}`, 'origin/main');

pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, '\t')}\n`);

const replaceVersion = (path, pattern, replacement, label) => {
	const current = readFileSync(path, 'utf8');
	if (!pattern.test(current)) {
		console.error(`could not find the current ${label} version`);
		process.exit(1);
	}
	writeFileSync(path, current.replace(pattern, replacement));
};

replaceVersion(cargoPath, /^version = "[^"]+"$/m, `version = "${version}"`, 'Cargo package');
replaceVersion(
	cargoLockPath,
	/(\[\[package\]\]\nname = "mohub"\nversion = ")[^"]+("\n)/,
	`$1${version}$2`,
	'Cargo lockfile',
);

run('git', 'add', 'package.json', 'apps/cli/Cargo.toml', 'apps/cli/Cargo.lock');
run('git', 'commit', '-m', `release: ${version}`);
run('git', 'push', '-u', 'origin', `release/${version}`);
execFileSync(
	'gh',
	[
		'pr',
		'create',
		'--title',
		`release: ${version}`,
		'--body',
		`Merging this PR tags \`v${version}\` and publishes the container image, Helm chart, and mohub CLI.`,
	],
	{ stdio: 'inherit' },
);
