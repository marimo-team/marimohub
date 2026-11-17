import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolTable } from './ToolTable';

describe('ToolTable', () => {
	it('renders table headers and escaped cells with a partial-results notice', () => {
		render(
			<ToolTable
				output={JSON.stringify({
					columns: ['name', 'count'],
					rows: [['<script>bad()</script>', null]],
					truncated: true,
				})}
			/>,
		);
		expect(screen.getByRole('columnheader', { name: 'name' })).toBeVisible();
		expect(screen.getByRole('cell', { name: '<script>bad()</script>' })).toBeVisible();
		expect(screen.getByRole('cell', { name: 'null' })).toBeVisible();
		expect(screen.getByText('1 rows · Partial results')).toBeVisible();
	});
	it('ignores redacted or malformed results', () => {
		const { container, rerender } = render(
			<ToolTable output='{"columns":["id"],"rows":"[omitted]"}' />,
		);
		expect(container).toBeEmptyDOMElement();
		rerender(<ToolTable output="not json" />);
		expect(container).toBeEmptyDOMElement();
	});
	it('caps displayed rows and columns', () => {
		render(
			<ToolTable
				output={JSON.stringify({
					columns: Array.from({ length: 51 }, (_, i) => String(i)),
					rows: Array.from({ length: 101 }, () => [1]),
				})}
			/>,
		);
		expect(screen.getAllByRole('columnheader')).toHaveLength(50);
		expect(screen.getAllByRole('row')).toHaveLength(101);
	});
});
