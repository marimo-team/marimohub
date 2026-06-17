import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ shouldThrow = true }: { shouldThrow?: boolean }) {
	if (shouldThrow) throw new Error('render exploded');
	return <div>Recovered</div>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
	it('renders children when nothing throws', () => {
		render(
			<ErrorBoundary>
				<Bomb shouldThrow={false} />
			</ErrorBoundary>,
		);

		expect(screen.getByText('Recovered')).toBeInTheDocument();
	});

	it('renders the default fallback and reports the error', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(
			<ErrorBoundary>
				<Bomb />
			</ErrorBoundary>,
		);

		expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
		expect(screen.getByText('render exploded')).toBeInTheDocument();
		expect(errorSpy).toHaveBeenCalledWith(
			'[ErrorBoundary] Caught error:',
			expect.any(Error),
			expect.any(String),
		);
	});

	it('renders a custom fallback instead of the default UI', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		render(
			<ErrorBoundary fallback={<div>Custom recovery</div>}>
				<Bomb />
			</ErrorBoundary>,
		);

		expect(screen.getByText('Custom recovery')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
	});

	it('resets the boundary when the retry button is pressed', async () => {
		const user = userEvent.setup();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let shouldThrow = true;

		function FlakyChild() {
			if (shouldThrow) throw new Error('first render failed');
			return <div>Recovered</div>;
		}

		render(
			<ErrorBoundary>
				<FlakyChild />
			</ErrorBoundary>,
		);

		expect(screen.getByText('first render failed')).toBeInTheDocument();

		shouldThrow = false;
		await user.click(screen.getByRole('button', { name: 'Try again' }));

		expect(screen.getByText('Recovered')).toBeInTheDocument();
	});
});
