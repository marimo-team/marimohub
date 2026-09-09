import { describe, expect, it } from 'vitest';
import { decodeRow } from './schema';
import type { BigQueryField } from './schema';

describe('BigQuery row decoding', () => {
	it('preserves nulls, empty arrays, repeated records, and exact decimals', () => {
		const fields: BigQueryField[] = [
			{ name: 'missing', type: 'STRING' },
			{ name: 'empty', type: 'INTEGER', mode: 'REPEATED' },
			{
				name: 'records',
				type: 'RECORD',
				mode: 'REPEATED',
				fields: [
					{ name: 'amount', type: 'BIGNUMERIC' },
					{ name: 'label', type: 'STRING' },
				],
			},
		];
		const amount = '123456789012345678901234567890.123456789012345678901234567890';
		expect(
			decodeRow(fields, {
				f: [{ v: null }, { v: [] }, { v: [{ v: { f: [{ v: amount }, { v: null }] } }] }],
			}),
		).toEqual([null, [], [{ amount, label: null }]]);
	});

	it('preserves unusual record field names as own properties', () => {
		const fields: BigQueryField[] = [
			{
				name: 'record',
				type: 'STRUCT',
				fields: [
					{ name: '__proto__', type: 'STRING' },
					{ name: 'constructor', type: 'STRING' },
				],
			},
		];
		const [record] = decodeRow(fields, { f: [{ v: { f: [{ v: 'value' }, { v: 'other' }] } }] });
		expect(Object.hasOwn(record as object, '__proto__')).toBe(true);
		expect(record).toEqual(JSON.parse('{"__proto__":"value","constructor":"other"}'));
	});

	it.each([
		'[2024-01-01, 2024-02-01)',
		'[2024-01-01T12:00:00.123456, 2024-01-02T12:00:00.654321)',
		'[1704110400.123456, 1704196800.654321)',
		'[UNBOUNDED, 2024-02-01)',
		'[2024-01-01, UNBOUNDED)',
		'[UNBOUNDED, UNBOUNDED)',
		'[NULL, NULL)',
		null,
	])('preserves REST RANGE values and endpoint precision: %s', (value) => {
		expect(decodeRow([{ name: 'period', type: 'RANGE' }], { f: [{ v: value }] })).toEqual([value]);
	});

	it('preserves repeated ranges nested in a record', () => {
		const values = ['[2024-01-01, 2024-02-01)', '[2024-03-01, UNBOUNDED)'];
		const fields: BigQueryField[] = [
			{
				name: 'schedule',
				type: 'RECORD',
				fields: [{ name: 'periods', type: 'RANGE', mode: 'REPEATED' }],
			},
		];
		expect(decodeRow(fields, { f: [{ v: { f: [{ v: values.map((v) => ({ v })) }] } }] })).toEqual([
			{ periods: values },
		]);
	});

	it.each([
		['FLOAT64', '1.25', 1.25],
		['FLOAT', 'NaN', 'NaN'],
		['FLOAT64', 'Infinity', 'Infinity'],
		['INTEGER', '-9223372036854775808', '-9223372036854775808'],
		['BOOL', 'false', false],
	])('decodes %s value %s without precision loss', (type, value, expected) => {
		expect(decodeRow([{ name: 'value', type: String(type) }], { f: [{ v: value }] })).toEqual([
			expected,
		]);
	});

	it.each([
		{ field: { name: 'flag', type: 'BOOLEAN' }, value: 'yes' },
		{ field: { name: 'id', type: 'INTEGER' }, value: 9007199254740992 },
		{ field: { name: 'text', type: 'STRING' }, value: { unexpected: 'secret' } },
		{ field: { name: 'list', type: 'STRING', mode: 'REPEATED' as const }, value: 'secret' },
		{
			field: { name: 'record', type: 'RECORD', fields: [{ name: 'id', type: 'INTEGER' }] },
			value: { f: [] },
		},
	])(
		'rejects malformed $field.type values instead of returning corrupt rows',
		({ field, value }) => {
			expect(() => decodeRow([field], { f: [{ v: value }] })).toThrow(/BigQuery returned/);
		},
	);

	it.each([{ f: [] }, { f: [{ v: 'one' }, { v: 'two' }] }])(
		'rejects mismatched row width: %j',
		({ f }) => {
			expect(() => decodeRow([{ name: 'id', type: 'INTEGER' }], { f })).toThrow('column count');
		},
	);
});
