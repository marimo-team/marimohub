import { writeFileSync } from 'node:fs';
import { readIacRelease, readJson, root } from './iac-release.mjs';

const { version, manifest, packagePath } = readIacRelease();
const examplePath = new URL('examples/integration-iac/deno/deno.json', root);
const example = readJson(examplePath);
if (
	!example ||
	typeof example !== 'object' ||
	!example.imports ||
	typeof example.imports !== 'object' ||
	Array.isArray(example.imports)
) {
	throw new Error('Release preparation requires a Deno imports map.');
}
manifest.version = version;
example.imports['@marimo-hub/iac'] = `npm:@marimo-hub/iac@${version}`;
example.imports['@marimo-hub/iac/runner'] = `npm:@marimo-hub/iac@${version}/runner`;
writeFileSync(packagePath, `${JSON.stringify(manifest, null, '\t')}\n`);
writeFileSync(examplePath, `${JSON.stringify(example, null, '\t')}\n`);
