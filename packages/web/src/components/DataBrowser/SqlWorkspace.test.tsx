import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryExecutionResults } from './SqlWorkspace';
import type { QueryExecution } from './SqlWorkspace';

function numericExecution(values: readonly (number | string)[]): QueryExecution[] {
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

describe('QueryResultTable column sorting', () => {
	it.each([
		{ name: 'numbers', values: [1.5, -3, 1.25, -5], expected: ['-5', '-3', '1.25', '1.5'] },
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
	])('sorts $name by value', async ({ values, expected }) => {
		const user = userEvent.setup();
		render(
			<QueryExecutionResults
				executions={numericExecution(values)}
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
