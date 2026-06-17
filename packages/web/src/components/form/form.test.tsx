import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import { useAppForm } from './useAppForm';
import { useSeedOnOpen } from './useSeedOnOpen';
import { schemaValidators } from './validators';
import { FormDialog } from './FormDialog';
import { ConfirmDialog } from './ConfirmDialog';

const nameSchema = z.object({ name: z.string().trim().min(1, 'Required') });

function NameForm({
	onSubmit,
	isPending,
	requireDirty,
	defaultName = '',
}: {
	onSubmit: (value: { name: string }) => void;
	isPending?: boolean;
	requireDirty?: boolean;
	defaultName?: string;
}) {
	const [isOpen, setIsOpen] = useState(true);
	const form = useAppForm({
		defaultValues: { name: defaultName },
		validators: schemaValidators(nameSchema),
		onSubmit: ({ value }) => onSubmit(value),
	});
	useSeedOnOpen(form, isOpen, { name: defaultName });
	return (
		<FormDialog
			form={form}
			isPending={isPending}
			requireDirty={requireDirty}
			isOpen={isOpen}
			onClose={() => setIsOpen(false)}
			title="Edit"
			submitLabel="Save"
			pendingLabel="Saving..."
		>
			<form.AppField name="name">{(f) => <f.TextField label="Name" />}</form.AppField>
		</FormDialog>
	);
}

function DeleteForm({ expected, onConfirm }: { expected: string; onConfirm: () => void }) {
	const form = useAppForm({
		defaultValues: { confirmName: '' },
		validators: schemaValidators(z.object({ confirmName: z.literal(expected) })),
		onSubmit: () => onConfirm(),
	});
	return (
		<ConfirmDialog
			form={form}
			isOpen
			onClose={() => {}}
			title="Delete"
			description="This cannot be undone."
			confirmLabel="Delete"
		>
			<form.AppField name="confirmName">
				{(f) => <f.TextField label="Type to confirm" />}
			</form.AppField>
		</ConfirmDialog>
	);
}

describe('form meta-framework', () => {
	it('binds value and shows the validation error after blur', async () => {
		const user = userEvent.setup();
		render(<NameForm onSubmit={vi.fn()} />);

		const input = screen.getByLabelText('Name');
		await user.type(input, 'hello');
		expect(input).toHaveValue('hello');

		await user.clear(input);
		await user.tab();
		expect(await screen.findByText('Required')).toBeInTheDocument();
	});

	it('disables submit until the form is valid, then submits the value', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(<NameForm onSubmit={onSubmit} />);

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		await user.type(screen.getByLabelText('Name'), 'Acme');
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSubmit).toHaveBeenCalledWith({ name: 'Acme' });
	});

	it('shows the pending label and disables submit while pending', () => {
		render(<NameForm onSubmit={vi.fn()} isPending defaultName="Acme" />);
		expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
	});

	it('requireDirty keeps submit disabled until a value changes', async () => {
		const user = userEvent.setup();
		render(<NameForm onSubmit={vi.fn()} requireDirty defaultName="Acme" />);

		// Valid (seeded) but not yet dirty.
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		await user.type(screen.getByLabelText('Name'), '!');
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('type-to-confirm blocks the confirm button until the name matches', async () => {
		const user = userEvent.setup();
		const onConfirm = vi.fn();
		render(<DeleteForm expected="my-project" onConfirm={onConfirm} />);

		const confirm = screen.getByRole('button', { name: 'Delete' });
		expect(confirm).toBeDisabled();

		await user.type(screen.getByLabelText('Type to confirm'), 'my-project');
		expect(confirm).toBeEnabled();

		await user.click(confirm);
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});
