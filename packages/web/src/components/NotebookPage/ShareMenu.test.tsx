import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient, jsonOk } from '@/test/render';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ShareMenu } from './ShareMenu';
import { OpenMenu } from './OpenMenu';
import { useSurfaceActions } from '@/api/surfaces';

function TestMenus({ canRunApp }: { canRunApp: boolean }) {
	const actions = useSurfaceActions('proj-1', 'nb-1');
	return (
		<>
			<ShareMenu projectId="proj-1" notebookId="nb-1" />
			<OpenMenu
				projectId="proj-1"
				notebookId="nb-1"
				title="Forecast"
				canRunApp={canRunApp}
				actions={actions}
				isApp={false}
				onOpenFrame={() => {}}
				onCloseFrame={() => {}}
			/>
		</>
	);
}

function LocationProbe() {
	const location = useLocation();
	return (
		<output data-testid="location">
			{location.pathname}
			{location.search}
		</output>
	);
}

function renderMenu({
	canRunApp = true,
	path = '/projects/proj-1/notebooks/nb-1',
	basename,
}: { canRunApp?: boolean; path?: string; basename?: string } = {}) {
	const client = createTestQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter basename={basename} initialEntries={[path]}>
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
	return render(
		<Routes>
			<Route
				path="*"
				element={
					<>
						<TestMenus canRunApp={canRunApp} />
						<LocationProbe />
					</>
				}
			/>
		</Routes>,
		{ wrapper },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, 'clipboard');
});

describe('Notebook sharing and navigation menus', () => {
	it('passes the current query to the App links dialog', async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk([{ slug: 'sales', registration_id: 'registration-1' }])),
		);
		renderMenu({ path: '/app/revenue?id=123&access_token=evil' });
		await user.click(screen.getByRole('button', { name: 'Share notebook' }));
		await user.click(screen.getByRole('menuitem', { name: 'App links' }));
		expect(await screen.findByRole('link')).toHaveAttribute('href', '/app/sales?id=123');
	});

	it.each(['denied', 'unavailable'])(
		'reports clipboard %s without a success message or navigation',
		async (failure) => {
			const user = userEvent.setup();
			const success = vi.spyOn(toast, 'success');
			const error = vi.spyOn(toast, 'error');
			const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
			Object.defineProperty(navigator, 'clipboard', {
				value: failure === 'unavailable' ? undefined : { writeText },
				configurable: true,
			});
			const path = '/projects/proj-1/notebooks/nb-1/app?id=123&access_token=evil';
			renderMenu({ path });
			await user.click(screen.getByRole('button', { name: 'Share notebook' }));
			await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
			expect(error).toHaveBeenCalledWith('Could not copy to clipboard');
			expect(success).not.toHaveBeenCalled();
			expect(screen.getByTestId('location').textContent).toBe(path);
			if (failure === 'denied') {
				expect(writeText).toHaveBeenCalledWith(
					`${window.location.origin}/projects/proj-1/notebooks/nb-1/app?id=123`,
				);
			}
		},
	);

	it('opens the latest static outputs', async () => {
		const user = userEvent.setup();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: 'View static outputs' }));

		expect(screen.getByTestId('location')).toHaveTextContent(
			'/projects/proj-1/notebooks/nb-1/snapshot',
		);
	});

	it('opens the shared app', async () => {
		const user = userEvent.setup();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('menuitem', { name: 'Run as app' }));

		expect(screen.getByTestId('location')).toHaveTextContent('/projects/proj-1/notebooks/nb-1/app');
	});

	it('copies the canonical notebook URL', async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText },
			configurable: true,
		});
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Share notebook' }));
		await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));

		expect(writeText).toHaveBeenCalledWith(
			new URL('/projects/proj-1/notebooks/nb-1', window.location.origin).toString(),
		);
	});

	it('hides app sharing when the viewer cannot start apps', async () => {
		const user = userEvent.setup();
		renderMenu({ canRunApp: false });

		await user.click(screen.getByRole('button', { name: 'Open' }));

		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).toBeNull();
		expect(screen.getByRole('menuitem', { name: 'View static outputs' })).toBeInTheDocument();
	});

	it.each(['', '/app'])('copies the current route and filtered parameters (%s)', async (suffix) => {
		const user = userEvent.setup();
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const base = document.createElement('base');
		base.href = `${window.location.origin}/hub/`;
		document.head.append(base);
		try {
			renderMenu({
				basename: '/hub',
				path: `/hub/projects/proj-1/notebooks/nb-1${suffix}?id=123&tag=one&tag=two&empty=&access_token=evil&%73ession_id=evil&theme=dark`,
			});
			await user.click(screen.getByRole('button', { name: 'Share notebook' }));
			await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
			expect(writeText).toHaveBeenCalledWith(
				`${window.location.origin}/hub/projects/proj-1/notebooks/nb-1${suffix}?id=123&tag=one&tag=two&empty=`,
			);
		} finally {
			base.remove();
		}
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
