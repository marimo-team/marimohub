import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { jsonOk, renderWithClient, setupUser } from '@/test/render';
import { ProjectPicker } from './ProjectPicker';

function Destination() {
	return <output aria-label="Destination">{useLocation().pathname}</output>;
}
function setup(canCreate = true) {
	const onNavigate = vi.fn();
	const requests: unknown[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
			const url = new URL(String(input), 'http://localhost');
			if (url.pathname !== '/api/v1/projects' || init.method !== 'POST')
				throw new Error(`Unexpected request: ${init.method} ${url}`);
			requests.push(JSON.parse(String(init.body)));
			return jsonOk({ id: 'new-project' });
		}),
	);
	renderWithClient(
		<>
			<ProjectPicker
				projects={[
					{ id: 'alpha', name: 'Alpha' },
					{ id: 'beta', name: 'Beta' },
				]}
				selectedId="alpha"
				isPending={false}
				canCreate={canCreate}
				onNavigate={onNavigate}
			/>
			<Destination />
		</>,
		{ route: '/projects/alpha', toaster: false },
	);
	return { user: setupUser(), onNavigate, requests };
}
afterEach(() => vi.unstubAllGlobals());

describe('Project picker', () => {
	it('reports programmatic closure when opening project creation', async () => {
		const onOpenChange = vi.fn();
		const user = setupUser();
		renderWithClient(
			<ProjectPicker projects={[]} isPending={false} canCreate onOpenChange={onOpenChange} />,
			{ route: '/projects', toaster: false },
		);
		await user.click(screen.getByRole('button', { name: /All projects/ }));
		expect(onOpenChange).toHaveBeenLastCalledWith(true);
		await user.click(screen.getByRole('button', { name: 'New project' }));
		expect(await screen.findByRole('dialog', { name: 'Create New Project' })).toBeVisible();
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
	});
	it('switches projects with arrow keys and Enter', async () => {
		const { user, onNavigate } = setup();
		screen.getByRole('button', { name: /Alpha/ }).focus();
		await user.keyboard('{Enter}{ArrowDown}{Enter}');
		expect(screen.getByRole('status', { name: 'Destination' })).toHaveTextContent('/projects/beta');
		expect(onNavigate).toHaveBeenCalled();
	});
	it('offers project creation from the keyboard and opens the created project', async () => {
		const { user, onNavigate, requests } = setup();
		await user.click(screen.getByRole('button', { name: /Alpha/ }));
		await user.tab();
		expect(screen.getByRole('button', { name: 'New project' })).toHaveFocus();
		await user.keyboard('{Enter}');
		await user.type(await screen.findByRole('textbox', { name: 'Project Name' }), 'Research');
		await user.click(screen.getByRole('button', { name: 'Create' }));
		await waitFor(() =>
			expect(screen.getByRole('status', { name: 'Destination' })).toHaveTextContent(
				'/projects/new-project',
			),
		);
		expect(requests).toEqual([{ name: 'Research', description: 'Research' }]);
		expect(onNavigate).toHaveBeenCalled();
	});
	it('allows creation when there are no projects', async () => {
		const user = setupUser();
		renderWithClient(<ProjectPicker projects={[]} isPending={false} canCreate />, {
			route: '/projects',
			toaster: false,
		});
		await user.click(screen.getByRole('button', { name: /All projects/ }));
		await user.click(await screen.findByRole('button', { name: 'New project' }));
		expect(await screen.findByRole('dialog', { name: 'Create New Project' })).toBeVisible();
	});

	it('hides creation when the caller cannot create projects', async () => {
		const { user } = setup(false);
		await user.click(screen.getByRole('button', { name: /Alpha/ }));
		expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
	});
});
