import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryExecutionResults } from './SqlWorkspace';
import type { QueryExecution } from './SqlWorkspace';

function queryExecution(values: readonly (number | string)[]): QueryExecution[] {
	return [
		{
			id: 0,
			sql: 'SELECT amount FROM t',
			result: {
				columns: ['amount'],
				rows: values.map((value) => [value]),
				truncated: false,
				execution_ms: 1,
			},
		},
	];
}

function renderedColumn(): string[] {
	const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
	return rows.map((row) => within(row).getAllByRole('cell')[1].textContent ?? '');
}

function permutations<T>(values: readonly T[]): T[][] {
	if (values.length === 0) return [[]];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]),
	);
}

describe('QueryResultTable column sorting', () => {
	it.each([
		{ name: 'numbers', values: [1.5, -3, 1.25, -5], expected: ['-5', '-3', '1.25', '1.5'] },
		{
			name: 'negative integer strings beyond number precision',
			values: ['-9223372036854775808', '-9223372036854775809'],
			expected: ['-9223372036854775809', '-9223372036854775808'],
		},
		{
			name: 'decimal strings',
			values: ['1.5', '-3', '1.25', '-5'],
			expected: ['-5', '-3', '1.25', '1.5'],
		},
		{
			name: 'exponent strings',
			values: ['1e21', '9223372036854775807', '-1e22'],
			expected: ['-1e22', '9223372036854775807', '1e21'],
		},
		{
			name: 'mixed exponent numbers and integer strings',
			values: [1e21, '9223372036854775807'],
			expected: ['9223372036854775807', '1e+21'],
		},
		{
			name: 'mixed decimals',
			values: ['1.25', -5, 1.5, -3],
			expected: ['-5', '-3', '1.25', '1.5'],
		},
		{
			name: 'mixed integers beyond number precision',
			values: ['9007199254740993', 9007199254740992],
			expected: ['9007199254740992', '9007199254740993'],
		},
		{
			name: 'mixed negative integers beyond number precision',
			values: [-9007199254740992, '-9007199254740993'],
			expected: ['-9007199254740993', '-9007199254740992'],
		},
		{
			name: 'integer strings and fractional numbers',
			values: [2.5, '2', '-3', -2.5],
			expected: ['-3', '-2.5', '2', '2.5'],
		},
		{
			name: 'large integer strings',
			values: ['9223372036854775809', '9223372036854775808'],
			expected: ['9223372036854775808', '9223372036854775809'],
		},
		...[
			{
				name: 'mixed numeric strings and text',
				values: ['1.9', '1.10', '1.9kg'],
				expected: ['1.10', '1.9', '1.9kg'],
			},
			{
				name: 'equal numeric representations',
				values: ['01', 1, '1.0'],
				expected: ['01', '1', '1.0'],
			},
			{
				name: 'NaN with numbers',
				values: [Number.NaN, 2, -1],
				expected: ['-1', '2', 'NaN'],
			},
			{
				name: 'nonfinite numbers and text',
				values: [Infinity, '-Infinity', 2],
				expected: ['2', '-Infinity', 'Infinity'],
			},
			{
				name: 'nonfinite text and numbers',
				values: ['Infinity', -Infinity, 2],
				expected: ['2', '-Infinity', 'Infinity'],
			},
		].flatMap(({ name, values, expected }) =>
			permutations<number | string>(values).map((permutation, index) => ({
				name: `${name}, permutation ${index + 1}`,
				values: permutation,
				expected,
			})),
		),
	])('sorts $name by value', async ({ values, expected }) => {
		const user = userEvent.setup();
		render(
			<QueryExecutionResults
				executions={queryExecution(values)}
				activeIndex={0}
				onSelect={() => {}}
			/>,
		);

		await user.click(screen.getByRole('button', { name: 'amount' }));

		expect(renderedColumn()).toEqual(expected);
		await user.click(screen.getByRole('button', { name: /amount/ }));
		expect(renderedColumn()).toEqual(expected.toReversed());
	});
});
