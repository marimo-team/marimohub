import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function nextVersion(current, requested) {
	if (!stable.test(current)) throw new Error('Current version must be stable SemVer');
	const parts = current.split('.').map(BigInt);
	const bump = ['major', 'minor', 'patch'].indexOf(requested);
	let next = requested;
	if (bump !== -1) {
		parts[bump] += 1n;
		for (let i = bump + 1; i < parts.length; i++) parts[i] = 0n;
		next = parts.join('.');
	}
	if (!stable.test(next)) throw new Error('Expected X.Y.Z, patch, minor, or major');
	const before = current.split('.').map(BigInt);
	const after = next.split('.').map(BigInt);
	const index = after.findIndex((part, i) => part !== before[i]);
	if (index === -1 || after[index] < before[index]) {
		throw new Error('Release version must be greater than the current version');
	}
	return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
	const version = nextVersion(pkg.version, process.argv[2]);
	const path = 'apps/cli/Cargo.toml';
	const cargo = readFileSync(path, 'utf8');
	const pattern = /^version = "[^"]+"$/m;
	if (!pattern.test(cargo)) throw new Error('Missing Cargo package version');
	pkg.version = version;
	writeFileSync('package.json', `${JSON.stringify(pkg, null, '\t')}\n`);
	execFileSync('node', ['scripts/prepare-iac-release.mjs'], { stdio: 'inherit' });
	writeFileSync(path, cargo.replace(pattern, `version = "${version}"`));
	execFileSync('cargo', ['update', '--manifest-path', path, '--package', 'mohub'], {
		stdio: 'inherit',
	});
	console.log(`Prepared release ${version}`);
}
