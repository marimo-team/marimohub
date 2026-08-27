import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IID, PID, pysparkKind, setup, sparkEntry } from './DataBrowserPage.testWorld';

describe('DataBrowserPage catalog', () => {
	it('shows PySpark connection info and opens its session snippet in a notebook', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${sparkEntry.id}`, {
			kind: pysparkKind,
			entry: sparkEntry,
		});

		expect(await screen.findByTestId('browse-integration')).toHaveTextContent('analytics-prod');
		expect(
			screen.getByText(/cannot inspect its catalogs without opening a Spark session/),
		).toBeInTheDocument();
		expect(screen.getByText('pyspark[connect]>=4.2')).toBeInTheDocument();
		expect(screen.getByText(/SparkSession\.builder\.remote/)).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Create PySpark Notebook' }));

		await waitFor(() => {
			expect(screen.getByTestId('location').textContent).toContain(
				`/projects/${PID}/notebooks/nb_1`,
			);
		});
		const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
		const body = JSON.parse(String(post?.[1]?.body)) as { title: string; code: string };
		expect(body.title).toBe('connect_analytics_prod');
		expect(body.code).toContain('.joinpath("pyspark", "analytics-prod.json")');
		expect(body.code).toContain('builder.getOrCreate()');
	});

	it('shows a disabled Query control with the server blocker reason', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			role: 'manager',
			querySurface: { available: false, reason: 'Broker unavailable.' },
		});

		await screen.findByTestId('browse-namespace', undefined, { timeout: 5000 });
		expect(screen.getByRole('button', { name: 'Tables' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
		expect(screen.queryByRole('button', { name: 'Objects' })).not.toBeInTheDocument();
		expect(screen.getByText('Run SQL unavailable.')).toBeInTheDocument();
		expect(screen.getByText('Broker unavailable.')).toBeInTheDocument();
	});

	it('shows the deployment blocker when the global Run SQL capability is off', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			role: 'manager',
			queryEnabled: false,
			querySurface: {
				available: false,
				reason: 'Run SQL is not enabled on this deployment.',
			},
		});

		await screen.findByTestId('browse-namespace', undefined, { timeout: 5000 });
		expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
		expect(screen.getByText('Run SQL is not enabled on this deployment.')).toBeInTheDocument();
	});

	it('restores a deep link: tree expanded to the namespace, table selected, schema shown', async () => {
		setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`);

		const namespace = await screen.findByTestId('browse-namespace', undefined, { timeout: 5000 });
		expect(namespace).toHaveAttribute('aria-expanded', 'true');
		const table = await screen.findByTestId('browse-table');
		expect(table).toHaveAttribute('aria-current', 'true');

		expect(await screen.findByText(/123[,.\s]456 rows/)).toBeInTheDocument();
		expect(screen.getByText('771 KiB')).toBeInTheDocument();
		expect(screen.getByText('format v2')).toBeInTheDocument();
		expect(screen.getByText('s3://warehouse/sales/orders')).toBeInTheDocument();
		expect(screen.getByText('day(ts)')).toBeInTheDocument();
		expect(screen.getByText(/load_catalog/)).toBeInTheDocument();
	});

	it('expands the ancestry when a deep link arrives while already mounted', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}`);

		const namespace = await screen.findByTestId('browse-namespace');
		expect(namespace).toHaveAttribute('aria-expanded', 'false');

		await user.click(screen.getByTestId('deeplink'));

		await waitFor(() => {
			expect(screen.getByTestId('browse-namespace')).toHaveAttribute('aria-expanded', 'true');
		});
		expect(await screen.findByTestId('browse-table')).toHaveAttribute('aria-current', 'true');
	});

	it('writes the selection into the URL when a table is clicked', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}`);

		await user.click(await screen.findByTestId('browse-namespace'));
		await user.click(await screen.findByTestId('browse-table'));

		await waitFor(() => {
			const location = screen.getByTestId('location').textContent ?? '';
			expect(location).toContain(`/projects/${PID}/data/${IID}`);
			expect(decodeURIComponent(location)).toContain(`ns=sales`);
			expect(location).toContain('table=orders');
		});
	});

	it('pages tables with Load more', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}`, { pagedTables: true });

		await user.click(await screen.findByTestId('browse-namespace'));
		expect(await screen.findByText('orders')).toBeInTheDocument();
		expect(screen.queryByText('refunds')).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Load more' }));
		expect(await screen.findByText('refunds')).toBeInTheDocument();
	});

	it('finds a table under a collapsed namespace while a filter is active', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?q=orders`);

		// The namespace stays visible (its tables are not loaded yet), so the
		// filtered table remains reachable by expanding it.
		const namespace = await screen.findByTestId('browse-namespace');
		expect(screen.getByLabelText('Filter tables')).toHaveValue('orders');
		await user.click(namespace);
		expect(await screen.findByTestId('browse-table')).toHaveTextContent('orders');
	});

	it('highlights the matched part of a filtered table name', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?q=ord`);

		await user.click(await screen.findByTestId('browse-namespace'));
		const table = await screen.findByTestId('browse-table');
		expect(table).toHaveTextContent('orders');
		expect(table.querySelector('mark')).toHaveTextContent('ord');
	});

	it('keeps the tree filter available and populated on the Query surface', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?q=ord`, {
			role: 'manager',
			querySurface: { available: true },
		});

		await screen.findByTestId('browse-namespace');
		await user.click(screen.getByRole('button', { name: 'Query' }));

		expect(await screen.findByLabelText('Filter tables')).toHaveValue('ord');
	});

	it('filters loaded tables and says so when nothing matches', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?q=zzz`);

		await user.click(await screen.findByTestId('browse-namespace'));
		expect(await screen.findByText('No tables here match "zzz".')).toBeInTheDocument();
		expect(screen.queryByTestId('browse-table')).not.toBeInTheDocument();
	});

	it('resets the column filter when another table is selected', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			tables: ['orders', 'refunds'],
		});

		const filter = await screen.findByPlaceholderText('Filter columns...');
		await user.type(filter, 'zzz');
		expect(await screen.findByText('No columns match "zzz".')).toBeInTheDocument();

		await user.click(screen.getByText('refunds'));

		expect(await screen.findByPlaceholderText('Filter columns...')).toHaveValue('');
		expect(screen.queryByText('No columns match "zzz".')).not.toBeInTheDocument();
	});

	it('creates a notebook seeded with the load snippet and navigates to it', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`);

		await user.click(await screen.findByRole('button', { name: /Open in Notebook/ }));

		await waitFor(() => {
			expect(screen.getByTestId('location').textContent).toContain(
				`/projects/${PID}/notebooks/nb_1`,
			);
		});
		const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
		const body = JSON.parse(String(post?.[1]?.body)) as { title: string; code: string };
		expect(body.title).toBe('explore_orders');
		expect(body.code).toContain('# sales.orders');
		expect(body.code).toContain('    catalog = load_catalog("lake")');
	});

	it('loads a row preview only after the explicit button is pressed', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			capability: { metadata: true, preview: true },
		});

		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/browse/preview'))).toBe(
			false,
		);

		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(await screen.findByText('paid')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
	});

	it('supports keyboard navigation and associates tabs with their panels', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			capability: { metadata: true, preview: true },
		});

		const schemaTab = await screen.findByRole('tab', { name: 'Schema' });
		const previewTab = screen.getByRole('tab', { name: 'Preview' });
		schemaTab.focus();
		await user.keyboard('{ArrowRight}');

		expect(previewTab).toHaveFocus();
		expect(previewTab).toHaveAttribute('aria-selected', 'true');
		const previewPanel = screen.getByRole('tabpanel');
		expect(previewTab).toHaveAttribute('aria-controls', previewPanel.id);
		expect(previewPanel).toHaveAttribute('aria-labelledby', previewTab.id);

		await user.keyboard('{ArrowLeft}');
		expect(schemaTab).toHaveFocus();
		expect(schemaTab).toHaveAttribute('aria-selected', 'true');
	});

	it('returns to schema when refreshed capabilities disable previews', async () => {
		const user = userEvent.setup();
		const capability = { metadata: true, preview: true };
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?ns=sales&table=orders`, {
			capability,
		});
		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();

		capability.preview = false;
		await user.click(screen.getByRole('button', { name: 'Refresh' }));

		await waitFor(() =>
			expect(screen.queryByRole('tab', { name: 'Preview' })).not.toBeInTheDocument(),
		);
		expect(screen.getByPlaceholderText('Filter columns...')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Load preview' })).not.toBeInTheDocument();

		capability.preview = true;
		await user.click(screen.getByRole('button', { name: 'Refresh' }));
		await waitFor(() =>
			expect(screen.getByRole('tab', { name: 'Schema' })).toHaveAttribute('aria-selected', 'true'),
		);
		expect(screen.queryByRole('button', { name: 'Load preview' })).not.toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/browse/preview'))).toBe(
			false,
		);
	});
});
