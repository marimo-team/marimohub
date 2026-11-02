import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { useProjectQuery } from '@/api/hooks';
import { jsonError, renderWithClient } from '@/test/render';
import { makeFetch, PID } from '@/components/Project/Project.testWorld';
import { ProjectCloudAccessButton } from './ProjectCloudAccessButton';

function Settings() {
	const { data: project } = useProjectQuery(PID);
	return <ProjectCloudAccessButton project={project} />;
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
			const calls = makeFetch({
				project: {
					federation: { enabled: true, target: 'prod' },
					federation_effective: { enabled: true, source: 'project' },
				},
				capabilities: {
					federation: { available: true, default_enabled: false },
					jobs: { available: true },
				},
			});
			await renderSettings();

			await user.click(await screen.findByRole('button', { name: /Cloud access/ }));
			await user.click(screen.getByRole('radio', { name: choice }));
			await user.click(screen.getByRole('button', { name: 'Save' }));

			await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(message));
			const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/proj-x'));
			expect(patch?.body).toEqual({ federation });
		},
	);
});

describe('environment and access', () => {
	it('opens cloud access directly', async () => {
		makeFetch({ capabilities: { federation: { available: false, default_enabled: false } } });
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
		const promise = new Promise<Response>((done) => {
			resolve = done;
		});
		makeFetch();
		const originalFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).includes('/capabilities')) return promise;
				return originalFetch(input, init);
			}),
		);
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
