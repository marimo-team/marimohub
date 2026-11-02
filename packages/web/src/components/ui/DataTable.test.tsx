import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';

interface Item {
	id: string;
	name: string;
	count: number;
}
const items: Item[] = [
	{ id: 'a', name: 'Alpha', count: 2 },
	{ id: 'b', name: 'Beta', count: 7 },
];
const columns: DataTableColumn<Item>[] = [
	{ id: 'name', header: 'Name', cell: (item) => <a href={`/${item.id}`}>{item.name}</a> },
	{ id: 'count', header: 'Count', align: 'right', cell: (item) => item.count },
	{ id: 'notes', header: 'Notes', cell: (item) => <input aria-label={`Notes for ${item.name}`} /> },
];

describe('DataTable', () => {
	it('associates configured headers with cells in column order', () => {
		render(
			<DataTable label="Items" items={items} columns={columns} getRowKey={(item) => item.id} />,
		);
		const table = within(screen.getByRole('table', { name: 'Items' }));
		expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
			'Name',
			'Count',
			'Notes',
		]);
		for (const header of table.getAllByRole('columnheader'))
			expect(header).toHaveAttribute('scope', 'col');
		const row = within(table.getAllByRole('row')[1]);
		expect(
			row
				.getAllByRole('cell')
				.slice(0, 2)
				.map((cell) => cell.textContent),
		).toEqual(['Alpha', '2']);
		expect(row.getByRole('link', { name: 'Alpha' })).toHaveAttribute('href', '/a');
	});

	it('preserves cell controls when rows and columns are reordered', async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<DataTable label="Items" items={items} columns={columns} getRowKey={(item) => item.id} />,
		);
		await user.type(screen.getByRole('textbox', { name: 'Notes for Alpha' }), 'Keep me');
		rerender(
			<DataTable
				label="Items"
				items={[...items].reverse()}
				columns={[columns[2], columns[0]]}
				getRowKey={(item) => item.id}
			/>,
		);
		expect(screen.getByRole('textbox', { name: 'Notes for Alpha' })).toHaveValue('Keep me');
		expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
			'Notes',
			'Name',
		]);
		for (const [index, name] of ['Beta', 'Alpha'].entries()) {
			const cells = within(screen.getAllByRole('row')[index + 1]).getAllByRole('cell');
			expect(cells).toHaveLength(2);
			expect(
				within(cells[0]).getByRole('textbox', { name: `Notes for ${name}` }),
			).toBeInTheDocument();
			expect(within(cells[1]).getByRole('link', { name })).toBeInTheDocument();
		}
		expect(screen.queryByRole('columnheader', { name: 'Count' })).not.toBeInTheDocument();
		expect(
			within(screen.getAllByRole('row')[1]).getByRole('link', { name: 'Beta' }),
		).toBeInTheDocument();
	});
});
