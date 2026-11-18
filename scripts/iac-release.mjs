import { readFileSync } from 'node:fs';
import { isStableVersion } from './release-version.mjs';

export const root = new URL('../', import.meta.url);

export function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

export function readIacRelease() {
	const { version } = readJson(new URL('package.json', root));
	const packagePath = new URL('packages/iac/package.json', root);
	const manifest = readJson(packagePath);
	if (!isStableVersion(version) || manifest?.name !== '@marimo-hub/iac') {
		throw new Error('Release requires a stable version and the IaC package manifest.');
	}
	return { version, manifest, packagePath };
}
