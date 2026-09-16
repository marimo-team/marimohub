import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Thumbnail } from './Thumbnail';

const props = { projectId: 'p', notebookId: 'n', title: 'Sales', refreshedAt: 1 };
const custom = {
	source: 'custom' as const,
	revision: 'first',
	captured_at: null,
	has_custom: true,
};

describe('gallery thumbnails', () => {
	it('shows the notebook title as a placeholder when no image is selected', () => {
		const { container } = render(<Thumbnail {...props} metadata={undefined} />);
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(container.querySelector('img')).toBeNull();
	});
	it.each(['revision', 'refresh'])('retries a failed image after a %s change', (change) => {
		const { container, rerender } = render(<Thumbnail {...props} metadata={custom} />);
		const original = container.querySelector('img')!;
		expect(original).toHaveAttribute('loading', 'lazy');
		expect(original).toHaveAttribute('width', '960');
		expect(original).toHaveAttribute('height', '540');
		fireEvent.error(original);
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(container.querySelector('img')).toBeNull();
		rerender(<Thumbnail {...props} metadata={custom} />);
		expect(container.querySelector('img')).toBeNull();
		rerender(
			<Thumbnail
				{...props}
				refreshedAt={change === 'refresh' ? 2 : 1}
				metadata={{ ...custom, revision: change === 'revision' ? 'second' : 'first' }}
			/>,
		);
		expect(container.querySelector('img')).not.toBeNull();
		expect(container.querySelector('img')).not.toBe(original);
	});
});
