import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTestQueryClient, jsonError, jsonOk } from '@/test/render';
import { IID, PID, setup } from './DataBrowserPage.testWorld';

const route = `/projects/${PID}/data/${IID}?ns=sales&table=orders`;

describe('catalog recovery', () => {
	it.each(['namespaces', 'tables'])(
		'retries an initial %s failure without losing the deep link',
		async (resource) => {
			const user = userEvent.setup();
			let failing = true;
			setup(route, {
				catalogResponse: (url) =>
					failing && url.pathname.endsWith(`/${resource}`)
						? jsonError('SERVICE_UNAVAILABLE', 'Catalog unavailable', 503)
						: undefined,
			});
			const retry = await screen.findByRole('button', { name: `Retry loading ${resource}` });
			failing = false;
			await user.click(retry);
			expect(await screen.findByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
			expect(screen.getByTestId('location')).toHaveTextContent(route);
		},
	);

	it('retries a failed table page and preserves loaded rows and selection', async () => {
		const user = userEvent.setup();
		let failing = true;
		setup(route, {
			pagedTables: true,
			catalogResponse: (url) =>
				failing && url.pathname.endsWith('/tables') && url.searchParams.has('cursor')
					? jsonError('SERVICE_UNAVAILABLE', 'Next page unavailable', 503)
					: undefined,
		});
		await screen.findByTestId('browse-table');
		await user.click(screen.getByRole('button', { name: 'Load more' }));
		expect(await screen.findByText('Next page unavailable')).toBeInTheDocument();
		expect(screen.getByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
		failing = false;
		await user.click(screen.getByRole('button', { name: 'Retry loading more tables' }));
		expect(await screen.findByText('refunds')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'orders' })).toHaveAttribute('aria-current', 'true');
		expect(screen.getAllByTestId('browse-table')).toHaveLength(2);
		expect(screen.getByTestId('location')).toHaveTextContent(route);
	});

	it('retries a failed namespace page without collapsing loaded branches', async () => {
		const user = userEvent.setup();
		let failing = true;
		setup(route, {
			catalogResponse: (url) => {
				if (!url.pathname.endsWith('/namespaces') || url.searchParams.has('parent')) return;
				if (!url.searchParams.has('cursor'))
					return jsonOk({ items: [['sales']], next_cursor: 'page2' });
				return failing
					? jsonError('SERVICE_UNAVAILABLE', 'Namespace page unavailable', 503)
					: jsonOk({ items: [['other']], next_cursor: null });
			},
		});
		await screen.findByTestId('browse-table');
		await user.click(screen.getByRole('button', { name: 'Load more' }));
		const retry = await screen.findByRole('button', { name: 'Retry loading more namespaces' });
		expect(screen.getByTestId('browse-namespace')).toHaveAttribute('aria-expanded', 'true');
		failing = false;
		await user.click(retry);
		expect(await screen.findByText('other')).toBeInTheDocument();
		expect(screen.getAllByTestId('browse-namespace')).toHaveLength(2);
		expect(screen.getByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
	});

	it.each(['namespaces', 'tables'])(
		'shows a %s refresh failure while retaining cached data',
		async (resource) => {
			const user = userEvent.setup();
			const client = createTestQueryClient();
			let failing = false;
			setup(
				route,
				{
					catalogResponse: (url) =>
						failing &&
						url.pathname.endsWith(`/${resource}`) &&
						(resource !== 'namespaces' || !url.searchParams.has('parent'))
							? jsonError('SERVICE_UNAVAILABLE', 'Refresh unavailable', 503)
							: undefined,
				},
				client,
			);
			await screen.findByTestId('browse-table');
			failing = true;
			await act(async () => {
				await client.invalidateQueries();
			});
			expect(screen.getByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
			const retry = await screen.findByRole('button', { name: `Retry refreshing ${resource}` });
			failing = false;
			await user.click(retry);
			await waitFor(() =>
				expect(screen.queryByText('Refresh unavailable')).not.toBeInTheDocument(),
			);
			expect(screen.getByTestId('location')).toHaveTextContent(route);
		},
	);

	it('shows a capability refresh failure and retries without losing the tree or selection', async () => {
		const user = userEvent.setup();
		const client = createTestQueryClient();
		const failures: { capability?: string } = {};
		setup(route, { objectFailures: failures }, client);
		const selectedTable = await screen.findByTestId('browse-table');
		expect(selectedTable).toHaveAttribute('aria-current', 'true');
		failures.capability = 'Capability refresh unavailable';
		await act(async () => {
			await client.invalidateQueries();
		});
		expect(await screen.findByText('Capability refresh unavailable')).toBeInTheDocument();
		expect(screen.getByTestId('browse-table')).toBe(selectedTable);
		expect(selectedTable).toHaveAttribute('aria-current', 'true');
		expect(screen.getByTestId('browse-namespace')).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByTestId('location')).toHaveTextContent(route);
		delete failures.capability;
		await user.click(screen.getByRole('button', { name: 'Retry refreshing capability' }));
		await waitFor(() =>
			expect(screen.queryByText('Capability refresh unavailable')).not.toBeInTheDocument(),
		);
		expect(screen.getByTestId('browse-table')).toBe(selectedTable);
		expect(selectedTable).toHaveAttribute('aria-current', 'true');
		expect(screen.getByTestId('browse-namespace')).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByTestId('location')).toHaveTextContent(route);
	});

	it('distinguishes an empty catalog from an access failure', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			catalogResponse: () => jsonOk({ items: [], next_cursor: null }),
		});
		expect(
			await screen.findByText('No namespaces are visible to this integration.'),
		).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
	});
});

