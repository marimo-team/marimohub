import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const version = json('package.json').version;
assert.equal(json('packages/iac/package.json').version, version);
// The Deno example imports the SDK sources from one commit of this repository. The URL
// entries map the sources' extensionless relative imports, so every entry must share that commit.
const imports = json('examples/integration-iac/deno/deno.json').imports;
const source =
	/^https:\/\/raw\.githubusercontent\.com\/marimo-team\/marimohub\/([0-9a-f]{40})\/packages\/iac\/src\/(index|runner|generated)(\.ts)?$/;
const commits = new Set();
for (const [name, target] of Object.entries(imports)) {
	const match = source.exec(target);
	assert.ok(match?.[3], `${name} must import a pinned SDK source file`);
	if (name.startsWith('https://'))
		assert.ok(source.test(name), `${name} must alias a pinned SDK source`);
	commits.add(match[1]);
}
assert.equal(imports['@marimo-hub/iac']?.endsWith('/index.ts'), true);
assert.equal(imports['@marimo-hub/iac/runner']?.endsWith('/runner.ts'), true);
assert.equal(commits.size, 1, 'Deno example imports must pin one commit');
const cargo = readFileSync('apps/cli/Cargo.toml', 'utf8');
assert.equal(cargo.match(/^version = "([^"]+)"$/m)?.[1], version);
const lock = readFileSync('apps/cli/Cargo.lock', 'utf8');
assert.equal(lock.match(/\[\[package\]\]\nname = "mohub"\nversion = "([^"]+)"/)?.[1], version);
