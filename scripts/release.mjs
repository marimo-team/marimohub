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

run('git', 'add', 'package.json');
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
		`Merging this PR tags \`v${version}\` and publishes the container image and Helm chart to GHCR.`,
	],
	{ stdio: 'inherit' },
);
