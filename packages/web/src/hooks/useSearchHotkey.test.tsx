import { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useSearchHotkey } from './useSearchHotkey';

function Harness({ showInput = true }: { showInput?: boolean }) {
	const ref = useRef<HTMLInputElement>(null);
	useSearchHotkey(ref);
	return (
		<div>
			{showInput && <input ref={ref} aria-label="search" />}
			<select aria-label="type">
				<option>All types</option>
			</select>
			<input aria-label="other" />
		</div>
	);
}

function pressSlash() {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
}

describe('useSearchHotkey', () => {
	it('leaves native select keyboard interaction alone', () => {
		render(<Harness />);
		const select = screen.getByRole('combobox');
		select.focus();
		expect(fireEvent.keyDown(select, { key: '/' })).toBe(true);
		expect(select).toHaveFocus();
	});
	it.each([{ isComposing: true }, { repeat: true }])(
		'ignores input method and repeated events (%j)',
		(options) => {
			render(<Harness />);
			expect(fireEvent.keyDown(document, { key: '/', ...options })).toBe(true);
			expect(screen.getByLabelText('search')).not.toHaveFocus();
		},
	);
	it('respects a handled event', () => {
		render(<Harness />);
		const event = new KeyboardEvent('keydown', { key: '/', cancelable: true });
		event.preventDefault();
		document.dispatchEvent(event);
		expect(screen.getByLabelText('search')).not.toHaveFocus();
	});
	it('does not consume slash without a mounted field', () => {
		render(<Harness showInput={false} />);
		expect(fireEvent.keyDown(document, { key: '/' })).toBe(true);
	});
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
