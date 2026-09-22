import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryExecutionResults } from './SqlWorkspace';
import type { QueryExecution } from './SqlWorkspace';

function numericExecution(values: number[]): QueryExecution[] {
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
	it('sorts a numeric column by value, not by collated digit groups', async () => {
		const user = userEvent.setup();
		render(
			<QueryExecutionResults
				executions={numericExecution([1.5, -3, 1.25, -5])}
				activeIndex={0}
				onSelect={() => {}}
			/>,
		);

		await user.click(screen.getByRole('button', { name: 'amount' }));

		expect(renderedColumn()).toEqual(['-5', '-3', '1.25', '1.5']);
	});
});
