import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { EXPERIMENTS } from './experiments';
import { CONFIG_SPEC, CONFIG_DOCUMENTED_IDS, CONFIG_VAR_IDS } from './spec';
import type { ConfigVar } from './spec';

// Files that read the env surface; scanned for MARIMOHUB_*/PORT literals.
const WIRING_SOURCES = [
	fileURLToPath(new URL('./index.ts', import.meta.url)),
	fileURLToPath(new URL('./library.ts', import.meta.url)),
	fileURLToPath(new URL('./storage.ts', import.meta.url)),
	fileURLToPath(new URL('./compute.ts', import.meta.url)),
	fileURLToPath(new URL('./auth.ts', import.meta.url)),
	fileURLToPath(new URL('./wif.ts', import.meta.url)),
	fileURLToPath(new URL('./ai.ts', import.meta.url)),
	fileURLToPath(new URL('./secrets.ts', import.meta.url)),
	fileURLToPath(new URL('./integrations.ts', import.meta.url)),
	fileURLToPath(new URL('./postgresFeatures.ts', import.meta.url)),
	fileURLToPath(new URL('./experiments.ts', import.meta.url)),
	fileURLToPath(new URL('./notifications.ts', import.meta.url)),
	fileURLToPath(new URL('./projectAlerts.ts', import.meta.url)),
	fileURLToPath(new URL('./resourceSecurity.ts', import.meta.url)),
	fileURLToPath(new URL('./sourceControl.ts', import.meta.url)),
	fileURLToPath(new URL('./surfaces.ts', import.meta.url)),
	fileURLToPath(new URL('../../../apps/server/src/index.ts', import.meta.url)),
];

// Literals that appear in the wiring sources but aren't config vars.
const IGNORED = new Set([
	// Compatibility-only fallbacks. Keep the engine-specific names out of the public config surface.
	'MARIMOHUB_DUCKDB_WASM_IDLE_TIMEOUT_SECONDS',
	'MARIMOHUB_DUCKDB_WASM_MEMORY_LIMIT_MB',
	'MARIMOHUB_DUCKDB_WASM_RUNTIME',
	// Removed by CoreWeave Sandbox v1; read only to reject them with a
	// migration-pointing ConfigError at boot.
	'MARIMOHUB_COMPUTE_COREWEAVE_PROFILE',
	'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MODE',
	'MARIMOHUB_COMPUTE_COREWEAVE_EGRESS_MODE',
]);

function scanReferencedIds(): Set<string> {
	const found = new Set<string>();
	for (const path of WIRING_SOURCES) {
		const src = readFileSync(path, 'utf8');
		for (const m of src.matchAll(/MARIMOHUB_[A-Z0-9_]+/g)) found.add(m[0]);
		// `PORT` is read as `process.env.PORT` and does not carry the prefix.
		if (/process\.env\.PORT\b/.test(src)) found.add('PORT');
	}
	for (const id of IGNORED) found.delete(id);
	return found;
}

const sorted = (s: Iterable<string>) => [...s].sort();

describe('config registry drift', () => {
	it('every MARIMOHUB_*/PORT env var read by the wiring is documented in spec.ts (and vice-versa)', () => {
		// If this fails, add or remove the var in packages/config/src/spec.ts so the
		// registry matches what createFromEnv() / apps/server actually read.
		expect(sorted(scanReferencedIds())).toEqual(sorted(CONFIG_DOCUMENTED_IDS));
	});
});

describe('config registry sanity', () => {
	it('has no duplicate variable ids within a backend', () => {
		for (const group of CONFIG_SPEC) {
			for (const backend of group.backends) {
				const ids = backend.vars.map((variable) => variable.id);
				expect(new Set(ids).size, `${group.name}/${backend.name}`).toBe(ids.length);
			}
		}
	});

	it('reuses one definition when a variable applies to multiple backends', () => {
		// Only `example` may differ per backend (a Bedrock model id is not an OpenAI one).
		const shared = ({ example: _example, ...rest }: ConfigVar) => rest;
		const definitions = new Map<string, ConfigVar>();
		for (const variable of CONFIG_SPEC.flatMap((group) =>
			group.backends.flatMap((backend) => backend.vars),
		)) {
			const existing = definitions.get(variable.id);
			if (existing) expect(shared(variable), variable.id).toEqual(shared(existing));
			else definitions.set(variable.id, variable);
		}
		expect(sorted(definitions.keys())).toEqual(sorted(CONFIG_VAR_IDS));
	});

	it('every variable has a name and a non-empty description', () => {
		for (const g of CONFIG_SPEC) {
			for (const b of g.backends) {
				for (const v of b.vars) {
					expect(v.name.trim(), v.id).not.toBe('');
					expect(v.description.trim(), v.id).not.toBe('');
				}
			}
		}
	});

	it('marks the ignored OIDC audience setting as deprecated', () => {
		const audience = CONFIG_SPEC.flatMap((group) => group.backends)
			.flatMap((backend) => backend.vars)
			.find((variable) => variable.id === 'MARIMOHUB_AUTH_OIDC_AUDIENCE');

		expect(audience?.name).toContain('deprecated');
		expect(audience?.description).toContain('ignored');
		expect(audience?.description).toContain('client ID');
	});

	it('does not recommend an experiment when no experiment exists', () => {
		if (Object.keys(EXPERIMENTS).length > 0) return;
		const experiments = CONFIG_SPEC.flatMap((group) => group.backends)
			.flatMap((backend) => backend.vars)
			.find((variable) => variable.id === 'MARIMOHUB_EXPERIMENTS');

		expect(experiments?.example).toBeUndefined();
	});

	it('documents proxy header defaults as mode-specific guidance', () => {
		const auth = CONFIG_SPEC.find((group) => group.selector === 'MARIMOHUB_AUTH_BACKEND');
		const oidc = auth?.backends.find((backend) => backend.selectorValue === 'oidc');
		const proxy = auth?.backends.find((backend) => backend.selectorValue === 'proxy-header');
		const header = proxy?.vars.find((variable) => variable.id === 'MARIMOHUB_AUTH_PROXY_HEADER');

		expect(oidc?.description).toContain('`hd` hint');
		expect(header?.default).toBeUndefined();
		expect(header?.description).toContain('X-Forwarded-Email,X-Forwarded-User');
		expect(header?.description).toContain('X-Goog-IAP-JWT-Assertion');
	});

	it('selector values are unique within a group, and only appear where a group has a selector', () => {
		for (const g of CONFIG_SPEC) {
			const selectorValues = g.backends
				.map((b) => b.selectorValue)
				.filter((v): v is string => Boolean(v));
			expect(new Set(selectorValues).size, g.name).toBe(selectorValues.length);
			if (!g.selector) expect(selectorValues, g.name).toEqual([]);
		}
	});
});
