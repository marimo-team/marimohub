import { readFileSync } from 'node:fs';

const rootVersion = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const cargo = readFileSync(new URL('../apps/cli/Cargo.toml', import.meta.url), 'utf8');

const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
if (cargoVersion !== rootVersion) {
	console.error(
		`version mismatch: package.json=${rootVersion}, apps/cli/Cargo.toml=${cargoVersion}`,
	);
	process.exit(1);
}
