import { describe, expect, it } from 'vitest';
import { parseTablePreviewJson } from './previewResult';

describe('parseTablePreviewJson', () => {
	it('accepts whitespace, empty results, and arbitrary JSON cell values', () => {
		expect(
			parseTablePreviewJson(
				'  {"columns":["value"],"rows":[[null],[true],[{"nested":[1,"x"]}]]}\n',
				3,
			),
		).toEqual({
			columns: ['value'],
			rows: [[null], [true], [{ nested: [1, 'x'] }]],
		});
		expect(parseTablePreviewJson('{"columns":[],"rows":[[]]}', 1)).toEqual({
			columns: [],
			rows: [[]],
		});
	});

	it('accepts exactly the configured row bound', () => {
		expect(parseTablePreviewJson('{"columns":["id"],"rows":[[1],[2]]}', 2)).toEqual({
			columns: ['id'],
			rows: [[1], [2]],
		});
	});

	it.each([
		['invalid JSON', 'not-json'],
		['empty input', '   '],
		['null envelope', 'null'],
		['array envelope', '[]'],
		['missing columns', '{"rows":[]}'],
		['missing rows', '{"columns":[]}'],
		['non-array columns', '{"columns":"id","rows":[]}'],
		['non-array rows', '{"columns":[],"rows":{}}'],
		['non-string column', '{"columns":[1],"rows":[]}'],
		['null row', '{"columns":["id"],"rows":[null]}'],
		['short row', '{"columns":["id"],"rows":[[]]}'],
		['long row', '{"columns":["id"],"rows":[[1,2]]}'],
	])('rejects %s', (_name, value) => {
		expect(() => parseTablePreviewJson(value, 1)).toThrow('invalid result');
	});

	it('rejects a result that exceeds the configured row bound', () => {
		expect(() => parseTablePreviewJson('{"columns":["id"],"rows":[[1],[2]]}', 1)).toThrow(
			'invalid result',
		);
	});
});
