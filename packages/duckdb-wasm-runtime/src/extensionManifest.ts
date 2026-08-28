export interface DuckDBExtensionAsset {
	file: string;
	sha256: string;
}

export const DUCKDB_WASM_PACKAGE_VERSION = '1.32.0';
export const DUCKDB_ENGINE_VERSION = '1.4.3';
export const DUCKLAKE_SPEC_VERSION = '0.3';
export const DUCKDB_EXTENSION_ORIGIN = `https://extensions.duckdb.org/v${DUCKDB_ENGINE_VERSION}/wasm_eh/`;

export const DUCKDB_EXTENSION_MANIFEST: Readonly<Record<string, DuckDBExtensionAsset>> =
	Object.freeze({
		avro: {
			file: 'avro.duckdb_extension.wasm',
			sha256: 'e22ea12d23eb7e5747118f0f1344541bacfe6aeeb664d8c05c2ec8350e4ff498',
		},
		ducklake: {
			file: 'ducklake.duckdb_extension.wasm',
			sha256: '11117e6faf92b7ab39ab3d2acca0eb103be9eb4f8a4398f4d718ba3ed9ff1679',
		},
		httpfs: {
			file: 'httpfs.duckdb_extension.wasm',
			sha256: '5e76d1fb0779c4803ebfd6fb49b80ff833c11b9a6f55208a701e63a491df1d5c',
		},
		iceberg: {
			file: 'iceberg.duckdb_extension.wasm',
			sha256: 'a58f8df016d86c4c57c7abaded4be344364ec63b768d088502e60cc3776f770f',
		},
		parquet: {
			file: 'parquet.duckdb_extension.wasm',
			sha256: '22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55',
		},
	});
