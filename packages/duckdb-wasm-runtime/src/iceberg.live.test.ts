import { describe, expect, it } from 'vitest';
import { createNodeDuckDBWasmRuntimeFactory, nodeDuckDBWasmCapabilities } from './node';

const uri = process.env.MARIMOHUB_TEST_DUCKDB_WASM_ICEBERG_URI;
const table = process.env.MARIMOHUB_TEST_DUCKDB_WASM_ICEBERG_TABLE;
const supportsIcebergHttp = nodeDuckDBWasmCapabilities().features.includes('iceberg-http');

if (uri && table && supportsIcebergHttp) {
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
	describe.skip('DuckDB-Wasm guarded Iceberg transport (requires fixture and iceberg-http support)', () => {
		it('requires a live broker fixture', () => {});
	});
}

function qualifiedIdentifier(value: string): string {
	return value
		.split('.')
		.map((part) => `"${part.replaceAll('"', '""')}"`)
		.join('.');
}
