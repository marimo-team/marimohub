import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryExecutionResults } from './SqlWorkspace';
import type { QueryExecution } from './SqlWorkspace';

const executions: QueryExecution[] = [
	{
		id: 0,
		sql: 'SELECT 1 AS first_value',
		result: {
			columns: ['first_value'],
			rows: [[1]],
			truncated: false,
			execution_ms: 2,
		},
	},
	{
		id: 1,
		sql: 'SELECT 2 AS second_value',
		result: {
			columns: ['second_value'],
			rows: [[2], [3]],
			truncated: true,
			execution_ms: 4,
		},
	},
];

function ResultsHarness() {
	const [activeIndex, setActiveIndex] = useState(0);
	return (
		<QueryExecutionResults
			executions={executions}
			activeIndex={activeIndex}
			onSelect={setActiveIndex}
		/>
	);
}

describe('QueryExecutionResults', () => {
	it('preserves every statement result and switches the displayed table', async () => {
		const user = userEvent.setup();
		render(<ResultsHarness />);

		const firstTab = screen.getByRole('tab', { name: 'Statement 1, 1 row' });
		const secondTab = screen.getByRole('tab', { name: 'Statement 2, 2 rows' });
		expect(firstTab).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('columnheader', { name: 'first_value' })).toBeInTheDocument();
		expect(screen.queryByRole('columnheader', { name: 'second_value' })).not.toBeInTheDocument();

		await user.click(secondTab);

		expect(secondTab).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('columnheader', { name: 'second_value' })).toBeInTheDocument();
		expect(screen.getByText('Result truncated')).toBeInTheDocument();
	});

	it('supports keyboard navigation between statement results', async () => {
		const user = userEvent.setup();
		render(<ResultsHarness />);

		const firstTab = screen.getByRole('tab', { name: 'Statement 1, 1 row' });
		firstTab.focus();
		await user.keyboard('{ArrowRight}');

		const secondTab = screen.getByRole('tab', { name: 'Statement 2, 2 rows' });
		expect(secondTab).toHaveFocus();
		expect(secondTab).toHaveAttribute('aria-selected', 'true');
	});
});
