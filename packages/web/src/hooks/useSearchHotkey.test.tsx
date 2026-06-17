import { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSearchHotkey } from './useSearchHotkey';

function Harness() {
	const ref = useRef<HTMLInputElement>(null);
	useSearchHotkey(ref);
	return (
		<div>
			<input ref={ref} aria-label="search" />
			<input aria-label="other" />
		</div>
	);
}

function pressSlash() {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
}

describe('useSearchHotkey', () => {
	it('focuses the input when "/" is pressed', () => {
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
});
