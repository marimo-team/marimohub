import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSelector } from '@tanstack/react-store';
import { z } from 'zod';
import { renderWithClient } from '@/test/render';
import { useAppForm } from './useAppForm';
import { schemaValidators } from './validators';
import { useSeedOnOpen } from './useSeedOnOpen';

const nameSchema = z.object({ name: z.string().trim().min(1, 'Required') });

type Values = { name: string };

/**
 * Stands in for a dialog body: stays mounted while `isOpen` flips, exactly like a
 * real dialog held open for its exit animation. `defaultValues` is derived from
 * the same source as the seed, as every caller of the hook does — the form's own
 * `update()` refuses to overwrite a touched form, which is why the explicit reset
 * is needed at all.
 */
function SeededForm({ isOpen, values }: { isOpen: boolean; values: Values }) {
	const form = useAppForm({
		defaultValues: values,
		validators: schemaValidators(nameSchema),
		onSubmit: () => {},
	});
	useSeedOnOpen(form, isOpen, values);
	const canSubmit = useSelector(form.store, (s) => s.canSubmit);
	return (
		<div>
			<form.AppField name="name">{(f) => <f.TextField label="Name" />}</form.AppField>
			<span data-testid="can-submit">{String(canSubmit)}</span>
		</div>
	);
}

function renderSeeded(isOpen: boolean, values: Values) {
	const { rerender } = renderWithClient(<SeededForm isOpen={isOpen} values={values} />, {
		toaster: false,
	});
	return {
		input: () => screen.getByLabelText('Name'),
		canSubmit: () => screen.getByTestId('can-submit'),
		setProps: (next: { isOpen: boolean; values: Values }) =>
			rerender(<SeededForm isOpen={next.isOpen} values={next.values} />),
	};
}

describe('useSeedOnOpen', () => {
	it('leaves the form alone while the dialog is closed', async () => {
		const user = userEvent.setup();
		const { input, setProps } = renderSeeded(false, { name: 'Alpha' });

		await user.clear(input());
		await user.type(input(), 'Draft');

		// A different subject arrives while closed: still no reset.
		setProps({ isOpen: false, values: { name: 'Beta' } });
		expect(input()).toHaveValue('Draft');
	});

	it('seeds the form on the closed → open transition', async () => {
		const user = userEvent.setup();
		const { input, setProps } = renderSeeded(false, { name: 'Alpha' });

		await user.clear(input());
		await user.type(input(), 'Draft');

		setProps({ isOpen: true, values: { name: 'Beta' } });

		await waitFor(() => expect(input()).toHaveValue('Beta'));
	});

	it('re-seeds on reopen, discarding edits from a cancelled session', async () => {
		const user = userEvent.setup();
		const values: Values = { name: 'Alpha' };
		const { input, setProps } = renderSeeded(false, values);

		setProps({ isOpen: true, values });
		await waitFor(() => expect(input()).toHaveValue('Alpha'));

		await user.clear(input());
		await user.type(input(), 'Abandoned edit');
		expect(input()).toHaveValue('Abandoned edit');

		// Close — the component stays mounted for the exit animation — then reopen.
		setProps({ isOpen: false, values });
		expect(input()).toHaveValue('Abandoned edit');

		setProps({ isOpen: true, values });
		await waitFor(() => expect(input()).toHaveValue('Alpha'));
	});

	it('does not clobber in-progress edits when values change while the dialog stays open', async () => {
		const user = userEvent.setup();
		const { input, setProps } = renderSeeded(true, { name: 'Alpha' });

		await waitFor(() => expect(input()).toHaveValue('Alpha'));
		await user.type(input(), ' edited');
		expect(input()).toHaveValue('Alpha edited');

		// A fresh object — and even a fresh value — must not re-seed: the effect
		// deliberately depends on `isOpen` only.
		setProps({ isOpen: true, values: { name: 'Alpha' } });
		expect(input()).toHaveValue('Alpha edited');

		setProps({ isOpen: true, values: { name: 'Refetched' } });
		expect(input()).toHaveValue('Alpha edited');
	});

	it('re-runs validation after the reset so canSubmit reflects the seeded values', async () => {
		const user = userEvent.setup();
		const values: Values = { name: '' };
		const { canSubmit, input, setProps } = renderSeeded(false, values);

		expect(canSubmit()).toHaveTextContent('false');

		await user.type(input(), 'Typed');
		await waitFor(() => expect(canSubmit()).toHaveTextContent('true'));

		// Reopening restores the invalid seed; reset() alone would clear the error
		// state and leave canSubmit stuck on true.
		setProps({ isOpen: true, values });

		await waitFor(() => expect(input()).toHaveValue(''));
		await waitFor(() => expect(canSubmit()).toHaveTextContent('false'));
		// The reset also clears touched state, so the message stays hidden.
		expect(screen.queryByText('Required')).not.toBeInTheDocument();
	});

	it('marks a valid seed as submittable without the user touching a field', async () => {
		const user = userEvent.setup();
		const values: Values = { name: 'Alpha' };
		const { canSubmit, setProps, input } = renderSeeded(false, values);

		await user.clear(input());
		await waitFor(() => expect(canSubmit()).toHaveTextContent('false'));

		setProps({ isOpen: true, values });

		await waitFor(() => expect(canSubmit()).toHaveTextContent('true'));
		expect(input()).toHaveValue('Alpha');
	});
});
