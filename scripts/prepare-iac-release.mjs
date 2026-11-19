import { writeFileSync } from 'node:fs';
import { readIacRelease } from './iac-release.mjs';

const { version, manifest, packagePath } = readIacRelease();
manifest.version = version;
writeFileSync(packagePath, `${JSON.stringify(manifest, null, '\t')}\n`);
