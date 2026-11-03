import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectCloudAccessDialog } from './ProjectCloudAccessDialog';
import type { ProjectDetail } from '@/types';

const project = (role: ProjectDetail['your_role'] = 'manager') =>
	({
		id: 'p_1',
		name: 'Demo',
		your_role: role,
		federation: { enabled: false },
		federation_effective: { enabled: false, source: 'project' },
	}) as ProjectDetail;

const inherited = (enabled: boolean): ProjectDetail => ({
	...project(),
	federation: undefined,
	federation_effective: { enabled, source: 'deployment' },
});

beforeEach(() => {
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
});

afterEach(() => vi.unstubAllGlobals());

describe('ProjectCloudAccessDialog', () => {
	it.each([undefined, false, true])(
		'keeps cloud access read-only without server resolution (override: %s)',
		(override) => {
			const legacyProject = {
				...project(),
				federation: override === undefined ? undefined : { enabled: override },
			};
			Reflect.deleteProperty(legacyProject, 'federation_effective');
			render(
				<ProjectCloudAccessDialog
					isOpen
					onClose={() => {}}
					project={legacyProject}
					cloudAccessLoading={false}
					cloudAccessAvailable
					cloudAccessDefaultEnabled
					onSaveCloudAccess={() => Promise.resolve()}
				/>,
			);
			expect(screen.getByRole('link', { name: /How to enable it/ })).toBeInTheDocument();
			expect(screen.queryByRole('radio')).not.toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
		},
	);

	it('saves federated cloud access without closing the dialog', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(() => Promise.resolve());
		const onClose = vi.fn();
		render(
			<ProjectCloudAccessDialog
				isOpen
				onClose={onClose}
				project={project()}
				cloudAccessLoading={false}
				cloudAccessAvailable
				onSaveCloudAccess={onSave}
				cloudAccessDefaultEnabled={false}
			/>,
		);
		await user.click(screen.getByRole('radio', { name: 'Enabled' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith('enabled');
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText('Federated cloud access', { selector: 'h3' })).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
		expect(onClose).not.toHaveBeenCalled();
	});

	it('shows non-managers read-only federation status', () => {
		render(
			<ProjectCloudAccessDialog
				isOpen
				onClose={() => {}}
				project={project('viewer')}
				cloudAccessLoading={false}
				cloudAccessAvailable
				onSaveCloudAccess={() => Promise.resolve()}
				cloudAccessDefaultEnabled={false}
			/>,
		);
		expect(
			screen.getByText('Federated cloud access is disabled for this project.'),
		).toBeInTheDocument();
		expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
	});

	it('keeps a failed cloud-access change dirty for retry', async () => {
		const user = userEvent.setup();
		const onSave = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('save failed'))
			.mockResolvedValueOnce();
		render(
			<ProjectCloudAccessDialog
				isOpen
				onClose={() => {}}
				project={project()}
				cloudAccessLoading={false}
				cloudAccessAvailable
				onSaveCloudAccess={onSave}
				cloudAccessDefaultEnabled={false}
			/>,
		);
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
			<ProjectCloudAccessDialog
				isOpen
				onClose={() => {}}
				project={inherited(true)}
				cloudAccessLoading={false}
				cloudAccessAvailable
				cloudAccessDefaultEnabled
				onSaveCloudAccess={onSave}
			/>,
		);
		expect(screen.getByRole('radio', { name: /Use deployment default/ })).toBeChecked();
		await user.click(screen.getByRole('radio', { name: 'Disabled' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith('disabled');
	});

	it('clears an explicit override to restore inheritance', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(async () => {});
		render(
			<ProjectCloudAccessDialog
				isOpen
				onClose={() => {}}
				project={project()}
				cloudAccessLoading={false}
				cloudAccessAvailable
				cloudAccessDefaultEnabled
				onSaveCloudAccess={onSave}
			/>,
		);
		await user.click(screen.getByRole('radio', { name: /Use deployment default/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith('inherit');
	});

	it('shows non-managers the deployment default as the source', () => {
		render(
			<ProjectCloudAccessDialog
				isOpen
				onClose={() => {}}
				project={{ ...inherited(true), your_role: 'viewer' }}
				cloudAccessLoading={false}
				cloudAccessAvailable
				cloudAccessDefaultEnabled
				onSaveCloudAccess={() => Promise.resolve()}
			/>,
		);
		expect(
			screen.getByText('Federated cloud access is enabled by deployment default.'),
		).toBeInTheDocument();
	});

	it('reports unavailable federation from the server even when capabilities are stale', () => {
		render(
			<ProjectCloudAccessDialog
				isOpen
				onClose={() => {}}
				project={{
					...project(),
					federation_effective: { enabled: false, source: 'unavailable' },
				}}
				cloudAccessLoading={false}
				cloudAccessAvailable
				cloudAccessDefaultEnabled
				onSaveCloudAccess={() => Promise.resolve()}
			/>,
		);
		expect(screen.getByRole('link', { name: /How to enable it/ })).toBeInTheDocument();
		expect(screen.queryByRole('radio')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
	});

	it('waits for capabilities before showing or editing inherited cloud access', () => {
		const onSave = vi.fn(async () => {});
		const props = {
			isOpen: true,
			onClose: () => {},
			project: inherited(true),
			onSaveCloudAccess: onSave,
		};
		const { rerender } = render(
			<ProjectCloudAccessDialog
				{...props}
				cloudAccessLoading
				cloudAccessAvailable={false}
				cloudAccessDefaultEnabled={false}
			/>,
		);
		expect(screen.getByRole('status')).toHaveTextContent('Loading cloud access…');
		expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
		rerender(
			<ProjectCloudAccessDialog
				{...props}
				cloudAccessLoading={false}
				cloudAccessAvailable
				cloudAccessDefaultEnabled
			/>,
		);
		expect(screen.getByRole('radio', { name: /Use deployment default/ })).toBeChecked();
		expect(screen.getByText('Currently enabled')).toBeInTheDocument();
	});
});
