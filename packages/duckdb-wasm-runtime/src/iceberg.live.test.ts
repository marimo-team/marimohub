import { describe, expect, it } from 'vitest';
import { createNodeDuckDBWasmRuntimeFactory } from './node';

const uri = process.env.MARIMOHUB_TEST_DUCKDB_WASM_ICEBERG_URI;
const table = process.env.MARIMOHUB_TEST_DUCKDB_WASM_ICEBERG_TABLE;

if (uri && table) {
	describe('DuckDB-Wasm guarded Iceberg transport (live)', () => {
		it('scans Iceberg only after the brokered runtime advertises support', async () => {
			const runtime = await createNodeDuckDBWasmRuntimeFactory('worker')();
			try {
				expect(runtime.features).toContain('iceberg-http');
				await runtime.initialize({ memoryLimitMb: 128 });
				await expect(
					runtime.execute({
						setup: [
							{ text: 'LOAD iceberg' },
							{ text: 'LOAD httpfs' },
							{
								text: `ATTACH 'live' AS live_iceberg (TYPE iceberg, ENDPOINT ?, READ_ONLY)`,
								params: [uri],
							},
						],
						query: { text: `SELECT * FROM live_iceberg.${qualifiedIdentifier(table)} LIMIT 1` },
						cleanup: [{ text: 'DETACH live_iceberg' }],
						requires: ['iceberg-http'],
					}),
				).resolves.toMatchObject({ columns: expect.any(Array), rows: expect.any(Array) });
			} finally {
				await runtime.close();
			}
		});
	});
} else {
	describe.skip('DuckDB-Wasm guarded Iceberg transport (set URI and TABLE fixture variables)', () => {
		it('requires a live broker fixture', () => {});
	});
}

function qualifiedIdentifier(value: string): string {
	return value
		.split('.')
		.map((part) => `"${part.replaceAll('"', '""')}"`)
		.join('.');
}
