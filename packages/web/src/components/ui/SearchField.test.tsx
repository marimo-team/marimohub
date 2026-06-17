import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchField } from './SearchField';

/** Controlled harness mirroring how the list pages use SearchField. */
function Harness() {
	const [value, setValue] = useState('');
	return (
		<div>
			<SearchField aria-label="Search" placeholder="Search..." value={value} onChange={setValue} />
			<output data-testid="value">{value}</output>
		</div>
	);
}

describe('SearchField', () => {
	it('is announced as a searchbox with its label and reports typing via onChange', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const input = screen.getByRole('searchbox', { name: 'Search' });
		await user.type(input, 'hello');
		expect(screen.getByTestId('value')).toHaveTextContent('hello');
	});

	it('clears via the clear button', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'hello');
		await user.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(screen.getByTestId('value')).toHaveTextContent('');
	});

	it('clears on Escape', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const input = screen.getByRole('searchbox', { name: 'Search' });
		await user.type(input, 'hello');
		await user.type(input, '{Escape}');
		expect(screen.getByTestId('value')).toHaveTextContent('');
	});
});
