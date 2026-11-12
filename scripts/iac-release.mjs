import { readFileSync } from 'node:fs';

export const root = new URL('../', import.meta.url);

export function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

export function readIacRelease() {
	const { version } = readJson(new URL('package.json', root));
	const packagePath = new URL('packages/iac/package.json', root);
	const manifest = readJson(packagePath);
	if (
		typeof version !== 'string' ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
		manifest?.name !== '@marimo-hub/iac'
	) {
		throw new Error('Release requires a stable version and the IaC package manifest.');
	}
	return { version, manifest, packagePath };
}
