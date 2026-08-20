import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency rule (see AGENTS.md) is stated as a review criterion, which
 * let `smol-toml` and `yaml` land without the documented list being updated.
 * Encode it instead: core may depend only on generic, side-effect-free
 * utilities — never a vendor SDK, an adapter package, or anything that performs
 * I/O — so the domain stays swappable across providers.
 *
 * Adding an entry here is a deliberate architectural decision, not a fix for a
 * red test. A dependency that *reaches* something belongs behind a port.
 */
const ALLOWED_DEPENDENCIES = new Set([
	// The vendor-neutral OTEL facade: pure and I/O-free, every call is a no-op
	// unless an entrypoint registers a provider (the SDK stays in apps/server).
	'@opentelemetry/api',
	'better-all',
	// Pure in-memory (de)compression for workspace archive parsing — no I/O.
	'fflate',
	'smol-toml',
	'ulidx',
	'yaml',
	'zod',
]);

const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

describe('@marimo-hub/core dependency rule', () => {
	it('depends only on vendor-free utilities', () => {
		expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...ALLOWED_DEPENDENCIES].sort());
	});

	it('never depends on a sibling adapter package', () => {
		const siblings = [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		].filter((d) => /^@marimo-hub\/(storage|compute|auth|secrets|credentials)-/.test(d));
		expect(siblings).toEqual([]);
	});
});
