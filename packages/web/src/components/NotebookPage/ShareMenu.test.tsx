import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ShareMenu } from './ShareMenu';

function LocationProbe() {
	return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderMenu({ canRunApp = true }: { canRunApp?: boolean } = {}) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={['/projects/proj-1/notebooks/nb-1']}>{children}</MemoryRouter>
	);
	return render(
		<Routes>
			<Route
				path="*"
				element={
					<>
						<ShareMenu
							projectId="proj-1"
							notebookId="nb-1"
							title="Forecast"
							canRunApp={canRunApp}
						/>
						<LocationProbe />
					</>
				}
			/>
		</Routes>,
		{ wrapper },
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, 'clipboard');
});

describe('ShareMenu', () => {
	it('opens the latest static outputs', async () => {
		const user = userEvent.setup();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Share notebook' }));
		await user.click(screen.getByRole('menuitem', { name: 'View static outputs' }));

		expect(screen.getByTestId('location')).toHaveTextContent(
			'/projects/proj-1/notebooks/nb-1/snapshot',
		);
	});

	it('opens the shared app', async () => {
		const user = userEvent.setup();
		renderMenu();

		await user.click(screen.getByRole('button', { name: 'Share notebook' }));
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

		await user.click(screen.getByRole('button', { name: 'Share notebook' }));

		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).toBeNull();
		expect(screen.getByRole('menuitem', { name: 'View static outputs' })).toBeInTheDocument();
	});
});
