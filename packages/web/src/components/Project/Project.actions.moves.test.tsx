import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { jsonOk, setupUser } from '@/test/render';
import { chooseNotebookAction, makeFetch, notebook, renderProject } from './Project.testWorld';

describe('Project — pending moves', () => {
	const moving = () => ({ ...notebook(), moving: { destination_project_id: 'proj-dest' } });

	function stubMoveRoutes() {
		const moves: { method: string; url: string; ifMatch: string | null; body: unknown }[] = [];
		const base = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (!url.endsWith('/move')) return base(input, init);
				moves.push({
					method: init?.method ?? 'GET',
					url,
					ifMatch: new Headers(init?.headers).get('if-match'),
					body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
				});
				return init?.method === 'DELETE'
					? jsonOk({ message: 'Move cancelled' })
					: jsonOk({ ...notebook(), project_id: 'proj-dest' });
			}),
		);
		return moves;
	}

	it('badges a moving notebook and does not link to it', async () => {
		makeFetch({ notebooks: [moving()] });
		await renderProject();
		expect(screen.getByRole('button', { name: 'Moving to proj-dest' })).toHaveTextContent('Moving');
		expect(screen.queryByRole('link', { name: 'Forecast' })).not.toBeInTheDocument();
		expect(screen.getByTestId('notebook-row')).toHaveClass('bg-muted/20');
	});

	it('lets managers resume a pending move with the entry version as precondition', async () => {
		const user = setupUser();
		makeFetch({ notebooks: [moving()] });
		const moves = stubMoveRoutes();
		await renderProject();
		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		const menu = await screen.findByRole('menu');
		expect(
			within(menu).queryByRole('menuitem', { name: 'Move to project…' }),
		).not.toBeInTheDocument();
		await user.click(within(menu).getByRole('menuitem', { name: 'Resume move' }));
		await waitFor(() => expect(moves).toHaveLength(1));
		expect(moves[0]).toEqual({
			method: 'POST',
			url: expect.stringContaining('/projects/proj-x/notebooks/nb-1/move'),
			ifMatch: `"${notebook().updated_at}"`,
			body: { destination_project_id: 'proj-dest' },
		});
	});

	it('does not resume the same move again while the first request is in flight', async () => {
		const user = setupUser();
		makeFetch({ notebooks: [moving()] });
		const base = globalThis.fetch;
		const posts: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!String(input).endsWith('/move')) return base(input, init);
				posts.push(init?.method ?? 'GET');
				return new Promise<Response>(() => {});
			}),
		);
		await renderProject();
		await chooseNotebookAction(user, 'Resume move');
		await waitFor(() => expect(posts).toEqual(['POST']));
		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		const menu = await screen.findByRole('menu');
		expect(within(menu).getByRole('menuitem', { name: 'Resume move' })).toHaveAttribute(
			'aria-disabled',
			'true',
		);
		expect(posts).toEqual(['POST']);
	});

	it('lets managers cancel a pending move', async () => {
		const user = setupUser();
		makeFetch({ notebooks: [moving()] });
		const moves = stubMoveRoutes();
		await renderProject();
		await chooseNotebookAction(user, 'Cancel move');
		await waitFor(() => expect(moves.map((move) => move.method)).toEqual(['DELETE']));
		expect(moves[0].url).toContain('/projects/proj-x/notebooks/nb-1/move');
	});

	it('shows editors the badge but no move actions', async () => {
		const user = setupUser();
		makeFetch({ role: 'editor', notebooks: [moving()] });
		await renderProject();
		expect(screen.getByRole('button', { name: 'Moving to proj-dest' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		const menu = await screen.findByRole('menu');
		for (const name of ['Resume move', 'Cancel move', 'Move to project…'])
			expect(within(menu).queryByRole('menuitem', { name })).not.toBeInTheDocument();
	});
});
