import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient, setupUser } from '@/test/render';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { OpenMenu } from './OpenMenu';
import { useSurfaceActions } from '@/api/surfaces';
import type { Session } from '@/types';

function TestMenu({
	canRunApp,
	isApp,
	session,
}: {
	canRunApp: boolean;
	isApp: boolean;
	session?: Session;
}) {
	const actions = useSurfaceActions('proj-1', 'nb-1');
	return (
		<OpenMenu
			projectId="proj-1"
			notebookId="nb-1"
			title="Forecast"
			canRunApp={canRunApp}
			actions={actions}
			isApp={isApp}
			session={session}
			onOpenFrame={() => {}}
			onCloseFrame={() => {}}
		/>
	);
}

function LocationProbe() {
	const location = useLocation();
	return (
		<>
			<output data-testid="location">
				{location.pathname}
				{location.search}
			</output>
			<output data-testid="state">{JSON.stringify(location.state)}</output>
		</>
	);
}

function renderMenu({
	canRunApp = true,
	isApp = false,
	path = '/projects/proj-1/notebooks/nb-1',
	session,
}: { canRunApp?: boolean; isApp?: boolean; path?: string; session?: Session } = {}) {
	const client = createTestQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[path]}>
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
	return render(
		<Routes>
			<Route
				path="*"
				element={
					<>
						<TestMenu canRunApp={canRunApp} isApp={isApp} session={session} />
						<LocationProbe />
					</>
				}
			/>
		</Routes>,
		{ wrapper },
	);
}

describe('OpenMenu', () => {
	it('opens the latest static outputs with the notebook title', async () => {
		const user = setupUser();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: 'View static outputs' }));

		expect(screen.getByTestId('location')).toHaveTextContent(
			'/projects/proj-1/notebooks/nb-1/snapshot',
		);
		expect(JSON.parse(screen.getByTestId('state').textContent)).toEqual({ title: 'Forecast' });
	});

	it('opens the shared app', async () => {
		const user = setupUser();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: 'Run as app' }));

		expect(screen.getByTestId('location')).toHaveTextContent('/projects/proj-1/notebooks/nb-1/app');
	});

	it.each([
		['the viewer cannot start apps', { canRunApp: false }],
		['the page already shows the app', { isApp: true }],
	])('hides Run as app when %s', async (_, options) => {
		const user = setupUser();
		renderMenu(options);

		await user.click(screen.getByRole('button', { name: 'Open' }));

		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).toBeNull();
		expect(screen.getByRole('menuitem', { name: 'View static outputs' })).toBeInTheDocument();
	});

	it.each([
		['Run as app', '/app?id=123&tag=one&tag=two&empty=&__mh_path=studio%2Fdata%2F'],
		['View static outputs', '/snapshot'],
	])('handles query parameters for %s', async (action, suffix) => {
		const user = setupUser();
		renderMenu({
			path: '/projects/proj-1/notebooks/nb-1?id=123&tag=one&tag=two&empty=&access_token=evil&file=other.py&__mh_path=studio%2Fdata%2F',
		});
		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: action }));
		expect(screen.getByTestId('location').textContent).toBe(
			`/projects/proj-1/notebooks/nb-1${suffix}`,
		);
	});
});

const linkedSession: Session = {
	session_id: 'sess-1',
	project_id: 'proj-1',
	notebook_id: 'nb-1',
	mode: 'edit',
	status: 'running',
	started_at: '2026-06-24T12:00:00Z',
	last_heartbeat: '2026-06-24T12:00:00Z',
	can: { attach: true, stop: true },
	links: [
		{ id: 'lookout', label: 'Lookout', href: 'https://lookout.example/?jobSet=sb-123' },
		{ id: 'logs', label: 'Logs', href: 'https://logs.example/sess-1' },
	],
};

describe('session links', () => {
	it.each(['starting', 'running', 'failed'] as const)(
		'shows external links in their own group while %s',
		async (status) => {
			const user = setupUser();
			renderMenu({ session: { ...linkedSession, status } });
			await user.click(screen.getByRole('button', { name: 'Open' }));
			const link = screen.getByRole('menuitem', { name: 'Open in Lookout' });
			expect(link.tagName).toBe('A');
			expect(link).toHaveAttribute('href', linkedSession.links![0].href);
			expect(link).toHaveAttribute('target', '_blank');
			expect(link).toHaveAttribute('rel', 'noopener noreferrer');
			expect(screen.getAllByRole('separator')).toHaveLength(1);
			expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
				'Run as app',
				'View static outputs',
				'Open in Lookout',
				'Open in Logs',
			]);
		},
	);

	it.each([
		{ session: undefined },
		{ session: { ...linkedSession, links: undefined } },
		{ session: { ...linkedSession, links: [] } },
		{ session: { ...linkedSession, can: { attach: false, stop: true } } },
		{ session: { ...linkedSession, mode: 'app' as const } },
		{ session: linkedSession, isApp: true },
	])('omits links and their separator when unavailable (%j)', async (options) => {
		const user = setupUser();
		renderMenu(options);
		await user.click(screen.getByRole('button', { name: 'Open' }));
		expect(screen.queryByRole('menuitem', { name: 'Open in Lookout' })).toBeNull();
		expect(screen.queryByRole('separator')).toBeNull();
	});
});
