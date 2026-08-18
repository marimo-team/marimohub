import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DUCKDB_ENGINE_VERSION,
	DUCKDB_EXTENSION_MANIFEST,
	DUCKDB_WASM_PACKAGE_VERSION,
} from './extensionManifest';

describe('DuckDB extension manifest', () => {
	it('matches the pinned package and embedded engine versions', () => {
		const workspace = readFileSync(
			fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url)),
			'utf8',
		);
		expect(workspace).toContain(`'@duckdb/duckdb-wasm': ${DUCKDB_WASM_PACKAGE_VERSION}`);

		const wasm = new URL(import.meta.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
		const badge = readFileSync(
			fileURLToPath(new URL('./img/duckdb_version_badge.svg', wasm)),
			'utf8',
		);
		expect(badge).toContain(`duckdb: v${DUCKDB_ENGINE_VERSION}`);
	});

	it('matches every packaged extension checksum', () => {
		for (const asset of Object.values(DUCKDB_EXTENSION_MANIFEST)) {
			const bytes = readFileSync(
				fileURLToPath(new URL(`../assets/extensions/${asset.file}`, import.meta.url)),
			);
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
		}
	});
});
