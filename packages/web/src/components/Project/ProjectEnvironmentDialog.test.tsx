import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectEnvironmentDialog } from './ProjectEnvironmentDialog';
import type { ProjectDetail } from '@/types';

const project = (role: ProjectDetail['your_role'] = 'manager') =>
	({
		id: 'p_1',
		name: 'Demo',
		your_role: role,
		federation: { enabled: false },
	}) as ProjectDetail;

beforeEach(() => {
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
});

afterEach(() => vi.unstubAllGlobals());

describe('ProjectEnvironmentDialog', () => {
	it('shows the integrations and cloud access overview', () => {
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={() => {}}
				project={project()}
				integrationsAvailable={false}
				cloudAccessAvailable={false}
				onSaveCloudAccess={() => Promise.resolve()}
			/>,
		);
		expect(screen.getByRole('heading', { name: 'Environment & cloud access' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Integrations/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Cloud access/ })).toBeInTheDocument();
		expect(screen.getByText(/does not control project roles or permissions/i)).toBeInTheDocument();
		expect(screen.getAllByText('Not configured for this deployment')).toHaveLength(2);
	});

	it('saves federated cloud access without closing the dialog', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(() => Promise.resolve());
		const onClose = vi.fn();
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={onClose}
				project={project()}
				integrationsAvailable
				cloudAccessAvailable
				onSaveCloudAccess={onSave}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		await user.click(screen.getByRole('switch', { name: /Federated cloud access disabled/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith(true);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText('Federated cloud access', { selector: 'h3' })).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
		expect(onClose).not.toHaveBeenCalled();
	});

	it('shows non-managers read-only federation status', async () => {
		const user = userEvent.setup();
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={() => {}}
				project={project('viewer')}
				integrationsAvailable
				cloudAccessAvailable
				onSaveCloudAccess={() => Promise.resolve()}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		expect(screen.getByText(/Federated cloud access is disabled/)).toBeInTheDocument();
		expect(screen.queryByRole('switch')).not.toBeInTheDocument();
	});

	it('shows the project cloud-access state in the overview', () => {
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={() => {}}
				project={{ ...project(), federation: { enabled: true } }}
				integrationsAvailable
				cloudAccessAvailable
				onSaveCloudAccess={() => Promise.resolve()}
			/>,
		);
		expect(screen.getByText('Enabled for this project')).toBeInTheDocument();
	});

	it('keeps a failed cloud-access change dirty for retry', async () => {
		const user = userEvent.setup();
		const onSave = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('save failed'))
			.mockResolvedValueOnce();
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={() => {}}
				project={project()}
				integrationsAvailable
				cloudAccessAvailable
				onSaveCloudAccess={onSave}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		await user.click(screen.getByRole('switch', { name: /Federated cloud access disabled/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		expect(onSave).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
	});
});
