import { describe, expect, it } from 'vitest';
import { parseExperiments } from './experiments';

describe('parseExperiments', () => {
	it('returns an empty set when unset', () => {
		expect([...parseExperiments({})]).toEqual([]);
	});

	it('normalizes and deduplicates experiment IDs', () => {
		expect([
			...parseExperiments({
				MARIMOHUB_EXPERIMENTS: ' DuckDB-Wasm-Preview,duckdb-wasm-preview ',
			}),
		]).toEqual(['duckdb-wasm-preview']);
	});

	it('rejects unknown IDs', () => {
		expect(() => parseExperiments({ MARIMOHUB_EXPERIMENTS: 'duckdb-wasm-preveiw' })).toThrow(
			'Unknown MARIMOHUB_EXPERIMENTS value',
		);
	});
});
