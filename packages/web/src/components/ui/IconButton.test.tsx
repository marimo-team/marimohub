import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pencil } from 'lucide-react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
	it('exposes its accessible name via `label`', () => {
		render(
			<IconButton label="Edit project">
				<Pencil />
			</IconButton>,
		);
		expect(screen.getByRole('button', { name: 'Edit project' })).toBeInTheDocument();
	});

	it('fires onPress when activated', async () => {
		const user = userEvent.setup();
		const onPress = vi.fn();
		render(
			<IconButton label="Edit" onPress={onPress}>
				<Pencil />
			</IconButton>,
		);
		await user.click(screen.getByRole('button', { name: 'Edit' }));
		expect(onPress).toHaveBeenCalledTimes(1);
	});

	it('carries the focus-visible ring class so keyboard focus is always visible', () => {
		render(
			<IconButton label="Edit">
				<Pencil />
			</IconButton>,
		);
		expect(screen.getByRole('button', { name: 'Edit' }).className).toContain(
			'focus-visible:ring-2',
		);
	});
});
