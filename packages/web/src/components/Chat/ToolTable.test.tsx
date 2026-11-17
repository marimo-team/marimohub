import { describe, expect, it, vi } from 'vitest';
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

it('preserves row and column identity when results reorder', () => {
	const { rerender } = render(
		<ToolTable
			output={JSON.stringify({
				columns: ['id', 'name'],
				rows: [
					[1, 'Alice'],
					[2, 'Bob'],
				],
			})}
		/>,
	);
	const aliceRow = screen.getByRole('cell', { name: 'Alice' }).closest('tr');
	const idHeader = screen.getByRole('columnheader', { name: 'id' });
	rerender(
		<ToolTable
			output={JSON.stringify({
				columns: ['id', 'name'],
				rows: [
					[2, 'Bob'],
					[1, 'Alice'],
				],
			})}
		/>,
	);
	expect(screen.getByRole('cell', { name: 'Alice' }).closest('tr')).toBe(aliceRow);
	rerender(
		<ToolTable
			output={JSON.stringify({
				columns: ['name', 'id'],
				rows: [
					['Bob', 2],
					['Alice', 1],
				],
			})}
		/>,
	);
	expect(screen.getByRole('columnheader', { name: 'id' })).toBe(idHeader);
});

it('keeps duplicate rows and column names without key collisions', () => {
	const error = vi.spyOn(console, 'error');
	try {
		const output = JSON.stringify({
			columns: ['id', 'id'],
			rows: [
				[1, 1],
				[1, 1],
			],
		});
		const { rerender } = render(<ToolTable output={output} />);
		rerender(<ToolTable output={output} />);
		expect(screen.getAllByRole('columnheader', { name: 'id' })).toHaveLength(2);
		expect(screen.getAllByRole('cell', { name: '1' })).toHaveLength(4);
		expect(error).not.toHaveBeenCalled();
	} finally {
		error.mockRestore();
	}
});
