import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
	it('renders the message', () => {
		render(<EmptyState message="No notebooks yet" />);
		expect(screen.getByText('No notebooks yet')).toBeInTheDocument();
	});

	it('renders the action when provided', () => {
		render(<EmptyState message="Nothing here" action={<button>Create one</button>} />);
		expect(screen.getByRole('button', { name: 'Create one' })).toBeInTheDocument();
	});

	it('omits the action region when none is given', () => {
		render(<EmptyState message="Nothing here" />);
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
	});
});
