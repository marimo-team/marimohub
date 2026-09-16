import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListResults } from './ListResults';

interface RenderOptions {
	gallery?: boolean;
	count?: number;
	isFiltered?: boolean;
	isLoading?: boolean;
}

function renderResults({
	gallery = false,
	count = 1,
	isFiltered = false,
	isLoading = false,
}: RenderOptions = {}) {
	const onReset = vi.fn();
	const result = render(
		<ListResults
			gallery={gallery}
			count={count}
			emptyState={<p>No notebooks yet</p>}
			isFetching={false}
			isFiltered={isFiltered}
			isLoading={isLoading}
			itemName="notebook"
			onReset={onReset}
			resultsId="notebook-results"
		>
			<p>Notebook row</p>
		</ListResults>,
	);
	return { ...result, onReset };
}

describe('ListResults', () => {
	it('renders gallery children in a responsive grid', () => {
		renderResults({ gallery: true });
		expect(screen.getByText('Notebook row').parentElement).toHaveClass(
			'grid',
			'sm:grid-cols-2',
			'xl:grid-cols-3',
		);
	});
	it('uses card placeholders while the gallery loads', () => {
		renderResults({ gallery: true, isLoading: true });
		const cards = screen.getAllByTestId('gallery-skeleton-card');
		expect(cards).toHaveLength(3);
		expect(cards[0].parentElement).toHaveClass('grid');
		expect(cards[0].firstChild).toHaveClass('aspect-video');
		expect(screen.queryByTestId('list-skeleton-row')).not.toBeInTheDocument();
	});
	it('shows skeleton rows while loading', () => {
		renderResults({ isLoading: true });

		expect(screen.getAllByTestId('list-skeleton-row')).toHaveLength(3);
		expect(screen.queryByText('Notebook row')).not.toBeInTheDocument();
		expect(screen.queryByText('No notebooks yet')).not.toBeInTheDocument();
	});

	it('shows the filtered empty state and resets filters', async () => {
		const user = userEvent.setup();
		const { onReset } = renderResults({ count: 0, isFiltered: true });

		expect(screen.getByText('No notebooks match these filters')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Reset filters' }));
		expect(onReset).toHaveBeenCalledOnce();
	});

	it('renders the caller-provided empty state when no filters are active', () => {
		renderResults({ count: 0 });

		expect(screen.getByText('No notebooks yet')).toBeInTheDocument();
		expect(screen.queryByText('No notebooks match these filters')).not.toBeInTheDocument();
	});
});
