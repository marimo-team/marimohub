import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseExperiments } from './experiments';

afterEach(() => {
	vi.restoreAllMocks();
});

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

	it('ignores unknown IDs with a warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect([
			...parseExperiments({ MARIMOHUB_EXPERIMENTS: 'duckdb-wasm-preveiw,duckdb-wasm-preview' }),
		]).toEqual(['duckdb-wasm-preview']);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toContain(
			'Unknown MARIMOHUB_EXPERIMENTS value: duckdb-wasm-preveiw',
		);
	});

	it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
		'ignores inherited object property %s',
		(id) => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect([...parseExperiments({ MARIMOHUB_EXPERIMENTS: id })]).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		},
	);
});
