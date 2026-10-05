import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComboBox } from './ComboBox';
import type { ComboBoxOption } from './ComboBox';

interface Option extends ComboBoxOption {
	label: string;
}

const OPTIONS: Option[] = [
	{ id: 'ada', textValue: 'Ada', label: 'Ada Lovelace' },
	{ id: 'grace', textValue: 'Grace', label: 'Grace Hopper' },
];

function Harness({
	onSelect,
	retainSelection = false,
}: {
	onSelect: (id: string) => void;
	retainSelection?: boolean;
}) {
	const [query, setQuery] = useState('');
	const options = OPTIONS.filter((o) =>
		o.textValue.toLowerCase().includes(query.trim().toLowerCase()),
	);
	return (
		<ComboBox
			retainSelection={retainSelection}
			aria-label="People"
			placeholder="Search people"
			inputValue={query}
			onInputChange={setQuery}
			options={options}
			onSelect={(id) => {
				onSelect(id);
				if (retainSelection) setQuery(OPTIONS.find((option) => option.id === id)!.textValue);
			}}
			renderOption={(o) => <span>{o.label}</span>}
			emptyState="No matches"
		/>
	);
}

describe('ComboBox', () => {
	it('opens on input, filters options, and fires onSelect with the option id', async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<Harness onSelect={onSelect} />);

		await user.type(screen.getByRole('combobox', { name: 'People' }), 'gra');
		expect(screen.queryByRole('option', { name: 'Ada Lovelace' })).not.toBeInTheDocument();

		await user.click(screen.getByRole('option', { name: 'Grace Hopper' }));
		expect(onSelect).toHaveBeenCalledWith('grace');
	});

	it('retains a selected option when its key differs from its text', async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<Harness onSelect={onSelect} retainSelection />);
		await user.type(screen.getByRole('combobox'), 'gra');
		await user.click(screen.getByRole('option', { name: 'Grace Hopper' }));
		await user.tab();
		expect(screen.getByRole('combobox')).toHaveValue('Grace');
		await user.click(screen.getByRole('combobox'));
		await user.keyboard('{ArrowDown}');
		expect(screen.getByRole('option', { name: 'Grace Hopper' })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		expect(onSelect).toHaveBeenCalledWith('grace');
	});

	it('shows the empty state when nothing matches (custom text allowed)', async () => {
		const user = userEvent.setup();
		render(<Harness onSelect={() => {}} />);

		await user.type(screen.getByRole('combobox', { name: 'People' }), 'zzz');
		expect(screen.getByText('No matches')).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: 'People' })).toHaveValue('zzz');
	});
});
