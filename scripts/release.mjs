// Cut a release PR: bump the root package.json version on a fresh branch off
// origin/main and open a PR titled "release: X.Y.Z". Merging that PR triggers
// the tag + publish workflows — see development_docs/releasing.md.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const fail = (message) => {
	console.error(message);
	process.exit(1);
};

const arg = process.argv[2];
if (!arg) {
	console.error('usage: pnpm release <X.Y.Z | patch | minor | major>');
	process.exit(1);
}
const isBump = arg === 'patch' || arg === 'minor' || arg === 'major';
if (!isBump && !/^\d+\.\d+\.\d+$/.test(arg)) {
	console.error(`invalid version "${arg}" — expected X.Y.Z, patch, minor, or major`);
	process.exit(1);
}

const missing = ['git', 'gh', 'cargo'].filter((tool) => {
	try {
		execFileSync(tool, ['--version'], { stdio: 'ignore' });
		return false;
	} catch {
		return true;
	}
});
if (missing.length > 0) {
	fail(`missing required tools: ${missing.join(', ')} (cargo: https://rustup.rs)`);
}
try {
	execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
	fail("gh is not authenticated — run 'gh auth login'");
}

if (run('git', 'status', '--porcelain') !== '') {
	console.error('working tree is not clean — commit or stash first');
	process.exit(1);
}

// The release branch is cut from origin/main, so validate and bump the files
// as they exist there — the local checkout may be on an older commit.
run('git', 'fetch', 'origin', 'main');
const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(run('git', 'show', 'origin/main:package.json'));
const cargoPath = new URL('../apps/cli/Cargo.toml', import.meta.url);
const cargoToml = execFileSync('git', ['show', 'origin/main:apps/cli/Cargo.toml'], {
	encoding: 'utf8',
});
const cargoPattern = /^version = "[^"]+"$/m;
if (!cargoPattern.test(cargoToml)) {
	fail('could not find the current Cargo package version');
}

let version = arg;
if (isBump) {
	const [major, minor, patch] = pkg.version.split('.').map(Number);
	version =
		arg === 'major'
			? `${major + 1}.0.0`
			: arg === 'minor'
				? `${major}.${minor + 1}.0`
				: `${major}.${minor}.${patch + 1}`;
}

const branch = `release/${version}`;
const tag = `v${version}`;
const localRefExists = (ref) => {
	try {
		run('git', 'show-ref', '--verify', '--quiet', ref);
		return true;
	} catch {
		return false;
	}
};
const remoteRefExists = (ref) => run('git', 'ls-remote', 'origin', ref) !== '';
if (localRefExists(`refs/tags/${tag}`) || remoteRefExists(`refs/tags/${tag}`)) {
	fail(`tag ${tag} already exists`);
}
if (localRefExists(`refs/heads/${branch}`)) {
	fail(`local branch ${branch} already exists — delete it with 'git branch -D ${branch}'`);
}
if (remoteRefExists(`refs/heads/${branch}`)) {
	fail(`remote branch origin/${branch} already exists`);
}

run('git', 'checkout', '-b', branch, 'origin/main');

pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, '\t')}\n`);

writeFileSync(cargoPath, cargoToml.replace(cargoPattern, `version = "${version}"`));
run('cargo', 'update', '--manifest-path', 'apps/cli/Cargo.toml', '--package', 'mohub');

run('git', 'add', 'package.json', 'apps/cli/Cargo.toml', 'apps/cli/Cargo.lock');
run('git', 'commit', '-m', `release: ${version}`);
run('git', 'push', '-u', 'origin', branch);
execFileSync(
	'gh',
	[
		'pr',
		'create',
		'--title',
		`release: ${version}`,
		'--body',
		`Merging this PR tags \`${tag}\` and publishes the container image, Helm chart, and mohub CLI.`,
	],
	{ stdio: 'inherit' },
);
