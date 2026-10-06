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
				cloudAccessDefaultEnabled={false}
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
				cloudAccessDefaultEnabled={false}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		await user.click(screen.getByRole('radio', { name: 'Enabled' }));
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
				cloudAccessDefaultEnabled={false}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		expect(screen.getByText(/Federated cloud access is disabled/)).toBeInTheDocument();
		expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
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
				cloudAccessDefaultEnabled={false}
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
				cloudAccessDefaultEnabled={false}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		await user.click(screen.getByRole('radio', { name: 'Enabled' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		expect(onSave).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
	});

	it('shows inherited access and lets a manager opt out', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(async () => {});
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={() => {}}
				project={{ ...project(), federation: undefined }}
				integrationsAvailable
				cloudAccessAvailable
				cloudAccessDefaultEnabled
				onSaveCloudAccess={onSave}
			/>,
		);
		expect(screen.getByText('Enabled by deployment default')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		expect(screen.getByRole('radio', { name: /Use deployment default/ })).toBeChecked();
		await user.click(screen.getByRole('radio', { name: 'Disabled' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith(false);
	});
	it('clears an explicit override to restore inheritance', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(async () => {});
		render(
			<ProjectEnvironmentDialog
				isOpen
				onClose={() => {}}
				project={project()}
				integrationsAvailable
				cloudAccessAvailable
				cloudAccessDefaultEnabled
				onSaveCloudAccess={onSave}
			/>,
		);
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		await user.click(screen.getByRole('radio', { name: /Use deployment default/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith(null);
	});

	it('waits for capabilities before showing or editing inherited cloud access', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(async () => {});
		const props = {
			isOpen: true,
			onClose: () => {},
			project: { ...project(), federation: undefined },
			integrationsAvailable: false,
			onSaveCloudAccess: onSave,
		};
		const { rerender } = render(
			<ProjectEnvironmentDialog
				{...props}
				cloudAccessAvailable={undefined}
				cloudAccessDefaultEnabled={undefined}
			/>,
		);
		expect(screen.getByText('Loading cloud access…')).toBeInTheDocument();
		expect(screen.queryByText('Disabled by deployment default')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: /Cloud access/ }));
		expect(screen.getByRole('status')).toHaveTextContent('Loading cloud access…');
		expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
		rerender(
			<ProjectEnvironmentDialog {...props} cloudAccessAvailable cloudAccessDefaultEnabled />,
		);
		expect(screen.getByRole('radio', { name: /Use deployment default/ })).toBeChecked();
		expect(screen.getByText('Currently enabled')).toBeInTheDocument();
	});
});
