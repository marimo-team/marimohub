import { describe, it, expect } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { useSearchField } from './useSearchField';

function Harness({ initialQuery }: { initialQuery?: string }) {
	const { query, setQuery, inputRef } = useSearchField(initialQuery);
	return (
		<div>
			<input
				ref={inputRef}
				aria-label="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<input aria-label="other" />
		</div>
	);
}

function pressSlash() {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
}

describe('useSearchField', () => {
	it('starts empty and honors an initial query', () => {
		const empty = renderHook(() => useSearchField());
		expect(empty.result.current.query).toBe('');

		const seeded = renderHook(() => useSearchField('notebooks'));
		expect(seeded.result.current.query).toBe('notebooks');
	});

	it('setQuery updates the query', () => {
		const { result } = renderHook(() => useSearchField());

		act(() => result.current.setQuery('deploy'));
		expect(result.current.query).toBe('deploy');

		act(() => result.current.setQuery(''));
		expect(result.current.query).toBe('');
	});

	it('focuses the wired input when "/" is pressed', () => {
		render(<Harness />);
		const search = screen.getByLabelText('search');
		expect(search).not.toHaveFocus();

		pressSlash();
		expect(search).toHaveFocus();
	});

	it('does not steal focus while the user is typing in another field', () => {
		render(<Harness />);
		const other = screen.getByLabelText('other');
		other.focus();

		pressSlash();
		expect(other).toHaveFocus();
		expect(screen.getByLabelText('search')).not.toHaveFocus();
	});

	it('renders the query into the wired input', () => {
		render(<Harness initialQuery="charts" />);
		expect(screen.getByLabelText('search')).toHaveValue('charts');
	});
});
