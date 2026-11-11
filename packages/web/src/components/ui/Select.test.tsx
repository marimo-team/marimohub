import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupUser } from '@/test/render';
import { Select } from './Select';

function Harness() {
	const [value, setValue] = useState('');
	return (
		<Select
			label="Scope"
			value={value}
			onChange={setValue}
			options={[
				{ id: '', label: 'All projects' },
				{ id: 'alpha', label: 'Alpha' },
				{ id: 'beta', label: 'Beta' },
			]}
		/>
	);
}

describe('Select', () => {
	it('supports keyboard selection, announces the chosen option, and restores trigger focus', async () => {
		const user = setupUser();
		render(<Harness />);
		const trigger = screen.getByRole('button', { name: 'All projects Scope' });
		trigger.focus();
		await user.keyboard('{Enter}{ArrowDown}{Enter}');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Alpha Scope' })).toHaveFocus());
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Alpha Scope' }));
		expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
		await user.click(screen.getByRole('option', { name: 'All projects' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'All projects Scope' })).toHaveFocus(),
		);
	});
	it('supports typeahead and Escape without committing a different choice', async () => {
		const user = setupUser();
		render(<Harness />);
		const trigger = screen.getByRole('button', { name: 'All projects Scope' });
		await user.click(trigger);
		await user.keyboard('b{Escape}');
		expect(trigger).toHaveTextContent('All projects');
		await waitFor(() => expect(trigger).toHaveFocus());
		await user.click(trigger);
		await user.keyboard('b{Enter}');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Beta Scope' })).toHaveFocus());
	});
});