describe('catalog pagination edge cases', () => {
	it.each(['namespaces', 'tables'])(
		'keeps %s loaded through empty pages and repeated retry failures',
		async (resource) => {
			const user = userEvent.setup();
			let attempts = 0;
			const cursors: (string | null)[] = [];
			setup(route, {
				catalogResponse: (url) => {
					if (!url.pathname.endsWith(`/${resource}`) || url.searchParams.has('parent')) return;
					const cursor = url.searchParams.get('cursor');
					cursors.push(cursor);
					if (!cursor)
						return jsonOk({
							items: resource === 'namespaces' ? [['sales']] : ['orders'],
							next_cursor: 'empty-page',
						});
					if (cursor === 'empty-page') return jsonOk({ items: [], next_cursor: 'last-page' });
					attempts += 1;
					return attempts < 3
						? jsonError('SERVICE_UNAVAILABLE', `Page attempt ${attempts} failed`, 503)
						: jsonOk({
								items: resource === 'namespaces' ? [['other']] : ['refunds'],
								next_cursor: null,
							});
				},
			});
			await screen.findByTestId('browse-table');
			await user.click(screen.getByRole('button', { name: 'Load more' }));
			await waitFor(() => expect(cursors).toEqual([null, 'empty-page']));
			expect(
				screen.queryByText('No namespaces are visible to this integration.'),
			).not.toBeInTheDocument();
			await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());
			await user.click(screen.getByRole('button', { name: 'Load more' }));
			for (const attempt of [1, 2]) {
				expect(await screen.findByText(`Page attempt ${attempt} failed`)).toBeInTheDocument();
				expect(screen.getByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
				expect(screen.getByTestId('browse-namespace')).toHaveAttribute('aria-expanded', 'true');
				expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
				await user.click(screen.getByRole('button', { name: `Retry loading more ${resource}` }));
			}
			expect(
				await screen.findByText(resource === 'namespaces' ? 'other' : 'refunds'),
			).toBeInTheDocument();
			expect(cursors).toEqual([null, 'empty-page', 'last-page', 'last-page', 'last-page']);
			expect(
				screen.getAllByTestId(resource === 'namespaces' ? 'browse-namespace' : 'browse-table'),
			).toHaveLength(2);
			expect(screen.getByTestId('location')).toHaveTextContent(route);
			expect(screen.queryByRole('button', { name: /Retry loading/ })).not.toBeInTheDocument();
		},
	);
});
