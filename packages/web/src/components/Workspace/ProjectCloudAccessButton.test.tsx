import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { useProjectQuery } from '@/api/hooks';
import { makeCapabilities, stubApi } from '@/test/apiStub';
import type { CapabilityOverrides } from '@/test/apiStub';
import { jsonError, renderWithClient } from '@/test/render';
import { PID, project } from '@/components/Project/Project.testWorld';
import type { ProjectDetail } from '@/types';
import { ProjectCloudAccessButton } from './ProjectCloudAccessButton';

function Settings() {
	const { data } = useProjectQuery(PID);
	return <ProjectCloudAccessButton project={data} />;
}

function stubProject(
	overrides: Partial<ProjectDetail> = {},
	capabilities: CapabilityOverrides | Promise<Response> = {},
) {
	return stubApi({
		[`/api/v1/projects/${PID}`]: { ...project(), ...overrides },
		[`PATCH /api/v1/projects/${PID}`]: project(),
		'/api/v1/capabilities':
			capabilities instanceof Promise ? () => capabilities : makeCapabilities(capabilities),
	});
}

async function renderSettings() {
	const result = renderWithClient(<Settings />, { route: `/projects/${PID}` });
	await screen.findByRole('button', { name: 'Cloud access' });
	return result;
}

describe('Project — cloud access', () => {
	it.each([
		['Disabled', { enabled: false, target: 'prod' }, 'Federated cloud access disabled'],
		[/Use deployment default/, null, 'Federated cloud access uses deployment default (disabled)'],
	] as const)(
		'saves %s as the project federation override',
		async (choice, federation, message) => {
			const user = userEvent.setup();
			const toastSuccess = vi.spyOn(toast, 'success');
			const { calls } = stubProject(
				{
					federation: { enabled: true, target: 'prod' },
					federation_effective: { enabled: true, source: 'project' },
				},
				{ federation: { available: true, default_enabled: false }, jobs: { available: true } },
			);
			await renderSettings();

			await user.click(await screen.findByRole('button', { name: /Cloud access/ }));
			await user.click(screen.getByRole('radio', { name: choice }));
			await user.click(screen.getByRole('button', { name: 'Save' }));

			await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(message));
			const patch = calls.find((call) => call.method === 'PATCH');
			expect(patch?.url.pathname).toBe(`/api/v1/projects/${PID}`);
			expect(patch?.body).toEqual({ federation });
		},
	);
});

describe('environment and access', () => {
	it('opens cloud access directly', async () => {
		stubProject();
		await renderSettings();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Cloud access' }));
		expect(screen.getByRole('heading', { name: 'Cloud access' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
	});
});

describe('Project settings loading', () => {
	it('shows cloud access guidance after a pending capabilities request fails', async () => {
		let resolve!: (response: Response) => void;
		const capabilities = new Promise<Response>((done) => {
			resolve = done;
		});
		stubProject({}, capabilities);
		await renderSettings();
		fireEvent.click(screen.getByRole('button', { name: /Cloud access/ }));
		expect(screen.getByText('Loading cloud access…')).toBeVisible();
		expect(screen.queryByRole('link', { name: 'How to enable it' })).not.toBeInTheDocument();

		await act(async () => {
			resolve(jsonError('UNAVAILABLE', 'Temporarily unavailable', 503));
		});

		expect(
			await screen.findByText(/This deployment has not configured federated cloud access/),
		).toBeVisible();
		expect(screen.getByRole('link', { name: 'How to enable it' })).toBeVisible();
		expect(screen.queryByText('Loading cloud access…')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
	});
});
