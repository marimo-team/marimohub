import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListFilters } from './ListFilters';
import type { ListFilterValues } from '@/lib/listFilters';

const STATUSES = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;
const onChange = vi.fn();

function filters(values: ListFilterValues<'active' | 'deleted'> = {}) {
	return (
		<ListFilters
			label="Filter projects"
			itemName="project"
			values={values}
			statuses={STATUSES}
			resultCount={1}
			resultsId="project-results"
			isLoading={false}
			isFetching={false}
			onChange={onChange}
		/>
	);
}

describe('ListFilters', () => {
	it('opens when URL-backed filters become active after mount', async () => {
		const { rerender } = render(filters());
		const toggle = screen.getByRole('button', { name: 'Filters' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');

		rerender(filters({ q: 'sales' }));

		await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
		expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('sales');
	});

	it('describes the blank status as current statuses', async () => {
		const user = userEvent.setup();
		render(filters());

		await user.click(screen.getByRole('button', { name: 'Filters' }));

		expect(screen.getByRole('option', { name: 'All current statuses' })).toHaveValue('');
	});

	it('focuses search after the shortcut mounts the filter panel', async () => {
		render(filters());

		fireEvent.keyDown(document, { key: '/' });

		await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveFocus());
	});
});
