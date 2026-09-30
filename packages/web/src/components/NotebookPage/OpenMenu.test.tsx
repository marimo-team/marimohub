import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/test/render';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { OpenMenu } from './OpenMenu';
import { useSurfaceActions } from '@/api/surfaces';

function TestMenu({ canRunApp, isApp }: { canRunApp: boolean; isApp: boolean }) {
	const actions = useSurfaceActions('proj-1', 'nb-1');
	return (
		<OpenMenu
			projectId="proj-1"
			notebookId="nb-1"
			title="Forecast"
			canRunApp={canRunApp}
			actions={actions}
			isApp={isApp}
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
}: { canRunApp?: boolean; isApp?: boolean; path?: string } = {}) {
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
						<TestMenu canRunApp={canRunApp} isApp={isApp} />
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
		const user = userEvent.setup();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: 'View static outputs' }));

		expect(screen.getByTestId('location')).toHaveTextContent(
			'/projects/proj-1/notebooks/nb-1/snapshot',
		);
		expect(JSON.parse(screen.getByTestId('state').textContent)).toEqual({ title: 'Forecast' });
	});

	it('opens the shared app', async () => {
		const user = userEvent.setup();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: 'Run as app' }));

		expect(screen.getByTestId('location')).toHaveTextContent('/projects/proj-1/notebooks/nb-1/app');
	});

	it.each([
		['the viewer cannot start apps', { canRunApp: false }],
		['the page already shows the app', { isApp: true }],
	])('hides Run as app when %s', async (_, options) => {
		const user = userEvent.setup();
		renderMenu(options);

		await user.click(screen.getByRole('button', { name: 'Open' }));

		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).toBeNull();
		expect(screen.getByRole('menuitem', { name: 'View static outputs' })).toBeInTheDocument();
	});

	it.each([
		['Run as app', '/app?id=123&tag=one&tag=two&empty='],
		['View static outputs', '/snapshot'],
	])('handles query parameters for %s', async (action, suffix) => {
		const user = userEvent.setup();
		renderMenu({
			path: '/projects/proj-1/notebooks/nb-1?id=123&tag=one&tag=two&empty=&access_token=evil&file=other.py',
		});
		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: action }));
		expect(screen.getByTestId('location').textContent).toBe(
			`/projects/proj-1/notebooks/nb-1${suffix}`,
		);
	});
});
