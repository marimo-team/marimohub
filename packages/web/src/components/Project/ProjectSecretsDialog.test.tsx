import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSecretsDialog } from './ProjectSecretsDialog';
import { DOCS_FEDERATION_URL } from '@/lib/links';
import type { ProjectDetail } from '@/types';

const project = (federation?: ProjectDetail['federation']): ProjectDetail =>
	({ id: 'p_1', name: 'Demo', federation }) as ProjectDetail;

function setup(overrides: Partial<React.ComponentProps<typeof ProjectSecretsDialog>> = {}) {
	const onSave = vi.fn();
	const onClose = vi.fn();
	render(
		<ProjectSecretsDialog
			isOpen
			onClose={onClose}
			project={project()}
			available
			onSave={onSave}
			{...overrides}
		/>,
	);
	return { onSave, onClose };
}

describe('ProjectSecretsDialog', () => {
	it('shows setup instructions + a docs link when federation is unavailable', () => {
		setup({ available: false });
		const link = screen.getByRole('link', { name: /how to enable it/i });
		expect(link).toHaveAttribute('href', DOCS_FEDERATION_URL);
		// No save action in the instructions view.
		expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
	});

	it('shows the toggle form when federation is available', () => {
		setup();
		expect(screen.getByRole('switch')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
	});

	it('disables Save until the toggle changes from the persisted value', async () => {
		const user = userEvent.setup();
		setup({ project: project({ enabled: false }) });
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		await user.click(screen.getByRole('switch'));
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('saves the new enabled state', async () => {
		const user = userEvent.setup();
		const { onSave } = setup({ project: project({ enabled: false }) });
		await user.click(screen.getByRole('switch'));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith(true);
	});
});
