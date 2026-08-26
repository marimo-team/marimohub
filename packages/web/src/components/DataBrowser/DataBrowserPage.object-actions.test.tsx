import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IID, PID, lakeEntry, objectKind, setup } from './DataBrowserPage.testWorld';

describe('DataBrowserPage object actions', () => {
	it('pages object listings through the reachable fallback button', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectNextCursor: 'p2',
			objectEntriesSecond: [{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 }],
		});

		await user.click(await screen.findByRole('button', { name: 'Load more' }));
		expect(await screen.findByText('second.csv')).toBeInTheDocument();
	});

	it('multi-selects object URIs and clears selection while navigating prefixes', async ({
		onTestFinished,
	}) => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'prefix', name: 'daily/', key: 'daily/' },
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await user.click((await screen.findByText('first.csv')).closest('button')!);
		await user.keyboard('{Control>}');
		await user.click(screen.getByText('second.csv').closest('button')!);
		await user.keyboard('{/Control}');
		const copy = screen.getByRole('button', { name: 'Copy 2 selected URIs' });
		const write = vi.spyOn(navigator.clipboard, 'writeText');
		onTestFinished(() => write.mockRestore());
		await user.click(copy);
		await waitFor(() =>
			expect(write).toHaveBeenCalledWith('s3://lake/first.csv\ns3://lake/second.csv'),
		);

		await user.click(screen.getByText('daily/').closest('button')!);
		expect(screen.queryByRole('button', { name: /Copy .* selected/ })).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent('prefix=daily%2F'),
		);
		const row = await screen.findByText('first.csv');
		row.closest('button')!.focus();
		await user.keyboard('{Backspace}');
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('prefix='));
	});

	it('applies loaded type, size, date, and sort controls without searching', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{
					kind: 'object',
					name: 'old.csv',
					key: 'old.csv',
					size: 100,
					last_modified: '2026-08-10T12:00:00Z',
				},
				{
					kind: 'object',
					name: 'new.py',
					key: 'new.py',
					size: 2 * 1024 * 1024,
					last_modified: '2026-08-12T12:00:00Z',
				},
				{ kind: 'object', name: 'large.png', key: 'large.png', size: 200 * 1024 * 1024 },
			],
		});
		await screen.findByText('new.py');

		await user.selectOptions(screen.getByLabelText('Type'), 'text');
		expect(screen.getByText('new.py')).toBeInTheDocument();
		expect(screen.queryByText('old.csv')).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('Type'), 'all');
		await user.selectOptions(screen.getByLabelText('Size'), 'large');
		expect(screen.getByText('large.png')).toBeInTheDocument();
		expect(screen.queryByText('new.py')).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('Size'), 'all');
		await user.type(screen.getByLabelText('Modified after'), '2026-08-11');
		expect(screen.getByText('new.py')).toBeInTheDocument();
		expect(screen.queryByText('old.csv')).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('Sort loaded results'), 'name-desc');
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/objects/search'))).toBe(
			false,
		);
	});

	it('creates a notebook from the object-specific load snippet', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`,
			{ kind: objectKind, entry: { ...lakeEntry, kind: 's3' } },
		);
		await user.click(await screen.findByRole('button', { name: 'Open in Notebook' }));
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PID}/notebooks/nb_1`),
		);
		const post = fetchImpl.mock.calls.find(
			([url, init]) => String(url).includes('/notebooks') && init?.method === 'POST',
		);
		const body = JSON.parse(String(post?.[1]?.body)) as { code: string };
		expect(body.code).toContain('# s3://lake/events.jsonl');
		expect(body.code).toContain('    import polars as pl');
	});

	it('disables object notebook creation while the request is pending', async () => {
		const user = userEvent.setup();
		let releaseNotebook!: () => void;
		const notebookGate = new Promise<void>((resolve) => {
			releaseNotebook = resolve;
		});
		const fetchImpl = setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`,
			{
				kind: objectKind,
				entry: { ...lakeEntry, kind: 's3' },
				notebookGate,
			},
		);

		await user.click(await screen.findByRole('button', { name: 'Open in Notebook' }));
		const pending = await screen.findByRole('button', { name: 'Creating Notebook…' });
		expect(pending).toBeDisabled();
		await user.click(pending);
		expect(
			fetchImpl.mock.calls.filter(
				([url, init]) => String(url).includes('/notebooks') && init?.method === 'POST',
			),
		).toHaveLength(1);
		releaseNotebook();
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${PID}/notebooks/nb_1`),
		);
	});

	it('preserves object selection when shared notebook creation fails', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			notebookFailure: 'Notebook creation failed.',
		});
		await user.click(await screen.findByRole('button', { name: 'Open in Notebook' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Open in Notebook' })).toBeEnabled(),
		);
		expect(screen.getByTestId('location')).toHaveTextContent('key=events.jsonl');
		expect(screen.getByText('s3://lake/events.jsonl')).toBeInTheDocument();
	});

	it('keeps an explicit preview failure inline with a retry action', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { preview: 'Preview failed. Try a smaller object.' },
		});
		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(
			await screen.findByText('Preview failed. Try a smaller object.', { selector: 'p' }),
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();
	});

	it('keeps an object metadata failure inside the detail pane', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { detail: 'Object metadata is unavailable.' },
		});
		expect(await screen.findByText('Object metadata is unavailable.')).toBeInTheDocument();
	});

	it('keeps an object search failure inside the listing pane', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&q=needle`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { search: 'Object search reached its scan limit.' },
		});
		expect(await screen.findByText('Object search reached its scan limit.')).toBeInTheDocument();
	});

	it('keeps an object version failure inside the versions panel', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { versions: 'Object versions are unavailable.' },
		});
		await user.click(await screen.findByRole('tab', { name: 'Versions' }));
		expect(await screen.findByText('Object versions are unavailable.')).toBeInTheDocument();
	});

	it('filters and keyboard-navigates loaded object rows without a server request', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		const object = await screen.findByText('events.jsonl');
		const objectButton = object.closest('button')!;
		objectButton.focus();
		await user.keyboard('{ArrowUp}');
		expect(screen.getByText('daily/').closest('button')).toHaveFocus();

		await user.selectOptions(screen.getByLabelText('Type'), 'text');
		expect(screen.queryByText('events.jsonl')).not.toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/objects/search'))).toBe(
			false,
		);
	});

	it('shows the capability reason under an instance the hub cannot browse', async () => {
		setup(`/projects/${PID}/data/${IID}`, {
			capability: { metadata: false, preview: false, reason: 'sandbox only' },
		});

		expect(await screen.findByText('sandbox only')).toBeInTheDocument();
		expect(screen.queryByTestId('browse-namespace')).not.toBeInTheDocument();
	});

	it('shows an object capability request failure instead of a perpetual loading message', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { capability: 'S3 capability check failed.' },
		});

		expect(await screen.findByText('S3 capability check failed.')).toBeInTheDocument();
		expect(screen.queryByText('Checking object-store access…')).not.toBeInTheDocument();
	});

	it('shows the upstream error inline when a listing fails', async () => {
		setup(`/projects/${PID}/data/${IID}`, { namespacesDown: true });

		expect(await screen.findByText('The catalog answered HTTP 503.')).toBeInTheDocument();
		expect(screen.getByText('Reference: browse-req-123')).toBeInTheDocument();
	});

	it('an unknown integration id in the URL falls back to the empty detail pane', async () => {
		setup(`/projects/${PID}/data/intg_ghost?ns=sales&table=orders`);

		expect(await screen.findByTestId('browse-integration')).toBeInTheDocument();
		expect(await screen.findByText('Select an Integration')).toBeInTheDocument();
	});
});
