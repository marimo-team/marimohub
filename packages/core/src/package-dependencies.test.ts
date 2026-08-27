import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The lint ban in vite.config.ts only catches import statements; this guards
// the other half of the dependency rule — an adapter sneaking into the
// manifest without any import (see AGENTS.md "The dependency rule").
const ADAPTER_PATTERN =
	/^@marimo-hub\/(?:(?:storage|compute|auth|credentials|secrets|notify|object-browser|source-control)-|duckdb-wasm-runtime$|postgres-runtime$)/;

const DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

it('recognizes source-control implementations as adapters', () => {
	expect(ADAPTER_PATTERN.test('@marimo-hub/source-control-github')).toBe(true);
});

it('declares no adapter packages in any dependency field', () => {
	const pkg = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	) as Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;
	for (const field of DEPENDENCY_FIELDS) {
		const names = Object.keys(pkg[field] ?? {});
		expect(names.filter((name) => ADAPTER_PATTERN.test(name))).toEqual([]);
	}
});
